pub mod comments;
pub mod folders;
pub mod highlights;
pub mod hlc;
pub mod migration;
pub mod resources;
pub mod search;
pub mod sync_log;
pub mod tags;

/// Context passed to CRUD functions for sync log tracking.
/// When None is passed, sync logging is skipped (e.g., tests, remote apply).
///
/// Conceptually this belongs to the sync layer, but the CRUD functions in this
/// crate need to append sync_log rows in the same transaction as domain
/// writes, so the context is defined alongside them.
pub struct SyncContext<'a> {
    pub clock: &'a hlc::HlcClock,
    pub device_id: &'a str,
}

use std::path::Path;

use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::Connection;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum DbError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("migration error: {0}")]
    Migration(#[from] migration::MigrationError),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("invalid operation: {0}")]
    InvalidOperation(String),
    #[error("pool error: {0}")]
    Pool(#[from] r2d2::Error),
}

pub type DbPool = Pool<SqliteConnectionManager>;
pub type SharedPool = std::sync::Arc<std::sync::RwLock<DbPool>>;

/// Customizer that enables foreign keys on every new connection.
#[derive(Debug)]
struct ForeignKeyCustomizer;

impl r2d2::CustomizeConnection<Connection, rusqlite::Error> for ForeignKeyCustomizer {
    fn on_acquire(&self, conn: &mut Connection) -> Result<(), rusqlite::Error> {
        conn.execute_batch("PRAGMA foreign_keys = ON")?;
        Ok(())
    }
}

/// Test helper: open a single-connection DB with migrations applied.
/// Gated by the `test-support` feature so downstream crates can use it from
/// their own test suites without this symbol bloating production builds.
#[cfg(any(test, feature = "test-support"))]
pub fn init_db(db_path: &Path) -> Result<Connection, DbError> {
    let mut conn = Connection::open(db_path)?;
    conn.execute_batch("PRAGMA foreign_keys = ON")?;
    migration::run_migrations(&mut conn)?;
    Ok(conn)
}

/// Create a connection pool. Runs migrations on a temporary connection first,
/// then builds a pool with the ForeignKeyCustomizer.
pub fn init_pool(db_path: &Path) -> Result<DbPool, DbError> {
    // Run migrations on a temporary connection (FK enabled for referential integrity during migration)
    let mut migration_conn = Connection::open(db_path)?;
    migration_conn.execute_batch("PRAGMA foreign_keys = ON")?;
    migration::run_migrations(&mut migration_conn)?;
    drop(migration_conn);

    // Build pool (4 connections: sufficient for single-user desktop app)
    let manager = SqliteConnectionManager::file(db_path);
    let pool = Pool::builder()
        .max_size(4)
        .connection_customizer(Box::new(ForeignKeyCustomizer))
        .build(manager)?;

    Ok(pool)
}

pub fn now_iso8601() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Create an in-memory database with migrations applied, for testing.
/// Gated by the `test-support` feature so downstream crates can use it from
/// their own test suites.
#[cfg(any(test, feature = "test-support"))]
pub fn test_db() -> Connection {
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
    migration::run_migrations(&mut conn).unwrap();
    conn
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_init_db_creates_database() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");

        let conn = init_db(&db_path).unwrap();

        let version: u32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 7);

        let fk_enabled: bool = conn
            .pragma_query_value(None, "foreign_keys", |row| row.get(0))
            .unwrap();
        assert!(fk_enabled);
    }

    #[test]
    fn test_init_db_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");

        let _conn1 = init_db(&db_path).unwrap();
        drop(_conn1);
        let conn2 = init_db(&db_path).unwrap();

        let version: u32 = conn2
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 7);
    }

    #[test]
    fn test_init_pool_creates_pool() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");

        let pool = init_pool(&db_path).unwrap();
        let conn = pool.get().unwrap();

        let version: u32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 7);

        let fk_enabled: bool = conn
            .pragma_query_value(None, "foreign_keys", |row| row.get(0))
            .unwrap();
        assert!(fk_enabled);
    }

    #[test]
    fn test_pool_connections_have_foreign_keys() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");

        let pool = init_pool(&db_path).unwrap();

        for _ in 0..3 {
            let conn = pool.get().unwrap();
            let fk_enabled: bool = conn
                .pragma_query_value(None, "foreign_keys", |row| row.get(0))
                .unwrap();
            assert!(fk_enabled, "foreign_keys should be enabled on every pool connection");
        }
    }

    #[test]
    fn test_fts5_trigram_available() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE VIRTUAL TABLE fts_test USING fts5(content, tokenize='trigram')"
        ).expect("FTS5 trigram tokenizer not available in bundled SQLite");
        conn.execute(
            "INSERT INTO fts_test (content) VALUES (?1)",
            rusqlite::params!["深度学习是机器学习的一个分支"],
        ).unwrap();
        let count: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM fts_test WHERE fts_test MATCH '\"机器学习\"'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "FTS5 trigram should match Chinese substring");
    }
}
