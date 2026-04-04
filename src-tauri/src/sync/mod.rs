pub mod backend;
pub mod credentials;
pub mod crypto;
pub mod keyring;
pub mod encrypted_backend;
pub mod os_keystore;
pub mod device;
pub mod engine;
pub mod export;
pub mod hlc;
pub mod sync_log;
pub mod sync_state;

/// Context passed to CRUD functions for sync log tracking.
/// When None is passed, sync logging is skipped (e.g., tests, remote apply).
pub struct SyncContext<'a> {
    pub clock: &'a hlc::HlcClock,
    pub device_id: &'a str,
}

use std::sync::Mutex;
use zeroize::Zeroizing;

/// Holds the decrypted Master Key in memory. Managed as Tauri state.
pub struct EncryptionState {
    master_key: Mutex<Option<Zeroizing<[u8; 32]>>>,
}

impl Default for EncryptionState {
    fn default() -> Self {
        Self::new()
    }
}

impl EncryptionState {
    pub fn new() -> Self {
        Self {
            master_key: Mutex::new(None),
        }
    }

    pub fn set_key(&self, key: Zeroizing<[u8; 32]>) {
        let mut mk = self.master_key.lock().unwrap();
        *mk = Some(key);
    }

    pub fn get_key(&self) -> Option<Zeroizing<[u8; 32]>> {
        let mk = self.master_key.lock().unwrap();
        mk.as_ref().map(|k| Zeroizing::new(**k))
    }

    pub fn clear(&self) {
        let mut mk = self.master_key.lock().unwrap();
        *mk = None;
    }

    pub fn is_unlocked(&self) -> bool {
        self.master_key.lock().unwrap().is_some()
    }
}
