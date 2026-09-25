-- 007: database names are unique per workspace (case-insensitive), not globally.
-- The slug (the public hostname key and the data dir name) stays globally
-- unique, but new databases get a random one instead of a name-derived one.
-- Existing rows keep their slugs, so published hostnames don't change.
CREATE UNIQUE INDEX idx_databases_workspace_name ON databases(workspace_id, name COLLATE NOCASE);
