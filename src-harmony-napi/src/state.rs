//! Global `AppState` singleton — the single source of truth every NAPI
//! command reaches into.
//!
//! Initialised exactly once by ArkTS calling `initApp(dataDir, caBundlePath)`
//! very early in app startup (before any other command). Subsequent commands
//! read via `state::get()`; if init hasn't run they receive
//! `error.notInitialized`.
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
//!   - `s3_creds`         — S3 access + secret keys in memory only (never
//!     SQLite). Populated by `primeS3Creds` on cold start (HUKS blob unwrap)
//!     and by `setS3Config` after pairing. Kill → blob on disk survives but
//!     this cache is gone until next HUKS unwrap.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock, RwLock};

use shibei_db::{init_pool, SharedPool};
use shibei_sync::EncryptionState;

pub struct AppState {
    pub data_dir: PathBuf,
    pub db_pool: SharedPool,
    pub encryption: Arc<EncryptionState>,
    pub device_id: String,
    pub clock: shibei_db::hlc::HlcClock,
    pub s3_creds: Arc<RwLock<Option<(String, String)>>>,
}

impl AppState {
    /// Build a SyncContext tied to this device's clock + id. The returned
    /// handle borrows from `&self`, so callers hold it only as long as the
    /// state reference. Every CRUD call that should land in sync_log gets
    /// `Some(&state.make_sync_context())`.
    pub fn make_sync_context(&self) -> shibei_db::SyncContext<'_> {
        shibei_db::SyncContext {
            clock: &self.clock,
            device_id: &self.device_id,
        }
    }
}

static APP_STATE: OnceLock<AppState> = OnceLock::new();

/// One-shot initialisation. Safe to call multiple times — subsequent calls
/// return the first-initialised state unchanged (important because ArkTS may
/// replay init after a page reload during dev).
///
/// `ca_bundle_path` must point at a readable cacert.pem copied out of the
/// HAP's rawfile resources. HarmonyOS's el2 sandbox exposes no system trust
/// store, so `rustls-native-certs` would otherwise reject every TLS peer as
/// `UnknownIssuer`. We export `SSL_CERT_FILE` so hyper-rustls (via rust-s3)
/// picks it up without needing to rebuild a `ClientConfig` ourselves.
pub fn init(data_dir: PathBuf, ca_bundle_path: PathBuf) -> Result<(), String> {
    if APP_STATE.get().is_some() {
        return Ok(());
    }

    std::fs::create_dir_all(&data_dir).map_err(|e| format!("error.createDataDir: {e}"))?;
    let db_path = data_dir.join("shibei.db");

    let pool = init_pool(&db_path).map_err(|e| format!("error.openDb: {e}"))?;
    let shared_pool: SharedPool = Arc::new(std::sync::RwLock::new(pool));

    let device_id = load_or_init_device_id(&shared_pool)?;
    ensure_inbox(&shared_pool)?;
    std::env::set_var("SSL_CERT_FILE", &ca_bundle_path);

    let clock = shibei_db::hlc::HlcClock::new(device_id.clone());
    let state = AppState {
        data_dir,
        db_pool: shared_pool,
        encryption: Arc::new(EncryptionState::new()),
        device_id,
        clock,
        s3_creds: Arc::new(RwLock::new(None)),
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

/// Phase 4.1: drop the in-memory S3 credentials. Called from `reset_device`
/// alongside `lock_vault`. The HUKS-wrapped blob on disk is wiped by the
/// reset flow's file-cleanup step (not here).
pub fn clear_s3_creds() {
    if let Some(state) = APP_STATE.get() {
        if let Ok(mut guard) = state.s3_creds.write() {
            *guard = None;
        }
    }
}
