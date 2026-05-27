-- Separate FTS5 virtual table for questions so they can be searched
-- independently of resources. Using the same trigram tokenizer for
-- consistent substring matching (esp. for CJK).
--
-- Schema mirrors search_index's UNINDEXED key pattern: question_id is
-- carried verbatim so we can delete/rebuild rows by id.
CREATE VIRTUAL TABLE question_index USING fts5(
    question_id UNINDEXED,
    title,
    description,
    tokenize='trigram'
);

-- Reset initialization flag — a separate boot-time pass will populate
-- this table for any pre-existing questions.
DELETE FROM sync_state WHERE key = 'config:question_fts_initialized';
