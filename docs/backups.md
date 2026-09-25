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

### Manual restore without sqlitend (disaster recovery)

```sh
LITESTREAM_ACCESS_KEY_ID=… LITESTREAM_SECRET_ACCESS_KEY=… \
  bin/litestream restore -o /tmp/restored.sqlite \
  "s3://<bucket>/<prefix>/db/<database-id>?endpoint=<endpoint>&region=<region>&force-path-style=true"
```

Next: a scheduled restore-verify drill, and an encrypted backup of the control plane (metadata +
per-database signing keys) for rebuilding a whole server.
