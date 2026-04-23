use rusqlite::Connection;
use shibei_db::DbError;
use super::sync_state;

/// Store S3 credentials. Writes the OS keychain as the canonical store;
/// the SQLite `sync_state` rows are **not** touched here — they only exist
/// as legacy fallback for installs that predate the keychain migration and
/// haven't been migrated yet (see `migrate_credentials_to_keystore`).
///
/// Returns `DbError::Generic` wrapping the keystore error if the platform
/// keychain is unavailable; callers on desktop should surface this to the
/// user rather than silently degrading to SQLite — the whole point of this
/// path is to keep plaintext off disk.
pub fn store_credentials(_conn: &Connection, access_key: &str, secret_key: &str) -> Result<(), DbError> {
    crate::os_keystore::save_s3_credentials(access_key, secret_key)
        .map_err(|e| DbError::InvalidOperation(format!("keystore save failed: {e}")))
}

/// Load S3 credentials. Prefers the OS keychain; falls back to the legacy
/// SQLite `sync_state` rows if the keychain is empty or errors. The SQLite
/// fallback exists so an install with already-migrated creds in the DB can
/// still sync while the user hasn't yet re-saved (or the one-shot startup
/// migration hasn't run because the keychain is temporarily unavailable).
/// Returns `None` only when both sources are empty.
pub fn load_credentials(conn: &Connection) -> Result<Option<(String, String)>, DbError> {
    match crate::os_keystore::load_s3_credentials() {
        Ok(Some(creds)) => return Ok(Some(creds)),
        Ok(None) => { /* fall through to SQLite */ }
        Err(e) => {
            // Keystore platform error (headless Linux, locked keychain).
            // Don't fail the whole sync — try SQLite so the user's current
            // session keeps working. They'll still see the entry reappear
            // in the keystore next startup via migration retry.
            eprintln!("[credentials] keystore read failed, falling back to sync_state: {e}");
        }
    }
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

/// Delete stored credentials from both the OS keychain and the legacy
/// SQLite rows. Best-effort on the keychain side (no-op if no entry) so a
/// user clearing creds doesn't get blocked by a keychain glitch.
pub fn delete_credentials(conn: &Connection) -> Result<(), DbError> {
    if let Err(e) = crate::os_keystore::delete_s3_credentials() {
        eprintln!("[credentials] keystore delete failed (continuing): {e}");
    }
    sync_state::delete(conn, "config:s3_access_key")?;
    sync_state::delete(conn, "config:s3_secret_key")?;
    Ok(())
}

/// Phase 4 migration helper: delete the SQLite credentials rows after the
/// creds have been moved elsewhere (mobile → HUKS blob, desktop → OS
/// keychain). Only touches the SQLite side — does NOT evict the keystore
/// entry. Idempotent.
pub fn clear_credentials(conn: &Connection) -> Result<(), DbError> {
    sync_state::delete(conn, "config:s3_access_key")?;
    sync_state::delete(conn, "config:s3_secret_key")?;
    Ok(())
}

/// Desktop-only one-shot migration: if SQLite has legacy creds AND the OS
/// keychain has no entry yet, copy them over and then clear the SQLite
/// rows. Best-effort — a keystore save failure (e.g., Linux without a
/// secret-service daemon) leaves the SQLite rows in place so the current
/// session still syncs via the `load_credentials` fallback. Next startup
/// retries the migration.
///
/// Returns `Ok(true)` when a migration actually happened this call, `Ok(false)`
/// when there's nothing to do or the keystore already has creds. Errors
/// bubble up only for DbError sources (sync_state read); keystore errors
/// become `Ok(false)` + a log line so startup isn't blocked.
pub fn migrate_credentials_to_keystore(conn: &Connection) -> Result<bool, DbError> {
    // Already migrated? Nothing to do.
    match crate::os_keystore::load_s3_credentials() {
        Ok(Some(_)) => return Ok(false),
        Ok(None) => {}
        Err(e) => {
            eprintln!("[credentials] migration: keystore probe failed, skipping: {e}");
            return Ok(false);
        }
    }
    let Some(ak) = sync_state::get(conn, "config:s3_access_key")?.filter(|v| !v.is_empty()) else {
        return Ok(false);
    };
    let Some(sk) = sync_state::get(conn, "config:s3_secret_key")?.filter(|v| !v.is_empty()) else {
        return Ok(false);
    };
    if let Err(e) = crate::os_keystore::save_s3_credentials(&ak, &sk) {
        eprintln!("[credentials] migration: keystore save failed, keeping SQLite rows: {e}");
        return Ok(false);
    }
    sync_state::delete(conn, "config:s3_access_key")?;
    sync_state::delete(conn, "config:s3_secret_key")?;
    Ok(true)
}
