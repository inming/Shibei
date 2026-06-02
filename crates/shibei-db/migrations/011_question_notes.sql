-- Question research notes: multiple timestamped markdown notes per question,
-- where the user (or an MCP-delegated AI agent) deposits synthesized thinking
-- and stage summaries built from the question's accumulated materials.
--
-- Each note is an INDEPENDENT sync entity (id-based HLC LWW), mirroring
-- question_links. This isolates note edits from the parent question row, so a
-- note edit on one device never clobbers a title/status edit on another. There
-- is no UNIQUE constraint: a question may hold any number of notes.
--
-- No FOREIGN KEY: same rationale as the other sync tables — remote apply
-- ordering may not be parent-first; the question_id link is enforced in code.
-- Cascade on question delete is handled in delete_question (code), not by SQL.
CREATE TABLE question_notes (
  id           TEXT PRIMARY KEY,                -- uuid v4
  question_id  TEXT NOT NULL,
  content      TEXT NOT NULL DEFAULT '',        -- Markdown
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  hlc          TEXT,                            -- sync LWW; nullable like question_links.hlc
  deleted_at   TEXT
);

CREATE INDEX idx_qnotes_question ON question_notes(question_id)
  WHERE deleted_at IS NULL;
