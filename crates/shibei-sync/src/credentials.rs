use rusqlite::Connection;
use shibei_db::DbError;
use super::sync_state;

/// Store S3 credentials in sync_state table.
pub fn store_credentials(conn: &Connection, access_key: &str, secret_key: &str) -> Result<(), DbError> {
    sync_state::set(conn, "config:s3_access_key", access_key)?;
    sync_state::set(conn, "config:s3_secret_key", secret_key)?;
    Ok(())
}

/// Load S3 credentials from sync_state table.
/// Returns None if either key is missing.
pub fn load_credentials(conn: &Connection) -> Result<Option<(String, String)>, DbError> {
    let access_key = match sync_state::get(conn, "config:s3_access_key")? {
        Some(v) if !v.is_empty() => v,
        _ => return Ok(None),
    };
    let secret_key = match sync_state::get(conn, "config:s3_secret_key")? {
        Some(v) if !v.is_empty() => v,
        _ => return Ok(None),
    };
    Ok(Some((access_key, secret_key)))
}

/// Delete stored credentials.
pub fn delete_credentials(conn: &Connection) -> Result<(), DbError> {
    sync_state::delete(conn, "config:s3_access_key")?;
    sync_state::delete(conn, "config:s3_secret_key")?;
    Ok(())
}

/// Phase 4 migration helper: delete the SQLite credentials rows after ArkTS
/// moved them into secure/s3_creds.blob. Idempotent.
///
/// Credentials live as two rows in `sync_state` (`config:s3_access_key` and
/// `config:s3_secret_key`); this is a thin alias over `delete_credentials`
/// so the NAPI call site reads cleanly.
pub fn clear_credentials(conn: &Connection) -> Result<(), DbError> {
    delete_credentials(conn)
}
