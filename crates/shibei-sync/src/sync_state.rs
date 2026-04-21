use rusqlite::{params, Connection};

use shibei_db::DbError;

pub fn get(conn: &Connection, key: &str) -> Result<Option<String>, DbError> {
    let mut stmt = conn.prepare("SELECT value FROM sync_state WHERE key = ?1")?;
    let result = stmt.query_row(params![key], |row| row.get(0));
    match result {
        Ok(value) => Ok(Some(value)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(DbError::Sqlite(e)),
    }
}

pub fn set(conn: &Connection, key: &str, value: &str) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO sync_state (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, key: &str) -> Result<(), DbError> {
    conn.execute("DELETE FROM sync_state WHERE key = ?1", params![key])?;
    Ok(())
}

pub fn list_by_prefix(conn: &Connection, prefix: &str) -> Result<Vec<(String, String)>, DbError> {
    let pattern = format!("{}%", prefix);
    let mut stmt =
        conn.prepare("SELECT key, value FROM sync_state WHERE key LIKE ?1 ORDER BY key")?;
    let rows = stmt.query_map(params![pattern], |row| Ok((row.get(0)?, row.get(1)?)))?;
    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

/// Return all resource IDs that have pending snapshot downloads.
pub fn get_pending_snapshot_ids(conn: &Connection) -> Result<Vec<String>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT key FROM sync_state WHERE key LIKE 'snapshot:%' AND value = 'pending'"
    )?;
    let ids = stmt
        .query_map([], |row| {
            let key: String = row.get(0)?;
            Ok(key.strip_prefix("snapshot:").unwrap_or("").to_string())
        })?
        .filter_map(|r| r.ok())
        .filter(|id| !id.is_empty())
        .collect();
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use shibei_db::test_db;

    #[test]
    fn test_get_set_roundtrip() {
        let conn = test_db();
        assert_eq!(get(&conn, "foo").unwrap(), None);
        set(&conn, "foo", "bar").unwrap();
        assert_eq!(get(&conn, "foo").unwrap(), Some("bar".to_string()));
    }

    #[test]
    fn test_set_upsert() {
        let conn = test_db();
        set(&conn, "k", "v1").unwrap();
        set(&conn, "k", "v2").unwrap();
        assert_eq!(get(&conn, "k").unwrap(), Some("v2".to_string()));
    }

    #[test]
    fn test_delete() {
        let conn = test_db();
        set(&conn, "k", "v").unwrap();
        delete(&conn, "k").unwrap();
        assert_eq!(get(&conn, "k").unwrap(), None);
    }

    #[test]
    fn test_list_by_prefix() {
        let conn = test_db();
        set(&conn, "config:a", "1").unwrap();
        set(&conn, "config:b", "2").unwrap();
        set(&conn, "other:c", "3").unwrap();
        let results = list_by_prefix(&conn, "config:").unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0], ("config:a".to_string(), "1".to_string()));
    }
}
