use std::path::Path;
use std::sync::Arc;

use rusqlite::Connection;

/// Config read from DB for building a SyncEngine.
pub struct SyncEngineConfig {
    pub region: String,
    pub bucket: String,
    pub endpoint: String,
    pub access_key: String,
    pub secret_key: String,
    pub local_encryption_enabled: bool,
}

/// Read sync config from DB. Called synchronously before any await so that
/// `&Connection` does not need to be held across `.await` points.
pub fn read_sync_config(conn: &Connection) -> Result<SyncEngineConfig, String> {
    let local_encryption_enabled =
        crate::sync::sync_state::get(conn, "config:encryption_enabled")
            .map_err(|e| e.to_string())?
            .map(|v| v == "true")
            .unwrap_or(false);

    let region = crate::sync::sync_state::get(conn, "config:s3_region")
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "error.syncRegionNotSet".to_string())?;
    let bucket = crate::sync::sync_state::get(conn, "config:s3_bucket")
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "error.syncBucketNotSet".to_string())?;
    let endpoint = crate::sync::sync_state::get(conn, "config:s3_endpoint")
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    let (access_key, secret_key) = crate::sync::credentials::load_credentials(conn)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "error.syncCredentialsNotSet".to_string())?;

    Ok(SyncEngineConfig {
        region,
        bucket,
        endpoint,
        access_key,
        secret_key,
        local_encryption_enabled,
    })
}

/// Build a SyncEngine from pre-read config. Async-safe: no `&Connection` parameter.
pub async fn build_sync_engine(
    config: SyncEngineConfig,
    pool: crate::db::SharedPool,
    base_dir: &Path,
    device_id: &str,
    encryption_state: &crate::sync::EncryptionState,
) -> Result<crate::sync::engine::SyncEngine, String> {
    let s3_config = crate::sync::backend::S3Config {
        endpoint: if config.endpoint.is_empty() {
            None
        } else {
            Some(config.endpoint)
        },
        region: config.region,
        bucket: config.bucket,
        access_key: config.access_key,
        secret_key: config.secret_key,
    };
    let s3_backend =
        crate::sync::backend::S3Backend::new(s3_config).map_err(|e| e.to_string())?;

    // Determine if encryption is needed.
    let encryption_enabled = if config.local_encryption_enabled {
        true
    } else {
        use crate::sync::backend::SyncBackend;
        let remote_has_keyring = s3_backend
            .head("meta/keyring.json")
            .await
            .map(|meta| meta.is_some())
            .unwrap_or(false);
        remote_has_keyring
    };

    let backend: Arc<dyn crate::sync::backend::SyncBackend> = if encryption_enabled {
        let mk = encryption_state
            .get_key()
            .ok_or_else(|| "error.encryptionNotUnlocked".to_string())?;
        Arc::new(crate::sync::encrypted_backend::EncryptedBackend::new(
            Arc::new(s3_backend),
            mk,
        ))
    } else {
        Arc::new(s3_backend)
    };

    let clock = Arc::new(crate::sync::hlc::HlcClock::new(device_id.to_string()));

    Ok(crate::sync::engine::SyncEngine::new(
        pool,
        backend,
        device_id.to_string(),
        clock,
        base_dir.to_path_buf(),
    ))
}

/// Self-heal: if encryption is enabled but the first post-encryption sync
/// never completed, reset sync state to force full re-sync.
/// Must be called AFTER `build_sync_engine` (so credentials + unlock are verified)
/// but BEFORE `engine.sync()` so the reset takes effect on this sync.
pub fn reset_for_first_encryption_sync(conn: &Connection) -> Result<(), String> {
    let encryption_enabled = crate::sync::sync_state::get(conn, "config:encryption_enabled")
        .map_err(|e| e.to_string())?
        .map(|v| v == "true")
        .unwrap_or(false);
    let sync_completed = crate::sync::sync_state::get(conn, "config:encryption_sync_completed")
        .map_err(|e| e.to_string())?
        .map(|v| v == "true")
        .unwrap_or(false);

    if encryption_enabled && !sync_completed {
        eprintln!("[sync] Encryption enabled but first sync not completed — resetting sync state");
        conn.execute("UPDATE sync_log SET uploaded = 0", [])
            .map_err(|e| e.to_string())?;
        let remote_keys =
            crate::sync::sync_state::list_by_prefix(conn, "remote:")
                .map_err(|e| e.to_string())?;
        for (key, _) in &remote_keys {
            crate::sync::sync_state::delete(conn, key).map_err(|e| e.to_string())?;
        }
        crate::sync::sync_state::delete(conn, "last_sync_at")
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Mark the first post-encryption sync as completed so future syncs don't
/// re-trigger the self-heal reset.
pub fn mark_encryption_sync_completed(conn: &Connection) -> Result<(), String> {
    if crate::sync::sync_state::get(conn, "config:encryption_enabled")
        .map_err(|e| e.to_string())?
        .map(|v| v == "true")
        .unwrap_or(false)
    {
        crate::sync::sync_state::set(conn, "config:encryption_sync_completed", "true")
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
