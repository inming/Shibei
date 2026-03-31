use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::{now_iso8601, DbError};

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
}

pub fn create_resource(
    conn: &Connection,
    input: CreateResourceInput,
) -> Result<Resource, DbError> {
    let id = input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = now_iso8601();

    conn.execute(
        "INSERT INTO resources (id, title, url, domain, author, description, folder_id, resource_type, file_path, created_at, captured_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
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
        ],
    )?;

    Ok(Resource {
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
    })
}

pub fn get_resource(conn: &Connection, id: &str) -> Result<Resource, DbError> {
    conn.query_row(
        "SELECT id, title, url, domain, author, description, folder_id, resource_type, file_path, created_at, captured_at
         FROM resources WHERE id = ?1",
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
            })
        },
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => DbError::NotFound(format!("resource {}", id)),
        other => DbError::Sqlite(other),
    })
}

pub fn list_resources_by_folder(
    conn: &Connection,
    folder_id: &str,
) -> Result<Vec<Resource>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT id, title, url, domain, author, description, folder_id, resource_type, file_path, created_at, captured_at
         FROM resources WHERE folder_id = ?1
         ORDER BY created_at DESC",
    )?;
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
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(resources)
}

pub fn move_resource(
    conn: &Connection,
    id: &str,
    new_folder_id: &str,
) -> Result<(), DbError> {
    let changed = conn.execute(
        "UPDATE resources SET folder_id = ?1 WHERE id = ?2",
        params![new_folder_id, id],
    )?;
    if changed == 0 {
        return Err(DbError::NotFound(format!("resource {}", id)));
    }
    Ok(())
}

pub fn delete_resource(conn: &Connection, id: &str) -> Result<String, DbError> {
    let changed = conn.execute("DELETE FROM resources WHERE id = ?1", params![id])?;
    if changed == 0 {
        return Err(DbError::NotFound(format!("resource {}", id)));
    }
    Ok(id.to_string())
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

    // We need to check against normalized versions of stored URLs
    let mut stmt = conn.prepare(
        "SELECT id, title, url, domain, author, description, folder_id, resource_type, file_path, created_at, captured_at
         FROM resources",
    )?;
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
            })
        })?
        .filter_map(|r| r.ok())
        .filter(|r| normalize_url(&r.url) == normalized)
        .collect();
    Ok(resources)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{folders, test_db};

    fn create_test_resource(conn: &Connection, folder_id: &str) -> Resource {
        create_resource(
            conn,
            CreateResourceInput { id: None,
                title: "Test Page".to_string(),
                url: "https://example.com/article".to_string(),
                domain: Some("example.com".to_string()),
                author: None,
                description: None,
                folder_id: folder_id.to_string(),
                resource_type: "webpage".to_string(),
                file_path: "storage/test/snapshot.mhtml".to_string(),
                captured_at: "2026-01-01T00:00:00Z".to_string(),
            },
        )
        .unwrap()
    }

    #[test]
    fn test_create_and_get_resource() {
        let conn = test_db();
        let folder = folders::create_folder(&conn, "docs", "__root__").unwrap();
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
        let folder = folders::create_folder(&conn, "docs", "__root__").unwrap();
        create_test_resource(&conn, &folder.id);
        create_test_resource(&conn, &folder.id);

        let resources = list_resources_by_folder(&conn, &folder.id).unwrap();
        assert_eq!(resources.len(), 2);
    }

    #[test]
    fn test_move_resource() {
        let conn = test_db();
        let f1 = folders::create_folder(&conn, "a", "__root__").unwrap();
        let f2 = folders::create_folder(&conn, "b", "__root__").unwrap();
        let resource = create_test_resource(&conn, &f1.id);

        move_resource(&conn, &resource.id, &f2.id).unwrap();

        let fetched = get_resource(&conn, &resource.id).unwrap();
        assert_eq!(fetched.folder_id, f2.id);
    }

    #[test]
    fn test_delete_resource() {
        let conn = test_db();
        let folder = folders::create_folder(&conn, "docs", "__root__").unwrap();
        let resource = create_test_resource(&conn, &folder.id);

        let deleted_id = delete_resource(&conn, &resource.id).unwrap();
        assert_eq!(deleted_id, resource.id);

        let result = get_resource(&conn, &resource.id);
        assert!(result.is_err());
    }

    #[test]
    fn test_find_by_url_normalized() {
        let conn = test_db();
        let folder = folders::create_folder(&conn, "docs", "__root__").unwrap();
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
}
