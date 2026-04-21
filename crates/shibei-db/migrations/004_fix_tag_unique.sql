-- Fix UNIQUE constraint on tags.name to only apply to non-deleted rows.
-- SQLite doesn't support DROP CONSTRAINT, so we recreate the table.

-- Step 1: Create new table without UNIQUE constraint on name
CREATE TABLE tags_new (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    color      TEXT NOT NULL,
    hlc        TEXT,
    deleted_at TEXT
);

-- Step 2: Copy data
INSERT INTO tags_new SELECT id, name, color, hlc, deleted_at FROM tags;

-- Step 3: Drop old table
DROP TABLE tags;

-- Step 4: Rename new table
ALTER TABLE tags_new RENAME TO tags;

-- Step 5: Create partial unique index (only active tags must have unique names)
CREATE UNIQUE INDEX idx_tags_name_active ON tags(name) WHERE deleted_at IS NULL;
