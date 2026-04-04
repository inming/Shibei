use argon2::{Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use hkdf::Hkdf;
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::Sha256;
use thiserror::Error;
use zeroize::Zeroizing;

use super::crypto;

const KEYRING_VERSION: u32 = 1;
const SALT_LEN: usize = 32;
const KEY_LEN: usize = 32;
const VERIFICATION_HASH_LEN: usize = 16;

// Argon2id parameters (OWASP minimum, upgradeable via keyring version)
const ARGON2_M_COST: u32 = 65536; // 64 MB
const ARGON2_T_COST: u32 = 3;
const ARGON2_P_COST: u32 = 1;

#[derive(Error, Debug)]
pub enum KeyringError {
    #[error("wrong password")]
    WrongPassword,
    #[error("keyring may be tampered")]
    Tampered,
    #[error("invalid keyring format: {0}")]
    InvalidFormat(String),
    #[error("crypto error: {0}")]
    Crypto(#[from] crypto::CryptoError),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct Argon2Params {
    pub m_cost: u32,
    pub t_cost: u32,
    pub p_cost: u32,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct Keyring {
    pub version: u32,
    pub kdf: String,
    pub argon2_params: Argon2Params,
    pub salt: String,
    pub wrapped_master_key: String,
    pub wrapped_master_key_nonce: String,
    pub verification_hash: String,
}

fn base64_encode(data: &[u8]) -> String {
    B64.encode(data)
}

fn base64_decode(s: &str) -> Result<Vec<u8>, KeyringError> {
    B64.decode(s)
        .map_err(|e| KeyringError::InvalidFormat(format!("base64: {}", e)))
}

/// Derive a 256-bit key from password using Argon2id.
fn derive_pdk(
    password: &str,
    salt: &[u8],
    params: &Argon2Params,
) -> Result<Zeroizing<[u8; KEY_LEN]>, KeyringError> {
    let argon2_params =
        Params::new(params.m_cost, params.t_cost, params.p_cost, Some(KEY_LEN))
            .map_err(|e| KeyringError::InvalidFormat(format!("argon2 params: {}", e)))?;
    let argon2 = Argon2::new(argon2::Algorithm::Argon2id, Version::V0x13, argon2_params);

    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    argon2
        .hash_password_into(password.as_bytes(), salt, key.as_mut())
        .map_err(|e| KeyringError::InvalidFormat(format!("argon2 hash: {}", e)))?;
    Ok(key)
}

/// Compute verification hash: HKDF-SHA256(ikm=MK, info="shibei-verify", length=16)
pub(crate) fn compute_verification_hash(mk: &[u8; KEY_LEN]) -> [u8; VERIFICATION_HASH_LEN] {
    let hk = Hkdf::<Sha256>::new(None, mk);
    let mut hash = [0u8; VERIFICATION_HASH_LEN];
    hk.expand(b"shibei-verify", &mut hash)
        .expect("HKDF expand should not fail for 16 bytes");
    hash
}

impl Keyring {
    /// Generate a new keyring with a random MK, wrapped by the given password.
    pub fn generate(password: &str) -> Result<Self, KeyringError> {
        // Generate random salt and MK
        let mut salt = [0u8; SALT_LEN];
        OsRng.fill_bytes(&mut salt);

        let mut mk = Zeroizing::new([0u8; KEY_LEN]);
        OsRng.fill_bytes(mk.as_mut());

        let params = Argon2Params {
            m_cost: ARGON2_M_COST,
            t_cost: ARGON2_T_COST,
            p_cost: ARGON2_P_COST,
        };

        // Derive PDK from password
        let pdk = derive_pdk(password, &salt, &params)?;

        // Wrap MK with PDK using XChaCha20-Poly1305
        // AAD = "shibei-keyring" to bind to this context
        let wrapped = crypto::encrypt(mk.as_ref(), &pdk, b"shibei-keyring")?;

        // The wrapped output includes [version(1)][nonce(24)][ciphertext+tag]
        // Extract nonce from wrapped for storage (it's at bytes 1..25)
        let nonce = &wrapped[1..1 + 24];
        // Store the ciphertext+tag part (skip version+nonce, they're stored separately)
        let ciphertext_with_tag = &wrapped[1 + 24..];

        // Compute verification hash
        let verification_hash = compute_verification_hash(&mk);

        Ok(Keyring {
            version: KEYRING_VERSION,
            kdf: "argon2id".to_string(),
            argon2_params: params,
            salt: base64_encode(&salt),
            wrapped_master_key: base64_encode(ciphertext_with_tag),
            wrapped_master_key_nonce: base64_encode(nonce),
            verification_hash: base64_encode(&verification_hash),
        })
    }

    /// Unlock the keyring with a password, returning the Master Key.
    pub fn unlock(&self, password: &str) -> Result<Zeroizing<[u8; KEY_LEN]>, KeyringError> {
        let salt = base64_decode(&self.salt)?;
        let pdk = derive_pdk(password, &salt, &self.argon2_params)?;

        // Reconstruct the encrypted format: [version][nonce][ciphertext+tag]
        let nonce = base64_decode(&self.wrapped_master_key_nonce)?;
        let ciphertext_with_tag = base64_decode(&self.wrapped_master_key)?;

        let mut encrypted = Vec::with_capacity(1 + nonce.len() + ciphertext_with_tag.len());
        encrypted.push(0x01); // crypto::VERSION
        encrypted.extend_from_slice(&nonce);
        encrypted.extend_from_slice(&ciphertext_with_tag);

        let mk_bytes = crypto::decrypt(&encrypted, &pdk, b"shibei-keyring")
            .map_err(|_| KeyringError::WrongPassword)?;

        if mk_bytes.len() != KEY_LEN {
            return Err(KeyringError::InvalidFormat(format!(
                "MK length {}, expected {}",
                mk_bytes.len(),
                KEY_LEN
            )));
        }

        let mut mk = Zeroizing::new([0u8; KEY_LEN]);
        mk.copy_from_slice(&mk_bytes);

        // Verify hash to detect tampering
        let expected_hash = base64_decode(&self.verification_hash)?;
        let actual_hash = compute_verification_hash(&mk);
        if actual_hash[..] != expected_hash[..] {
            return Err(KeyringError::Tampered);
        }

        Ok(mk)
    }

    /// Change password: unlock with old, re-wrap same MK with new password.
    pub fn change_password(
        &self,
        old_password: &str,
        new_password: &str,
    ) -> Result<Self, KeyringError> {
        // Unlock to get MK (validates old password)
        let mk = self.unlock(old_password)?;

        // Generate new salt
        let mut new_salt = [0u8; SALT_LEN];
        OsRng.fill_bytes(&mut new_salt);

        let params = Argon2Params {
            m_cost: self.argon2_params.m_cost,
            t_cost: self.argon2_params.t_cost,
            p_cost: self.argon2_params.p_cost,
        };

        // Derive new PDK
        let new_pdk = derive_pdk(new_password, &new_salt, &params)?;

        // Re-wrap MK
        let wrapped = crypto::encrypt(mk.as_ref(), &new_pdk, b"shibei-keyring")?;
        let nonce = &wrapped[1..1 + 24];
        let ciphertext_with_tag = &wrapped[1 + 24..];

        // Verification hash stays the same (same MK)
        let verification_hash = compute_verification_hash(&mk);

        Ok(Keyring {
            version: self.version,
            kdf: self.kdf.clone(),
            argon2_params: params,
            salt: base64_encode(&new_salt),
            wrapped_master_key: base64_encode(ciphertext_with_tag),
            wrapped_master_key_nonce: base64_encode(nonce),
            verification_hash: base64_encode(&verification_hash),
        })
    }

    /// Serialize to JSON string.
    pub fn to_json(&self) -> Result<String, KeyringError> {
        serde_json::to_string_pretty(self).map_err(KeyringError::Json)
    }

    /// Deserialize from JSON string.
    pub fn from_json(json: &str) -> Result<Self, KeyringError> {
        serde_json::from_str(json).map_err(KeyringError::Json)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_and_unlock_roundtrip() {
        let password = "test-password-123";
        let keyring = Keyring::generate(password).unwrap();

        let mk = keyring.unlock(password).unwrap();
        assert_eq!(mk.len(), 32);
    }

    #[test]
    fn test_unlock_wrong_password_fails() {
        let keyring = Keyring::generate("correct-password").unwrap();
        let result = keyring.unlock("wrong-password");
        assert!(matches!(result, Err(KeyringError::WrongPassword)));
    }

    #[test]
    fn test_serialize_deserialize_roundtrip() {
        let keyring = Keyring::generate("password").unwrap();
        let json = keyring.to_json().unwrap();
        let parsed = Keyring::from_json(&json).unwrap();

        // Unlock with same password should produce same MK
        let mk1 = keyring.unlock("password").unwrap();
        let mk2 = parsed.unlock("password").unwrap();
        assert_eq!(mk1.as_ref(), mk2.as_ref());
    }

    #[test]
    fn test_verification_hash_detects_tampering() {
        let mut keyring = Keyring::generate("password").unwrap();
        // Tamper with verification hash
        keyring.verification_hash = base64_encode(&[0u8; 16]);
        let result = keyring.unlock("password");
        // Should fail — either WrongPassword or Tampered
        assert!(result.is_err());
    }

    #[test]
    fn test_change_password() {
        let keyring = Keyring::generate("old-pass").unwrap();
        let mk_old = keyring.unlock("old-pass").unwrap();

        let new_keyring = keyring.change_password("old-pass", "new-pass").unwrap();

        // Old password should fail on new keyring
        assert!(new_keyring.unlock("old-pass").is_err());

        // New password should produce same MK
        let mk_new = new_keyring.unlock("new-pass").unwrap();
        assert_eq!(mk_old.as_ref(), mk_new.as_ref());
    }

    #[test]
    fn test_change_password_wrong_old_fails() {
        let keyring = Keyring::generate("correct").unwrap();
        let result = keyring.change_password("wrong", "new");
        assert!(result.is_err());
    }

    #[test]
    fn test_json_format_has_expected_fields() {
        let keyring = Keyring::generate("pass").unwrap();
        let json = keyring.to_json().unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();

        assert_eq!(value["version"], 1);
        assert_eq!(value["kdf"], "argon2id");
        assert!(value["argon2_params"]["m_cost"].is_number());
        assert!(value["argon2_params"]["t_cost"].is_number());
        assert!(value["argon2_params"]["p_cost"].is_number());
        assert!(value["salt"].is_string());
        assert!(value["wrapped_master_key"].is_string());
        assert!(value["wrapped_master_key_nonce"].is_string());
        assert!(value["verification_hash"].is_string());
    }
}
