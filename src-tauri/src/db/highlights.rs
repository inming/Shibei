use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::{now_iso8601, DbError};
use crate::sync::{self, SyncContext};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextPosition {
    pub start: u64,
    pub end: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextQuote {
    pub exact: String,
    pub prefix: String,
    pub suffix: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Anchor {
    pub text_position: TextPosition,
    pub text_quote: TextQuote,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Highlight {
    pub id: String,
    pub resource_id: String,
    pub text_content: String,
    pub anchor: Anchor,
    pub color: String,
    pub created_at: String,
}

pub fn create_highlight(
    conn: &Connection,
    resource_id: &str,
    text_content: &str,
    anchor: &Anchor,
    color: &str,
    sync_ctx: Option<&SyncContext>,
) -> Result<Highlight, DbError> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso8601();
    let hlc_str = sync_ctx.map(|ctx| ctx.clock.tick().to_string());
    let anchor_json = serde_json::to_string(anchor)
        .map_err(|e| DbError::InvalidOperation(format!("anchor serialization failed: {}", e)))?;

    conn.execute(
        "INSERT INTO highlights (id, resource_id, text_content, anchor, color, created_at, hlc)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, resource_id, text_content, anchor_json, color, now, hlc_str],
    )?;

    let highlight = Highlight {
        id,
        resource_id: resource_id.to_string(),
        text_content: text_content.to_string(),
        anchor: anchor.clone(),
        color: color.to_string(),
        created_at: now,
    };

    if let Some(ctx) = sync_ctx {
        let payload = serde_json::to_string(&highlight)
            .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
        sync::sync_log::append(
            conn,
            "highlight",
            &highlight.id,
            "INSERT",
            &payload,
            hlc_str.as_deref().unwrap_or(""),
            ctx.device_id,
        )?;
    }

    Ok(highlight)
}

pub fn get_highlights_for_resource(
    conn: &Connection,
    resource_id: &str,
) -> Result<Vec<Highlight>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT id, resource_id, text_content, anchor, color, created_at
         FROM highlights WHERE resource_id = ?1 AND deleted_at IS NULL
         ORDER BY created_at",
    )?;
    let highlights = stmt
        .query_map(params![resource_id], |row| {
            let anchor_json: String = row.get(3)?;
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, anchor_json, row.get(4)?, row.get(5)?))
        })?
        .map(|r| {
            let (id, resource_id, text_content, anchor_json, color, created_at): (String, String, String, String, String, String) = r?;
            let anchor: Anchor = serde_json::from_str(&anchor_json)
                .map_err(|e| rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(e)))?;
            Ok(Highlight {
                id,
                resource_id,
                text_content,
                anchor,
                color,
                created_at,
            })
        })
        .collect::<Result<Vec<_>, rusqlite::Error>>()?;
    Ok(highlights)
}

pub fn delete_highlight(
    conn: &Connection,
    id: &str,
    sync_ctx: Option<&SyncContext>,
) -> Result<(), DbError> {
    // Serialize before soft-delete
    let highlight_before = if sync_ctx.is_some() {
        get_highlight(conn, id).ok()
    } else {
        None
    };

    let now = now_iso8601();
    let hlc_str = sync_ctx.map(|ctx| ctx.clock.tick().to_string());
    let changed = conn.execute(
        "UPDATE highlights SET deleted_at = ?1, hlc = COALESCE(?2, hlc) WHERE id = ?3 AND deleted_at IS NULL",
        params![now, hlc_str, id],
    )?;
    if changed == 0 {
        return Err(DbError::NotFound(format!("highlight {}", id)));
    }
    // Cascade soft-delete to comments on this highlight
    conn.execute(
        "UPDATE comments SET deleted_at = ?1 WHERE highlight_id = ?2 AND deleted_at IS NULL",
        params![now, id],
    )?;

    if let Some(ctx) = sync_ctx {
        if let Some(highlight) = highlight_before {
            let payload = serde_json::to_string(&highlight)
                .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
            sync::sync_log::append(
                conn,
                "highlight",
                id,
                "DELETE",
                &payload,
                hlc_str.as_deref().unwrap_or(""),
                ctx.device_id,
            )?;
        }
    }

    Ok(())
}

fn get_highlight(conn: &Connection, id: &str) -> Result<Highlight, DbError> {
    conn.query_row(
        "SELECT id, resource_id, text_content, anchor, color, created_at
         FROM highlights WHERE id = ?1 AND deleted_at IS NULL",
        params![id],
        |row| {
            let anchor_json: String = row.get(3)?;
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, anchor_json, row.get(4)?, row.get(5)?))
        },
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => DbError::NotFound(format!("highlight {}", id)),
        other => DbError::Sqlite(other),
    })
    .and_then(|(id, resource_id, text_content, anchor_json, color, created_at): (String, String, String, String, String, String)| {
        let anchor: Anchor = serde_json::from_str(&anchor_json)
            .map_err(|e| DbError::InvalidOperation(format!("anchor parse failed: {}", e)))?;
        Ok(Highlight {
            id,
            resource_id,
            text_content,
            anchor,
            color,
            created_at,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{comments, folders, resources, test_db};

    fn test_anchor() -> Anchor {
        Anchor {
            text_position: TextPosition {
                start: 100,
                end: 150,
            },
            text_quote: TextQuote {
                exact: "highlighted text".to_string(),
                prefix: "before ".to_string(),
                suffix: " after".to_string(),
            },
        }
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
                captured_at: "2026-01-01".to_string(),
                selection_meta: None,
            },
            None,
        )
        .unwrap()
    }

    #[test]
    fn test_create_highlight() {
        let conn = test_db();
        let resource = setup_resource(&conn);
        let hl = create_highlight(&conn, &resource.id, "highlighted text", &test_anchor(), "#FFFF00", None).unwrap();
        assert_eq!(hl.text_content, "highlighted text");
        assert_eq!(hl.color, "#FFFF00");
    }

    #[test]
    fn test_get_highlights_for_resource() {
        let conn = test_db();
        let resource = setup_resource(&conn);
        create_highlight(&conn, &resource.id, "first", &test_anchor(), "#FF0", None).unwrap();
        create_highlight(&conn, &resource.id, "second", &test_anchor(), "#0FF", None).unwrap();

        let highlights = get_highlights_for_resource(&conn, &resource.id).unwrap();
        assert_eq!(highlights.len(), 2);
    }

    #[test]
    fn test_anchor_roundtrip() {
        let conn = test_db();
        let resource = setup_resource(&conn);
        let anchor = test_anchor();
        create_highlight(&conn, &resource.id, "test", &anchor, "#FF0", None).unwrap();

        let highlights = get_highlights_for_resource(&conn, &resource.id).unwrap();
        assert_eq!(highlights[0].anchor.text_position.start, 100);
        assert_eq!(highlights[0].anchor.text_position.end, 150);
        assert_eq!(highlights[0].anchor.text_quote.exact, "highlighted text");
        assert_eq!(highlights[0].anchor.text_quote.prefix, "before ");
        assert_eq!(highlights[0].anchor.text_quote.suffix, " after");
    }

    #[test]
    fn test_delete_highlight() {
        let conn = test_db();
        let resource = setup_resource(&conn);
        let hl = create_highlight(&conn, &resource.id, "test", &test_anchor(), "#FF0", None).unwrap();
        delete_highlight(&conn, &hl.id, None).unwrap();

        let highlights = get_highlights_for_resource(&conn, &resource.id).unwrap();
        assert!(highlights.is_empty());
    }

    #[test]
    fn test_delete_highlight_cascades_to_comments() {
        let conn = test_db();
        let resource = setup_resource(&conn);
        let hl = create_highlight(&conn, &resource.id, "test", &test_anchor(), "#FF0", None).unwrap();
        comments::create_comment(&conn, &resource.id, Some(&hl.id), "my note", None).unwrap();

        delete_highlight(&conn, &hl.id, None).unwrap();

        let comments = comments::get_comments_for_resource(&conn, &resource.id).unwrap();
        assert!(comments.is_empty());
    }
}
