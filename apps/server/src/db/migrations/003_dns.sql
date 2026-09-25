-- 003: Cloudflare DNS automation state per database. dns_status is NULL when
-- DNS is not managed, else 'active' | 'error' | 'conflict'.
ALTER TABLE databases ADD COLUMN dns_hostname TEXT;
ALTER TABLE databases ADD COLUMN dns_record_id TEXT;
ALTER TABLE databases ADD COLUMN dns_status TEXT;
ALTER TABLE databases ADD COLUMN dns_error TEXT;
