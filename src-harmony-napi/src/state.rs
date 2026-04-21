//! Global `AppState` singleton — the single source of truth every NAPI
//! command reaches into.
//!
//! Initialised exactly once by ArkTS calling `init(dataDir)` very early in
//! app startup (before any other command). Subsequent commands read via
//! `state::get()`; if init hasn't run they receive `error.notInitialized`.
//!
//! What lives here (all cheaply clonable handles / Arcs):
//!   - `data_dir`         — the on-device sandbox path under el2/base/haps
//!   - `db_pool`          — `SharedPool` from shibei-db (write-lock is taken
//!                          only for backup/restore swap; Phase 2 doesn't do
//!                          either, so in practice it's always a read lock)
//!   - `encryption`       — the decrypted Master Key, once `setE2EEPassword`
//!                          has run successfully. Wrapped in `Mutex<Option<…>>`
//!                          so `lockVault()` can clear it without rebuilding
//!                          the state.
//!   - `device_id`        — UUID written to `sync_state` on first init, stable
//!                          across runs; used as HLC node id for this device.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use shibei_db::{init_pool, SharedPool};
use shibei_sync::EncryptionState;

pub struct AppState {
    pub data_dir: PathBuf,
    pub db_pool: SharedPool,
    pub encryption: Arc<EncryptionState>,
    pub device_id: String,
}

static APP_STATE: OnceLock<AppState> = OnceLock::new();

/// One-shot initialisation. Safe to call multiple times — subsequent calls
/// return the first-initialised state unchanged (important because ArkTS may
/// replay init after a page reload during dev).
pub fn init(data_dir: PathBuf) -> Result<(), String> {
    if APP_STATE.get().is_some() {
        return Ok(());
    }

    std::fs::create_dir_all(&data_dir).map_err(|e| format!("error.createDataDir: {e}"))?;
    let db_path = data_dir.join("shibei.db");

    let pool = init_pool(&db_path).map_err(|e| format!("error.openDb: {e}"))?;
    let shared_pool: SharedPool = Arc::new(std::sync::RwLock::new(pool));

    let device_id = load_or_init_device_id(&shared_pool)?;
    ensure_inbox(&shared_pool)?;
    ensure_ca_bundle(&data_dir)?;

    let state = AppState {
        data_dir,
        db_pool: shared_pool,
        encryption: Arc::new(EncryptionState::new()),
        device_id,
    };

    // If two threads race into init at the same time we pick one winner; the
    // loser sees its `state` dropped here with zero side effect beyond the
    // DbPool it briefly held (still safe — the pool didn't open any
    // connections yet beyond the migration one).
    let _ = APP_STATE.set(state);
    Ok(())
}

pub fn get() -> Result<&'static AppState, String> {
    APP_STATE.get().ok_or_else(|| "error.notInitialized".to_string())
}

/// System-preset "收件箱" folder — mirrors desktop's `ensure_inbox_folder()`
/// called at Tauri setup time. Without this, the very first listFolders() on
/// a fresh mobile install returns `[]`, which breaks the Library page's
/// default selection. Idempotent.
fn ensure_inbox(pool: &SharedPool) -> Result<(), String> {
    let pool_read = pool.read().map_err(|e| format!("error.poolPoisoned: {e}"))?;
    let conn = pool_read.get().map_err(|e| format!("error.dbConn: {e}"))?;
    shibei_db::folders::ensure_inbox_folder(&conn, None)
        .map_err(|e| format!("error.seedInbox: {e}"))?;
    Ok(())
}

/// HarmonyOS sandbox does not expose a system trust store where
/// `rustls-native-certs` can find PEM roots — rust-s3's hyper-rustls
/// stack otherwise rejects every S3 endpoint with `invalid peer
/// certificate: UnknownIssuer`.
///
/// Ship the Mozilla root CA bundle (curl's `cacert.pem`, ~226 KB) as a
/// compile-time embedded asset, write it to `$data_dir/ca-bundle.pem`
/// on first launch, and point `SSL_CERT_FILE` at it. `rustls-native-certs`
/// reads that env var on every platform — see its lib.rs header.
///
/// Refresh the bundle periodically by re-downloading
/// https://curl.se/ca/cacert.pem into `src-harmony-napi/ca-bundle.pem`.
///
/// FIXME(tech-debt 2026-04-21): include_bytes! adds ~300 KB to every
/// release .so and couples CA trust updates to Rust rebuilds. Preferred
/// replacement is to ship cacert.pem as a HAP rawfile resource and
/// accept its path through initApp(dataDir, caBundlePath). See
/// docs/superpowers/techdebt/2026-04-21-harmony-tls-ca-bundle.md.
static CA_BUNDLE_PEM: &[u8] = include_bytes!("../ca-bundle.pem");

fn ensure_ca_bundle(data_dir: &std::path::Path) -> Result<(), String> {
    let bundle_path = data_dir.join("ca-bundle.pem");
    // Always (re)write — the embedded bundle may have been updated in a
    // new release; the file is ~226 KB and the write is I/O-cheap on el2.
    if bundle_path.metadata().map(|m| m.len()).ok() != Some(CA_BUNDLE_PEM.len() as u64) {
        std::fs::write(&bundle_path, CA_BUNDLE_PEM)
            .map_err(|e| format!("error.writeCaBundle: {e}"))?;
    }
    std::env::set_var("SSL_CERT_FILE", &bundle_path);
    Ok(())
}

fn load_or_init_device_id(pool: &SharedPool) -> Result<String, String> {
    let pool_read = pool.read().map_err(|e| format!("error.poolPoisoned: {e}"))?;
    let conn = pool_read.get().map_err(|e| format!("error.dbConn: {e}"))?;
    if let Some(id) = shibei_sync::sync_state::get(&conn, "device:id")
        .map_err(|e| format!("error.readDeviceId: {e}"))?
    {
        return Ok(id);
    }
    let new_id = uuid::Uuid::new_v4().to_string();
    shibei_sync::sync_state::set(&conn, "device:id", &new_id)
        .map_err(|e| format!("error.writeDeviceId: {e}"))?;
    Ok(new_id)
}

/// Whether `init` has produced a usable state. Separate from `is_unlocked`:
/// init succeeds the first time the app ever opens; unlock only succeeds once
/// the user has completed Onboard Step 4.
pub fn has_saved_config() -> bool {
    let Some(state) = APP_STATE.get() else {
        return false;
    };
    let Ok(pool_read) = state.db_pool.read() else {
        return false;
    };
    let Ok(conn) = pool_read.get() else {
        return false;
    };
    // "Has S3 config saved" == the onboarding flow has at least reached the
    // point of writing S3 settings. Checking `config:s3_bucket` suffices
    // because all three of endpoint/region/bucket are written atomically.
    matches!(
        shibei_sync::sync_state::get(&conn, "config:s3_bucket"),
        Ok(Some(_))
    )
}

pub fn is_unlocked() -> bool {
    let Some(state) = APP_STATE.get() else {
        return false;
    };
    state.encryption.is_unlocked()
}

pub fn lock_vault() {
    if let Some(state) = APP_STATE.get() {
        state.encryption.clear();
    }
}
