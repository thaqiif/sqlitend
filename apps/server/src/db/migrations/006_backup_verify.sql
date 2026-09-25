-- 006: restore-verify results (nightly + on demand). One row per attempt.
CREATE TABLE backup_verifications(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  database_id TEXT NOT NULL,            -- no FK: history survives a delete
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  outcome TEXT NOT NULL,                -- 'ok' | 'failed'
  detail TEXT,
  restored_bytes INTEGER,
  trigger TEXT NOT NULL                 -- 'schedule' | 'manual'
);
CREATE INDEX idx_backup_verifications_db ON backup_verifications(database_id, id);
