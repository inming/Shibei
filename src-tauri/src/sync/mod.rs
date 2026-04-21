pub mod backend;
pub mod credentials;
pub mod crypto;
pub mod keyring;
pub mod encrypted_backend;
pub mod os_keystore;
pub mod device;
pub mod engine;
pub mod export;
pub mod pairing;
pub mod sync_state;

// Phase 2 crate refactor: hlc / sync_log / SyncContext live in shibei-db so the
// data layer can write sync_log rows without a reverse dependency. Re-exported
// here to keep `crate::sync::hlc::…` / `crate::sync::SyncContext` call sites
// in commands/server/engine unchanged.
pub use shibei_db::{hlc, sync_log, SyncContext};

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
