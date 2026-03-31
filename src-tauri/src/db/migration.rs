use rusqlite::Connection;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum MigrationError {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("migration {version} failed: {reason}")]
    Failed { version: u32, reason: String },
}

struct Migration {
    version: u32,
    sql: &'static str,
}

const MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    sql: include_str!("../../migrations/001_init.sql"),
}];

pub fn run_migrations(conn: &mut Connection) -> Result<(), MigrationError> {
    let current_version: u32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;

    for migration in MIGRATIONS {
        if migration.version <= current_version {
            continue;
        }

        let tx = conn.transaction()?;
        tx.execute_batch(migration.sql).map_err(|e| MigrationError::Failed {
            version: migration.version,
            reason: e.to_string(),
        })?;
        tx.pragma_update(None, "user_version", migration.version)?;
        tx.commit()?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn tables_in(conn: &Connection) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .unwrap();
        stmt.query_map([], |row| row.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    }

    #[test]
    fn test_fresh_migration_creates_all_tables() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        run_migrations(&mut conn).unwrap();

        let tables = tables_in(&conn);
        assert!(tables.contains(&"folders".to_string()));
        assert!(tables.contains(&"resources".to_string()));
        assert!(tables.contains(&"tags".to_string()));
        assert!(tables.contains(&"resource_tags".to_string()));
        assert!(tables.contains(&"highlights".to_string()));
        assert!(tables.contains(&"comments".to_string()));
    }

    #[test]
    fn test_migration_is_idempotent() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        run_migrations(&mut conn).unwrap();
        run_migrations(&mut conn).unwrap();

        let version: u32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 1);
    }

    #[test]
    fn test_migration_sets_version() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();

        let before: u32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(before, 0);

        run_migrations(&mut conn).unwrap();

        let after: u32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(after, 1);
    }

    #[test]
    fn test_virtual_root_node_exists() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        run_migrations(&mut conn).unwrap();

        let root_name: String = conn
            .query_row("SELECT name FROM folders WHERE id = '__root__'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(root_name, "root");
    }

    #[test]
    fn test_foreign_key_constraint_enforced() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        run_migrations(&mut conn).unwrap();

        let result = conn.execute(
            "INSERT INTO resources (id, title, url, folder_id, resource_type, file_path, created_at, captured_at)
             VALUES ('r1', 'test', 'http://x', 'nonexistent', 'webpage', 'x', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_unique_folder_name_per_parent() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        run_migrations(&mut conn).unwrap();

        conn.execute(
            "INSERT INTO folders (id, name, parent_id, sort_order, created_at, updated_at)
             VALUES ('f1', 'tech', '__root__', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();

        let result = conn.execute(
            "INSERT INTO folders (id, name, parent_id, sort_order, created_at, updated_at)
             VALUES ('f2', 'tech', '__root__', 2, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        );
        assert!(result.is_err());
    }
}
