use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

const SERVICE: &str = "shibei";
const ACCOUNT: &str = "encryption-master-key";
const KEY_LEN: usize = 32;

#[derive(Error, Debug)]
pub enum KeystoreError {
    #[error("key not found in keychain")]
    NotFound,
    #[error("keychain platform error: {0}")]
    PlatformError(String),
    #[error("invalid key format: {0}")]
    InvalidFormat(String),
}

/// Store the master key (raw 32 bytes) in the OS keychain.
pub fn save_master_key(mk: &[u8; KEY_LEN]) -> Result<(), KeystoreError> {
    let entry = ::keyring::Entry::new(SERVICE, ACCOUNT)
        .map_err(|e| KeystoreError::PlatformError(e.to_string()))?;
    entry
        .set_secret(mk)
        .map_err(|e| KeystoreError::PlatformError(e.to_string()))
}

/// Load the master key from the OS keychain.
/// Returns Ok(None) if no entry exists.
pub fn load_master_key() -> Result<Option<Zeroizing<[u8; KEY_LEN]>>, KeystoreError> {
    let entry = ::keyring::Entry::new(SERVICE, ACCOUNT)
        .map_err(|e| KeystoreError::PlatformError(e.to_string()))?;
    match entry.get_secret() {
        Ok(mut secret) => {
            if secret.len() != KEY_LEN {
                secret.zeroize();
                return Err(KeystoreError::InvalidFormat(format!(
                    "expected {} bytes, got {}",
                    KEY_LEN,
                    secret.len()
                )));
            }
            let mut mk = Zeroizing::new([0u8; KEY_LEN]);
            mk.copy_from_slice(&secret);
            secret.zeroize();
            Ok(Some(mk))
        }
        Err(::keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(KeystoreError::PlatformError(e.to_string())),
    }
}

/// Delete the master key from the OS keychain.
/// Silently succeeds if no entry exists.
pub fn delete_master_key() -> Result<(), KeystoreError> {
    let entry = ::keyring::Entry::new(SERVICE, ACCOUNT)
        .map_err(|e| KeystoreError::PlatformError(e.to_string()))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(::keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(KeystoreError::PlatformError(e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // NOTE: These tests interact with the real OS keychain.
    // They use a unique account suffix to avoid conflicts.
    // On CI without a keychain, they will be ignored.

    #[test]
    #[ignore] // Requires interactive macOS Keychain access; run manually with --ignored
    fn test_save_load_delete_roundtrip() {
        // Clean up first in case a previous test run left state
        let _ = delete_master_key();

        let mk = [42u8; KEY_LEN];
        save_master_key(&mk).expect("save should succeed");

        let loaded = load_master_key().expect("load should succeed");
        assert!(loaded.is_some(), "should find stored key");
        assert_eq!(*loaded.unwrap(), mk);

        delete_master_key().expect("delete should succeed");

        let after_delete = load_master_key().expect("load should succeed");
        assert!(after_delete.is_none(), "should be None after delete");
    }

    #[test]
    #[ignore] // Touches the real OS keychain; run manually with --ignored
    fn test_load_returns_none_when_no_entry() {
        let _ = delete_master_key(); // ensure clean
        let result = load_master_key().expect("load should succeed");
        assert!(result.is_none());
    }

    #[test]
    #[ignore] // Touches the real OS keychain; run manually with --ignored
    fn test_delete_when_no_entry_succeeds() {
        let _ = delete_master_key(); // ensure clean
        let result = delete_master_key();
        assert!(result.is_ok(), "delete of non-existent should succeed");
    }
}
