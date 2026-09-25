-- 005: control-plane authentication (single operator), sessions, audit log.
CREATE TABLE admin(
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL,          -- argon2id (Bun.password)
  totp_secret TEXT,                     -- base32; NULL = TOTP off
  totp_last_step INTEGER,               -- last accepted TOTP counter (replay guard)
  password_changed_at INTEGER NOT NULL
);
CREATE TABLE sessions(
  id_hash TEXT PRIMARY KEY,             -- sha256(session id); the id itself is never stored
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,          -- absolute limit
  ip TEXT,
  user_agent TEXT
);
CREATE TABLE audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,                  -- 'admin' | 'anonymous' | 'cli'
  ip TEXT,
  action TEXT NOT NULL,                 -- e.g. 'auth.login', 'database.create'
  target TEXT,
  outcome TEXT NOT NULL,                -- 'ok' | 'denied' | 'error'
  detail TEXT
);
CREATE INDEX idx_audit_at ON audit_log(at);
