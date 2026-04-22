//! NAPI lock-screen command implementations (called from commands.rs).
//! Uses `shibei-mobile-lock` for crypto + throttle and `SecureStore` for I/O.
//!
//! The outer HUKS device-bound wrap is applied/un-applied by ArkTS before/after
//! calling NAPI (see HuksService.ets). From Rust's POV all blob bytes are
//! opaque ciphertext we write to disk.

use crate::secure_store::{FileStore, SecureStore};
use crate::state;
use shibei_mobile_lock::{pin, throttle::ThrottleState, wrap, LockError};
use zeroize::Zeroizing;

const PREFS_FILE: &str = "preferences/security.json";

#[derive(Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityPrefs {
    #[serde(default)]
    pub lock_enabled: bool,
    #[serde(default)]
    pub bio_enabled: bool,
    #[serde(default)]
    pub pin_version: u32,
    #[serde(default)]
    pub failed_attempts: u32,
    #[serde(default)]
    pub lockout_until_ms: i64,
}

impl SecurityPrefs {
    pub fn load(data_dir: &std::path::Path) -> Self {
        let path = data_dir.join(PREFS_FILE);
        match std::fs::read(&path) {
            Ok(b) => serde_json::from_slice(&b).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self, data_dir: &std::path::Path) -> Result<(), String> {
        let path = data_dir.join(PREFS_FILE);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("error.prefsMkdir: {e}"))?;
        }
        let json = serde_json::to_vec(self).map_err(|e| format!("error.prefsSerialize: {e}"))?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, &json).map_err(|e| format!("error.prefsWrite: {e}"))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("error.prefsRename: {e}"))?;
        Ok(())
    }

    fn throttle(&self) -> ThrottleState {
        ThrottleState {
            failed_attempts: self.failed_attempts,
            lockout_until_ms: self.lockout_until_ms,
        }
    }

    fn merge_throttle(&mut self, t: &ThrottleState) {
        self.failed_attempts = t.failed_attempts;
        self.lockout_until_ms = t.lockout_until_ms;
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn error_code(e: LockError) -> String {
    format!("{e}")
}

// ──────────── Query commands (sync) ────────────

pub fn is_configured() -> bool {
    let Ok(app) = state::get() else { return false };
    SecurityPrefs::load(&app.data_dir).lock_enabled
}

pub fn is_bio_enabled() -> bool {
    let Ok(app) = state::get() else { return false };
    SecurityPrefs::load(&app.data_dir).bio_enabled
}

pub fn lockout_remaining_secs() -> i32 {
    let Ok(app) = state::get() else { return 0 };
    let prefs = SecurityPrefs::load(&app.data_dir);
    prefs.throttle().remaining_secs(now_ms()) as i32
}

// ──────────── Setup / unlock / disable ────────────

pub fn setup_pin(pin_str: String) -> Result<String, String> {
    let app = state::get()?;
    // EncryptionState::get_key() returns Option<Zeroizing<[u8; 32]>> — a fresh
    // Zeroizing copy guarded by the mutex. We borrow the 32 bytes out, pass a
    // reference to `wrap_mk`, then drop the Zeroizing which scrubs the copy.
    let mk_guard: Zeroizing<[u8; 32]> = app
        .encryption
        .get_key()
        .ok_or_else(|| "error.notUnlocked".to_string())?;
    let store = FileStore::new(&app.data_dir).map_err(|e| format!("error.fsInit: {e}"))?;
    let (hash_blob, salt) = pin::hash_pin(&pin_str).map_err(error_code)?;
    store.write("pin_hash", &hash_blob)?;
    let kek = wrap::derive_kek(&pin_str, &salt).map_err(error_code)?;
    let mk_blob = wrap::wrap_mk(&kek, &mk_guard).map_err(error_code)?;
    drop(mk_guard);
    store.write("mk_pin", &mk_blob)?;

    let mut prefs = SecurityPrefs::load(&app.data_dir);
    prefs.lock_enabled = true;
    prefs.pin_version = 1;
    prefs.failed_attempts = 0;
    prefs.lockout_until_ms = 0;
    prefs.save(&app.data_dir)?;
    Ok("ok".to_string())
}

pub fn unlock_with_pin(pin_str: String) -> Result<String, String> {
    let app = state::get()?;
    let mut prefs = SecurityPrefs::load(&app.data_dir);
    let mut throttle = prefs.throttle();
    let remaining = throttle.remaining_secs(now_ms());
    if remaining > 0 {
        return Err(format!("error.lockThrottled:{remaining}"));
    }
    let store = FileStore::new(&app.data_dir).map_err(|e| format!("error.fsInit: {e}"))?;
    let hash_blob = store
        .read("pin_hash")?
        .ok_or_else(|| "error.notConfigured".to_string())?;
    let salt = match pin::verify_pin(&pin_str, &hash_blob) {
        Ok(s) => s,
        Err(LockError::WrongPin) => {
            throttle.on_failure(now_ms());
            prefs.merge_throttle(&throttle);
            prefs.save(&app.data_dir)?;
            let remaining = throttle.remaining_secs(now_ms());
            if remaining > 0 {
                return Err(format!("error.lockThrottled:{remaining}"));
            }
            return Err("error.pinIncorrect".to_string());
        }
        Err(e) => return Err(error_code(e)),
    };
    let mk_blob = store
        .read("mk_pin")?
        .ok_or_else(|| "error.secureStoreCorrupted: mk_pin missing".to_string())?;
    let kek = wrap::derive_kek(&pin_str, &salt).map_err(error_code)?;
    let mk = wrap::unwrap_mk(&kek, &mk_blob).map_err(error_code)?;

    // `set_key` takes ownership of a Zeroizing<[u8;32]> — hand the unwrapped
    // MK straight in without allocating another temporary.
    app.encryption.set_key(mk);

    throttle.on_success();
    prefs.merge_throttle(&throttle);
    prefs.save(&app.data_dir)?;
    Ok("ok".to_string())
}

pub fn disable(pin_str: String) -> Result<String, String> {
    let app = state::get()?;
    let store = FileStore::new(&app.data_dir).map_err(|e| format!("error.fsInit: {e}"))?;
    let hash_blob = store
        .read("pin_hash")?
        .ok_or_else(|| "error.notConfigured".to_string())?;
    let _ = pin::verify_pin(&pin_str, &hash_blob).map_err(error_code)?;

    store.delete("mk_pin")?;
    store.delete("mk_bio")?;
    store.delete("pin_hash")?;

    let mut prefs = SecurityPrefs::load(&app.data_dir);
    prefs.lock_enabled = false;
    prefs.bio_enabled = false;
    prefs.failed_attempts = 0;
    prefs.lockout_until_ms = 0;
    prefs.save(&app.data_dir)?;
    Ok("ok".to_string())
}
