-- 007: database names are unique per workspace (case-insensitive), not globally.
-- The slug (the public hostname key and the data dir name) stays globally
-- unique, but new databases get a random one instead of a name-derived one.
-- Existing rows keep their slugs, so published hostnames do not change.
--
-- Older versions could hold two same-named databases in one workspace (e.g.
-- names that slugified to nothing). Keep the oldest name as is and suffix the
-- others with their id prefix, so the index below can always be built.
UPDATE databases
   SET name = name || ' (' || substr(id, 1, 8) || ')'
 WHERE rowid NOT IN (
   SELECT min(rowid) FROM databases GROUP BY workspace_id, name COLLATE NOCASE
 );
CREATE UNIQUE INDEX idx_databases_workspace_name ON databases(workspace_id, name COLLATE NOCASE);
