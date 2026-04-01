use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::{now_iso8601, DbError};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub parent_id: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

pub fn create_folder(conn: &Connection, name: &str, parent_id: &str) -> Result<Folder, DbError> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso8601();

    // Get next sort_order among siblings
    let sort_order: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM folders WHERE parent_id = ?1",
            params![parent_id],
            |row| row.get(0),
        )
        .unwrap_or(1);

    conn.execute(
        "INSERT INTO folders (id, name, parent_id, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, name, parent_id, sort_order, now, now],
    )?;

    Ok(Folder {
        id,
        name: name.to_string(),
        parent_id: parent_id.to_string(),
        sort_order,
        created_at: now.clone(),
        updated_at: now,
    })
}

pub fn rename_folder(conn: &Connection, id: &str, new_name: &str) -> Result<(), DbError> {
    if id == "__root__" {
        return Err(DbError::InvalidOperation(
            "cannot rename root folder".to_string(),
        ));
    }
    let now = now_iso8601();
    let changed = conn.execute(
        "UPDATE folders SET name = ?1, updated_at = ?2 WHERE id = ?3",
        params![new_name, now, id],
    )?;
    if changed == 0 {
        return Err(DbError::NotFound(format!("folder {}", id)));
    }
    Ok(())
}

pub fn delete_folder(conn: &Connection, id: &str) -> Result<Vec<String>, DbError> {
    if id == "__root__" {
        return Err(DbError::InvalidOperation(
            "cannot delete root folder".to_string(),
        ));
    }

    // Recursively collect all resource_ids under this folder for filesystem cleanup
    let resource_ids = collect_resource_ids(conn, id)?;

    conn.execute("DELETE FROM folders WHERE id = ?1", params![id])?;

    Ok(resource_ids)
}

/// Recursively collect resource IDs under a folder and all its sub-folders.
fn collect_resource_ids(conn: &Connection, folder_id: &str) -> Result<Vec<String>, DbError> {
    let mut result = Vec::new();

    // Resources directly in this folder
    let mut stmt = conn.prepare("SELECT id FROM resources WHERE folder_id = ?1")?;
    let ids = stmt.query_map(params![folder_id], |row| row.get::<_, String>(0))?;
    for id in ids {
        result.push(id?);
    }

    // Recurse into child folders
    let mut stmt = conn.prepare("SELECT id FROM folders WHERE parent_id = ?1")?;
    let child_ids: Vec<String> = stmt
        .query_map(params![folder_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;

    for child_id in child_ids {
        result.extend(collect_resource_ids(conn, &child_id)?);
    }

    Ok(result)
}

pub fn move_folder(
    conn: &Connection,
    id: &str,
    new_parent_id: &str,
) -> Result<(), DbError> {
    if id == "__root__" {
        return Err(DbError::InvalidOperation(
            "cannot move root folder".to_string(),
        ));
    }

    // Cycle detection: walk from new_parent_id up to __root__
    // If we encounter `id` along the way, it's a cycle
    let mut current = new_parent_id.to_string();
    while current != "__root__" {
        if current == id {
            return Err(DbError::InvalidOperation(
                "cannot move folder into its own subtree".to_string(),
            ));
        }
        current = conn
            .query_row(
                "SELECT parent_id FROM folders WHERE id = ?1",
                params![current],
                |row| row.get::<_, String>(0),
            )
            .map_err(|_| DbError::NotFound(format!("folder {}", current)))?;
    }

    let now = now_iso8601();
    conn.execute(
        "UPDATE folders SET parent_id = ?1, updated_at = ?2 WHERE id = ?3",
        params![new_parent_id, now, id],
    )?;
    Ok(())
}

pub fn list_children(conn: &Connection, parent_id: &str) -> Result<Vec<Folder>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT id, name, parent_id, sort_order, created_at, updated_at
         FROM folders WHERE parent_id = ?1 AND id != '__root__'
         ORDER BY sort_order",
    )?;
    let folders = stmt
        .query_map(params![parent_id], |row| {
            Ok(Folder {
                id: row.get(0)?,
                name: row.get(1)?,
                parent_id: row.get(2)?,
                sort_order: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(folders)
}

/// Returns the set of folder IDs that have at least one child folder.
pub fn parent_ids_with_children(conn: &Connection) -> Result<std::collections::HashSet<String>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT parent_id FROM folders WHERE id != '__root__'",
    )?;
    let ids = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(ids)
}

pub fn reorder_folder(conn: &Connection, id: &str, new_sort_order: i64) -> Result<(), DbError> {
    let now = now_iso8601();
    let changed = conn.execute(
        "UPDATE folders SET sort_order = ?1, updated_at = ?2 WHERE id = ?3",
        params![new_sort_order, now, id],
    )?;
    if changed == 0 {
        return Err(DbError::NotFound(format!("folder {}", id)));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_db;

    #[test]
    fn test_create_folder() {
        let conn = test_db();
        let folder = create_folder(&conn, "tech", "__root__").unwrap();
        assert_eq!(folder.name, "tech");
        assert_eq!(folder.parent_id, "__root__");
        assert_eq!(folder.sort_order, 1);
    }

    #[test]
    fn test_create_folder_auto_sort_order() {
        let conn = test_db();
        let f1 = create_folder(&conn, "a", "__root__").unwrap();
        let f2 = create_folder(&conn, "b", "__root__").unwrap();
        assert_eq!(f1.sort_order, 1);
        assert_eq!(f2.sort_order, 2);
    }

    #[test]
    fn test_create_folder_duplicate_name_rejected() {
        let conn = test_db();
        create_folder(&conn, "tech", "__root__").unwrap();
        let result = create_folder(&conn, "tech", "__root__");
        assert!(result.is_err());
    }

    #[test]
    fn test_rename_folder() {
        let conn = test_db();
        let folder = create_folder(&conn, "old", "__root__").unwrap();
        rename_folder(&conn, &folder.id, "new").unwrap();

        let children = list_children(&conn, "__root__").unwrap();
        assert_eq!(children[0].name, "new");
    }

    #[test]
    fn test_rename_root_rejected() {
        let conn = test_db();
        let result = rename_folder(&conn, "__root__", "nope");
        assert!(result.is_err());
    }

    #[test]
    fn test_delete_folder() {
        let conn = test_db();
        let folder = create_folder(&conn, "temp", "__root__").unwrap();
        let ids = delete_folder(&conn, &folder.id).unwrap();
        assert!(ids.is_empty());

        let children = list_children(&conn, "__root__").unwrap();
        assert!(children.is_empty());
    }

    #[test]
    fn test_delete_root_rejected() {
        let conn = test_db();
        let result = delete_folder(&conn, "__root__");
        assert!(result.is_err());
    }

    #[test]
    fn test_delete_folder_returns_resource_ids() {
        let conn = test_db();
        let folder = create_folder(&conn, "docs", "__root__").unwrap();

        // Insert a resource directly
        conn.execute(
            "INSERT INTO resources (id, title, url, folder_id, resource_type, file_path, created_at, captured_at)
             VALUES ('r1', 'test', 'http://x', ?1, 'webpage', 'x', '2026-01-01', '2026-01-01')",
            params![folder.id],
        )
        .unwrap();

        let ids = delete_folder(&conn, &folder.id).unwrap();
        assert_eq!(ids, vec!["r1"]);
    }

    #[test]
    fn test_move_folder() {
        let conn = test_db();
        let a = create_folder(&conn, "a", "__root__").unwrap();
        let b = create_folder(&conn, "b", "__root__").unwrap();
        move_folder(&conn, &a.id, &b.id).unwrap();

        let root_children = list_children(&conn, "__root__").unwrap();
        assert_eq!(root_children.len(), 1);
        assert_eq!(root_children[0].name, "b");

        let b_children = list_children(&conn, &b.id).unwrap();
        assert_eq!(b_children.len(), 1);
        assert_eq!(b_children[0].name, "a");
    }

    #[test]
    fn test_move_folder_cycle_rejected() {
        let conn = test_db();
        let a = create_folder(&conn, "a", "__root__").unwrap();
        let b = create_folder(&conn, "b", &a.id).unwrap();

        // Moving a into b would create a cycle
        let result = move_folder(&conn, &a.id, &b.id);
        assert!(result.is_err());
    }

    #[test]
    fn test_move_root_rejected() {
        let conn = test_db();
        let a = create_folder(&conn, "a", "__root__").unwrap();
        let result = move_folder(&conn, "__root__", &a.id);
        assert!(result.is_err());
    }

    #[test]
    fn test_list_children() {
        let conn = test_db();
        create_folder(&conn, "b", "__root__").unwrap();
        create_folder(&conn, "a", "__root__").unwrap();

        let children = list_children(&conn, "__root__").unwrap();
        assert_eq!(children.len(), 2);
        // Ordered by sort_order (creation order)
        assert_eq!(children[0].name, "b");
        assert_eq!(children[1].name, "a");
    }

    #[test]
    fn test_reorder_folder() {
        let conn = test_db();
        let f1 = create_folder(&conn, "first", "__root__").unwrap();
        let _f2 = create_folder(&conn, "second", "__root__").unwrap();

        reorder_folder(&conn, &f1.id, 10).unwrap();

        let children = list_children(&conn, "__root__").unwrap();
        assert_eq!(children[0].name, "second");
        assert_eq!(children[1].name, "first");
    }
}
