-- 010: delete-protection flags (default ON) and soft-delete trash metadata (Phase 4).
ALTER TABLE workspaces ADD COLUMN protected INTEGER NOT NULL DEFAULT 1;
ALTER TABLE databases ADD COLUMN protected INTEGER NOT NULL DEFAULT 1;
ALTER TABLE databases ADD COLUMN trashed_at INTEGER;
ALTER TABLE databases ADD COLUMN trash_path TEXT;
ALTER TABLE databases ADD COLUMN last_write_at INTEGER;
