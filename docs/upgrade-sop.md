# Upgrading the `sqld` binary (SOP)

sqlitend pins an exact `sqld` release (and its SHA-256) in `scripts/fetch-sqld.sh`. Two things can
go out of sync when you upgrade it: the **control plane's boot smoke gating** and **`--auth` /
`--http-listen` flag behavior** (which changed between versions historically). This is the safe
procedure.

## Prereqs

- Read the changelog/diff for the new `sqld` version first — especially anything touching:
  - `--auth-jwt-key-file` / `SQLD_AUTH_JWT_KEY` (the control plane requires **Ed25519** JWT auth;
    sqld does not enforce token claims — the per-database signing key *is* the scope)
  - `--http-listen-addr` / `--grpc-listen-addr` (each database gets an explicit http+grpc pair)
  - `/health` readiness and the `/v2/pipeline` Hrana path

## Procedure

```sh
# 1. Stop everything (also stops the auto_start databases cleanly).
#    There is NO stop script. Stop the control plane process itself: Ctrl+C (SIGINT) in the
#    foreground, or `kill -TERM <control-plane-pid>` in the background. On SIGINT/SIGTERM the
#    control plane TERMs ALL sqld children (spawned + adopted) with a 5s grace before KILL, then
#    closes the metadata DB.
kill -TERM <control-plane-pid>   # wait for "[shutdown] complete"

# 2. Swap the binary.
#    Update scripts/fetch-sqld.sh: bump TAG and the PINNED_BIN_SHA256_* values (the literal
#    SHA-256 of the EXTRACTED sqld binary). The script verifies the installed binary's hash
#    against that pin on EVERY run, including the fast path, so a swapped binary that merely
#    reports the right version is detected and re-fetched. Then:
./scripts/fetch-sqld.sh

# 3. Boot smoke (the control plane refuses to use databases if the binary is unusable).
bun run start
#    Watch the boot line: "sqld <version> | dataRoot=..." — if it reports
#    "UNAVAILABLE at <path> — run scripts/fetch-sqld.sh", the new binary failed the version
#    smoke and BOTH database create and start are gated, returning 503
#    {code:"sqld_unavailable"} (GET /api/system shows sqldOk:false with a reason).

# 4. Verify against a throwaway database before touching real ones.
bun run e2e                  # timed killer-workflow; exercises create/connect/token/metrics/delete
#    or manually: create a scratch workspace + db, connect with a minted token, view metrics.

# 5. Reconcile + relaunch (auto_start).
#    On boot the control plane re-adopts live sqld processes (pid-reuse guarded, so an adopted
#    DB keeps its original pid) and relaunches any auto_start=1 database whose process died.
#    Confirm each leaves reconcile running; check the UI metrics for the ones left stopped.

# 6. Trouble — flag/behavior drift.
#    If the new sqld rejects all tokens (401 on every request incl. a freshly minted one), the
#    auth model changed. Re-run the isolated probe documented in
#    apps/server/src/supervisor/launcher.ts (STEP-1 SPIKE FINDINGS) against the new binary and
#    update auth/tokens.ts + the launcher accordingly.
```

## Data layout

Everything lives under the data root (default `~/.local/share/sqlitend`):

```
<dataRoot>/
  metadata.sqlite            # workspaces / databases / tokens (WAL mode) — the control plane state
  metadata.sqlite-wal        # and -shm sidecars hold recent writes — copy them with backups
  keys/<dbId>.key            # per-database Ed25519 private signing key (0600)
  keys/<dbId>.pub            # per-database public key handed to that DB's sqld
  workspaces/<wsSlug>/dbs/<dbSlug>/db.sqlite   # the actual libSQL database
```

> Note: after a plain restore from a non-WAL copy, re-create the database row with
> `auto_start=1` (see below) so the restored database relaunches on the next boot rather than
> silently staying offline.

## Boot behavior

On boot the control plane:

- **Reconciles against `metadata.sqlite`** — it *adopts* (takes ownership of) any live `sqld`
  process whose `/proc` start time matches the persisted `start_time` (pid-reuse guarded), so an
  already-running database keeps its existing pid and is not restarted. Rows that are dead,
  mismatched, or have no pid are left *stopped* if `auto_start=0`, or **relaunched** if
  `auto_start=1` (unless something already binds the database's http port — the double-bind
  guard — in which case the row is marked `failed` until the orphan is swept).
- **Sweeps orphaned `sqld` processes** left over from a crash: killed only when all of these
  hold — the pid is not tracked, `/proc/<pid>/exe` resolves to the configured sqld binary, and
  the `--db-path` argument is strictly inside this data root. Terminates with SIGTERM, 1s grace,
  then SIGKILL.
- **Warns about unregistered data dirs**: any directory under
  `<dataRoot>/workspaces/*/dbs/*` that `metadata.sqlite` does not reference logs a
  `[boot] WARNING: N data dir(s) on disk are not referenced by metadata.sqlite:` list. Those
  databases are healthy on disk but unreachable by the control plane until re-registered.

## Backup

Stop the control plane — or stop the individual database from the UI — **before** copying its
data, so SQLite is quiescent. Then copy the entire data root. The `-wal` / `-shm` sidecars hold
the newest rows between checkpoints, so **must be copied too** — copying only
`metadata.sqlite` (or only `db.sqlite`) can silently lose the most recent writes.

```sh
# Control plane stopped (see step 1) — or the database stopped from the UI.
cp -a ~/.local/share/sqlitend /backups/sqlitend
```

## Recovery — metadata.sqlite lost

`metadata.sqlite` holds the rows that make databases reachable. Losing it does **not** destroy
the on-disk databases, but orphans them: a healthy `workspaces/<ws>/dbs/<slug>/db.sqlite` with
no row is invisible to the API. The boot log's `[boot] WARNING … not referenced by
metadata.sqlite` lists exactly the dirs affected.

**Option A — restore from backup.** Stop the server, restore the backed-up `metadata.sqlite`
(and its WAL sidecars if available), and restart. Rows whose process died relaunch on boot iff
`auto_start=1`; `auto_start=0` databases stay stopped until started manually.

**Option B — re-register manually.** Stop the server, point a `sqlite3` shell at
`<dataRoot>/metadata.sqlite` (recreated fresh if deleted — migrations run on boot), and insert
the workspace and database rows. Start from the workspace-script / database-script from the
schema (see `apps/server/src/db/migrations/001_init.sql`, `002_failed_reason.sql`). The
`databases` columns are:

```
id, workspace_id, slug, name, status, pid, start_time, port, grpc_port, data_dir,
auth_key, auto_start, sqld_version, failed_reason, created_at
```

The database id is the file stem of its signing key in `<dataRoot>/keys/` (e.g. a key file
`keys/0d218d52….key` means `id='0d218d52…'`). Steps:

1. Re-create the workspace row with the **real** slugs from the directory layout
   (`data_dir` is derived from the workspace slug, so they must match exactly):
   ```sql
   INSERT INTO workspaces(id, slug, name, created_at)
   VALUES ('<wsId>', '<wsSlug>', '<name>', strftime('%s','now'));
   ```
2. Insert the database row. Set `status='stopped'` for a safe create, and `auto_start=1` so the
   control plane relaunches it on restart. Ports must be free numbers inside
   `SQLITEND_PORT_RANGE` (default `6101-6300`). `data_dir` is the absolute path of the dir from
   the boot warning; `auth_key` is the relative `keys/<dbId>.pub`:
   ```sql
   INSERT INTO databases(
     id, workspace_id, slug, name, status,
     port, grpc_port, data_dir, auth_key, auto_start, created_at
   )
   VALUES (
     '<dbId>', '<wsId>', '<dbSlug>', '<name>', 'stopped',
     6101, 6102,
     '<absolute data-root>/workspaces/<wsSlug>/dbs/<dbSlug>',
     'keys/<dbId>.pub', 1, strftime('%s','now')
   );
   ```
3. Restart the server. Reconcile adopts the row, sees the database is not running and
   `auto_start=1`, and relaunches it — the DB shows `running` with a fresh pid and metrics.

> Tokens are stateless EdDSA JWTs validated against the per-database key file, so a restored
> `metadata.sqlite` (fresh `tokens` table) does not retroactively invalidate or revive any token;
> mint fresh ones as needed.

## Rollback

```sh
# Point SQLITEND_SQLD_PATH back at the previous binary (or re-fetch the old pin) and restart.
./scripts/fetch-sqld.sh  # after reverting the pin
bun run start
```

Take a backup of the data root before upgrading — see **Backup** above. Stop the control plane
(or the database) first and copy the WAL sidecars along with the main files; restores are
covered under **Recovery**.
