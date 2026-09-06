CREATE TABLE workspaces(
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE databases(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'stopped',
  pid INTEGER,
  start_time INTEGER,
  port INTEGER,
  grpc_port INTEGER,
  data_dir TEXT NOT NULL,
  auth_key TEXT,
  auto_start INTEGER NOT NULL DEFAULT 1,
  sqld_version TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE tokens(
  jti TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE config(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX idx_databases_workspace ON databases(workspace_id);
CREATE INDEX idx_tokens_database ON tokens(database_id);