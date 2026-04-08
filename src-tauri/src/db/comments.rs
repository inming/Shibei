use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::{now_iso8601, DbError};
use crate::sync::{self, SyncContext};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Comment {
    pub id: String,
    pub highlight_id: Option<String>,
    pub resource_id: String,
    pub content: String,
    pub created_at: String,
    pub updated_at: String,
}

pub fn create_comment(
    conn: &Connection,
    resource_id: &str,
    highlight_id: Option<&str>,
    content: &str,
    sync_ctx: Option<&SyncContext>,
) -> Result<Comment, DbError> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso8601();
    let hlc_str = sync_ctx.map(|ctx| ctx.clock.tick().to_string());

    conn.execute(
        "INSERT INTO comments (id, highlight_id, resource_id, content, created_at, updated_at, hlc)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, highlight_id, resource_id, content, now, now, hlc_str],
    )?;

    let comment = Comment {
        id,
        highlight_id: highlight_id.map(|s| s.to_string()),
        resource_id: resource_id.to_string(),
        content: content.to_string(),
        created_at: now.clone(),
        updated_at: now,
    };

    if let Some(ctx) = sync_ctx {
        let payload = serde_json::to_string(&comment)
            .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
        sync::sync_log::append(
            conn,
            "comment",
            &comment.id,
            "INSERT",
            &payload,
            hlc_str.as_deref().unwrap_or(""),
            ctx.device_id,
        )?;
    }

    let _ = super::search::rebuild_search_index(conn, resource_id);

    Ok(comment)
}

pub fn update_comment(
    conn: &Connection,
    id: &str,
    content: &str,
    sync_ctx: Option<&SyncContext>,
) -> Result<(), DbError> {
    let now = now_iso8601();
    let fts_resource_id: Option<String> = conn
        .query_row(
            "SELECT resource_id FROM comments WHERE id = ?1 AND deleted_at IS NULL",
            params![id],
            |row| row.get(0),
        )
        .ok();
    let hlc_str = sync_ctx.map(|ctx| ctx.clock.tick().to_string());
    let changed = conn.execute(
        "UPDATE comments SET content = ?1, updated_at = ?2, hlc = COALESCE(?3, hlc) WHERE id = ?4 AND deleted_at IS NULL",
        params![content, now, hlc_str, id],
    )?;
    if changed == 0 {
        return Err(DbError::NotFound(format!("comment {}", id)));
    }

    if let Some(ctx) = sync_ctx {
        let comment = get_comment_by_id(conn, id)?;
        let payload = serde_json::to_string(&comment)
            .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
        sync::sync_log::append(
            conn,
            "comment",
            id,
            "UPDATE",
            &payload,
            hlc_str.as_deref().unwrap_or(""),
            ctx.device_id,
        )?;
    }

    if let Some(ref rid) = fts_resource_id {
        let _ = super::search::rebuild_search_index(conn, rid);
    }

    Ok(())
}

pub fn delete_comment(
    conn: &Connection,
    id: &str,
    sync_ctx: Option<&SyncContext>,
) -> Result<(), DbError> {
    let fts_resource_id: Option<String> = conn
        .query_row(
            "SELECT resource_id FROM comments WHERE id = ?1 AND deleted_at IS NULL",
            params![id],
            |row| row.get(0),
        )
        .ok();

    // Serialize before soft-delete
    let comment_before = if sync_ctx.is_some() {
        get_comment_by_id(conn, id).ok()
    } else {
        None
    };

    let now = now_iso8601();
    let hlc_str = sync_ctx.map(|ctx| ctx.clock.tick().to_string());
    let changed = conn.execute(
        "UPDATE comments SET deleted_at = ?1, hlc = COALESCE(?2, hlc) WHERE id = ?3 AND deleted_at IS NULL",
        params![now, hlc_str, id],
    )?;
    if changed == 0 {
        return Err(DbError::NotFound(format!("comment {}", id)));
    }

    if let Some(ctx) = sync_ctx {
        if let Some(comment) = comment_before {
            let payload = serde_json::to_string(&comment)
                .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
            sync::sync_log::append(
                conn,
                "comment",
                id,
                "DELETE",
                &payload,
                hlc_str.as_deref().unwrap_or(""),
                ctx.device_id,
            )?;
        }
    }

    if let Some(ref rid) = fts_resource_id {
        let _ = super::search::rebuild_search_index(conn, rid);
    }

    Ok(())
}

pub fn get_comment_by_id(conn: &Connection, id: &str) -> Result<Comment, DbError> {
    conn.query_row(
        "SELECT id, highlight_id, resource_id, content, created_at, updated_at
         FROM comments WHERE id = ?1 AND deleted_at IS NULL",
        params![id],
        |row| {
            Ok(Comment {
                id: row.get(0)?,
                highlight_id: row.get(1)?,
                resource_id: row.get(2)?,
                content: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        },
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => DbError::NotFound(format!("comment {}", id)),
        other => DbError::Sqlite(other),
    })
}

pub fn get_comments_for_resource(
    conn: &Connection,
    resource_id: &str,
) -> Result<Vec<Comment>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT id, highlight_id, resource_id, content, created_at, updated_at
         FROM comments WHERE resource_id = ?1 AND deleted_at IS NULL
         ORDER BY created_at",
    )?;
    let comments = stmt
        .query_map(params![resource_id], |row| {
            Ok(Comment {
                id: row.get(0)?,
                highlight_id: row.get(1)?,
                resource_id: row.get(2)?,
                content: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(comments)
}

/// List comment IDs that were soft-deleted for a resource (for restore sync).
pub fn list_deleted_comment_ids_for_resource(
    conn: &Connection,
    resource_id: &str,
) -> Result<Vec<String>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT id FROM comments WHERE resource_id = ?1 AND deleted_at IS NOT NULL",
    )?;
    let ids = stmt
        .query_map(params![resource_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ids)
}

#[allow(dead_code)]
pub fn get_comments_for_highlight(
    conn: &Connection,
    highlight_id: &str,
) -> Result<Vec<Comment>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT id, highlight_id, resource_id, content, created_at, updated_at
         FROM comments WHERE highlight_id = ?1 AND deleted_at IS NULL
         ORDER BY created_at",
    )?;
    let comments = stmt
        .query_map(params![highlight_id], |row| {
            Ok(Comment {
                id: row.get(0)?,
                highlight_id: row.get(1)?,
                resource_id: row.get(2)?,
                content: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(comments)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{folders, highlights, resources, test_db};

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
                captured_at: "2026-01-01".to_string(),
                selection_meta: None,
            },
            None,
        )
        .unwrap()
    }

    #[test]
    fn test_create_comment_on_highlight() {
        let conn = test_db();
        let resource = setup_resource(&conn);
        let anchor = highlights::Anchor {
            text_position: highlights::TextPosition { start: 0, end: 10 },
            text_quote: highlights::TextQuote {
                exact: "test".to_string(),
                prefix: "".to_string(),
                suffix: "".to_string(),
            },
        };
        let hl = highlights::create_highlight(&conn, &resource.id, "test", &anchor, "#FF0", None).unwrap();

        let comment = create_comment(&conn, &resource.id, Some(&hl.id), "great insight", None).unwrap();
        assert_eq!(comment.content, "great insight");
        assert_eq!(comment.highlight_id.as_deref(), Some(hl.id.as_str()));
    }

    #[test]
    fn test_create_resource_level_note() {
        let conn = test_db();
        let resource = setup_resource(&conn);

        let comment = create_comment(&conn, &resource.id, None, "general note", None).unwrap();
        assert!(comment.highlight_id.is_none());
    }

    #[test]
    fn test_update_comment() {
        let conn = test_db();
        let resource = setup_resource(&conn);
        let comment = create_comment(&conn, &resource.id, None, "old", None).unwrap();

        update_comment(&conn, &comment.id, "new content", None).unwrap();

        let comments = get_comments_for_resource(&conn, &resource.id).unwrap();
        assert_eq!(comments[0].content, "new content");
    }

    #[test]
    fn test_delete_comment() {
        let conn = test_db();
        let resource = setup_resource(&conn);
        let comment = create_comment(&conn, &resource.id, None, "temp", None).unwrap();

        delete_comment(&conn, &comment.id, None).unwrap();

        let comments = get_comments_for_resource(&conn, &resource.id).unwrap();
        assert!(comments.is_empty());
    }

    #[test]
    fn test_get_comments_for_highlight() {
        let conn = test_db();
        let resource = setup_resource(&conn);
        let anchor = highlights::Anchor {
            text_position: highlights::TextPosition { start: 0, end: 10 },
            text_quote: highlights::TextQuote {
                exact: "test".to_string(),
                prefix: "".to_string(),
                suffix: "".to_string(),
            },
        };
        let hl = highlights::create_highlight(&conn, &resource.id, "test", &anchor, "#FF0", None).unwrap();

        create_comment(&conn, &resource.id, Some(&hl.id), "comment 1", None).unwrap();
        create_comment(&conn, &resource.id, Some(&hl.id), "comment 2", None).unwrap();
        create_comment(&conn, &resource.id, None, "resource note", None).unwrap();

        let hl_comments = get_comments_for_highlight(&conn, &hl.id).unwrap();
        assert_eq!(hl_comments.len(), 2);

        let all_comments = get_comments_for_resource(&conn, &resource.id).unwrap();
        assert_eq!(all_comments.len(), 3);
    }

    #[test]
    fn test_delete_comment_keeps_highlight() {
        let conn = test_db();
        let resource = setup_resource(&conn);
        let anchor = highlights::Anchor {
            text_position: highlights::TextPosition { start: 0, end: 10 },
            text_quote: highlights::TextQuote {
                exact: "test".to_string(),
                prefix: "".to_string(),
                suffix: "".to_string(),
            },
        };
        let hl = highlights::create_highlight(&conn, &resource.id, "test", &anchor, "#FF0", None).unwrap();
        let comment = create_comment(&conn, &resource.id, Some(&hl.id), "note", None).unwrap();

        delete_comment(&conn, &comment.id, None).unwrap();

        // Highlight should still exist
        let highlights = highlights::get_highlights_for_resource(&conn, &resource.id).unwrap();
        assert_eq!(highlights.len(), 1);
    }
}
