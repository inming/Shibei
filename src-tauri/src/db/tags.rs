use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::resources::Resource;
use super::DbError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color: String,
}

pub fn create_tag(conn: &Connection, name: &str, color: &str) -> Result<Tag, DbError> {
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO tags (id, name, color) VALUES (?1, ?2, ?3)",
        params![id, name, color],
    )?;
    Ok(Tag {
        id,
        name: name.to_string(),
        color: color.to_string(),
    })
}

pub fn update_tag(conn: &Connection, id: &str, name: &str, color: &str) -> Result<(), DbError> {
    let changed = conn.execute(
        "UPDATE tags SET name = ?1, color = ?2 WHERE id = ?3",
        params![name, color, id],
    )?;
    if changed == 0 {
        return Err(DbError::NotFound(format!("tag {}", id)));
    }
    Ok(())
}

pub fn delete_tag(conn: &Connection, id: &str) -> Result<(), DbError> {
    let changed = conn.execute("DELETE FROM tags WHERE id = ?1", params![id])?;
    if changed == 0 {
        return Err(DbError::NotFound(format!("tag {}", id)));
    }
    Ok(())
}

pub fn list_tags(conn: &Connection) -> Result<Vec<Tag>, DbError> {
    let mut stmt = conn.prepare("SELECT id, name, color FROM tags ORDER BY name")?;
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
) -> Result<(), DbError> {
    conn.execute(
        "INSERT OR IGNORE INTO resource_tags (resource_id, tag_id) VALUES (?1, ?2)",
        params![resource_id, tag_id],
    )?;
    Ok(())
}

pub fn remove_tag_from_resource(
    conn: &Connection,
    resource_id: &str,
    tag_id: &str,
) -> Result<(), DbError> {
    conn.execute(
        "DELETE FROM resource_tags WHERE resource_id = ?1 AND tag_id = ?2",
        params![resource_id, tag_id],
    )?;
    Ok(())
}

pub fn get_tags_for_resource(
    conn: &Connection,
    resource_id: &str,
) -> Result<Vec<Tag>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name, t.color FROM tags t
         JOIN resource_tags rt ON t.id = rt.tag_id
         WHERE rt.resource_id = ?1
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
        "SELECT r.id, r.title, r.url, r.domain, r.author, r.description, r.folder_id, r.resource_type, r.file_path, r.created_at, r.captured_at
         FROM resources r
         JOIN resource_tags rt ON r.id = rt.resource_id
         WHERE rt.tag_id = ?1",
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
        let tag = create_tag(&conn, "rust", "#FF5733").unwrap();
        assert_eq!(tag.name, "rust");
        assert_eq!(tag.color, "#FF5733");
    }

    #[test]
    fn test_create_duplicate_tag_rejected() {
        let conn = test_db();
        create_tag(&conn, "rust", "#FF5733").unwrap();
        let result = create_tag(&conn, "rust", "#000000");
        assert!(result.is_err());
    }

    #[test]
    fn test_update_tag() {
        let conn = test_db();
        let tag = create_tag(&conn, "old", "#000").unwrap();
        update_tag(&conn, &tag.id, "new", "#FFF").unwrap();

        let tags = list_tags(&conn).unwrap();
        assert_eq!(tags[0].name, "new");
        assert_eq!(tags[0].color, "#FFF");
    }

    #[test]
    fn test_delete_tag() {
        let conn = test_db();
        let tag = create_tag(&conn, "temp", "#000").unwrap();
        delete_tag(&conn, &tag.id).unwrap();

        let tags = list_tags(&conn).unwrap();
        assert!(tags.is_empty());
    }

    #[test]
    fn test_tag_resource_association() {
        let conn = test_db();
        let folder = folders::create_folder(&conn, "docs", "__root__").unwrap();
        let resource = resources::create_resource(
            &conn,
            resources::CreateResourceInput {
                title: "test".to_string(),
                url: "https://example.com".to_string(),
                domain: None,
                author: None,
                description: None,
                folder_id: folder.id.clone(),
                resource_type: "webpage".to_string(),
                file_path: "x".to_string(),
                captured_at: "2026-01-01".to_string(),
            },
        )
        .unwrap();

        let tag = create_tag(&conn, "tech", "#00F").unwrap();
        add_tag_to_resource(&conn, &resource.id, &tag.id).unwrap();

        let tags = get_tags_for_resource(&conn, &resource.id).unwrap();
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].name, "tech");

        let resources = get_resources_by_tag(&conn, &tag.id).unwrap();
        assert_eq!(resources.len(), 1);

        remove_tag_from_resource(&conn, &resource.id, &tag.id).unwrap();
        let tags = get_tags_for_resource(&conn, &resource.id).unwrap();
        assert!(tags.is_empty());
    }

    #[test]
    fn test_delete_tag_removes_associations() {
        let conn = test_db();
        let folder = folders::create_folder(&conn, "docs", "__root__").unwrap();
        let resource = resources::create_resource(
            &conn,
            resources::CreateResourceInput {
                title: "test".to_string(),
                url: "https://example.com".to_string(),
                domain: None,
                author: None,
                description: None,
                folder_id: folder.id.clone(),
                resource_type: "webpage".to_string(),
                file_path: "x".to_string(),
                captured_at: "2026-01-01".to_string(),
            },
        )
        .unwrap();

        let tag = create_tag(&conn, "temp", "#000").unwrap();
        add_tag_to_resource(&conn, &resource.id, &tag.id).unwrap();
        delete_tag(&conn, &tag.id).unwrap();

        let tags = get_tags_for_resource(&conn, &resource.id).unwrap();
        assert!(tags.is_empty());
    }
}
