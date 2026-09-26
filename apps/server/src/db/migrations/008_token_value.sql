-- 008: keep the issued JWT so the dashboard can show/copy it again (owner's choice
-- for this deployment; the metadata DB is 0600 and its off-box backup is
-- encrypted). Tokens issued before 008 have NULL here: rotate to get a copyable one.
ALTER TABLE tokens ADD COLUMN token TEXT;
