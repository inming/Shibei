-- Add sync fields to business tables
ALTER TABLE folders ADD COLUMN hlc TEXT;
ALTER TABLE folders ADD COLUMN deleted_at TEXT;
ALTER TABLE resources ADD COLUMN hlc TEXT;
ALTER TABLE resources ADD COLUMN deleted_at TEXT;
ALTER TABLE tags ADD COLUMN hlc TEXT;
ALTER TABLE tags ADD COLUMN deleted_at TEXT;
ALTER TABLE highlights ADD COLUMN hlc TEXT;
ALTER TABLE highlights ADD COLUMN deleted_at TEXT;
ALTER TABLE comments ADD COLUMN hlc TEXT;
ALTER TABLE comments ADD COLUMN deleted_at TEXT;
ALTER TABLE resource_tags ADD COLUMN hlc TEXT;
ALTER TABLE resource_tags ADD COLUMN deleted_at TEXT;

-- Initialize hlc for existing data (pre-sync placeholder)
UPDATE folders SET hlc = CAST(strftime('%s', updated_at) AS INTEGER) * 1000 || '-0000-pre-sync' WHERE hlc IS NULL;
UPDATE resources SET hlc = CAST(strftime('%s', created_at) AS INTEGER) * 1000 || '-0000-pre-sync' WHERE hlc IS NULL;
UPDATE tags SET hlc = CAST(strftime('%s', 'now') AS INTEGER) * 1000 || '-0000-pre-sync' WHERE hlc IS NULL;
UPDATE highlights SET hlc = CAST(strftime('%s', created_at) AS INTEGER) * 1000 || '-0000-pre-sync' WHERE hlc IS NULL;
UPDATE comments SET hlc = CAST(strftime('%s', updated_at) AS INTEGER) * 1000 || '-0000-pre-sync' WHERE hlc IS NULL;

-- Sync log: tracks all local changes for upload
CREATE TABLE sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload TEXT NOT NULL,
  hlc TEXT NOT NULL,
  device_id TEXT NOT NULL,
  uploaded INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sync_log_uploaded ON sync_log(uploaded);
CREATE INDEX idx_sync_log_entity ON sync_log(entity_type, entity_id);

-- Sync state: KV store for sync progress and config
CREATE TABLE sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
