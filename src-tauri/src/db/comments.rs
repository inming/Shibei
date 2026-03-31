use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::{now_iso8601, DbError};

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
) -> Result<Comment, DbError> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso8601();

    conn.execute(
        "INSERT INTO comments (id, highlight_id, resource_id, content, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, highlight_id, resource_id, content, now, now],
    )?;

    Ok(Comment {
        id,
        highlight_id: highlight_id.map(|s| s.to_string()),
        resource_id: resource_id.to_string(),
        content: content.to_string(),
        created_at: now.clone(),
        updated_at: now,
    })
}

pub fn update_comment(conn: &Connection, id: &str, content: &str) -> Result<(), DbError> {
    let now = now_iso8601();
    let changed = conn.execute(
        "UPDATE comments SET content = ?1, updated_at = ?2 WHERE id = ?3",
        params![content, now, id],
    )?;
    if changed == 0 {
        return Err(DbError::NotFound(format!("comment {}", id)));
    }
    Ok(())
}

pub fn delete_comment(conn: &Connection, id: &str) -> Result<(), DbError> {
    let changed = conn.execute("DELETE FROM comments WHERE id = ?1", params![id])?;
    if changed == 0 {
        return Err(DbError::NotFound(format!("comment {}", id)));
    }
    Ok(())
}

pub fn get_comments_for_resource(
    conn: &Connection,
    resource_id: &str,
) -> Result<Vec<Comment>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT id, highlight_id, resource_id, content, created_at, updated_at
         FROM comments WHERE resource_id = ?1
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

pub fn get_comments_for_highlight(
    conn: &Connection,
    highlight_id: &str,
) -> Result<Vec<Comment>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT id, highlight_id, resource_id, content, created_at, updated_at
         FROM comments WHERE highlight_id = ?1
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
        let folder = folders::create_folder(conn, "docs", "__root__").unwrap();
        resources::create_resource(
            conn,
            resources::CreateResourceInput {
                title: "test".to_string(),
                url: "https://example.com".to_string(),
                domain: None,
                author: None,
                description: None,
                folder_id: folder.id,
                resource_type: "webpage".to_string(),
                file_path: "x".to_string(),
                captured_at: "2026-01-01".to_string(),
            },
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
        let hl = highlights::create_highlight(&conn, &resource.id, "test", &anchor, "#FF0").unwrap();

        let comment = create_comment(&conn, &resource.id, Some(&hl.id), "great insight").unwrap();
        assert_eq!(comment.content, "great insight");
        assert_eq!(comment.highlight_id.as_deref(), Some(hl.id.as_str()));
    }

    #[test]
    fn test_create_resource_level_note() {
        let conn = test_db();
        let resource = setup_resource(&conn);

        let comment = create_comment(&conn, &resource.id, None, "general note").unwrap();
        assert!(comment.highlight_id.is_none());
    }

    #[test]
    fn test_update_comment() {
        let conn = test_db();
        let resource = setup_resource(&conn);
        let comment = create_comment(&conn, &resource.id, None, "old").unwrap();

        update_comment(&conn, &comment.id, "new content").unwrap();

        let comments = get_comments_for_resource(&conn, &resource.id).unwrap();
        assert_eq!(comments[0].content, "new content");
    }

    #[test]
    fn test_delete_comment() {
        let conn = test_db();
        let resource = setup_resource(&conn);
        let comment = create_comment(&conn, &resource.id, None, "temp").unwrap();

        delete_comment(&conn, &comment.id).unwrap();

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
        let hl = highlights::create_highlight(&conn, &resource.id, "test", &anchor, "#FF0").unwrap();

        create_comment(&conn, &resource.id, Some(&hl.id), "comment 1").unwrap();
        create_comment(&conn, &resource.id, Some(&hl.id), "comment 2").unwrap();
        create_comment(&conn, &resource.id, None, "resource note").unwrap();

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
        let hl = highlights::create_highlight(&conn, &resource.id, "test", &anchor, "#FF0").unwrap();
        let comment = create_comment(&conn, &resource.id, Some(&hl.id), "note").unwrap();

        delete_comment(&conn, &comment.id).unwrap();

        // Highlight should still exist
        let highlights = highlights::get_highlights_for_resource(&conn, &resource.id).unwrap();
        assert_eq!(highlights.len(), 1);
    }
}
