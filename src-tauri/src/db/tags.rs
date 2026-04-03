use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::resources::Resource;
use super::{now_iso8601, DbError};
use crate::sync::{self, SyncContext};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color: String,
}

pub fn create_tag(
    conn: &Connection,
    name: &str,
    color: &str,
    sync_ctx: Option<&SyncContext>,
) -> Result<Tag, DbError> {
    let id = uuid::Uuid::new_v4().to_string();
    let hlc_str = sync_ctx.map(|ctx| ctx.clock.tick().to_string());
    conn.execute(
        "INSERT INTO tags (id, name, color, hlc) VALUES (?1, ?2, ?3, ?4)",
        params![id, name, color, hlc_str],
    )?;

    let tag = Tag {
        id,
        name: name.to_string(),
        color: color.to_string(),
    };

    if let Some(ctx) = sync_ctx {
        let payload = serde_json::to_string(&tag)
            .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
        sync::sync_log::append(
            conn,
            "tag",
            &tag.id,
            "INSERT",
            &payload,
            hlc_str.as_deref().unwrap_or(""),
            ctx.device_id,
        )?;
    }

    Ok(tag)
}

pub fn update_tag(
    conn: &Connection,
    id: &str,
    name: &str,
    color: &str,
    sync_ctx: Option<&SyncContext>,
) -> Result<(), DbError> {
    let hlc_str = sync_ctx.map(|ctx| ctx.clock.tick().to_string());
    let changed = conn.execute(
        "UPDATE tags SET name = ?1, color = ?2, hlc = COALESCE(?3, hlc) WHERE id = ?4 AND deleted_at IS NULL",
        params![name, color, hlc_str, id],
    )?;
    if changed == 0 {
        return Err(DbError::NotFound(format!("tag {}", id)));
    }

    if let Some(ctx) = sync_ctx {
        let tag = Tag {
            id: id.to_string(),
            name: name.to_string(),
            color: color.to_string(),
        };
        let payload = serde_json::to_string(&tag)
            .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
        sync::sync_log::append(
            conn,
            "tag",
            id,
            "UPDATE",
            &payload,
            hlc_str.as_deref().unwrap_or(""),
            ctx.device_id,
        )?;
    }

    Ok(())
}

pub fn delete_tag(
    conn: &Connection,
    id: &str,
    sync_ctx: Option<&SyncContext>,
) -> Result<(), DbError> {
    // Serialize before soft-delete
    let tag_before = if sync_ctx.is_some() {
        get_tag(conn, id).ok()
    } else {
        None
    };

    let now = now_iso8601();
    let hlc_str = sync_ctx.map(|ctx| ctx.clock.tick().to_string());
    let changed = conn.execute(
        "UPDATE tags SET deleted_at = ?1, hlc = COALESCE(?2, hlc) WHERE id = ?3 AND deleted_at IS NULL",
        params![now, hlc_str, id],
    )?;
    if changed == 0 {
        return Err(DbError::NotFound(format!("tag {}", id)));
    }
    // Cascade soft-delete to resource_tags
    conn.execute(
        "UPDATE resource_tags SET deleted_at = ?1 WHERE tag_id = ?2 AND deleted_at IS NULL",
        params![now, id],
    )?;

    if let Some(ctx) = sync_ctx {
        if let Some(tag) = tag_before {
            let payload = serde_json::to_string(&tag)
                .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
            sync::sync_log::append(
                conn,
                "tag",
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

fn get_tag(conn: &Connection, id: &str) -> Result<Tag, DbError> {
    conn.query_row(
        "SELECT id, name, color FROM tags WHERE id = ?1 AND deleted_at IS NULL",
        params![id],
        |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
            })
        },
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => DbError::NotFound(format!("tag {}", id)),
        other => DbError::Sqlite(other),
    })
}

pub fn list_tags(conn: &Connection) -> Result<Vec<Tag>, DbError> {
    let mut stmt = conn.prepare("SELECT id, name, color FROM tags WHERE deleted_at IS NULL ORDER BY name")?;
    let tags = stmt
        .query_map([], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(tags)
}

pub fn add_tag_to_resource(
    conn: &Connection,
    resource_id: &str,
    tag_id: &str,
    sync_ctx: Option<&SyncContext>,
) -> Result<(), DbError> {
    let hlc_str = sync_ctx.map(|ctx| ctx.clock.tick().to_string());
    conn.execute(
        "INSERT INTO resource_tags (resource_id, tag_id, hlc) VALUES (?1, ?2, ?3)
         ON CONFLICT(resource_id, tag_id) DO UPDATE SET deleted_at = NULL, hlc = COALESCE(?3, hlc)",
        params![resource_id, tag_id, hlc_str],
    )?;

    // Write sync log for the RESOURCE (tag_ids changed)
    if let Some(ctx) = sync_ctx {
        let resource = super::resources::get_resource(conn, resource_id)?;
        let tag_ids = get_tag_ids_for_resource(conn, resource_id)?;
        let payload = build_resource_with_tags_payload(&resource, &tag_ids);
        sync::sync_log::append(
            conn,
            "resource",
            resource_id,
            "UPDATE",
            &payload,
            hlc_str.as_deref().unwrap_or(""),
            ctx.device_id,
        )?;
    }

    Ok(())
}

pub fn remove_tag_from_resource(
    conn: &Connection,
    resource_id: &str,
    tag_id: &str,
    sync_ctx: Option<&SyncContext>,
) -> Result<(), DbError> {
    let now = now_iso8601();
    let hlc_str = sync_ctx.map(|ctx| ctx.clock.tick().to_string());
    conn.execute(
        "UPDATE resource_tags SET deleted_at = ?1, hlc = COALESCE(?2, hlc) WHERE resource_id = ?3 AND tag_id = ?4 AND deleted_at IS NULL",
        params![now, hlc_str, resource_id, tag_id],
    )?;

    // Write sync log for the RESOURCE (tag_ids changed)
    if let Some(ctx) = sync_ctx {
        let resource = super::resources::get_resource(conn, resource_id)?;
        let tag_ids = get_tag_ids_for_resource(conn, resource_id)?;
        let payload = build_resource_with_tags_payload(&resource, &tag_ids);
        sync::sync_log::append(
            conn,
            "resource",
            resource_id,
            "UPDATE",
            &payload,
            hlc_str.as_deref().unwrap_or(""),
            ctx.device_id,
        )?;
    }

    Ok(())
}

/// Helper: get tag IDs for a resource.
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

/// Build a JSON payload for a resource including tag_ids.
fn build_resource_with_tags_payload(resource: &Resource, tag_ids: &[String]) -> String {
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

pub fn get_tags_for_resource(
    conn: &Connection,
    resource_id: &str,
) -> Result<Vec<Tag>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name, t.color FROM tags t
         JOIN resource_tags rt ON t.id = rt.tag_id
         WHERE rt.resource_id = ?1 AND t.deleted_at IS NULL AND rt.deleted_at IS NULL
         ORDER BY t.name",
    )?;
    let tags = stmt
        .query_map(params![resource_id], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(tags)
}

pub fn get_resources_by_tag(
    conn: &Connection,
    tag_id: &str,
) -> Result<Vec<Resource>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT r.id, r.title, r.url, r.domain, r.author, r.description, r.folder_id, r.resource_type, r.file_path, r.created_at, r.captured_at, r.selection_meta
         FROM resources r
         JOIN resource_tags rt ON r.id = rt.resource_id
         WHERE rt.tag_id = ?1 AND r.deleted_at IS NULL AND rt.deleted_at IS NULL",
    )?;
    let resources = stmt
        .query_map(params![tag_id], |row| {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{folders, resources, test_db};

    #[test]
    fn test_create_tag() {
        let conn = test_db();
        let tag = create_tag(&conn, "rust", "#FF5733", None).unwrap();
        assert_eq!(tag.name, "rust");
        assert_eq!(tag.color, "#FF5733");
    }

    #[test]
    fn test_create_duplicate_tag_rejected() {
        let conn = test_db();
        create_tag(&conn, "rust", "#FF5733", None).unwrap();
        let result = create_tag(&conn, "rust", "#000000", None);
        assert!(result.is_err());
    }

    #[test]
    fn test_update_tag() {
        let conn = test_db();
        let tag = create_tag(&conn, "old", "#000", None).unwrap();
        update_tag(&conn, &tag.id, "new", "#FFF", None).unwrap();

        let tags = list_tags(&conn).unwrap();
        assert_eq!(tags[0].name, "new");
        assert_eq!(tags[0].color, "#FFF");
    }

    #[test]
    fn test_delete_tag() {
        let conn = test_db();
        let tag = create_tag(&conn, "temp", "#000", None).unwrap();
        delete_tag(&conn, &tag.id, None).unwrap();

        let tags = list_tags(&conn).unwrap();
        assert!(tags.is_empty());
    }

    #[test]
    fn test_tag_resource_association() {
        let conn = test_db();
        let folder = folders::create_folder(&conn, "docs", "__root__", None).unwrap();
        let resource = resources::create_resource(
            &conn,
            resources::CreateResourceInput {
                id: None,
                title: "test".to_string(),
                url: "https://example.com".to_string(),
                domain: None,
                author: None,
                description: None,
                folder_id: folder.id.clone(),
                resource_type: "webpage".to_string(),
                file_path: "x".to_string(),
                captured_at: "2026-01-01".to_string(),
                selection_meta: None,
            },
            None,
        )
        .unwrap();

        let tag = create_tag(&conn, "tech", "#00F", None).unwrap();
        add_tag_to_resource(&conn, &resource.id, &tag.id, None).unwrap();

        let tags = get_tags_for_resource(&conn, &resource.id).unwrap();
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].name, "tech");

        let resources = get_resources_by_tag(&conn, &tag.id).unwrap();
        assert_eq!(resources.len(), 1);

        remove_tag_from_resource(&conn, &resource.id, &tag.id, None).unwrap();
        let tags = get_tags_for_resource(&conn, &resource.id).unwrap();
        assert!(tags.is_empty());
    }

    #[test]
    fn test_delete_tag_removes_associations() {
        let conn = test_db();
        let folder = folders::create_folder(&conn, "docs", "__root__", None).unwrap();
        let resource = resources::create_resource(
            &conn,
            resources::CreateResourceInput {
                id: None,
                title: "test".to_string(),
                url: "https://example.com".to_string(),
                domain: None,
                author: None,
                description: None,
                folder_id: folder.id.clone(),
                resource_type: "webpage".to_string(),
                file_path: "x".to_string(),
                captured_at: "2026-01-01".to_string(),
                selection_meta: None,
            },
            None,
        )
        .unwrap();

        let tag = create_tag(&conn, "temp", "#000", None).unwrap();
        add_tag_to_resource(&conn, &resource.id, &tag.id, None).unwrap();
        delete_tag(&conn, &tag.id, None).unwrap();

        let tags = get_tags_for_resource(&conn, &resource.id).unwrap();
        assert!(tags.is_empty());
    }
}
