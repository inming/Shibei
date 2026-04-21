use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::DbError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncLogEntry {
    pub id: i64,
    pub entity_type: String,
    pub entity_id: String,
    pub operation: String,
    pub payload: String,
    pub hlc: String,
    pub device_id: String,
}

pub fn append(
    conn: &Connection,
    entity_type: &str,
    entity_id: &str,
    operation: &str,
    payload: &str,
    hlc: &str,
    device_id: &str,
) -> Result<i64, DbError> {
    conn.execute(
        "INSERT INTO sync_log (entity_type, entity_id, operation, payload, hlc, device_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![entity_type, entity_id, operation, payload, hlc, device_id],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn get_pending(conn: &Connection) -> Result<Vec<SyncLogEntry>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT id, entity_type, entity_id, operation, payload, hlc, device_id
         FROM sync_log WHERE uploaded = 0 ORDER BY id",
    )?;
    let entries = stmt
        .query_map([], |row| {
            Ok(SyncLogEntry {
                id: row.get(0)?,
                entity_type: row.get(1)?,
                entity_id: row.get(2)?,
                operation: row.get(3)?,
                payload: row.get(4)?,
                hlc: row.get(5)?,
                device_id: row.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(entries)
}

pub fn mark_uploaded(conn: &Connection, up_to_id: i64) -> Result<(), DbError> {
    conn.execute(
        "UPDATE sync_log SET uploaded = 1 WHERE id <= ?1 AND uploaded = 0",
        params![up_to_id],
    )?;
    Ok(())
}

pub fn delete_uploaded(conn: &Connection) -> Result<usize, DbError> {
    let count = conn.execute("DELETE FROM sync_log WHERE uploaded = 1", [])?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_db;

    #[test]
    fn test_append_and_get_pending() {
        let conn = test_db();
        append(&conn, "folder", "f1", "INSERT", "{}", "1000-0000-dev1", "dev1").unwrap();
        append(&conn, "resource", "r1", "UPDATE", "{}", "1001-0000-dev1", "dev1").unwrap();
        let pending = get_pending(&conn).unwrap();
        assert_eq!(pending.len(), 2);
        assert_eq!(pending[0].entity_type, "folder");
        assert_eq!(pending[1].entity_type, "resource");
    }

    #[test]
    fn test_mark_uploaded() {
        let conn = test_db();
        let id1 = append(&conn, "folder", "f1", "INSERT", "{}", "1000-0000-d", "d").unwrap();
        let _id2 = append(&conn, "folder", "f2", "INSERT", "{}", "1001-0000-d", "d").unwrap();
        mark_uploaded(&conn, id1).unwrap();
        let pending = get_pending(&conn).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].entity_id, "f2");
    }

    #[test]
    fn test_delete_uploaded() {
        let conn = test_db();
        let id = append(&conn, "folder", "f1", "INSERT", "{}", "1000-0000-d", "d").unwrap();
        mark_uploaded(&conn, id).unwrap();
        let count = delete_uploaded(&conn).unwrap();
        assert_eq!(count, 1);
        let pending = get_pending(&conn).unwrap();
        assert!(pending.is_empty());
    }
}
