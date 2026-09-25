# Backups: continuous replication to S3-compatible storage

sqlitend runs one [Litestream](https://litestream.io) process per running database. Each process
streams that database's changes to any S3-compatible store: Cloudflare R2, AWS S3, Backblaze B2,
Wasabi, MinIO, and so on.

```
sqld (db.sqlite/dbs/default/data) ──WAL──▶ litestream ──▶ s3://<bucket>/<prefix>/db/<database-id>/
```

Litestream 0.5.16 is pinned (`scripts/fetch-litestream.sh`, SHA-256 of the binary). It's the same
version already proven on sqld data files in `postgresql-db-infra`, including byte-identical restores.

## Enable

```sh
./scripts/fetch-litestream.sh
```

Then add to `~/.config/sqlitend/env` (mode 0600):

```ini
SQLITEND_BACKUP_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com   # or https://s3.<region>.amazonaws.com, …
SQLITEND_BACKUP_S3_BUCKET=sqlitend-backup-server-a
SQLITEND_BACKUP_S3_ACCESS_KEY_ID=…
SQLITEND_BACKUP_S3_SECRET_ACCESS_KEY=…
SQLITEND_BACKUP_S3_REGION=auto            # R2: auto; AWS: the bucket's region
SQLITEND_BACKUP_S3_FORCE_PATH_STYLE=true  # default; false for AWS virtual-host style
SQLITEND_BACKUP_PREFIX=server-a           # default: hostname; one prefix per server
# Optional:
SQLITEND_BACKUP_SNAPSHOT_INTERVAL=24h     # full snapshot cadence
SQLITEND_BACKUP_RETENTION=168h            # how far back point-in-time restore reaches
SQLITEND_BACKUP_MAX_LAG_SECONDS=300       # replica may trail this long before "lagging"
```

Restart sqlitend. The boot log prints `[backup] continuous backup to s3://…`. Without these
settings it prints a warning and `/healthz` reports `degraded`, so "not backed up" can't go
unnoticed.

**Credentials:** give the key write access to this bucket only. The secret goes to Litestream
through its process environment and is never written to disk; the generated per-database configs
in `<dataRoot>/litestream/` contain no secrets.

## Status and alerting

- **Database page → Backup:** state, replica URL, last sync, last snapshot, local vs replica txid,
  and the last error.
- **API:** `GET /api/databases/:id/backup` and `GET /api/backups` (all databases).
- **`GET /healthz`** (unauthenticated, counts only) returns 200 when every database that should run
  is running and every backup is `ok`; otherwise **503**. Point an uptime monitor at it.

| State | Meaning |
|---|---|
| `starting` | just launched, no sync reported yet |
| `ok` | replica caught up (Litestream reports a sync every 1–2 s, even when idle) |
| `lagging` | replica behind the database, or no sync reported, for longer than `MAX_LAG` |
| `error` | an upload error with no successful sync since (bad key, missing bucket, 403 …) |
| `stopped` | database not running, or Litestream exited and is waiting to restart |

State comes from Litestream's own log rather than from polling S3. That catches the failure mode
`postgresql-db-infra` found in production: **Litestream 0.5.x keeps running while every upload
fails with 403**, so "the process is up" proves nothing. An unexpected exit is restarted with
backoff (2 s … 60 s) and counted in `restarts`.

## Lifecycle

- **Create or start a database:** replication starts within about 5 s.
- **Stop a database:** Litestream gets SIGTERM and flushes pending changes, then exits.
- **Delete a database:** replication is flushed and stopped before the files are removed. **The
  replica stays in S3** (subject to retention), so a deleted database can still be recovered.
- **sqlitend shutdown:** sqld stops first, then Litestream flushes and exits.

## Restore

**A restore always creates a new database.** The source, live or deleted, is never touched. The new
database gets its own id, signing key, tokens, hostname and replica path. That one operation covers:

- "someone dropped a table": restore to 5 minutes ago beside production and copy the rows back;
- "what did this look like yesterday?": restore to a point in time and compare;
- "bring back the database I deleted": replicas are kept in S3 after a delete (subject to retention).

**UI:** a database page → *Backup* → **Restore as new database…**, or the header's **Backups**,
which lists every replica under this server's prefix, deleted databases included.

**API:**

```sh
GET  /api/backups/replicas          # [{id, slug, name, workspaceId, exists}, …]
POST /api/backups/<source-id>/restore
     {"name": "mws-prod-restored", "workspaceId": "<ws id>", "at": "2026-09-25T08:00:00+08:00"}
     # → 202 with the new database (status "restoring"); poll GET /api/databases/<new id>
```

What happens:

1. The new row is created as `restoring` with `auto_start=0`, so a crash mid-restore can never come
   back up as an **empty** database. At boot, an interrupted restore is marked `failed`.
2. `litestream restore` writes to `<data_dir>.restore/data`.
3. `PRAGMA integrity_check` must return `ok`; otherwise the restore fails and nothing is placed.
4. The file moves to sqld's layout (`db.sqlite/dbs/default/data`), `auto_start=1`, sqld starts, DNS
   is synced, and replication begins under the **new** id.
5. On failure, the row is `failed` with the reason (Litestream's own message, e.g. "no matching
   backup files available").

**Point in time.** Litestream 0.5.16's `-timestamp` only accepts times *inside* the span of existing
LTX files, so "restore to now" fails when the last write was a minute ago. sqlitend resolves the
time itself (`litestream ltx -json`): it uses the highest transaction id of any LTX file written
**strictly before** that time, then restores with `-txid`. This never includes a change made after
the time you asked for; at worst it stops one second earlier. Times before the first backup fail
with the earliest restorable time. How far back you can go is `SQLITEND_BACKUP_RETENTION`.

A deleted database is restored by its old id. The manifest (`<prefix>/db/<id>/sqlitend.json`)
supplies its name.

## Import an existing SQLite file

This brings a database from another host (for example a namespace from a plain `sqld` server, or a
`litestream restore` output) into sqlitend as a **new** database. It works with or without backups configured.

1. Make **one self-contained file**, after the source has stopped taking writes (freeze the app, or stop its
   sqld). Otherwise writes made after the copy are silently missing. Use `sqlite3 <src> ".backup /tmp/x.db"`
   (safe even while sqld runs), or the output of `litestream restore`. Then put it in the import directory,
   owned by the service user:
   ```sh
   sudo install -o sqlitend -g sqlitend -m 0600 /tmp/x.db /var/lib/sqlitend/imports/quranready_prod.db
   ```
   A `-wal`, `-shm` or `-journal` next to the file is **refused**, not merged. Nothing ties a WAL to its
   database, so a stale one would replay the wrong pages.
2. Start the import. The file is referred to by its **name only**; paths and symlinks are refused.
   ```
   GET  /api/imports                                   → {dir, files:[{file, bytes, tables}]}
   POST /api/workspaces/:id/databases/import  {"name":"quranready-prod","file":"quranready_prod.db"}  → 202
   ```
3. sqlitend copies the file's bytes into a private staging dir, logs the size and SHA-256 (compare them with your copy), compacts it with `VACUUM INTO`, runs `PRAGMA integrity_check` on the copy,
   places it where sqld expects it and starts it. Then the usual start-up steps run: its DNS record is created and
   Litestream replication begins. While this runs the database shows `restoring` and cannot be started,
   stopped or deleted. On any problem it becomes `failed` with `import failed: …` and nothing is published.
4. The import works only on its own copy. The source stays byte for byte as it was (the listing only opens it read-only). Delete it from `imports/` once the new database checks out.

Tokens are **not** carried over. Mint a new token for the new hostname and give it to the app.

## Nightly restore-verify

"Uploading" doesn't prove "restorable". Every night at `SQLITEND_BACKUP_VERIFY_AT` (default `03:30`,
server local time; `off` disables it), and on demand, sqlitend works through each running database,
one at a time:

1. **Free space:** it needs about 1.2× the database size plus a 256 MB reserve. A verify never
   fills the disk the live databases need.
2. **Preflight:** it lists the replica through the S3 API with a 20 s limit.
   `litestream restore` retries an unreachable store forever (verified), so without this an outage
   would hang the run.
3. **Restore** the latest state to `<dataRoot>/verify/<id>/data`.
4. **`PRAGMA integrity_check`** must be `ok`.
5. **Schema check:** the tables, views, indexes and triggers of the restored copy must equal the
   live database's. This catches a backup that is valid SQLite but the wrong or empty data.
6. Delete the scratch copy and record the result (the last 60 per database are kept, and each run
   is also in the audit log as `backup.verify`).

Results show on the database page under *Backup*, with a **Verify now** button. Also:

```
POST /api/databases/:id/backup/verify      # verify one now; returns the backup status
POST /api/backups/verify                   # verify all, in the background
GET  /api/databases/:id/backup/verifications
```

**`/healthz` turns 503** when a database's latest verify **failed**, or its last successful verify
is older than `SQLITEND_BACKUP_VERIFY_MAX_AGE_HOURS` (default 48), i.e. **stale**. Stale means the
verifier itself silently stopped. A database younger than that window is `pending` until its first
nightly run, and doesn't alarm.

A migration applied seconds before a verify can show up as a schema mismatch while the replica
catches up; the next run clears it. Use **Verify now** to confirm.

## Control-plane backup (rebuilding a whole server)

Litestream protects database **contents**. Rebuilding a lost server also needs sqlitend's own
state:

- `metadata.sqlite`: workspaces, databases (id ↔ replica path), the **token allowlist** the gateway
  enforces, the admin login, and the audit log;
- `keys/`: each database's **signing key**. Without it, every issued token is invalid.

This state is backed up **encrypted** (AES-256-GCM) to `s3://<bucket>/<prefix>/control/`. That
happens daily at `SQLITEND_CONTROL_BACKUP_AT` (default `03:15`), about 60 s after any change a
rebuild depends on (a database, token or workspace change, or a password/TOTP change), at first
boot, and on demand. The last `SQLITEND_CONTROL_BACKUP_KEEP` (30) copies are kept.

```sh
sqlitend gen-backup-key        # prints a 32-byte key + fingerprint
# → SQLITEND_CONTROL_BACKUP_KEY=… in ~/.config/sqlitend/env, AND a copy in your password manager
```

**The key never goes to S3.** Someone with read access to the bucket still can't mint tokens or
read the admin hash. Lose the key and control backups can't be decrypted, so keep it offline.
Without a key set, the boot log warns and `/healthz` reports `degraded` (`"control":"disabled"`).

### Full-server rebuild (drill-tested)

On a fresh server with sqlitend installed, the same `SQLITEND_BACKUP_*` and
`SQLITEND_CONTROL_BACKUP_KEY` settings, and **sqlitend stopped**:

```sh
sqlitend restore-control          # latest; or --list / --object <key>; --force moves an existing metadata aside
sqlitend restore-data             # restores every database's data in place, verified with integrity_check
systemctl --user start sqlitend   # databases relaunch; existing tokens keep working
```

- `restore-control` decrypts the bundle (a wrong key is named by its fingerprint) and writes the
  metadata and keys. If the new data root differs from the old one, it remaps the database paths.
  It then **parks** every database (`stopped`, `auto_start=0`, "restore pending"): starting one
  before its data is back would bring it up empty and replicate the emptiness. Start is refused for
  parked databases.
- `restore-data` restores each parked database into its own path, never over an existing file, then
  re-enables auto-start. A database that fails stays parked; fix the cause and run it again.
- Both commands refuse to run while sqlitend is up.
- Replication then continues into the **same** replica paths (same database ids).

Drill result: the whole data root was wiped. `restore-control`, then `restore-data`, then start:
both databases came back with every row, and **tokens issued before the wipe** still worked through
the public gateway.

### Manual restore without sqlitend (disaster recovery)

```sh
LITESTREAM_ACCESS_KEY_ID=… LITESTREAM_SECRET_ACCESS_KEY=… \
  bin/litestream restore -o /tmp/restored.sqlite \
  "s3://<bucket>/<prefix>/db/<database-id>?endpoint=<endpoint>&region=<region>&force-path-style=true"
```

Next: an encrypted backup of the control plane (metadata + per-database signing keys) for rebuilding
a whole server.
