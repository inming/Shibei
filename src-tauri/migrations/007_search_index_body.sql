DROP TABLE IF EXISTS search_index;

CREATE VIRTUAL TABLE search_index USING fts5(
    resource_id UNINDEXED,
    title,
    url,
    description,
    highlights_text,
    comments_text,
    body_text,
    tokenize='trigram'
);

-- Reset FTS initialization flag to trigger full rebuild on next startup
DELETE FROM sync_state WHERE key = 'config:fts_initialized';
