//! Questions — tracked research questions with lifecycle, plus polymorphic
//! links to resources / highlights / comments.
//!
//! Design notes
//! ------------
//! * `status` ∈ {"active", "archived"} is **orthogonal** to `deleted_at`.
//!   - Archiving a question DOES NOT touch its links (history is preserved).
//!   - Deleting a question soft-deletes all of its alive links.
//! * `question_links` is polymorphic by `target_type`. Reverse-cascade is
//!   triggered from `resources::delete_resource` / `highlights::delete_highlight`
//!   / `comments::delete_comment` via `cascade_soft_delete_for_target`.
//! * Per-link `reason` is optional Markdown — when present it is the "why is
//!   this relevant" note that an AI summarizer relies on.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::{now_iso8601, sync_log, DbError, SyncContext};

pub const STATUS_ACTIVE: &str = "active";
pub const STATUS_ARCHIVED: &str = "archived";

pub const TARGET_RESOURCE: &str = "resource";
pub const TARGET_HIGHLIGHT: &str = "highlight";
pub const TARGET_COMMENT: &str = "comment";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Question {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub status: String,
    pub archived_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionLink {
    pub id: String,
    pub question_id: String,
    pub target_type: String,
    pub target_id: String,
    pub reason: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

// ─── helpers ──────────────────────────────────────────────────────────────────

fn validate_target_type(t: &str) -> Result<(), DbError> {
    match t {
        TARGET_RESOURCE | TARGET_HIGHLIGHT | TARGET_COMMENT => Ok(()),
        other => Err(DbError::InvalidOperation(format!(
            "invalid target_type: {}",
            other
        ))),
    }
}

fn write_sync_log(
    conn: &Connection,
    sync_ctx: Option<&SyncContext>,
    entity_type: &str,
    entity_id: &str,
    operation: &str,
    payload: &str,
    hlc_str: Option<&str>,
) -> Result<(), DbError> {
    if let Some(ctx) = sync_ctx {
        sync_log::append(
            conn,
            entity_type,
            entity_id,
            operation,
            payload,
            hlc_str.unwrap_or(""),
            ctx.device_id,
        )?;
    }
    Ok(())
}

// ─── questions: CRUD ─────────────────────────────────────────────────────────

pub fn create_question(
    conn: &Connection,
    title: &str,
    description: Option<&str>,
    sync_ctx: Option<&SyncContext>,
) -> Result<Question, DbError> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso8601();
    let hlc_str = sync_ctx.map(|ctx| ctx.clock.tick().to_string());

    conn.execute(
        "INSERT INTO questions (id, title, description, status, created_at, updated_at, hlc)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)",
        params![id, title, description, STATUS_ACTIVE, now, hlc_str],
    )?;

    let question = Question {
        id,
        title: title.to_string(),
        description: description.map(|s| s.to_string()),
        status: STATUS_ACTIVE.to_string(),
        archived_at: None,
        created_at: now.clone(),
        updated_at: now,
    };

    if sync_ctx.is_some() {
        let payload = serde_json::to_string(&question)
            .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
        write_sync_log(
            conn,
            sync_ctx,
            "question",
            &question.id,
            "INSERT",
            &payload,
            hlc_str.as_deref(),
        )?;
    }

    // FTS index: best-effort, never fail the create on index trouble.
    let _ = super::search::rebuild_question_search_index(conn, &question.id);

    Ok(question)
}

pub fn update_question(
    conn: &Connection,
    id: &str,
    title: &str,
    description: Option<&str>,
    sync_ctx: Option<&SyncContext>,
) -> Result<(), DbError> {
    let now = now_iso8601();
    let hlc_str = sync_ctx.map(|ctx| ctx.clock.tick().to_string());
    let changed = conn.execute(
        "UPDATE questions
         SET title = ?1, description = ?2, updated_at = ?3, hlc = COALESCE(?4, hlc)
         WHERE id = ?5 AND deleted_at IS NULL",
        params![title, description, now, hlc_str, id],
    )?;
    if changed == 0 {
        return Err(DbError::NotFound(format!("question {}", id)));
    }

    if sync_ctx.is_some() {
        let q = get_question(conn, id)?;
        let payload = serde_json::to_string(&q)
            .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
        write_sync_log(
            conn,
            sync_ctx,
            "question",
            id,
            "UPDATE",
            &payload,
            hlc_str.as_deref(),
        )?;
    }

    let _ = super::search::rebuild_question_search_index(conn, id);

    Ok(())
}

pub fn archive_question(
    conn: &Connection,
    id: &str,
    sync_ctx: Option<&SyncContext>,
) -> Result<(), DbError> {
    let now = now_iso8601();
    let hlc_str = sync_ctx.map(|ctx| ctx.clock.tick().to_string());
    let changed = conn.execute(
        "UPDATE questions
         SET status = ?1, archived_at = ?2, updated_at = ?2, hlc = COALESCE(?3, hlc)
         WHERE id = ?4 AND deleted_at IS NULL AND status = ?5",
        params![STATUS_ARCHIVED, now, hlc_str, id, STATUS_ACTIVE],
    )?;
    if changed == 0 {
        // Distinguish "not found" vs "already archived"
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM questions WHERE id = ?1 AND deleted_at IS NULL",
                params![id],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if !exists {
            return Err(DbError::NotFound(format!("question {}", id)));
        }
        return Err(DbError::InvalidOperation(format!(
            "question {} is not active",
            id
        )));
    }

    if sync_ctx.is_some() {
        let q = get_question(conn, id)?;
        let payload = serde_json::to_string(&q)
            .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
        write_sync_log(
            conn,
            sync_ctx,
            "question",
            id,
            "UPDATE",
            &payload,
            hlc_str.as_deref(),
        )?;
    }

    Ok(())
}

pub fn unarchive_question(
    conn: &Connection,
    id: &str,
    sync_ctx: Option<&SyncContext>,
) -> Result<(), DbError> {
    let now = now_iso8601();
    let hlc_str = sync_ctx.map(|ctx| ctx.clock.tick().to_string());
    let changed = conn.execute(
        "UPDATE questions
         SET status = ?1, archived_at = NULL, updated_at = ?2, hlc = COALESCE(?3, hlc)
         WHERE id = ?4 AND deleted_at IS NULL AND status = ?5",
        params![STATUS_ACTIVE, now, hlc_str, id, STATUS_ARCHIVED],
    )?;
    if changed == 0 {
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM questions WHERE id = ?1 AND deleted_at IS NULL",
                params![id],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if !exists {
            return Err(DbError::NotFound(format!("question {}", id)));
        }
        return Err(DbError::InvalidOperation(format!(
            "question {} is not archived",
            id
        )));
    }

    if sync_ctx.is_some() {
        let q = get_question(conn, id)?;
        let payload = serde_json::to_string(&q)
            .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
        write_sync_log(
            conn,
            sync_ctx,
            "question",
            id,
            "UPDATE",
            &payload,
            hlc_str.as_deref(),
        )?;
    }

    Ok(())
}

pub fn delete_question(
    conn: &Connection,
    id: &str,
    sync_ctx: Option<&SyncContext>,
) -> Result<(), DbError> {
    // Serialize before soft-delete for sync log
    let question_before = if sync_ctx.is_some() {
        get_question(conn, id).ok()
    } else {
        None
    };

    let now = now_iso8601();
    let hlc_str = sync_ctx.map(|ctx| ctx.clock.tick().to_string());
    let changed = conn.execute(
        "UPDATE questions SET deleted_at = ?1, hlc = COALESCE(?2, hlc)
         WHERE id = ?3 AND deleted_at IS NULL",
        params![now, hlc_str, id],
    )?;
    if changed == 0 {
        return Err(DbError::NotFound(format!("question {}", id)));
    }

    // Cascade soft-delete to all alive links under this question. For sync
    // correctness we collect the link IDs first, then process each so we can
    // emit a sync_log row per link (matches the resource-delete pattern of
    // emitting one DELETE per child).
    let link_ids: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT id FROM question_links
             WHERE question_id = ?1 AND deleted_at IS NULL",
        )?;
        let collected = stmt
            .query_map(params![id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        collected
    };

    for link_id in &link_ids {
        let link_before = if sync_ctx.is_some() {
            get_link(conn, link_id).ok()
        } else {
            None
        };
        let link_hlc = sync_ctx.map(|ctx| ctx.clock.tick().to_string());
        conn.execute(
            "UPDATE question_links SET deleted_at = ?1, hlc = COALESCE(?2, hlc)
             WHERE id = ?3 AND deleted_at IS NULL",
            params![now, link_hlc, link_id],
        )?;
        if let Some(link) = link_before {
            let payload = serde_json::to_string(&link)
                .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
            write_sync_log(
                conn,
                sync_ctx,
                "question_link",
                link_id,
                "DELETE",
                &payload,
                link_hlc.as_deref(),
            )?;
        }
    }

    if let Some(q) = question_before {
        let payload = serde_json::to_string(&q)
            .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
        write_sync_log(
            conn,
            sync_ctx,
            "question",
            id,
            "DELETE",
            &payload,
            hlc_str.as_deref(),
        )?;
    }

    let _ = super::search::delete_question_search_index(conn, id);

    Ok(())
}

// ─── questions: queries ──────────────────────────────────────────────────────

pub fn get_question(conn: &Connection, id: &str) -> Result<Question, DbError> {
    conn.query_row(
        "SELECT id, title, description, status, archived_at, created_at, updated_at
         FROM questions WHERE id = ?1 AND deleted_at IS NULL",
        params![id],
        |row| {
            Ok(Question {
                id: row.get(0)?,
                title: row.get(1)?,
                description: row.get(2)?,
                status: row.get(3)?,
                archived_at: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        },
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => DbError::NotFound(format!("question {}", id)),
        other => DbError::Sqlite(other),
    })
}

fn row_to_question(row: &rusqlite::Row<'_>) -> rusqlite::Result<Question> {
    Ok(Question {
        id: row.get(0)?,
        title: row.get(1)?,
        description: row.get(2)?,
        status: row.get(3)?,
        archived_at: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

/// List questions, optionally filtered by status. Order: active first by
/// updated_at desc, then archived by archived_at desc.
pub fn list_questions(
    conn: &Connection,
    status: Option<&str>,
) -> Result<Vec<Question>, DbError> {
    let rows = if let Some(s) = status {
        let mut stmt = conn.prepare(
            "SELECT id, title, description, status, archived_at, created_at, updated_at
             FROM questions
             WHERE deleted_at IS NULL AND status = ?1
             ORDER BY CASE WHEN status = 'archived' THEN archived_at ELSE updated_at END DESC",
        )?;
        let collected = stmt
            .query_map(params![s], row_to_question)?
            .collect::<Result<Vec<_>, _>>()?;
        collected
    } else {
        let mut stmt = conn.prepare(
            "SELECT id, title, description, status, archived_at, created_at, updated_at
             FROM questions
             WHERE deleted_at IS NULL
             ORDER BY status ASC,
                      CASE WHEN status = 'archived' THEN archived_at ELSE updated_at END DESC",
        )?;
        let collected = stmt
            .query_map([], row_to_question)?
            .collect::<Result<Vec<_>, _>>()?;
        collected
    };
    Ok(rows)
}

// ─── question_links: CRUD ────────────────────────────────────────────────────

pub fn link(
    conn: &Connection,
    question_id: &str,
    target_type: &str,
    target_id: &str,
    reason: Option<&str>,
    sync_ctx: Option<&SyncContext>,
) -> Result<QuestionLink, DbError> {
    validate_target_type(target_type)?;

    // Verify the question is alive (links to deleted questions are nonsense).
    let q_alive: bool = conn
        .query_row(
            "SELECT 1 FROM questions WHERE id = ?1 AND deleted_at IS NULL",
            params![question_id],
            |_| Ok(true),
        )
        .unwrap_or(false);
    if !q_alive {
        return Err(DbError::NotFound(format!("question {}", question_id)));
    }

    // If an alive link already exists, return it unchanged (idempotent).
    if let Some(existing) =
        find_alive_link(conn, question_id, target_type, target_id)?
    {
        return Ok(existing);
    }

    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso8601();
    let hlc_str = sync_ctx.map(|ctx| ctx.clock.tick().to_string());

    conn.execute(
        "INSERT INTO question_links
            (id, question_id, target_type, target_id, reason, created_at, updated_at, hlc)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)",
        params![id, question_id, target_type, target_id, reason, now, hlc_str],
    )?;

    let link = QuestionLink {
        id,
        question_id: question_id.to_string(),
        target_type: target_type.to_string(),
        target_id: target_id.to_string(),
        reason: reason.map(|s| s.to_string()),
        created_at: now.clone(),
        updated_at: now,
    };

    if sync_ctx.is_some() {
        let payload = serde_json::to_string(&link)
            .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
        write_sync_log(
            conn,
            sync_ctx,
            "question_link",
            &link.id,
            "INSERT",
            &payload,
            hlc_str.as_deref(),
        )?;
    }

    Ok(link)
}

pub fn update_link_reason(
    conn: &Connection,
    link_id: &str,
    reason: Option<&str>,
    sync_ctx: Option<&SyncContext>,
) -> Result<(), DbError> {
    let now = now_iso8601();
    let hlc_str = sync_ctx.map(|ctx| ctx.clock.tick().to_string());
    let changed = conn.execute(
        "UPDATE question_links
         SET reason = ?1, updated_at = ?2, hlc = COALESCE(?3, hlc)
         WHERE id = ?4 AND deleted_at IS NULL",
        params![reason, now, hlc_str, link_id],
    )?;
    if changed == 0 {
        return Err(DbError::NotFound(format!("question_link {}", link_id)));
    }

    if sync_ctx.is_some() {
        let link = get_link(conn, link_id)?;
        let payload = serde_json::to_string(&link)
            .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
        write_sync_log(
            conn,
            sync_ctx,
            "question_link",
            link_id,
            "UPDATE",
            &payload,
            hlc_str.as_deref(),
        )?;
    }

    Ok(())
}

pub fn unlink(
    conn: &Connection,
    link_id: &str,
    sync_ctx: Option<&SyncContext>,
) -> Result<(), DbError> {
    let link_before = if sync_ctx.is_some() {
        get_link(conn, link_id).ok()
    } else {
        None
    };

    let now = now_iso8601();
    let hlc_str = sync_ctx.map(|ctx| ctx.clock.tick().to_string());
    let changed = conn.execute(
        "UPDATE question_links SET deleted_at = ?1, hlc = COALESCE(?2, hlc)
         WHERE id = ?3 AND deleted_at IS NULL",
        params![now, hlc_str, link_id],
    )?;
    if changed == 0 {
        return Err(DbError::NotFound(format!("question_link {}", link_id)));
    }

    if let Some(link) = link_before {
        let payload = serde_json::to_string(&link)
            .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
        write_sync_log(
            conn,
            sync_ctx,
            "question_link",
            link_id,
            "DELETE",
            &payload,
            hlc_str.as_deref(),
        )?;
    }

    Ok(())
}

// ─── question_links: queries ─────────────────────────────────────────────────

pub fn get_link(conn: &Connection, link_id: &str) -> Result<QuestionLink, DbError> {
    conn.query_row(
        "SELECT id, question_id, target_type, target_id, reason, created_at, updated_at
         FROM question_links WHERE id = ?1 AND deleted_at IS NULL",
        params![link_id],
        |row| {
            Ok(QuestionLink {
                id: row.get(0)?,
                question_id: row.get(1)?,
                target_type: row.get(2)?,
                target_id: row.get(3)?,
                reason: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        },
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => DbError::NotFound(format!("question_link {}", link_id)),
        other => DbError::Sqlite(other),
    })
}

fn find_alive_link(
    conn: &Connection,
    question_id: &str,
    target_type: &str,
    target_id: &str,
) -> Result<Option<QuestionLink>, DbError> {
    let result = conn.query_row(
        "SELECT id, question_id, target_type, target_id, reason, created_at, updated_at
         FROM question_links
         WHERE question_id = ?1 AND target_type = ?2 AND target_id = ?3
           AND deleted_at IS NULL",
        params![question_id, target_type, target_id],
        |row| {
            Ok(QuestionLink {
                id: row.get(0)?,
                question_id: row.get(1)?,
                target_type: row.get(2)?,
                target_id: row.get(3)?,
                reason: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        },
    );
    match result {
        Ok(link) => Ok(Some(link)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(DbError::Sqlite(e)),
    }
}

/// All alive links for a question, in creation order.
pub fn list_links_for_question(
    conn: &Connection,
    question_id: &str,
) -> Result<Vec<QuestionLink>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT id, question_id, target_type, target_id, reason, created_at, updated_at
         FROM question_links
         WHERE question_id = ?1 AND deleted_at IS NULL
         ORDER BY created_at ASC",
    )?;
    let rows = stmt
        .query_map(params![question_id], |row| {
            Ok(QuestionLink {
                id: row.get(0)?,
                question_id: row.get(1)?,
                target_type: row.get(2)?,
                target_id: row.get(3)?,
                reason: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Reverse lookup: which alive questions reference this target?
/// Only questions still alive are returned; status (active/archived) is
/// preserved in the result so callers can filter.
pub fn list_questions_for_target(
    conn: &Connection,
    target_type: &str,
    target_id: &str,
) -> Result<Vec<Question>, DbError> {
    validate_target_type(target_type)?;
    let mut stmt = conn.prepare(
        "SELECT q.id, q.title, q.description, q.status, q.archived_at,
                q.created_at, q.updated_at
         FROM questions q
         JOIN question_links ql ON ql.question_id = q.id
         WHERE ql.target_type = ?1 AND ql.target_id = ?2
           AND q.deleted_at IS NULL AND ql.deleted_at IS NULL
         ORDER BY q.updated_at DESC",
    )?;
    let rows = stmt
        .query_map(params![target_type, target_id], |row| {
            Ok(Question {
                id: row.get(0)?,
                title: row.get(1)?,
                description: row.get(2)?,
                status: row.get(3)?,
                archived_at: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Batch reverse lookup keyed by resource_id (Phase 2 PreviewPanel / list view).
pub fn list_questions_for_resources(
    conn: &Connection,
    resource_ids: &[String],
) -> Result<std::collections::HashMap<String, Vec<Question>>, DbError> {
    if resource_ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let placeholders: Vec<String> = resource_ids
        .iter()
        .enumerate()
        .map(|(i, _)| format!("?{}", i + 2))
        .collect();
    let sql = format!(
        "SELECT ql.target_id, q.id, q.title, q.description, q.status, q.archived_at,
                q.created_at, q.updated_at
         FROM questions q
         JOIN question_links ql ON ql.question_id = q.id
         WHERE ql.target_type = ?1 AND ql.target_id IN ({})
           AND q.deleted_at IS NULL AND ql.deleted_at IS NULL
         ORDER BY q.updated_at DESC",
        placeholders.join(", ")
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut params: Vec<&dyn rusqlite::types::ToSql> = Vec::with_capacity(resource_ids.len() + 1);
    let target_type = TARGET_RESOURCE;
    params.push(&target_type as &dyn rusqlite::types::ToSql);
    for id in resource_ids {
        params.push(id as &dyn rusqlite::types::ToSql);
    }
    let rows = stmt.query_map(params.as_slice(), |row| {
        Ok((
            row.get::<_, String>(0)?,
            Question {
                id: row.get(1)?,
                title: row.get(2)?,
                description: row.get(3)?,
                status: row.get(4)?,
                archived_at: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            },
        ))
    })?;
    let mut map: std::collections::HashMap<String, Vec<Question>> =
        std::collections::HashMap::new();
    for row in rows {
        let (target_id, q) = row?;
        map.entry(target_id).or_default().push(q);
    }
    Ok(map)
}

// ─── cascade (called by resources / highlights / comments on soft-delete) ────

/// Soft-delete every alive link whose target matches the given (type, id),
/// and emit one sync_log DELETE per link when a SyncContext is provided.
///
/// Called from `resources::delete_resource`, `highlights::delete_highlight`,
/// and `comments::delete_comment`. The caller is expected to run inside the
/// same DB transaction / connection as the parent delete.
pub fn cascade_soft_delete_for_target(
    conn: &Connection,
    target_type: &str,
    target_id: &str,
    sync_ctx: Option<&SyncContext>,
) -> Result<usize, DbError> {
    validate_target_type(target_type)?;

    let link_ids: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT id FROM question_links
             WHERE target_type = ?1 AND target_id = ?2 AND deleted_at IS NULL",
        )?;
        let collected = stmt
            .query_map(params![target_type, target_id], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        collected
    };

    if link_ids.is_empty() {
        return Ok(0);
    }

    let now = now_iso8601();
    for link_id in &link_ids {
        let link_before = if sync_ctx.is_some() {
            get_link(conn, link_id).ok()
        } else {
            None
        };
        let hlc_str = sync_ctx.map(|ctx| ctx.clock.tick().to_string());
        conn.execute(
            "UPDATE question_links SET deleted_at = ?1, hlc = COALESCE(?2, hlc)
             WHERE id = ?3 AND deleted_at IS NULL",
            params![now, hlc_str, link_id],
        )?;
        if let Some(link) = link_before {
            let payload = serde_json::to_string(&link)
                .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
            write_sync_log(
                conn,
                sync_ctx,
                "question_link",
                link_id,
                "DELETE",
                &payload,
                hlc_str.as_deref(),
            )?;
        }
    }

    Ok(link_ids.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{comments, folders, highlights, hlc::HlcClock, resources, test_db};

    fn ctx_for_device(device_id: &'static str) -> (HlcClock, &'static str) {
        (HlcClock::new(device_id.to_string()), device_id)
    }

    fn setup_resource(conn: &Connection) -> resources::Resource {
        let folder = folders::create_folder(conn, "docs", "__root__", None).unwrap();
        resources::create_resource(
            conn,
            resources::CreateResourceInput {
                id: None,
                title: "test".to_string(),
                url: "https://example.com".to_string(),
                domain: None,
                author: None,
                description: None,
                folder_id: folder.id,
                resource_type: "webpage".to_string(),
                file_path: "x".to_string(),
                captured_at: "2026-01-01T00:00:00Z".to_string(),
                selection_meta: None,
            },
            None,
        )
        .unwrap()
    }

    fn make_highlight(conn: &Connection, resource_id: &str) -> highlights::Highlight {
        let anchor = serde_json::json!({
            "text_position": { "start": 0, "end": 5 },
            "text_quote": { "exact": "hello", "prefix": "", "suffix": "" }
        });
        highlights::create_highlight(conn, resource_id, "hello", &anchor, "#FFFF00", None)
            .unwrap()
    }

    #[test]
    fn test_create_and_list_question() {
        let conn = test_db();
        let q = create_question(&conn, "可观测性", Some("微服务体系下"), None).unwrap();
        assert_eq!(q.title, "可观测性");
        assert_eq!(q.status, STATUS_ACTIVE);
        assert!(q.archived_at.is_none());

        let all = list_questions(&conn, None).unwrap();
        assert_eq!(all.len(), 1);
        let active = list_questions(&conn, Some(STATUS_ACTIVE)).unwrap();
        assert_eq!(active.len(), 1);
        let archived = list_questions(&conn, Some(STATUS_ARCHIVED)).unwrap();
        assert!(archived.is_empty());
    }

    #[test]
    fn test_update_question() {
        let conn = test_db();
        let q = create_question(&conn, "old title", None, None).unwrap();
        update_question(&conn, &q.id, "new title", Some("new desc"), None).unwrap();
        let fetched = get_question(&conn, &q.id).unwrap();
        assert_eq!(fetched.title, "new title");
        assert_eq!(fetched.description.as_deref(), Some("new desc"));
    }

    #[test]
    fn test_archive_unarchive() {
        let conn = test_db();
        let q = create_question(&conn, "Q", None, None).unwrap();

        archive_question(&conn, &q.id, None).unwrap();
        let fetched = get_question(&conn, &q.id).unwrap();
        assert_eq!(fetched.status, STATUS_ARCHIVED);
        assert!(fetched.archived_at.is_some());

        // Second archive should fail (not currently active)
        let err = archive_question(&conn, &q.id, None).unwrap_err();
        matches!(err, DbError::InvalidOperation(_));

        unarchive_question(&conn, &q.id, None).unwrap();
        let fetched = get_question(&conn, &q.id).unwrap();
        assert_eq!(fetched.status, STATUS_ACTIVE);
        assert!(fetched.archived_at.is_none());
    }

    #[test]
    fn test_archive_does_not_cascade_links() {
        let conn = test_db();
        let resource = setup_resource(&conn);
        let q = create_question(&conn, "Q", None, None).unwrap();
        link(&conn, &q.id, TARGET_RESOURCE, &resource.id, None, None).unwrap();

        archive_question(&conn, &q.id, None).unwrap();

        // Links must still be alive after archive
        let links = list_links_for_question(&conn, &q.id).unwrap();
        assert_eq!(links.len(), 1);
        let qs = list_questions_for_target(&conn, TARGET_RESOURCE, &resource.id).unwrap();
        assert_eq!(qs.len(), 1, "archived question should still appear in reverse lookup");
    }

    #[test]
    fn test_link_and_unlink() {
        let conn = test_db();
        let resource = setup_resource(&conn);
        let q = create_question(&conn, "Q", None, None).unwrap();

        let lnk = link(
            &conn,
            &q.id,
            TARGET_RESOURCE,
            &resource.id,
            Some("初步线索"),
            None,
        )
        .unwrap();
        assert_eq!(lnk.reason.as_deref(), Some("初步线索"));

        let links = list_links_for_question(&conn, &q.id).unwrap();
        assert_eq!(links.len(), 1);

        unlink(&conn, &lnk.id, None).unwrap();
        assert!(list_links_for_question(&conn, &q.id).unwrap().is_empty());
    }

    #[test]
    fn test_link_idempotent_for_alive_pair() {
        let conn = test_db();
        let resource = setup_resource(&conn);
        let q = create_question(&conn, "Q", None, None).unwrap();

        let a = link(&conn, &q.id, TARGET_RESOURCE, &resource.id, None, None).unwrap();
        let b = link(&conn, &q.id, TARGET_RESOURCE, &resource.id, Some("ignored"), None)
            .unwrap();
        assert_eq!(a.id, b.id, "second link should return the existing alive link");
        // Reason must remain whatever was set originally — link() does not update it.
        assert!(b.reason.is_none());
    }

    #[test]
    fn test_relink_after_unlink_creates_new_row() {
        let conn = test_db();
        let resource = setup_resource(&conn);
        let q = create_question(&conn, "Q", None, None).unwrap();

        let first = link(&conn, &q.id, TARGET_RESOURCE, &resource.id, None, None).unwrap();
        unlink(&conn, &first.id, None).unwrap();
        let second = link(&conn, &q.id, TARGET_RESOURCE, &resource.id, None, None).unwrap();
        assert_ne!(first.id, second.id);
    }

    #[test]
    fn test_update_link_reason() {
        let conn = test_db();
        let resource = setup_resource(&conn);
        let q = create_question(&conn, "Q", None, None).unwrap();
        let lnk = link(&conn, &q.id, TARGET_RESOURCE, &resource.id, None, None).unwrap();

        update_link_reason(&conn, &lnk.id, Some("新的理由"), None).unwrap();
        let fetched = get_link(&conn, &lnk.id).unwrap();
        assert_eq!(fetched.reason.as_deref(), Some("新的理由"));

        update_link_reason(&conn, &lnk.id, None, None).unwrap();
        let cleared = get_link(&conn, &lnk.id).unwrap();
        assert!(cleared.reason.is_none());
    }

    #[test]
    fn test_invalid_target_type_rejected() {
        let conn = test_db();
        let q = create_question(&conn, "Q", None, None).unwrap();
        let err = link(&conn, &q.id, "bogus", "x", None, None).unwrap_err();
        matches!(err, DbError::InvalidOperation(_));
    }

    #[test]
    fn test_link_to_missing_question_rejected() {
        let conn = test_db();
        let resource = setup_resource(&conn);
        let err = link(&conn, "no-such-q", TARGET_RESOURCE, &resource.id, None, None)
            .unwrap_err();
        matches!(err, DbError::NotFound(_));
    }

    #[test]
    fn test_delete_question_cascades_links() {
        let conn = test_db();
        let resource = setup_resource(&conn);
        let q = create_question(&conn, "Q", None, None).unwrap();
        link(&conn, &q.id, TARGET_RESOURCE, &resource.id, None, None).unwrap();

        delete_question(&conn, &q.id, None).unwrap();
        assert!(list_links_for_question(&conn, &q.id).unwrap().is_empty());
        assert!(list_questions_for_target(&conn, TARGET_RESOURCE, &resource.id)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn test_cascade_from_target_soft_delete() {
        let conn = test_db();
        let resource = setup_resource(&conn);
        let hl = make_highlight(&conn, &resource.id);
        let q = create_question(&conn, "Q", None, None).unwrap();
        link(&conn, &q.id, TARGET_HIGHLIGHT, &hl.id, None, None).unwrap();
        link(&conn, &q.id, TARGET_RESOURCE, &resource.id, None, None).unwrap();

        // Simulate the caller invoking the cascade helper directly.
        let n = cascade_soft_delete_for_target(&conn, TARGET_HIGHLIGHT, &hl.id, None).unwrap();
        assert_eq!(n, 1);
        let remaining = list_links_for_question(&conn, &q.id).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].target_type, TARGET_RESOURCE);
    }

    #[test]
    fn test_reverse_lookup_multi() {
        let conn = test_db();
        let r1 = setup_resource(&conn);
        let r2 = {
            let folder = folders::create_folder(&conn, "docs2", "__root__", None).unwrap();
            resources::create_resource(
                &conn,
                resources::CreateResourceInput {
                    id: None,
                    title: "r2".to_string(),
                    url: "https://b.com".to_string(),
                    domain: None,
                    author: None,
                    description: None,
                    folder_id: folder.id,
                    resource_type: "webpage".to_string(),
                    file_path: "y".to_string(),
                    captured_at: "2026-01-01T00:00:00Z".to_string(),
                    selection_meta: None,
                },
                None,
            )
            .unwrap()
        };

        let q1 = create_question(&conn, "Q1", None, None).unwrap();
        let q2 = create_question(&conn, "Q2", None, None).unwrap();
        link(&conn, &q1.id, TARGET_RESOURCE, &r1.id, None, None).unwrap();
        link(&conn, &q2.id, TARGET_RESOURCE, &r1.id, None, None).unwrap();
        link(&conn, &q2.id, TARGET_RESOURCE, &r2.id, None, None).unwrap();

        let map = list_questions_for_resources(&conn, &[r1.id.clone(), r2.id.clone()])
            .unwrap();
        assert_eq!(map.get(&r1.id).map(|v| v.len()).unwrap_or(0), 2);
        assert_eq!(map.get(&r2.id).map(|v| v.len()).unwrap_or(0), 1);
    }

    #[test]
    fn test_sync_log_emissions_basic() {
        let conn = test_db();
        let (clock, device_id) = ctx_for_device("dev-A");
        let ctx = SyncContext { clock: &clock, device_id };

        let resource = setup_resource(&conn);

        let q = create_question(&conn, "Q", Some("d"), Some(&ctx)).unwrap();
        let lnk = link(&conn, &q.id, TARGET_RESOURCE, &resource.id, Some("why"), Some(&ctx))
            .unwrap();
        update_link_reason(&conn, &lnk.id, Some("revised"), Some(&ctx)).unwrap();
        unlink(&conn, &lnk.id, Some(&ctx)).unwrap();
        archive_question(&conn, &q.id, Some(&ctx)).unwrap();
        unarchive_question(&conn, &q.id, Some(&ctx)).unwrap();

        let pending = sync_log::get_pending(&conn).unwrap();
        let kinds: Vec<(String, String)> = pending
            .iter()
            .map(|e| (e.entity_type.clone(), e.operation.clone()))
            .collect();
        assert!(kinds.contains(&("question".to_string(), "INSERT".to_string())));
        assert!(kinds.contains(&("question_link".to_string(), "INSERT".to_string())));
        assert!(kinds.contains(&("question_link".to_string(), "UPDATE".to_string())));
        assert!(kinds.contains(&("question_link".to_string(), "DELETE".to_string())));
        // archive + unarchive are encoded as question UPDATEs
        let question_updates = kinds
            .iter()
            .filter(|(t, op)| t == "question" && op == "UPDATE")
            .count();
        assert!(question_updates >= 2);
    }

    #[test]
    fn test_delete_question_emits_link_delete_logs() {
        let conn = test_db();
        let (clock, device_id) = ctx_for_device("dev-A");
        let ctx = SyncContext { clock: &clock, device_id };
        let resource = setup_resource(&conn);
        let hl = make_highlight(&conn, &resource.id);

        let q = create_question(&conn, "Q", None, Some(&ctx)).unwrap();
        link(&conn, &q.id, TARGET_RESOURCE, &resource.id, None, Some(&ctx)).unwrap();
        link(&conn, &q.id, TARGET_HIGHLIGHT, &hl.id, None, Some(&ctx)).unwrap();

        delete_question(&conn, &q.id, Some(&ctx)).unwrap();

        let pending = sync_log::get_pending(&conn).unwrap();
        let link_deletes = pending
            .iter()
            .filter(|e| e.entity_type == "question_link" && e.operation == "DELETE")
            .count();
        assert_eq!(link_deletes, 2, "one DELETE log per cascaded link");
        let q_deletes = pending
            .iter()
            .filter(|e| e.entity_type == "question" && e.operation == "DELETE")
            .count();
        assert_eq!(q_deletes, 1);
    }

    #[test]
    fn test_cascade_via_resource_delete() {
        // Real path: resources::delete_resource → questions::cascade_*
        let conn = test_db();
        let resource = setup_resource(&conn);
        let q = create_question(&conn, "Q", None, None).unwrap();
        link(&conn, &q.id, TARGET_RESOURCE, &resource.id, None, None).unwrap();

        resources::delete_resource(&conn, &resource.id, None).unwrap();
        assert!(list_links_for_question(&conn, &q.id).unwrap().is_empty());
    }

    #[test]
    fn test_cascade_via_highlight_delete() {
        // Real path: highlights::delete_highlight → questions::cascade_*
        let conn = test_db();
        let resource = setup_resource(&conn);
        let hl = make_highlight(&conn, &resource.id);
        let q = create_question(&conn, "Q", None, None).unwrap();
        link(&conn, &q.id, TARGET_HIGHLIGHT, &hl.id, None, None).unwrap();

        highlights::delete_highlight(&conn, &hl.id, None).unwrap();
        assert!(list_links_for_question(&conn, &q.id).unwrap().is_empty());
    }

    #[test]
    fn test_cascade_via_comment_delete() {
        // Real path: comments::delete_comment → questions::cascade_*
        let conn = test_db();
        let resource = setup_resource(&conn);
        let comment =
            comments::create_comment(&conn, &resource.id, None, "note", None).unwrap();
        let q = create_question(&conn, "Q", None, None).unwrap();
        link(&conn, &q.id, TARGET_COMMENT, &comment.id, None, None).unwrap();

        comments::delete_comment(&conn, &comment.id, None).unwrap();
        assert!(list_links_for_question(&conn, &q.id).unwrap().is_empty());
    }

    #[test]
    fn test_cascade_from_comment_soft_delete() {
        let conn = test_db();
        let resource = setup_resource(&conn);
        let comment = comments::create_comment(&conn, &resource.id, None, "note", None).unwrap();
        let q = create_question(&conn, "Q", None, None).unwrap();
        link(&conn, &q.id, TARGET_COMMENT, &comment.id, None, None).unwrap();

        cascade_soft_delete_for_target(&conn, TARGET_COMMENT, &comment.id, None).unwrap();
        assert!(list_links_for_question(&conn, &q.id).unwrap().is_empty());
    }

    #[test]
    fn test_hlc_monotonic_within_sync_ctx() {
        let conn = test_db();
        let (clock, device_id) = ctx_for_device("dev-A");
        let ctx = SyncContext { clock: &clock, device_id };

        let q = create_question(&conn, "Q", None, Some(&ctx)).unwrap();
        update_question(&conn, &q.id, "Q2", None, Some(&ctx)).unwrap();
        archive_question(&conn, &q.id, Some(&ctx)).unwrap();

        let pending = sync_log::get_pending(&conn).unwrap();
        let hlcs: Vec<&str> = pending.iter().map(|e| e.hlc.as_str()).collect();
        for w in hlcs.windows(2) {
            assert!(w[0] < w[1], "HLC must be strictly increasing: {:?}", w);
        }
    }
}
