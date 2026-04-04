use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::{now_iso8601, DbError};
use crate::sync::{self, SyncContext};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Resource {
    pub id: String,
    pub title: String,
    pub url: String,
    pub domain: Option<String>,
    pub author: Option<String>,
    pub description: Option<String>,
    pub folder_id: String,
    pub resource_type: String,
    pub file_path: String,
    pub created_at: String,
    pub captured_at: String,
    pub selection_meta: Option<String>,
}

pub struct CreateResourceInput {
    pub id: Option<String>,
    pub title: String,
    pub url: String,
    pub domain: Option<String>,
    pub author: Option<String>,
    pub description: Option<String>,
    pub folder_id: String,
    pub resource_type: String,
    pub file_path: String,
    pub captured_at: String,
    pub selection_meta: Option<String>,
}

pub fn create_resource(
    conn: &Connection,
    input: CreateResourceInput,
    sync_ctx: Option<&SyncContext>,
) -> Result<Resource, DbError> {
    let id = input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = now_iso8601();
    let hlc_str = sync_ctx.map(|ctx| ctx.clock.tick().to_string());

    conn.execute(
        "INSERT INTO resources (id, title, url, domain, author, description, folder_id, resource_type, file_path, created_at, captured_at, selection_meta, hlc)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            id,
            input.title,
            input.url,
            input.domain,
            input.author,
            input.description,
            input.folder_id,
            input.resource_type,
            input.file_path,
            now,
            input.captured_at,
            input.selection_meta,
            hlc_str,
        ],
    )?;

    let resource = Resource {
        id,
        title: input.title,
        url: input.url,
        domain: input.domain,
        author: input.author,
        description: input.description,
        folder_id: input.folder_id,
        resource_type: input.resource_type,
        file_path: input.file_path,
        created_at: now,
        captured_at: input.captured_at,
        selection_meta: input.selection_meta,
    };

    if let Some(ctx) = sync_ctx {
        // Include tag_ids (empty for create)
        let payload = build_resource_payload(&resource, &[]);
        sync::sync_log::append(
            conn,
            "resource",
            &resource.id,
            "INSERT",
            &payload,
            hlc_str.as_deref().unwrap_or(""),
            ctx.device_id,
        )?;
    }

    Ok(resource)
}

/// Build a JSON payload for a resource including tag_ids.
fn build_resource_payload(resource: &Resource, tag_ids: &[String]) -> String {
    let mut map = serde_json::to_value(resource).unwrap_or_default();
    if let Some(obj) = map.as_object_mut() {
        obj.insert(
            "tag_ids".to_string(),
            serde_json::Value::Array(
                tag_ids
                    .iter()
                    .map(|id| serde_json::Value::String(id.clone()))
                    .collect(),
            ),
        );
    }
    serde_json::to_string(&map).unwrap_or_default()
}

pub fn get_resource(conn: &Connection, id: &str) -> Result<Resource, DbError> {
    conn.query_row(
        "SELECT id, title, url, domain, author, description, folder_id, resource_type, file_path, created_at, captured_at, selection_meta
         FROM resources WHERE id = ?1 AND deleted_at IS NULL",
        params![id],
        |row| {
            Ok(Resource {
                id: row.get(0)?,
                title: row.get(1)?,
                url: row.get(2)?,
                domain: row.get(3)?,
                author: row.get(4)?,
                description: row.get(5)?,
                folder_id: row.get(6)?,
                resource_type: row.get(7)?,
                file_path: row.get(8)?,
                created_at: row.get(9)?,
                captured_at: row.get(10)?,
                selection_meta: row.get(11)?,
            })
        },
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => DbError::NotFound(format!("resource {}", id)),
        other => DbError::Sqlite(other),
    })
}

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SortBy {
    CreatedAt,
    AnnotatedAt,
}

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SortOrder {
    Asc,
    Desc,
}

pub fn list_resources_by_folder(
    conn: &Connection,
    folder_id: &str,
    sort_by: SortBy,
    sort_order: SortOrder,
) -> Result<Vec<Resource>, DbError> {
    let order_dir = match sort_order {
        SortOrder::Asc => "ASC",
        SortOrder::Desc => "DESC",
    };
    let sql = match sort_by {
        SortBy::CreatedAt => format!(
            "SELECT id, title, url, domain, author, description, folder_id, \
             resource_type, file_path, created_at, captured_at, selection_meta \
             FROM resources WHERE folder_id = ?1 AND deleted_at IS NULL ORDER BY created_at {}",
            order_dir
        ),
        SortBy::AnnotatedAt => format!(
            "SELECT r.id, r.title, r.url, r.domain, r.author, r.description, r.folder_id, \
             r.resource_type, r.file_path, r.created_at, r.captured_at, r.selection_meta \
             FROM resources r LEFT JOIN (\
               SELECT resource_id, MAX(created_at) AS last_at FROM (\
                 SELECT resource_id, created_at FROM highlights WHERE deleted_at IS NULL \
                 UNION ALL \
                 SELECT resource_id, created_at FROM comments WHERE deleted_at IS NULL\
               ) GROUP BY resource_id\
             ) a ON r.id = a.resource_id \
             WHERE r.folder_id = ?1 AND r.deleted_at IS NULL \
             ORDER BY COALESCE(a.last_at, r.created_at) {}",
            order_dir
        ),
    };
    let mut stmt = conn.prepare(&sql)?;
    let resources = stmt
        .query_map(params![folder_id], |row| {
            Ok(Resource {
                id: row.get(0)?,
                title: row.get(1)?,
                url: row.get(2)?,
                domain: row.get(3)?,
                author: row.get(4)?,
                description: row.get(5)?,
                folder_id: row.get(6)?,
                resource_type: row.get(7)?,
                file_path: row.get(8)?,
                created_at: row.get(9)?,
                captured_at: row.get(10)?,
                selection_meta: row.get(11)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(resources)
}

pub fn list_all_resources(
    conn: &Connection,
    sort_by: SortBy,
    sort_order: SortOrder,
) -> Result<Vec<Resource>, DbError> {
    let order_dir = match sort_order {
        SortOrder::Asc => "ASC",
        SortOrder::Desc => "DESC",
    };
    let sql = match sort_by {
        SortBy::CreatedAt => format!(
            "SELECT id, title, url, domain, author, description, folder_id, \
             resource_type, file_path, created_at, captured_at, selection_meta \
             FROM resources WHERE deleted_at IS NULL ORDER BY created_at {}",
            order_dir
        ),
        SortBy::AnnotatedAt => format!(
            "SELECT r.id, r.title, r.url, r.domain, r.author, r.description, r.folder_id, \
             r.resource_type, r.file_path, r.created_at, r.captured_at, r.selection_meta \
             FROM resources r LEFT JOIN (\
               SELECT resource_id, MAX(created_at) AS last_at FROM (\
                 SELECT resource_id, created_at FROM highlights WHERE deleted_at IS NULL \
                 UNION ALL \
                 SELECT resource_id, created_at FROM comments WHERE deleted_at IS NULL\
               ) GROUP BY resource_id\
             ) a ON r.id = a.resource_id \
             WHERE r.deleted_at IS NULL \
             ORDER BY COALESCE(a.last_at, r.created_at) {}",
            order_dir
        ),
    };
    let mut stmt = conn.prepare(&sql)?;
    let resources = stmt
        .query_map([], |row| {
            Ok(Resource {
                id: row.get(0)?,
                title: row.get(1)?,
                url: row.get(2)?,
                domain: row.get(3)?,
                author: row.get(4)?,
                description: row.get(5)?,
                folder_id: row.get(6)?,
                resource_type: row.get(7)?,
                file_path: row.get(8)?,
                created_at: row.get(9)?,
                captured_at: row.get(10)?,
                selection_meta: row.get(11)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(resources)
}

pub fn move_resource(
    conn: &Connection,
    id: &str,
    new_folder_id: &str,
    sync_ctx: Option<&SyncContext>,
) -> Result<(), DbError> {
    let hlc_str = sync_ctx.map(|ctx| ctx.clock.tick().to_string());
    let changed = conn.execute(
        "UPDATE resources SET folder_id = ?1, hlc = COALESCE(?2, hlc) WHERE id = ?3 AND deleted_at IS NULL",
        params![new_folder_id, hlc_str, id],
    )?;
    if changed == 0 {
        return Err(DbError::NotFound(format!("resource {}", id)));
    }

    if let Some(ctx) = sync_ctx {
        let resource = get_resource(conn, id)?;
        let tag_ids = get_tag_ids_for_resource(conn, id)?;
        let payload = build_resource_payload(&resource, &tag_ids);
        sync::sync_log::append(
            conn,
            "resource",
            id,
            "UPDATE",
            &payload,
            hlc_str.as_deref().unwrap_or(""),
            ctx.device_id,
        )?;
    }

    Ok(())
}

pub fn update_resource(
    conn: &Connection,
    id: &str,
    title: &str,
    description: Option<&str>,
    sync_ctx: Option<&SyncContext>,
) -> Result<(), DbError> {
    let hlc_str = sync_ctx.map(|ctx| ctx.clock.tick().to_string());
    let changed = conn.execute(
        "UPDATE resources SET title = ?1, description = ?2, hlc = COALESCE(?3, hlc) WHERE id = ?4 AND deleted_at IS NULL",
        params![title, description, hlc_str, id],
    )?;
    if changed == 0 {
        return Err(DbError::NotFound(format!("resource {id}")));
    }

    if let Some(ctx) = sync_ctx {
        let resource = get_resource(conn, id)?;
        let tag_ids = get_tag_ids_for_resource(conn, id)?;
        let payload = build_resource_payload(&resource, &tag_ids);
        sync::sync_log::append(
            conn,
            "resource",
            id,
            "UPDATE",
            &payload,
            hlc_str.as_deref().unwrap_or(""),
            ctx.device_id,
        )?;
    }

    Ok(())
}

pub fn delete_resource(
    conn: &Connection,
    id: &str,
    sync_ctx: Option<&SyncContext>,
) -> Result<String, DbError> {
    // Serialize before soft-delete
    let resource_before = if sync_ctx.is_some() {
        Some(get_resource(conn, id)?)
    } else {
        None
    };

    let now = now_iso8601();
    let hlc_str = sync_ctx.map(|ctx| ctx.clock.tick().to_string());
    let changed = conn.execute(
        "UPDATE resources SET deleted_at = ?1, hlc = COALESCE(?2, hlc) WHERE id = ?3 AND deleted_at IS NULL",
        params![now, hlc_str, id],
    )?;
    if changed == 0 {
        return Err(DbError::NotFound(format!("resource {}", id)));
    }
    // Cascade soft-delete to highlights, comments, resource_tags
    conn.execute(
        "UPDATE highlights SET deleted_at = ?1 WHERE resource_id = ?2 AND deleted_at IS NULL",
        params![now, id],
    )?;
    conn.execute(
        "UPDATE comments SET deleted_at = ?1 WHERE resource_id = ?2 AND deleted_at IS NULL",
        params![now, id],
    )?;
    conn.execute(
        "UPDATE resource_tags SET deleted_at = ?1 WHERE resource_id = ?2 AND deleted_at IS NULL",
        params![now, id],
    )?;

    if let Some(ctx) = sync_ctx {
        if let Some(resource) = resource_before {
            let payload = serde_json::to_string(&resource)
                .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
            sync::sync_log::append(
                conn,
                "resource",
                id,
                "DELETE",
                &payload,
                hlc_str.as_deref().unwrap_or(""),
                ctx.device_id,
            )?;
        }
    }

    Ok(id.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeletedResource {
    pub id: String,
    pub title: String,
    pub url: String,
    pub domain: Option<String>,
    pub folder_id: String,
    pub deleted_at: String,
}

pub fn list_deleted_resources(conn: &Connection) -> Result<Vec<DeletedResource>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT id, title, url, domain, folder_id, deleted_at
         FROM resources
         WHERE deleted_at IS NOT NULL
         ORDER BY deleted_at DESC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(DeletedResource {
                id: row.get(0)?,
                title: row.get(1)?,
                url: row.get(2)?,
                domain: row.get(3)?,
                folder_id: row.get(4)?,
                deleted_at: row.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn restore_resource(
    conn: &Connection,
    id: &str,
    sync_ctx: Option<&SyncContext>,
) -> Result<Resource, DbError> {
    let hlc_str = sync_ctx.map(|ctx| ctx.clock.tick().to_string());

    // Check if the resource's folder still exists (not deleted)
    let folder_id: String = conn
        .query_row(
            "SELECT folder_id FROM resources WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(|_| DbError::NotFound(format!("resource {}", id)))?;

    let folder_exists: bool = conn
        .query_row(
            "SELECT COUNT(*) > 0 FROM folders WHERE id = ?1 AND deleted_at IS NULL",
            params![folder_id],
            |row| row.get(0),
        )
        .unwrap_or(false);

    let target_folder = if folder_exists {
        folder_id
    } else {
        super::folders::ensure_inbox_folder(conn, sync_ctx)?
    };

    conn.execute(
        "UPDATE resources SET deleted_at = NULL, folder_id = ?1, hlc = COALESCE(?2, hlc) WHERE id = ?3",
        params![target_folder, hlc_str, id],
    )?;

    // Also restore associated highlights, comments, resource_tags
    conn.execute(
        "UPDATE highlights SET deleted_at = NULL WHERE resource_id = ?1 AND deleted_at IS NOT NULL",
        params![id],
    )?;
    conn.execute(
        "UPDATE comments SET deleted_at = NULL WHERE resource_id = ?1 AND deleted_at IS NOT NULL",
        params![id],
    )?;
    conn.execute(
        "UPDATE resource_tags SET deleted_at = NULL WHERE resource_id = ?1 AND deleted_at IS NOT NULL",
        params![id],
    )?;

    let resource = get_resource(conn, id)?;

    if let Some(ctx) = sync_ctx {
        let payload = serde_json::to_string(&resource)
            .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
        sync::sync_log::append(
            conn,
            "resource",
            id,
            "UPDATE",
            &payload,
            hlc_str.as_deref().unwrap_or(""),
            ctx.device_id,
        )?;
    }

    Ok(resource)
}

pub fn purge_resource(conn: &Connection, id: &str) -> Result<(), DbError> {
    // Guard: only purge items that are already soft-deleted
    let affected = conn.execute(
        "DELETE FROM resources WHERE id = ?1 AND deleted_at IS NOT NULL",
        params![id],
    )?;
    if affected == 0 {
        return Err(DbError::NotFound(format!("deleted resource {}", id)));
    }
    conn.execute("DELETE FROM comments WHERE resource_id = ?1", params![id])?;
    conn.execute("DELETE FROM highlights WHERE resource_id = ?1", params![id])?;
    conn.execute("DELETE FROM resource_tags WHERE resource_id = ?1", params![id])?;
    Ok(())
}

/// Permanently delete all soft-deleted resources and their annotations.
/// Returns the list of resource IDs that were purged (for filesystem cleanup).
pub fn purge_all_deleted_resources(conn: &Connection) -> Result<Vec<String>, DbError> {
    let mut stmt = conn.prepare("SELECT id FROM resources WHERE deleted_at IS NOT NULL")?;
    let ids: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .collect();

    for rid in &ids {
        conn.execute("DELETE FROM comments WHERE resource_id = ?1", params![rid])?;
        conn.execute("DELETE FROM highlights WHERE resource_id = ?1", params![rid])?;
        conn.execute("DELETE FROM resource_tags WHERE resource_id = ?1", params![rid])?;
    }
    conn.execute("DELETE FROM resources WHERE deleted_at IS NOT NULL", [])?;

    Ok(ids)
}

pub fn count_by_folder(conn: &Connection) -> Result<std::collections::HashMap<String, i64>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT folder_id, COUNT(*) FROM resources WHERE deleted_at IS NULL GROUP BY folder_id",
    )?;
    let counts = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(counts)
}

/// Normalize a URL for dedup comparison: remove trailing slash, fragment, lowercase scheme.
fn normalize_url(url: &str) -> String {
    let mut s = url.to_string();
    // Remove fragment
    if let Some(pos) = s.find('#') {
        s.truncate(pos);
    }
    // Remove trailing slash
    if s.ends_with('/') && s.len() > 1 {
        s.pop();
    }
    // Lowercase scheme
    if let Some(pos) = s.find("://") {
        let scheme = s[..pos].to_lowercase();
        s = format!("{}{}", scheme, &s[pos..]);
    }
    s
}

pub fn find_by_url(conn: &Connection, url: &str) -> Result<Vec<Resource>, DbError> {
    let normalized = normalize_url(url);

    // Extract host+path for SQL pre-filter (strip scheme)
    let like_pattern = if let Some(pos) = normalized.find("://") {
        format!("%{}%", &normalized[pos + 3..])
    } else {
        format!("%{}%", normalized)
    };

    let mut stmt = conn.prepare(
        "SELECT id, title, url, domain, author, description, folder_id, resource_type, file_path, created_at, captured_at, selection_meta
         FROM resources WHERE url LIKE ?1 AND deleted_at IS NULL",
    )?;
    let resources = stmt
        .query_map(rusqlite::params![like_pattern], |row| {
            Ok(Resource {
                id: row.get(0)?,
                title: row.get(1)?,
                url: row.get(2)?,
                domain: row.get(3)?,
                author: row.get(4)?,
                description: row.get(5)?,
                folder_id: row.get(6)?,
                resource_type: row.get(7)?,
                file_path: row.get(8)?,
                created_at: row.get(9)?,
                captured_at: row.get(10)?,
                selection_meta: row.get(11)?,
            })
        })?
        .filter_map(|r| r.ok())
        .filter(|r| normalize_url(&r.url) == normalized)
        .collect();
    Ok(resources)
}

/// Helper to get tag IDs for a resource (used for sync log payloads).
fn get_tag_ids_for_resource(conn: &Connection, resource_id: &str) -> Result<Vec<String>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT t.id FROM tags t
         JOIN resource_tags rt ON t.id = rt.tag_id
         WHERE rt.resource_id = ?1 AND t.deleted_at IS NULL AND rt.deleted_at IS NULL",
    )?;
    let ids = stmt
        .query_map(params![resource_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{folders, test_db};

    fn create_test_resource(conn: &Connection, folder_id: &str) -> Resource {
        create_resource(
            conn,
            CreateResourceInput {
                id: None,
                title: "Test Page".to_string(),
                url: "https://example.com/article".to_string(),
                domain: Some("example.com".to_string()),
                author: None,
                description: None,
                folder_id: folder_id.to_string(),
                resource_type: "webpage".to_string(),
                file_path: "storage/test/snapshot.mhtml".to_string(),
                captured_at: "2026-01-01T00:00:00Z".to_string(),
                selection_meta: None,
            },
            None,
        )
        .unwrap()
    }

    #[test]
    fn test_create_and_get_resource() {
        let conn = test_db();
        let folder = folders::create_folder(&conn, "docs", "__root__", None).unwrap();
        let resource = create_test_resource(&conn, &folder.id);

        let fetched = get_resource(&conn, &resource.id).unwrap();
        assert_eq!(fetched.title, "Test Page");
        assert_eq!(fetched.url, "https://example.com/article");
    }

    #[test]
    fn test_get_resource_not_found() {
        let conn = test_db();
        let result = get_resource(&conn, "nonexistent");
        assert!(matches!(result, Err(DbError::NotFound(_))));
    }

    #[test]
    fn test_list_resources_by_folder() {
        let conn = test_db();
        let folder = folders::create_folder(&conn, "docs", "__root__", None).unwrap();
        create_test_resource(&conn, &folder.id);
        create_test_resource(&conn, &folder.id);

        let resources = list_resources_by_folder(&conn, &folder.id, SortBy::CreatedAt, SortOrder::Desc).unwrap();
        assert_eq!(resources.len(), 2);
    }

    #[test]
    fn test_move_resource() {
        let conn = test_db();
        let f1 = folders::create_folder(&conn, "a", "__root__", None).unwrap();
        let f2 = folders::create_folder(&conn, "b", "__root__", None).unwrap();
        let resource = create_test_resource(&conn, &f1.id);

        move_resource(&conn, &resource.id, &f2.id, None).unwrap();

        let fetched = get_resource(&conn, &resource.id).unwrap();
        assert_eq!(fetched.folder_id, f2.id);
    }

    #[test]
    fn test_update_resource() {
        let conn = test_db();
        let folder = folders::create_folder(&conn, "docs", "__root__", None).unwrap();
        let resource = create_test_resource(&conn, &folder.id);

        update_resource(&conn, &resource.id, "Updated Title", Some("A description"), None).unwrap();

        let fetched = get_resource(&conn, &resource.id).unwrap();
        assert_eq!(fetched.title, "Updated Title");
        assert_eq!(fetched.description, Some("A description".to_string()));
    }

    #[test]
    fn test_update_resource_clears_description() {
        let conn = test_db();
        let folder = folders::create_folder(&conn, "docs", "__root__", None).unwrap();
        let resource = create_test_resource(&conn, &folder.id);

        update_resource(&conn, &resource.id, "Title", Some("desc"), None).unwrap();
        update_resource(&conn, &resource.id, "Title", None, None).unwrap();

        let fetched = get_resource(&conn, &resource.id).unwrap();
        assert_eq!(fetched.description, None);
    }

    #[test]
    fn test_update_resource_not_found() {
        let conn = test_db();
        let result = update_resource(&conn, "nonexistent", "Title", None, None);
        assert!(matches!(result, Err(DbError::NotFound(_))));
    }

    #[test]
    fn test_delete_resource() {
        let conn = test_db();
        let folder = folders::create_folder(&conn, "docs", "__root__", None).unwrap();
        let resource = create_test_resource(&conn, &folder.id);

        let deleted_id = delete_resource(&conn, &resource.id, None).unwrap();
        assert_eq!(deleted_id, resource.id);

        let result = get_resource(&conn, &resource.id);
        assert!(result.is_err());
    }

    #[test]
    fn test_soft_delete_resource() {
        let conn = test_db();
        let folder = folders::create_folder(&conn, "docs", "__root__", None).unwrap();
        let resource = create_test_resource(&conn, &folder.id);
        delete_resource(&conn, &resource.id, None).unwrap();
        let resources = list_resources_by_folder(&conn, &folder.id, SortBy::CreatedAt, SortOrder::Desc).unwrap();
        assert!(resources.is_empty());
        let deleted_at: Option<String> = conn
            .query_row("SELECT deleted_at FROM resources WHERE id = ?1", params![resource.id], |row| row.get(0))
            .unwrap();
        assert!(deleted_at.is_some());
    }

    #[test]
    fn test_find_by_url_normalized() {
        let conn = test_db();
        let folder = folders::create_folder(&conn, "docs", "__root__", None).unwrap();
        create_test_resource(&conn, &folder.id);

        // Should match with trailing slash
        let found = find_by_url(&conn, "https://example.com/article/").unwrap();
        assert_eq!(found.len(), 1);

        // Should match with fragment
        let found = find_by_url(&conn, "https://example.com/article#section").unwrap();
        assert_eq!(found.len(), 1);

        // Should not match different URL
        let found = find_by_url(&conn, "https://example.com/other").unwrap();
        assert!(found.is_empty());
    }

    #[test]
    fn test_count_by_folder() {
        let conn = test_db();
        let f1 = folders::create_folder(&conn, "a", "__root__", None).unwrap();
        let f2 = folders::create_folder(&conn, "b", "__root__", None).unwrap();

        create_test_resource(&conn, &f1.id);
        create_test_resource(&conn, &f1.id);
        create_test_resource(&conn, &f2.id);

        let counts = count_by_folder(&conn).unwrap();
        assert_eq!(counts.get(&f1.id), Some(&2));
        assert_eq!(counts.get(&f2.id), Some(&1));
    }

    #[test]
    fn test_normalize_url() {
        assert_eq!(
            normalize_url("HTTPS://example.com/page/"),
            "https://example.com/page"
        );
        assert_eq!(
            normalize_url("https://example.com/page#top"),
            "https://example.com/page"
        );
    }

    #[test]
    fn test_create_resource_with_selection_meta() {
        let conn = test_db();
        let folder = folders::create_folder(&conn, "docs", "__root__", None).unwrap();
        let resource = create_resource(
            &conn,
            CreateResourceInput {
                id: None,
                title: "Clipped Article".to_string(),
                url: "https://example.com/article".to_string(),
                domain: Some("example.com".to_string()),
                author: None,
                description: None,
                folder_id: folder.id,
                resource_type: "html".to_string(),
                file_path: "storage/test/snapshot.html".to_string(),
                captured_at: "2026-01-01T00:00:00Z".to_string(),
                selection_meta: Some("{\"selector\":\"article.post\",\"tag_name\":\"article\",\"text_preview\":\"Hello world\"}".to_string()),
            },
            None,
        )
        .unwrap();

        let fetched = get_resource(&conn, &resource.id).unwrap();
        assert_eq!(
            fetched.selection_meta,
            Some("{\"selector\":\"article.post\",\"tag_name\":\"article\",\"text_preview\":\"Hello world\"}".to_string())
        );
    }

    #[test]
    fn test_create_resource_without_selection_meta() {
        let conn = test_db();
        let folder = folders::create_folder(&conn, "docs", "__root__", None).unwrap();
        let resource = create_resource(
            &conn,
            CreateResourceInput {
                id: None,
                title: "Full Page".to_string(),
                url: "https://example.com/page".to_string(),
                domain: Some("example.com".to_string()),
                author: None,
                description: None,
                folder_id: folder.id,
                resource_type: "html".to_string(),
                file_path: "storage/test/snapshot.html".to_string(),
                captured_at: "2026-01-01T00:00:00Z".to_string(),
                selection_meta: None,
            },
            None,
        )
        .unwrap();

        let fetched = get_resource(&conn, &resource.id).unwrap();
        assert_eq!(fetched.selection_meta, None);
    }
}
