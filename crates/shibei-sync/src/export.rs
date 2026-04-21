use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use shibei_db::DbError;

#[derive(Debug, Serialize, Deserialize)]
pub struct FullSnapshot {
    pub timestamp: String,
    pub device_id: String,
    pub folders: Vec<serde_json::Value>,
    pub resources: Vec<serde_json::Value>,
    pub tags: Vec<serde_json::Value>,
    pub resource_tags: Vec<serde_json::Value>,
    pub highlights: Vec<serde_json::Value>,
    pub comments: Vec<serde_json::Value>,
}

fn export_table(
    conn: &Connection,
    sql: &str,
    columns: &[&str],
) -> Result<Vec<serde_json::Value>, DbError> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt
        .query_map([], |row| {
            let mut map = serde_json::Map::new();
            for (i, &col) in columns.iter().enumerate() {
                let val: rusqlite::types::Value = row.get(i)?;
                let json_val = match val {
                    rusqlite::types::Value::Null => serde_json::Value::Null,
                    rusqlite::types::Value::Integer(n) => serde_json::json!(n),
                    rusqlite::types::Value::Real(f) => serde_json::json!(f),
                    rusqlite::types::Value::Text(s) => serde_json::Value::String(s),
                    rusqlite::types::Value::Blob(_) => serde_json::Value::Null,
                };
                map.insert(col.to_string(), json_val);
            }
            Ok(serde_json::Value::Object(map))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn export_full_state(conn: &Connection, device_id: &str) -> Result<FullSnapshot, DbError> {
    let timestamp = chrono::Utc::now().to_rfc3339();

    let folders = export_table(
        conn,
        "SELECT id, name, parent_id, sort_order, created_at, updated_at, hlc, deleted_at
         FROM folders WHERE id != '__root__'",
        &[
            "id",
            "name",
            "parent_id",
            "sort_order",
            "created_at",
            "updated_at",
            "hlc",
            "deleted_at",
        ],
    )?;

    let resources = export_table(
        conn,
        "SELECT id, title, url, domain, author, description, folder_id, resource_type,
                file_path, created_at, captured_at, selection_meta, hlc, deleted_at
         FROM resources",
        &[
            "id",
            "title",
            "url",
            "domain",
            "author",
            "description",
            "folder_id",
            "resource_type",
            "file_path",
            "created_at",
            "captured_at",
            "selection_meta",
            "hlc",
            "deleted_at",
        ],
    )?;

    let tags = export_table(
        conn,
        "SELECT id, name, color, hlc, deleted_at FROM tags",
        &["id", "name", "color", "hlc", "deleted_at"],
    )?;

    let resource_tags = export_table(
        conn,
        "SELECT resource_id, tag_id, hlc, deleted_at FROM resource_tags",
        &["resource_id", "tag_id", "hlc", "deleted_at"],
    )?;

    let highlights = export_table(
        conn,
        "SELECT id, resource_id, text_content, anchor, color, created_at, hlc, deleted_at
         FROM highlights",
        &[
            "id",
            "resource_id",
            "text_content",
            "anchor",
            "color",
            "created_at",
            "hlc",
            "deleted_at",
        ],
    )?;

    let comments = export_table(
        conn,
        "SELECT id, highlight_id, resource_id, content, created_at, updated_at, hlc, deleted_at
         FROM comments",
        &[
            "id",
            "highlight_id",
            "resource_id",
            "content",
            "created_at",
            "updated_at",
            "hlc",
            "deleted_at",
        ],
    )?;

    Ok(FullSnapshot {
        timestamp,
        device_id: device_id.to_string(),
        folders,
        resources,
        tags,
        resource_tags,
        highlights,
        comments,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use shibei_db::{folders, test_db};

    #[test]
    fn test_export_full_state() {
        let conn = test_db();
        folders::create_folder(&conn, "test", "__root__", None).unwrap();

        let snapshot = export_full_state(&conn, "test-device").unwrap();
        assert_eq!(snapshot.folders.len(), 1);
        assert_eq!(snapshot.device_id, "test-device");
        assert!(snapshot.resources.is_empty());
        // Verify folder has expected fields
        let f = &snapshot.folders[0];
        assert_eq!(f["name"].as_str(), Some("test"));
    }

    #[test]
    fn test_export_excludes_root_folder() {
        let conn = test_db();

        let snapshot = export_full_state(&conn, "test-device").unwrap();
        // __root__ should not appear even though it exists in the DB
        assert!(snapshot.folders.is_empty());
    }

    #[test]
    fn test_export_includes_soft_deleted() {
        let conn = test_db();
        let folder = folders::create_folder(&conn, "to-delete", "__root__", None).unwrap();
        folders::delete_folder(&conn, &folder.id, None).unwrap();

        let snapshot = export_full_state(&conn, "test-device").unwrap();
        // Soft-deleted folder should still be exported
        assert_eq!(snapshot.folders.len(), 1);
        let f = &snapshot.folders[0];
        assert!(f["deleted_at"] != serde_json::Value::Null);
    }
}
