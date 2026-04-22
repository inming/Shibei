//! HKDF-SHA256 PIN-KEK derivation + XChaCha20-Poly1305 MK wrap/unwrap.
//!
//! Blob shape (secure/mk_pin.blob):
//!   { "version": 1, "nonce": "base64(24B)", "ct": "base64(32B + 16B tag)" }
//!
//! AAD is the fixed constant `b"shibei-mk-v1"` — we deliberately don't
//! include a device id (the outer HUKS device-bound wrap covers that in
//! production; for unit tests we don't need replay protection).

use crate::{LockError, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use chacha20poly1305::{aead::Aead, KeyInit, XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::Zeroizing;

const MK_LEN: usize = 32;
const KEK_LEN: usize = 32;
const NONCE_LEN: usize = 24;
const SALT_LEN: usize = 16;
const AAD: &[u8] = b"shibei-mk-v1";

// MUST match pin.rs
const ARGON2_MEMORY_KIB: u32 = 19 * 1024;
const ARGON2_ITERS: u32 = 2;
const ARGON2_LANES: u32 = 1;

#[derive(Serialize, Deserialize)]
pub struct WrappedMkBlob {
    pub version: u32,
    pub nonce: String,
    pub ct: String,
}

/// Derive the PIN-KEK from a raw PIN + the salt recovered from pin_hash.blob.
/// Runs Argon2id once (~250ms on Mate X5) then HKDF-SHA256 to separate the
/// verification path (stored hash) from the KEK path — so the KEK never
/// leaks through the on-disk blob even if an attacker recovers the hash.
pub fn derive_kek(pin: &str, salt: &[u8; SALT_LEN]) -> Result<Zeroizing<[u8; KEK_LEN]>> {
    let params = Params::new(ARGON2_MEMORY_KIB, ARGON2_ITERS, ARGON2_LANES, Some(KEK_LEN))
        .expect("argon2 params are static and valid");
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut ikm = Zeroizing::new([0u8; KEK_LEN]);
    argon2
        .hash_password_into(pin.as_bytes(), salt, ikm.as_mut())
        .map_err(|e| LockError::Corrupted(format!("argon2: {e}")))?;
    let hk = Hkdf::<Sha256>::new(Some(salt), ikm.as_ref());
    let mut kek = Zeroizing::new([0u8; KEK_LEN]);
    hk.expand(b"shibei-mobile-lock-v1", kek.as_mut())
        .map_err(|e| LockError::Corrupted(format!("hkdf: {e}")))?;
    Ok(kek)
}

pub fn wrap_mk(kek: &[u8; KEK_LEN], mk: &[u8; MK_LEN]) -> Result<Vec<u8>> {
    let cipher = XChaCha20Poly1305::new(kek.into());
    let mut nonce = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce);
    let ct = cipher
        .encrypt(XNonce::from_slice(&nonce), chacha20poly1305::aead::Payload { msg: mk, aad: AAD })
        .map_err(|e| LockError::Corrupted(format!("seal: {e}")))?;
    let blob = WrappedMkBlob {
        version: 1,
        nonce: base64::engine::general_purpose::STANDARD.encode(nonce),
        ct: base64::engine::general_purpose::STANDARD.encode(&ct),
    };
    serde_json::to_vec(&blob).map_err(|e| LockError::Corrupted(e.to_string()))
}

pub fn unwrap_mk(kek: &[u8; KEK_LEN], blob_bytes: &[u8]) -> Result<Zeroizing<[u8; MK_LEN]>> {
    let blob: WrappedMkBlob = serde_json::from_slice(blob_bytes)
        .map_err(|e| LockError::Corrupted(format!("mk blob: {e}")))?;
    if blob.version != 1 {
        return Err(LockError::Corrupted(format!("mk blob version {}", blob.version)));
    }
    let nonce_bytes = base64::engine::general_purpose::STANDARD
        .decode(&blob.nonce)
        .map_err(|e| LockError::Corrupted(format!("nonce b64: {e}")))?;
    if nonce_bytes.len() != NONCE_LEN {
        return Err(LockError::Corrupted(format!("nonce len {}", nonce_bytes.len())));
    }
    let ct = base64::engine::general_purpose::STANDARD
        .decode(&blob.ct)
        .map_err(|e| LockError::Corrupted(format!("ct b64: {e}")))?;
    let cipher = XChaCha20Poly1305::new(kek.into());
    let pt = cipher
        .decrypt(XNonce::from_slice(&nonce_bytes), chacha20poly1305::aead::Payload { msg: &ct, aad: AAD })
        .map_err(|_| LockError::WrongPin)?;
    if pt.len() != MK_LEN {
        return Err(LockError::Corrupted(format!("pt len {}", pt.len())));
    }
    let mut mk = Zeroizing::new([0u8; MK_LEN]);
    mk.copy_from_slice(&pt);
    Ok(mk)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_mk() -> [u8; MK_LEN] {
        let mut mk = [0u8; MK_LEN];
        for (i, b) in mk.iter_mut().enumerate() {
            *b = i as u8;
        }
        mk
    }

    #[test]
    fn kek_derivation_is_deterministic() {
        let salt = [7u8; SALT_LEN];
        let k1 = derive_kek("1357", &salt).unwrap();
        let k2 = derive_kek("1357", &salt).unwrap();
        assert_eq!(k1.as_ref(), k2.as_ref());
    }

    #[test]
    fn kek_derivation_varies_by_pin() {
        let salt = [7u8; SALT_LEN];
        let k1 = derive_kek("1357", &salt).unwrap();
        let k2 = derive_kek("1358", &salt).unwrap();
        assert_ne!(k1.as_ref(), k2.as_ref());
    }

    #[test]
    fn wrap_unwrap_round_trip() {
        let salt = [7u8; SALT_LEN];
        let kek = derive_kek("1357", &salt).unwrap();
        let mk = sample_mk();
        let blob = wrap_mk(&kek, &mk).unwrap();
        let recovered = unwrap_mk(&kek, &blob).unwrap();
        assert_eq!(recovered.as_ref(), &mk);
    }

    #[test]
    fn unwrap_with_wrong_kek_fails_as_wrong_pin() {
        let salt = [7u8; SALT_LEN];
        let kek_good = derive_kek("1357", &salt).unwrap();
        let kek_bad = derive_kek("1358", &salt).unwrap();
        let blob = wrap_mk(&kek_good, &sample_mk()).unwrap();
        assert!(matches!(unwrap_mk(&kek_bad, &blob), Err(LockError::WrongPin)));
    }

    #[test]
    fn unwrap_tampered_ct_fails() {
        let salt = [7u8; SALT_LEN];
        let kek = derive_kek("1357", &salt).unwrap();
        let blob_bytes = wrap_mk(&kek, &sample_mk()).unwrap();
        let mut blob: WrappedMkBlob = serde_json::from_slice(&blob_bytes).unwrap();
        let mut ct = base64::engine::general_purpose::STANDARD.decode(&blob.ct).unwrap();
        ct[0] ^= 1;
        blob.ct = base64::engine::general_purpose::STANDARD.encode(&ct);
        let tampered = serde_json::to_vec(&blob).unwrap();
        let res = unwrap_mk(&kek, &tampered);
        assert!(matches!(res, Err(LockError::WrongPin)));
    }

    #[test]
    fn unwrap_bad_version_errors() {
        let salt = [7u8; SALT_LEN];
        let kek = derive_kek("1357", &salt).unwrap();
        let blob_bytes = wrap_mk(&kek, &sample_mk()).unwrap();
        let mut blob: WrappedMkBlob = serde_json::from_slice(&blob_bytes).unwrap();
        blob.version = 999;
        let raw = serde_json::to_vec(&blob).unwrap();
        assert!(matches!(unwrap_mk(&kek, &raw), Err(LockError::Corrupted(_))));
    }
}
