-- Questions: tracked research questions with lifecycle.
-- `status` is orthogonal to `deleted_at`:
--   - status = 'active' | 'archived' (user-facing lifecycle)
--   - deleted_at = NULL | <ts>      (system-level soft delete)
-- Archiving a question DOES NOT cascade to question_links; deletion DOES.
CREATE TABLE questions (
  id           TEXT PRIMARY KEY,                -- uuid v4
  title        TEXT NOT NULL,
  description  TEXT,                            -- Markdown, nullable
  status       TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'archived'
  archived_at  TEXT,                            -- ISO8601, set when status='archived'
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  hlc          TEXT,                            -- sync LWW; nullable like tags.hlc
  deleted_at   TEXT
);
CREATE INDEX idx_questions_status ON questions(status) WHERE deleted_at IS NULL;

-- Question links: polymorphic many-to-many with optional per-link reason.
-- target_type ∈ {'resource', 'highlight', 'comment'}.
-- Resource-level note is stored as resources.description, so it is covered
-- by target_type='resource' (no separate 'note' type).
-- No FOREIGN KEY: same rationale as sync tables — apply ordering may not be
-- parent-first when receiving remote changes; cascade is enforced in code.
CREATE TABLE question_links (
  id            TEXT PRIMARY KEY,               -- uuid v4
  question_id   TEXT NOT NULL,
  target_type   TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  reason        TEXT,                           -- Markdown, nullable
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  hlc           TEXT,
  deleted_at    TEXT
);

-- Only one alive link per (question, target). Soft-deleted rows are excluded,
-- so "delete then re-link" is allowed and produces a new row.
CREATE UNIQUE INDEX idx_qlinks_unique_alive
  ON question_links(question_id, target_type, target_id)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_qlinks_question ON question_links(question_id)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_qlinks_target   ON question_links(target_type, target_id)
  WHERE deleted_at IS NULL;
