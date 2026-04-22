//! PIN Argon2id hashing + verification.
//!
//! The on-disk hash blob has shape:
//!   { "version": 1, "salt": "base64(16B)", "hash": "base64(32B)" }
//!
//! We deliberately store salt and raw hash instead of argon2's PHC string —
//! the HKDF path in `wrap.rs` needs the salt back verbatim to re-derive the
//! KEK, and threading PHC parse just to get salt out is avoidable churn.

use crate::{LockError, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

/// Argon2id parameters — must match `wrap.rs`. memory=19 MiB, iters=2,
/// parallelism=1. Rough budget: ~250ms per call on Mate X5.
const ARGON2_MEMORY_KIB: u32 = 19 * 1024;
const ARGON2_ITERS: u32 = 2;
const ARGON2_LANES: u32 = 1;
const SALT_LEN: usize = 16;
const HASH_LEN: usize = 32;

#[derive(Serialize, Deserialize)]
pub struct PinHashBlob {
    pub version: u32,
    pub salt: String,
    pub hash: String,
}

pub fn validate_pin(pin: &str) -> Result<()> {
    if pin.len() == 4 && pin.chars().all(|c| c.is_ascii_digit()) {
        Ok(())
    } else {
        Err(LockError::PinFormat)
    }
}

fn argon2() -> Argon2<'static> {
    let params = Params::new(ARGON2_MEMORY_KIB, ARGON2_ITERS, ARGON2_LANES, Some(HASH_LEN))
        .expect("argon2 params are static and valid");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

/// Hash a PIN with a freshly-sampled salt. Returns the JSON blob bytes ready
/// to write to `secure/pin_hash.blob` (plus the salt so the caller can feed
/// it into `wrap::derive_kek` without a second Argon2 pass).
pub fn hash_pin(pin: &str) -> Result<(Vec<u8>, Zeroizing<[u8; SALT_LEN]>)> {
    validate_pin(pin)?;
    let mut salt = [0u8; SALT_LEN];
    rand::thread_rng().fill_bytes(&mut salt);
    let mut hash_out = Zeroizing::new([0u8; HASH_LEN]);
    argon2()
        .hash_password_into(pin.as_bytes(), &salt, hash_out.as_mut())
        .map_err(|e| LockError::Corrupted(format!("argon2: {e}")))?;
    let blob = PinHashBlob {
        version: 1,
        salt: base64::engine::general_purpose::STANDARD.encode(salt),
        hash: base64::engine::general_purpose::STANDARD.encode(hash_out.as_ref()),
    };
    let json = serde_json::to_vec(&blob).map_err(|e| LockError::Corrupted(e.to_string()))?;
    Ok((json, Zeroizing::new(salt)))
}

/// Verify a candidate PIN against a blob written by `hash_pin`. Returns
/// the salt on success so the caller can feed it to `wrap::derive_kek`.
pub fn verify_pin(pin: &str, blob_bytes: &[u8]) -> Result<Zeroizing<[u8; SALT_LEN]>> {
    validate_pin(pin)?;
    let blob: PinHashBlob = serde_json::from_slice(blob_bytes)
        .map_err(|e| LockError::Corrupted(format!("pin_hash.blob: {e}")))?;
    if blob.version != 1 {
        return Err(LockError::Corrupted(format!("unsupported pin_hash version {}", blob.version)));
    }
    let salt_bytes = base64::engine::general_purpose::STANDARD
        .decode(&blob.salt)
        .map_err(|e| LockError::Corrupted(format!("salt b64: {e}")))?;
    if salt_bytes.len() != SALT_LEN {
        return Err(LockError::Corrupted(format!("salt len {}", salt_bytes.len())));
    }
    let expected = base64::engine::general_purpose::STANDARD
        .decode(&blob.hash)
        .map_err(|e| LockError::Corrupted(format!("hash b64: {e}")))?;
    if expected.len() != HASH_LEN {
        return Err(LockError::Corrupted(format!("hash len {}", expected.len())));
    }
    let mut computed = Zeroizing::new([0u8; HASH_LEN]);
    argon2()
        .hash_password_into(pin.as_bytes(), &salt_bytes, computed.as_mut())
        .map_err(|e| LockError::Corrupted(format!("argon2: {e}")))?;
    let eq = constant_time_eq(computed.as_ref(), &expected);
    if !eq {
        return Err(LockError::WrongPin);
    }
    let mut salt = [0u8; SALT_LEN];
    salt.copy_from_slice(&salt_bytes);
    Ok(Zeroizing::new(salt))
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut acc = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        acc |= x ^ y;
    }
    acc == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_accepts_4_digits() {
        validate_pin("1234").unwrap();
        validate_pin("0000").unwrap();
    }

    #[test]
    fn validate_rejects_non_digits() {
        assert!(matches!(validate_pin("abcd"), Err(LockError::PinFormat)));
        assert!(matches!(validate_pin("12a4"), Err(LockError::PinFormat)));
    }

    #[test]
    fn validate_rejects_wrong_length() {
        assert!(matches!(validate_pin("123"), Err(LockError::PinFormat)));
        assert!(matches!(validate_pin("12345"), Err(LockError::PinFormat)));
        assert!(matches!(validate_pin(""), Err(LockError::PinFormat)));
    }

    #[test]
    fn hash_verify_round_trip() {
        let (blob, _) = hash_pin("1357").unwrap();
        let salt = verify_pin("1357", &blob).unwrap();
        assert_eq!(salt.len(), SALT_LEN);
    }

    #[test]
    fn verify_rejects_wrong_pin() {
        let (blob, _) = hash_pin("1357").unwrap();
        assert!(matches!(verify_pin("1358", &blob), Err(LockError::WrongPin)));
    }

    #[test]
    fn verify_rejects_tampered_blob() {
        let (mut blob, _) = hash_pin("1357").unwrap();
        for byte in blob.iter_mut() {
            if byte.is_ascii_alphanumeric() && *byte != b'\"' {
                *byte ^= 1;
                break;
            }
        }
        let res = verify_pin("1357", &blob);
        assert!(matches!(res, Err(LockError::WrongPin) | Err(LockError::Corrupted(_))));
    }
}
