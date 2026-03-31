-- Folders (tree structure with virtual root)
CREATE TABLE folders (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    parent_id  TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(parent_id, name)
);

-- Virtual root node: parent of all top-level folders
INSERT INTO folders (id, name, parent_id, sort_order, created_at, updated_at)
VALUES ('__root__', 'root', '__root__', 0, datetime('now'), datetime('now'));

-- Resources (saved web snapshots)
CREATE TABLE resources (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    url           TEXT NOT NULL,
    domain        TEXT,
    author        TEXT,
    description   TEXT,
    folder_id     TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    resource_type TEXT NOT NULL DEFAULT 'webpage',
    file_path     TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    captured_at   TEXT NOT NULL
);

-- Tags
CREATE TABLE tags (
    id    TEXT PRIMARY KEY,
    name  TEXT NOT NULL UNIQUE,
    color TEXT NOT NULL
);

-- Resource-Tag associations (many-to-many)
CREATE TABLE resource_tags (
    resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    tag_id      TEXT NOT NULL REFERENCES tags(id)      ON DELETE CASCADE,
    PRIMARY KEY (resource_id, tag_id)
);

-- Highlights (text annotations on resources)
CREATE TABLE highlights (
    id           TEXT PRIMARY KEY,
    resource_id  TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    text_content TEXT NOT NULL,
    anchor       TEXT NOT NULL,
    color        TEXT NOT NULL,
    created_at   TEXT NOT NULL
);

-- Comments (on highlights or standalone notes on resources)
CREATE TABLE comments (
    id           TEXT PRIMARY KEY,
    highlight_id TEXT REFERENCES highlights(id) ON DELETE CASCADE,
    resource_id  TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    content      TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);

-- Indexes
CREATE INDEX idx_resources_url            ON resources(url);
CREATE INDEX idx_resources_folder_created ON resources(folder_id, created_at DESC);
CREATE INDEX idx_highlights_resource      ON highlights(resource_id);
CREATE INDEX idx_comments_resource        ON comments(resource_id);
CREATE INDEX idx_comments_highlight       ON comments(highlight_id);
CREATE INDEX idx_resource_tags_resource   ON resource_tags(resource_id);
CREATE INDEX idx_resource_tags_tag        ON resource_tags(tag_id);
CREATE INDEX idx_folders_parent_sort      ON folders(parent_id, sort_order);
