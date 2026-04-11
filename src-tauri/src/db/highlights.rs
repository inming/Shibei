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

    let _ = super::search::rebuild_search_index(conn, resource_id);

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

/// List highlight IDs that were soft-deleted for a resource (for restore sync).
pub fn list_deleted_highlight_ids_for_resource(
    conn: &Connection,
    resource_id: &str,
) -> Result<Vec<String>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT id FROM highlights WHERE resource_id = ?1 AND deleted_at IS NOT NULL",
    )?;
    let ids = stmt
        .query_map(params![resource_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ids)
}

pub fn delete_highlight(
    conn: &Connection,
    id: &str,
    sync_ctx: Option<&SyncContext>,
) -> Result<(), DbError> {
    let fts_resource_id: Option<String> = conn
        .query_row(
            "SELECT resource_id FROM highlights WHERE id = ?1 AND deleted_at IS NULL",
            params![id],
            |row| row.get(0),
        )
        .ok();

    // Serialize before soft-delete
    let highlight_before = if sync_ctx.is_some() {
        get_highlight_by_id(conn, id).ok()
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
    // Cascade soft-delete to comments on this highlight (with HLC update)
    conn.execute(
        "UPDATE comments SET deleted_at = ?1, hlc = COALESCE(?2, hlc) WHERE highlight_id = ?3 AND deleted_at IS NULL",
        params![now, hlc_str, id],
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

    if let Some(ref rid) = fts_resource_id {
        let _ = super::search::rebuild_search_index(conn, rid);
    }

    Ok(())
}

pub fn update_highlight_color(
    conn: &Connection,
    id: &str,
    color: &str,
    sync_ctx: Option<&SyncContext>,
) -> Result<Highlight, DbError> {
    let hlc_str = sync_ctx.map(|ctx| ctx.clock.tick().to_string());
    let changed = conn.execute(
        "UPDATE highlights SET color = ?1, hlc = COALESCE(?2, hlc) WHERE id = ?3 AND deleted_at IS NULL",
        params![color, hlc_str, id],
    )?;
    if changed == 0 {
        return Err(DbError::NotFound(format!("highlight {}", id)));
    }
    let highlight = get_highlight_by_id(conn, id)?;

    if let Some(ctx) = sync_ctx {
        let payload = serde_json::to_string(&highlight)
            .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
        sync::sync_log::append(
            conn,
            "highlight",
            id,
            "UPDATE",
            &payload,
            hlc_str.as_deref().unwrap_or(""),
            ctx.device_id,
        )?;
    }

    Ok(highlight)
}

pub fn get_highlight_by_id(conn: &Connection, id: &str) -> Result<Highlight, DbError> {
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

/// Batch-count highlights for multiple resources.
pub fn count_by_resource_ids(
    conn: &Connection,
    resource_ids: &[String],
) -> Result<std::collections::HashMap<String, i64>, DbError> {
    if resource_ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let placeholders: Vec<String> = resource_ids
        .iter()
        .enumerate()
        .map(|(i, _)| format!("?{}", i + 1))
        .collect();
    let sql = format!(
        "SELECT resource_id, COUNT(*) FROM highlights WHERE resource_id IN ({}) AND deleted_at IS NULL GROUP BY resource_id",
        placeholders.join(", ")
    );
    let mut stmt = conn.prepare(&sql)?;
    let params: Vec<&dyn rusqlite::types::ToSql> = resource_ids
        .iter()
        .map(|id| id as &dyn rusqlite::types::ToSql)
        .collect();
    let rows = stmt.query_map(params.as_slice(), |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    let mut map = std::collections::HashMap::new();
    for row in rows {
        let (id, count) = row?;
        map.insert(id, count);
    }
    Ok(map)
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
    fn test_update_highlight_color() {
        let conn = test_db();
        let resource = setup_resource(&conn);
        let hl = create_highlight(&conn, &resource.id, "test", &test_anchor(), "#FFFF00", None).unwrap();
        let updated = update_highlight_color(&conn, &hl.id, "#81C784", None).unwrap();
        assert_eq!(updated.color, "#81C784");
        assert_eq!(updated.text_content, "test");

        let fetched = get_highlight_by_id(&conn, &hl.id).unwrap();
        assert_eq!(fetched.color, "#81C784");
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

    #[test]
    fn test_count_by_resource_ids() {
        let conn = test_db();
        let folder = folders::create_folder(&conn, "test", "__root__", None).unwrap();
        let r1 = resources::create_resource(
            &conn,
            resources::CreateResourceInput {
                id: None,
                title: "R1".to_string(),
                url: "https://a.com".to_string(),
                domain: None,
                author: None,
                description: None,
                folder_id: folder.id.clone(),
                resource_type: "webpage".to_string(),
                file_path: "x".to_string(),
                captured_at: "2026-01-01T00:00:00Z".to_string(),
                selection_meta: None,
            },
            None,
        )
        .unwrap();
        let r2 = resources::create_resource(
            &conn,
            resources::CreateResourceInput {
                id: None,
                title: "R2".to_string(),
                url: "https://b.com".to_string(),
                domain: None,
                author: None,
                description: None,
                folder_id: folder.id.clone(),
                resource_type: "webpage".to_string(),
                file_path: "y".to_string(),
                captured_at: "2026-01-01T00:00:00Z".to_string(),
                selection_meta: None,
            },
            None,
        )
        .unwrap();

        let anchor = Anchor {
            text_position: TextPosition { start: 0, end: 5 },
            text_quote: TextQuote {
                exact: "test".to_string(),
                prefix: "".to_string(),
                suffix: "".to_string(),
            },
        };
        create_highlight(&conn, &r1.id, "hl1", &anchor, "#FF0000", None).unwrap();
        create_highlight(&conn, &r1.id, "hl2", &anchor, "#00FF00", None).unwrap();

        let counts = count_by_resource_ids(&conn, &[r1.id.clone(), r2.id.clone()]).unwrap();
        assert_eq!(*counts.get(&r1.id).unwrap_or(&0), 2);
        assert_eq!(counts.get(&r2.id), None); // r2 has no highlights, not in map
    }
}
