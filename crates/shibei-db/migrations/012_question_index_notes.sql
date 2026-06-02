-- Fold research-note content into the question FTS index so a search can find
-- a question by the thinking the user (or an AI agent) deposited in its notes.
--
-- FTS5 has no ALTER ADD COLUMN, so recreate the table with an extra
-- `notes_text` column. Backfill the new index IN THIS MIGRATION (a plain
-- INSERT…SELECT) rather than resetting the boot-time init flag: the desktop
-- has a question-FTS boot pass but the HarmonyOS port does not, so an in-SQL
-- backfill is the one mechanism that repopulates both platforms atomically.
-- `notes_text` aggregates every alive note's content for the question (order
-- is irrelevant for trigram matching).
DROP TABLE IF EXISTS question_index;
CREATE VIRTUAL TABLE question_index USING fts5(
    question_id UNINDEXED,
    title,
    description,
    notes_text,
    tokenize='trigram'
);

INSERT INTO question_index (question_id, title, description, notes_text)
SELECT
    q.id,
    q.title,
    COALESCE(q.description, ''),
    COALESCE(
        (SELECT group_concat(n.content, char(10))
         FROM question_notes n
         WHERE n.question_id = q.id AND n.deleted_at IS NULL),
        ''
    )
FROM questions q
WHERE q.deleted_at IS NULL;
