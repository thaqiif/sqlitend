-- 002: persist the last launch failure (sqld stderr tail) so a `failed`
-- database is diagnosable from the UI/API without SSH. Also drop the unused
-- config table (never read or written by any repo).
ALTER TABLE databases ADD COLUMN failed_reason TEXT;
DROP TABLE config;
