use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::{now_iso8601, DbError};
use crate::sync::{self, SyncContext};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub parent_id: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

pub fn create_folder(
    conn: &Connection,
    name: &str,
    parent_id: &str,
    sync_ctx: Option<&SyncContext>,
) -> Result<Folder, DbError> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso8601();
    let hlc_str = sync_ctx.map(|ctx| ctx.clock.tick().to_string());

    // Get next sort_order among siblings
    let sort_order: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM folders WHERE parent_id = ?1 AND deleted_at IS NULL",
            params![parent_id],
            |row| row.get(0),
        )
        .unwrap_or(1);

    conn.execute(
        "INSERT INTO folders (id, name, parent_id, sort_order, created_at, updated_at, hlc)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, name, parent_id, sort_order, now, now, hlc_str],
    )?;

    let folder = Folder {
        id,
        name: name.to_string(),
        parent_id: parent_id.to_string(),
        sort_order,
        created_at: now.clone(),
        updated_at: now,
    };

    if let Some(ctx) = sync_ctx {
        let payload = serde_json::to_string(&folder)
            .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
        sync::sync_log::append(
            conn,
            "folder",
            &folder.id,
            "INSERT",
            &payload,
            hlc_str.as_deref().unwrap_or(""),
            ctx.device_id,
        )?;
    }

    Ok(folder)
}

pub fn rename_folder(
    conn: &Connection,
    id: &str,
    new_name: &str,
    sync_ctx: Option<&SyncContext>,
) -> Result<(), DbError> {
    if id == "__root__" {
        return Err(DbError::InvalidOperation(
            "cannot rename root folder".to_string(),
        ));
    }
    let now = now_iso8601();
    let hlc_str = sync_ctx.map(|ctx| ctx.clock.tick().to_string());
    let changed = conn.execute(
        "UPDATE folders SET name = ?1, updated_at = ?2, hlc = COALESCE(?3, hlc) WHERE id = ?4 AND deleted_at IS NULL",
        params![new_name, now, hlc_str, id],
    )?;
    if changed == 0 {
        return Err(DbError::NotFound(format!("folder {}", id)));
    }

    if let Some(ctx) = sync_ctx {
        let folder = get_folder(conn, id)?;
        let payload = serde_json::to_string(&folder)
            .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
        sync::sync_log::append(
            conn,
            "folder",
            id,
            "UPDATE",
            &payload,
            hlc_str.as_deref().unwrap_or(""),
            ctx.device_id,
        )?;
    }

    Ok(())
}

pub fn delete_folder(
    conn: &Connection,
    id: &str,
    sync_ctx: Option<&SyncContext>,
) -> Result<Vec<String>, DbError> {
    if id == "__root__" {
        return Err(DbError::InvalidOperation(
            "cannot delete root folder".to_string(),
        ));
    }

    // Serialize folder before soft-delete for sync log
    let folder_before = if sync_ctx.is_some() {
        Some(get_folder(conn, id)?)
    } else {
        None
    };

    // Collect resource IDs before any soft-delete (rows still visible)
    let resource_ids = collect_resource_ids(conn, id)?;

    // Generate HLC before soft-delete so cascaded entities also get it
    let hlc_str = sync_ctx.map(|ctx| ctx.clock.tick().to_string());

    // Recursively soft-delete the folder tree and cascaded entities
    soft_delete_folder_tree(conn, id, hlc_str.as_deref())?;

    if let Some(ctx) = sync_ctx {
        let hlc_ref = hlc_str.as_deref().unwrap_or("");
        if let Some(folder) = folder_before {
            let payload = serde_json::to_string(&folder)
                .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
            sync::sync_log::append(
                conn, "folder", id, "DELETE", &payload, hlc_ref, ctx.device_id,
            )?;
        }
    }

    Ok(resource_ids)
}

/// Return the folder path from root to the given folder.
/// Returns folders in order: [root-child, ..., parent, folder].
/// Excludes the __root__ pseudo-folder.
pub fn get_folder_path(conn: &Connection, folder_id: &str) -> Result<Vec<Folder>, DbError> {
    let mut path = Vec::new();
    let mut current_id = folder_id.to_string();

    // Walk up the tree collecting ancestors
    loop {
        if current_id == "__root__" {
            break;
        }
        let folder = get_folder(conn, &current_id)?;
        let parent = folder.parent_id.clone();
        path.push(folder);
        current_id = parent;
    }

    path.reverse(); // Now [root-child, ..., parent, folder]
    Ok(path)
}

/// Read a single folder by id.
pub fn get_folder(conn: &Connection, id: &str) -> Result<Folder, DbError> {
    conn.query_row(
        "SELECT id, name, parent_id, sort_order, created_at, updated_at
         FROM folders WHERE id = ?1 AND deleted_at IS NULL",
        params![id],
        |row| {
            Ok(Folder {
                id: row.get(0)?,
                name: row.get(1)?,
                parent_id: row.get(2)?,
                sort_order: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        },
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => DbError::NotFound(format!("folder {}", id)),
        other => DbError::Sqlite(other),
    })
}

/// Recursively collect resource IDs under a folder and all its sub-folders.
fn collect_resource_ids(conn: &Connection, folder_id: &str) -> Result<Vec<String>, DbError> {
    let mut result = Vec::new();

    // Resources directly in this folder
    let mut stmt =
        conn.prepare("SELECT id FROM resources WHERE folder_id = ?1 AND deleted_at IS NULL")?;
    let ids = stmt.query_map(params![folder_id], |row| row.get::<_, String>(0))?;
    for id in ids {
        result.push(id?);
    }

    // Recurse into child folders
    let mut stmt =
        conn.prepare("SELECT id FROM folders WHERE parent_id = ?1 AND deleted_at IS NULL")?;
    let child_ids: Vec<String> = stmt
        .query_map(params![folder_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;

    for child_id in child_ids {
        result.extend(collect_resource_ids(conn, &child_id)?);
    }

    Ok(result)
}

/// Recursively soft-delete a folder, its child folders, and all cascaded entities.
fn soft_delete_folder_tree(conn: &Connection, folder_id: &str, hlc: Option<&str>) -> Result<(), DbError> {
    let now = now_iso8601();

    // Find child folders (before soft-deleting anything)
    let mut stmt =
        conn.prepare("SELECT id FROM folders WHERE parent_id = ?1 AND deleted_at IS NULL")?;
    let child_ids: Vec<String> = stmt
        .query_map(params![folder_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;

    // Recurse into children first
    for child_id in child_ids {
        soft_delete_folder_tree(conn, &child_id, hlc)?;
    }

    // Soft-delete cascaded entities for resources in this folder
    // First get the resource IDs in this folder
    let mut stmt =
        conn.prepare("SELECT id FROM resources WHERE folder_id = ?1 AND deleted_at IS NULL")?;
    let resource_ids: Vec<String> = stmt
        .query_map(params![folder_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;

    for rid in &resource_ids {
        conn.execute(
            "UPDATE resource_tags SET deleted_at = ?1, hlc = COALESCE(?2, hlc) WHERE resource_id = ?3 AND deleted_at IS NULL",
            params![now, hlc, rid],
        )?;
        conn.execute(
            "UPDATE highlights SET deleted_at = ?1, hlc = COALESCE(?2, hlc) WHERE resource_id = ?3 AND deleted_at IS NULL",
            params![now, hlc, rid],
        )?;
        conn.execute(
            "UPDATE comments SET deleted_at = ?1, hlc = COALESCE(?2, hlc) WHERE resource_id = ?3 AND deleted_at IS NULL",
            params![now, hlc, rid],
        )?;
    }

    // Soft-delete resources in this folder
    conn.execute(
        "UPDATE resources SET deleted_at = ?1, hlc = COALESCE(?2, hlc) WHERE folder_id = ?3 AND deleted_at IS NULL",
        params![now, hlc, folder_id],
    )?;

    // Soft-delete the folder itself
    conn.execute(
        "UPDATE folders SET deleted_at = ?1, hlc = COALESCE(?2, hlc) WHERE id = ?3",
        params![now, hlc, folder_id],
    )?;

    Ok(())
}

/// Recursively restore a folder tree and all cascaded entities.
/// Symmetric with `soft_delete_folder_tree`.
fn restore_folder_tree(
    conn: &Connection,
    folder_id: &str,
    hlc: Option<&str>,
    sync_ctx: Option<&SyncContext>,
) -> Result<(), DbError> {
    // Restore child folders first
    let mut stmt = conn.prepare(
        "SELECT id FROM folders WHERE parent_id = ?1 AND deleted_at IS NOT NULL",
    )?;
    let child_ids: Vec<String> = stmt
        .query_map(params![folder_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;

    for child_id in &child_ids {
        conn.execute(
            "UPDATE folders SET deleted_at = NULL, hlc = COALESCE(?1, hlc) WHERE id = ?2",
            params![hlc, child_id],
        )?;

        if let Some(ctx) = sync_ctx {
            if let Ok(folder) = get_folder(conn, child_id) {
                let payload = serde_json::to_string(&folder)
                    .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
                sync::sync_log::append(
                    conn, "folder", child_id, "UPDATE", &payload,
                    hlc.unwrap_or(""), ctx.device_id,
                )?;
            }
        }

        restore_folder_tree(conn, child_id, hlc, sync_ctx)?;
    }

    // Restore resources in this folder
    let mut stmt = conn.prepare(
        "SELECT id FROM resources WHERE folder_id = ?1 AND deleted_at IS NOT NULL",
    )?;
    let resource_ids: Vec<String> = stmt
        .query_map(params![folder_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;

    for rid in &resource_ids {
        // Collect deleted child IDs before restoring
        let deleted_highlight_ids = super::highlights::list_deleted_highlight_ids_for_resource(conn, rid)?;
        let deleted_comment_ids = super::comments::list_deleted_comment_ids_for_resource(conn, rid)?;

        conn.execute(
            "UPDATE resources SET deleted_at = NULL, hlc = COALESCE(?1, hlc) WHERE id = ?2",
            params![hlc, rid],
        )?;
        conn.execute(
            "UPDATE highlights SET deleted_at = NULL, hlc = COALESCE(?1, hlc) WHERE resource_id = ?2 AND deleted_at IS NOT NULL",
            params![hlc, rid],
        )?;
        conn.execute(
            "UPDATE comments SET deleted_at = NULL, hlc = COALESCE(?1, hlc) WHERE resource_id = ?2 AND deleted_at IS NOT NULL",
            params![hlc, rid],
        )?;
        conn.execute(
            "UPDATE resource_tags SET deleted_at = NULL, hlc = COALESCE(?1, hlc) WHERE resource_id = ?2 AND deleted_at IS NOT NULL",
            params![hlc, rid],
        )?;

        if let Some(ctx) = sync_ctx {
            let hlc_ref = hlc.unwrap_or("");

            if let Ok(resource) = super::resources::get_resource(conn, rid) {
                let payload = serde_json::to_string(&resource)
                    .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
                sync::sync_log::append(conn, "resource", rid, "UPDATE", &payload, hlc_ref, ctx.device_id)?;
            }

            for hid in &deleted_highlight_ids {
                if let Ok(h) = super::highlights::get_highlight_by_id(conn, hid) {
                    let payload = serde_json::to_string(&h)
                        .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
                    sync::sync_log::append(conn, "highlight", hid, "UPDATE", &payload, hlc_ref, ctx.device_id)?;
                }
            }

            for cid in &deleted_comment_ids {
                if let Ok(c) = super::comments::get_comment_by_id(conn, cid) {
                    let payload = serde_json::to_string(&c)
                        .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
                    sync::sync_log::append(conn, "comment", cid, "UPDATE", &payload, hlc_ref, ctx.device_id)?;
                }
            }
        }

        let _ = super::search::rebuild_search_index(conn, rid);
    }

    Ok(())
}

/// The well-known ID for the inbox virtual folder.
pub const INBOX_FOLDER_ID: &str = "__inbox__";

/// Ensure the inbox folder exists, creating it if needed.
pub fn ensure_inbox_folder(
    conn: &Connection,
    sync_ctx: Option<&SyncContext>,
) -> Result<String, DbError> {
    let exists: bool = conn
        .query_row(
            "SELECT COUNT(*) > 0 FROM folders WHERE id = ?1 AND deleted_at IS NULL",
            params![INBOX_FOLDER_ID],
            |row| row.get(0),
        )
        .unwrap_or(false);

    if exists {
        return Ok(INBOX_FOLDER_ID.to_string());
    }

    let now = now_iso8601();
    let hlc_str = sync_ctx.map(|ctx| ctx.clock.tick().to_string());

    conn.execute(
        "INSERT OR IGNORE INTO folders (id, name, parent_id, sort_order, created_at, updated_at, hlc)
         VALUES (?1, '收件箱', '__root__', 0, ?2, ?3, ?4)",
        params![INBOX_FOLDER_ID, now, now, hlc_str],
    )?;

    if let Some(ctx) = sync_ctx {
        let folder = get_folder(conn, INBOX_FOLDER_ID)?;
        let payload = serde_json::to_string(&folder)
            .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
        sync::sync_log::append(
            conn,
            "folder",
            INBOX_FOLDER_ID,
            "INSERT",
            &payload,
            hlc_str.as_deref().unwrap_or(""),
            ctx.device_id,
        )?;
    }

    Ok(INBOX_FOLDER_ID.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeletedFolder {
    pub id: String,
    pub name: String,
    pub parent_id: String,
    pub deleted_at: String,
}

pub fn list_deleted_folders(conn: &Connection) -> Result<Vec<DeletedFolder>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT id, name, parent_id, deleted_at FROM folders WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(DeletedFolder {
                id: row.get(0)?,
                name: row.get(1)?,
                parent_id: row.get(2)?,
                deleted_at: row.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn restore_folder(
    conn: &Connection,
    id: &str,
    sync_ctx: Option<&SyncContext>,
) -> Result<Folder, DbError> {
    let hlc_str = sync_ctx.map(|ctx| ctx.clock.tick().to_string());

    let parent_id: String = conn
        .query_row(
            "SELECT parent_id FROM folders WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(|_| DbError::NotFound(format!("folder {}", id)))?;

    let parent_exists: bool = parent_id == "__root__"
        || conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM folders WHERE id = ?1 AND deleted_at IS NULL",
                params![parent_id],
                |row| row.get(0),
            )
            .unwrap_or(false);

    let target_parent = if parent_exists {
        parent_id
    } else {
        "__root__".to_string()
    };

    conn.execute(
        "UPDATE folders SET deleted_at = NULL, parent_id = ?1, hlc = COALESCE(?2, hlc) WHERE id = ?3",
        params![target_parent, hlc_str, id],
    )?;

    // Cascade restore to child folders, resources, and annotations
    restore_folder_tree(conn, id, hlc_str.as_deref(), sync_ctx)?;

    let folder = get_folder(conn, id)?;

    if let Some(ctx) = sync_ctx {
        let payload = serde_json::to_string(&folder)
            .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
        sync::sync_log::append(
            conn,
            "folder",
            id,
            "UPDATE",
            &payload,
            hlc_str.as_deref().unwrap_or(""),
            ctx.device_id,
        )?;
    }

    Ok(folder)
}

pub fn purge_folder(conn: &Connection, id: &str) -> Result<Vec<String>, DbError> {
    // Guard: only purge folders that are already soft-deleted
    let is_deleted: bool = conn.query_row(
        "SELECT deleted_at IS NOT NULL FROM folders WHERE id = ?1",
        params![id],
        |row| row.get(0),
    ).map_err(|_| DbError::NotFound(format!("folder {}", id)))?;
    if !is_deleted {
        return Err(DbError::InvalidOperation(format!("folder {} is not deleted", id)));
    }

    let mut stmt = conn.prepare("SELECT id FROM resources WHERE folder_id = ?1")?;
    let resource_ids: Vec<String> = stmt
        .query_map(params![id], |row| row.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .collect();

    for rid in &resource_ids {
        conn.execute("DELETE FROM comments WHERE resource_id = ?1", params![rid])?;
        conn.execute("DELETE FROM highlights WHERE resource_id = ?1", params![rid])?;
        conn.execute("DELETE FROM resource_tags WHERE resource_id = ?1", params![rid])?;
    }
    conn.execute("DELETE FROM resources WHERE folder_id = ?1", params![id])?;
    conn.execute("DELETE FROM folders WHERE id = ?1", params![id])?;

    Ok(resource_ids)
}

/// Permanently delete all soft-deleted folders and the resources inside them.
/// Returns the list of resource IDs that were purged (for filesystem cleanup).
pub fn purge_all_deleted_folders(conn: &Connection) -> Result<Vec<String>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT r.id FROM resources r
         JOIN folders f ON r.folder_id = f.id
         WHERE f.deleted_at IS NOT NULL",
    )?;
    let resource_ids: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .collect();

    for rid in &resource_ids {
        conn.execute("DELETE FROM comments WHERE resource_id = ?1", params![rid])?;
        conn.execute("DELETE FROM highlights WHERE resource_id = ?1", params![rid])?;
        conn.execute("DELETE FROM resource_tags WHERE resource_id = ?1", params![rid])?;
    }
    conn.execute(
        "DELETE FROM resources WHERE folder_id IN (SELECT id FROM folders WHERE deleted_at IS NOT NULL)",
        [],
    )?;
    conn.execute("DELETE FROM folders WHERE deleted_at IS NOT NULL", [])?;

    Ok(resource_ids)
}

/// Return IDs of all soft-deleted folders.
pub fn list_deleted_folder_ids(conn: &Connection) -> Result<Vec<String>, DbError> {
    let mut stmt = conn.prepare("SELECT id FROM folders WHERE deleted_at IS NOT NULL")?;
    let ids = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(ids)
}

pub fn move_folder(
    conn: &Connection,
    id: &str,
    new_parent_id: &str,
    sync_ctx: Option<&SyncContext>,
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
                "SELECT parent_id FROM folders WHERE id = ?1 AND deleted_at IS NULL",
                params![current],
                |row| row.get::<_, String>(0),
            )
            .map_err(|_| DbError::NotFound(format!("folder {}", current)))?;
    }

    let now = now_iso8601();
    let hlc_str = sync_ctx.map(|ctx| ctx.clock.tick().to_string());
    conn.execute(
        "UPDATE folders SET parent_id = ?1, updated_at = ?2, hlc = COALESCE(?3, hlc) WHERE id = ?4",
        params![new_parent_id, now, hlc_str, id],
    )?;

    if let Some(ctx) = sync_ctx {
        let folder = get_folder(conn, id)?;
        let payload = serde_json::to_string(&folder)
            .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
        sync::sync_log::append(
            conn,
            "folder",
            id,
            "UPDATE",
            &payload,
            hlc_str.as_deref().unwrap_or(""),
            ctx.device_id,
        )?;
    }

    Ok(())
}

pub fn list_children(conn: &Connection, parent_id: &str) -> Result<Vec<Folder>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT id, name, parent_id, sort_order, created_at, updated_at
         FROM folders WHERE parent_id = ?1 AND id != '__root__' AND deleted_at IS NULL
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
        "SELECT DISTINCT parent_id FROM folders WHERE id != '__root__' AND deleted_at IS NULL",
    )?;
    let ids = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(ids)
}

pub fn reorder_folder(
    conn: &Connection,
    id: &str,
    new_sort_order: i64,
    sync_ctx: Option<&SyncContext>,
) -> Result<(), DbError> {
    let now = now_iso8601();
    let hlc_str = sync_ctx.map(|ctx| ctx.clock.tick().to_string());
    let changed = conn.execute(
        "UPDATE folders SET sort_order = ?1, updated_at = ?2, hlc = COALESCE(?3, hlc) WHERE id = ?4 AND deleted_at IS NULL",
        params![new_sort_order, now, hlc_str, id],
    )?;
    if changed == 0 {
        return Err(DbError::NotFound(format!("folder {}", id)));
    }

    if let Some(ctx) = sync_ctx {
        let folder = get_folder(conn, id)?;
        let payload = serde_json::to_string(&folder)
            .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
        sync::sync_log::append(
            conn,
            "folder",
            id,
            "UPDATE",
            &payload,
            hlc_str.as_deref().unwrap_or(""),
            ctx.device_id,
        )?;
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
        let folder = create_folder(&conn, "tech", "__root__", None).unwrap();
        assert_eq!(folder.name, "tech");
        assert_eq!(folder.parent_id, "__root__");
        assert_eq!(folder.sort_order, 1);
    }

    #[test]
    fn test_create_folder_auto_sort_order() {
        let conn = test_db();
        let f1 = create_folder(&conn, "a", "__root__", None).unwrap();
        let f2 = create_folder(&conn, "b", "__root__", None).unwrap();
        assert_eq!(f1.sort_order, 1);
        assert_eq!(f2.sort_order, 2);
    }

    #[test]
    fn test_create_folder_duplicate_name_rejected() {
        let conn = test_db();
        create_folder(&conn, "tech", "__root__", None).unwrap();
        let result = create_folder(&conn, "tech", "__root__", None);
        assert!(result.is_err());
    }

    #[test]
    fn test_rename_folder() {
        let conn = test_db();
        let folder = create_folder(&conn, "old", "__root__", None).unwrap();
        rename_folder(&conn, &folder.id, "new", None).unwrap();

        let children = list_children(&conn, "__root__").unwrap();
        assert_eq!(children[0].name, "new");
    }

    #[test]
    fn test_rename_root_rejected() {
        let conn = test_db();
        let result = rename_folder(&conn, "__root__", "nope", None);
        assert!(result.is_err());
    }

    #[test]
    fn test_delete_folder() {
        let conn = test_db();
        let folder = create_folder(&conn, "temp", "__root__", None).unwrap();
        let ids = delete_folder(&conn, &folder.id, None).unwrap();
        assert!(ids.is_empty());

        let children = list_children(&conn, "__root__").unwrap();
        assert!(children.is_empty());
    }

    #[test]
    fn test_delete_root_rejected() {
        let conn = test_db();
        let result = delete_folder(&conn, "__root__", None);
        assert!(result.is_err());
    }

    #[test]
    fn test_delete_folder_returns_resource_ids() {
        let conn = test_db();
        let folder = create_folder(&conn, "docs", "__root__", None).unwrap();

        // Insert a resource directly
        conn.execute(
            "INSERT INTO resources (id, title, url, folder_id, resource_type, file_path, created_at, captured_at)
             VALUES ('r1', 'test', 'http://x', ?1, 'webpage', 'x', '2026-01-01', '2026-01-01')",
            params![folder.id],
        )
        .unwrap();

        let ids = delete_folder(&conn, &folder.id, None).unwrap();
        assert_eq!(ids, vec!["r1"]);
    }

    #[test]
    fn test_move_folder() {
        let conn = test_db();
        let a = create_folder(&conn, "a", "__root__", None).unwrap();
        let b = create_folder(&conn, "b", "__root__", None).unwrap();
        move_folder(&conn, &a.id, &b.id, None).unwrap();

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
        let a = create_folder(&conn, "a", "__root__", None).unwrap();
        let b = create_folder(&conn, "b", &a.id, None).unwrap();

        // Moving a into b would create a cycle
        let result = move_folder(&conn, &a.id, &b.id, None);
        assert!(result.is_err());
    }

    #[test]
    fn test_move_root_rejected() {
        let conn = test_db();
        let a = create_folder(&conn, "a", "__root__", None).unwrap();
        let result = move_folder(&conn, "__root__", &a.id, None);
        assert!(result.is_err());
    }

    #[test]
    fn test_list_children() {
        let conn = test_db();
        create_folder(&conn, "b", "__root__", None).unwrap();
        create_folder(&conn, "a", "__root__", None).unwrap();

        let children = list_children(&conn, "__root__").unwrap();
        assert_eq!(children.len(), 2);
        // Ordered by sort_order (creation order)
        assert_eq!(children[0].name, "b");
        assert_eq!(children[1].name, "a");
    }

    #[test]
    fn test_soft_delete_folder() {
        let conn = test_db();
        let folder = create_folder(&conn, "temp", "__root__", None).unwrap();
        delete_folder(&conn, &folder.id, None).unwrap();

        // Should not appear in list
        let children = list_children(&conn, "__root__").unwrap();
        assert!(children.is_empty());

        // But should still exist in DB with deleted_at set
        let deleted_at: Option<String> = conn
            .query_row(
                "SELECT deleted_at FROM folders WHERE id = ?1",
                params![folder.id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(deleted_at.is_some());
    }

    #[test]
    fn test_reorder_folder() {
        let conn = test_db();
        let f1 = create_folder(&conn, "first", "__root__", None).unwrap();
        let _f2 = create_folder(&conn, "second", "__root__", None).unwrap();

        reorder_folder(&conn, &f1.id, 10, None).unwrap();

        let children = list_children(&conn, "__root__").unwrap();
        assert_eq!(children[0].name, "second");
        assert_eq!(children[1].name, "first");
    }

    #[test]
    fn test_restore_folder_cascades_to_children() {
        let conn = test_db();
        let clock = crate::sync::hlc::HlcClock::new("test-device".to_string());
        let ctx = crate::sync::SyncContext { clock: &clock, device_id: "test-device" };

        let parent = create_folder(&conn, "parent", "__root__", Some(&ctx)).unwrap();
        let child = create_folder(&conn, "child", &parent.id, Some(&ctx)).unwrap();

        // Insert a resource in the child folder
        conn.execute(
            "INSERT INTO resources (id, title, url, folder_id, resource_type, file_path, created_at, captured_at, hlc)
             VALUES ('r1', 'test', 'http://x', ?1, 'webpage', 'x', '2026-01-01', '2026-01-01', '0000000000001-0000-dev')",
            params![child.id],
        ).unwrap();

        // Delete parent folder (cascades to child folder and resource)
        delete_folder(&conn, &parent.id, Some(&ctx)).unwrap();

        // Verify child folder and resource are deleted
        let child_deleted: bool = conn.query_row(
            "SELECT deleted_at IS NOT NULL FROM folders WHERE id = ?1", params![child.id], |row| row.get(0),
        ).unwrap();
        assert!(child_deleted);
        let r_deleted: bool = conn.query_row(
            "SELECT deleted_at IS NOT NULL FROM resources WHERE id = 'r1'", [], |row| row.get(0),
        ).unwrap();
        assert!(r_deleted);

        // Restore parent folder
        restore_folder(&conn, &parent.id, Some(&ctx)).unwrap();

        // Verify child folder is restored
        let child_deleted_after: Option<String> = conn.query_row(
            "SELECT deleted_at FROM folders WHERE id = ?1", params![child.id], |row| row.get(0),
        ).unwrap();
        assert!(child_deleted_after.is_none(), "child folder should be restored");

        // Verify resource is restored
        let r_deleted_after: Option<String> = conn.query_row(
            "SELECT deleted_at FROM resources WHERE id = 'r1'", [], |row| row.get(0),
        ).unwrap();
        assert!(r_deleted_after.is_none(), "resource should be restored");
    }

    #[test]
    fn test_soft_delete_folder_tree_updates_child_hlc() {
        let conn = test_db();
        let folder = create_folder(&conn, "parent", "__root__", None).unwrap();

        conn.execute(
            "INSERT INTO resources (id, title, url, folder_id, resource_type, file_path, created_at, captured_at, hlc)
             VALUES ('r1', 'test', 'http://x', ?1, 'webpage', 'x', '2026-01-01', '2026-01-01', '0000000000100-0000-dev-old')",
            params![folder.id],
        ).unwrap();

        conn.execute(
            "INSERT INTO highlights (id, resource_id, text_content, anchor, color, created_at, hlc)
             VALUES ('h1', 'r1', 'hello', '{\"text_position\":{\"start\":0,\"end\":5},\"text_quote\":{\"exact\":\"hello\",\"prefix\":\"\",\"suffix\":\"\"}}', '#FFEB3B', '2026-01-01', '0000000000100-0000-dev-old')",
            [],
        ).unwrap();

        soft_delete_folder_tree(&conn, &folder.id, Some("0000000000200-0000-dev-new")).unwrap();

        let r_hlc: String = conn.query_row("SELECT hlc FROM resources WHERE id = 'r1'", [], |row| row.get(0)).unwrap();
        assert_eq!(r_hlc, "0000000000200-0000-dev-new");

        let h_hlc: String = conn.query_row("SELECT hlc FROM highlights WHERE id = 'h1'", [], |row| row.get(0)).unwrap();
        assert_eq!(h_hlc, "0000000000200-0000-dev-new");
    }
}
