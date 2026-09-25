-- 004: token management. name = operator label (e.g. "worker-prod");
-- revoked_at enforced by the gateway (sqld itself cannot revoke);
-- last_used_at is a throttled gateway touch.
ALTER TABLE tokens ADD COLUMN name TEXT;
ALTER TABLE tokens ADD COLUMN revoked_at INTEGER;
ALTER TABLE tokens ADD COLUMN last_used_at INTEGER;
