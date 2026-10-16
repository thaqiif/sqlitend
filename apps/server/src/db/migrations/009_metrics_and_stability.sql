-- 009: persisted metrics history ring buffer & stability counters (Phase 3).
ALTER TABLE databases ADD COLUMN crash_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE databases ADD COLUMN last_crash_at INTEGER;
ALTER TABLE databases ADD COLUMN last_crash_reason TEXT;
ALTER TABLE databases ADD COLUMN restart_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE metrics_history(
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  sampled_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  cpu_pct REAL,
  memory_bytes INTEGER NOT NULL,
  disk_bytes INTEGER NOT NULL,
  wal_bytes INTEGER NOT NULL DEFAULT 0,
  query_count INTEGER NOT NULL DEFAULT 0,
  query_errors INTEGER NOT NULL DEFAULT 0,
  p50_ms REAL,
  p95_ms REAL,
  p99_ms REAL,
  PRIMARY KEY (database_id, sampled_at)
);
CREATE INDEX idx_metrics_history_sampled_at ON metrics_history(sampled_at);

CREATE TABLE crash_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  reason TEXT
);
CREATE INDEX idx_crash_events_db_at ON crash_events(database_id, at);
