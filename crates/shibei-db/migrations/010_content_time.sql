-- v2026-06-01: content_time records the timeliness of the content itself
-- (e.g. an article's publication date), distinct from created_at (when the
-- resource was added to Shibei) and captured_at (when the snapshot was taken).
-- Nullable: existing resources have no content_time until backfilled via the
-- edit dialog.
ALTER TABLE resources ADD COLUMN content_time TEXT;
