CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
    resource_id UNINDEXED,
    title,
    url,
    description,
    highlights_text,
    comments_text,
    tokenize='trigram'
);
