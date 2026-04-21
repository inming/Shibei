//! PIN-encrypted payload envelope for pairing a mobile device with the Shibei
//! desktop app.
//!
//! # Threat model
//!
//! A 6-digit PIN has ~20 bits of entropy, so no KDF (including Argon2id) can
//! resist an offline brute force. The real defensive posture here is:
//!
//! 1. Payload is shown only in the in-app Modal for 30s, then discarded.
//! 2. PIN is displayed beside (never embedded in) the QR — an attacker capturing
//!    only the QR cannot decrypt without the PIN shown on the desktop screen.
//! 3. AAD binds the ciphertext to this specific pairing purpose (`shibei-pair-v1`).
//!
//! HKDF-SHA256 is therefore sufficient and fast; the cipher is
//! XChaCha20-Poly1305 to match Shibei's existing E2EE stack.
//!
//! # Wire format
//!
//! `encrypt_payload(pin, plain)` returns a JSON envelope:
//! ```json
//! { "v": 1, "salt": "<b64url 16B>", "nonce": "<b64url 24B>", "ct": "<b64url>" }
//! ```
//! Base64URL is used without padding (shorter in QR codes).

use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use thiserror::Error;
use zeroize::Zeroizing;

/// Maximum raw (unencrypted) payload size, in bytes.
///
/// Bounded so the resulting QR stays easily scannable on mobile cameras
/// (empirically ~700 Base64URL chars ≈ QR version 16, L correction).
pub const MAX_PAYLOAD_BYTES: usize = 512;

const ENVELOPE_VERSION: u8 = 1;
const INFO: &[u8] = b"shibei-pair-v1";
const AAD: &[u8] = b"shibei-pair-v1";
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
const KEY_LEN: usize = 32;

#[derive(Error, Debug)]
pub enum PairingError {
    #[error("PIN must be exactly 6 digits")]
    InvalidPin,
    #[error("payload exceeds {limit} bytes (got {size})")]
    PayloadTooLarge { size: usize, limit: usize },
    #[error("envelope JSON malformed: {0}")]
    InvalidEnvelope(String),
    #[error("unsupported envelope version: {0}")]
    UnsupportedVersion(u8),
    #[error("decryption failed (wrong PIN or tampered payload)")]
    DecryptFailed,
    #[error("internal crypto error: {0}")]
    Crypto(String),
}

#[derive(Serialize, Deserialize)]
struct Envelope {
    v: u8,
    salt: String,
    nonce: String,
    ct: String,
}

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
}

fn validate_pin(pin: &str) -> Result<(), PairingError> {
    if pin.len() != 6 {
        return Err(PairingError::InvalidPin);
    }
    if !pin.bytes().all(|b| b.is_ascii_digit()) {
        return Err(PairingError::InvalidPin);
    }
    Ok(())
}

fn derive_key(pin: &str, salt: &[u8]) -> Zeroizing<[u8; KEY_LEN]> {
    let hk = Hkdf::<Sha256>::new(Some(salt), pin.as_bytes());
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    hk.expand(INFO, key.as_mut())
        .expect("HKDF expand of 32 bytes cannot fail");
    key
}

/// Encrypt `plain` under `pin`, returning the JSON envelope as a UTF-8 string.
pub fn encrypt_payload(pin: &str, plain: &[u8]) -> Result<String, PairingError> {
    validate_pin(pin)?;
    if plain.len() > MAX_PAYLOAD_BYTES {
        return Err(PairingError::PayloadTooLarge {
            size: plain.len(),
            limit: MAX_PAYLOAD_BYTES,
        });
    }

    let mut rng = rand::thread_rng();
    let mut salt = [0u8; SALT_LEN];
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rng.fill_bytes(&mut salt);
    rng.fill_bytes(&mut nonce_bytes);

    let key = derive_key(pin, &salt);
    let cipher = XChaCha20Poly1305::new(key.as_ref().into());
    let nonce = XNonce::from_slice(&nonce_bytes);

    let ct = cipher
        .encrypt(nonce, Payload { msg: plain, aad: AAD })
        .map_err(|e| PairingError::Crypto(e.to_string()))?;

    let env = Envelope {
        v: ENVELOPE_VERSION,
        salt: b64().encode(salt),
        nonce: b64().encode(nonce_bytes),
        ct: b64().encode(&ct),
    };

    serde_json::to_string(&env).map_err(|e| PairingError::Crypto(e.to_string()))
}

/// Decrypt a JSON envelope produced by `encrypt_payload`.
pub fn decrypt_payload(pin: &str, envelope_json: &str) -> Result<Vec<u8>, PairingError> {
    validate_pin(pin)?;

    let env: Envelope = serde_json::from_str(envelope_json)
        .map_err(|e| PairingError::InvalidEnvelope(e.to_string()))?;
    if env.v != ENVELOPE_VERSION {
        return Err(PairingError::UnsupportedVersion(env.v));
    }

    let salt = b64()
        .decode(env.salt.as_bytes())
        .map_err(|e| PairingError::InvalidEnvelope(format!("salt: {e}")))?;
    let nonce_bytes = b64()
        .decode(env.nonce.as_bytes())
        .map_err(|e| PairingError::InvalidEnvelope(format!("nonce: {e}")))?;
    let ct = b64()
        .decode(env.ct.as_bytes())
        .map_err(|e| PairingError::InvalidEnvelope(format!("ct: {e}")))?;

    if salt.len() != SALT_LEN {
        return Err(PairingError::InvalidEnvelope(format!(
            "salt length: expected {SALT_LEN}, got {}",
            salt.len()
        )));
    }
    if nonce_bytes.len() != NONCE_LEN {
        return Err(PairingError::InvalidEnvelope(format!(
            "nonce length: expected {NONCE_LEN}, got {}",
            nonce_bytes.len()
        )));
    }

    let key = derive_key(pin, &salt);
    let cipher = XChaCha20Poly1305::new(key.as_ref().into());
    let nonce = XNonce::from_slice(&nonce_bytes);

    cipher
        .decrypt(nonce, Payload { msg: &ct, aad: AAD })
        .map_err(|_| PairingError::DecryptFailed)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &[u8] = b"{\"endpoint\":\"https://s3.example.com\",\"bucket\":\"b\"}";

    #[test]
    fn round_trip_succeeds() {
        let env = encrypt_payload("123456", SAMPLE).unwrap();
        let plain = decrypt_payload("123456", &env).unwrap();
        assert_eq!(plain, SAMPLE);
    }

    #[test]
    fn different_pins_produce_different_envelopes() {
        let a = encrypt_payload("123456", SAMPLE).unwrap();
        let b = encrypt_payload("654321", SAMPLE).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn wrong_pin_fails_to_decrypt() {
        let env = encrypt_payload("123456", SAMPLE).unwrap();
        let err = decrypt_payload("654321", &env).unwrap_err();
        assert!(matches!(err, PairingError::DecryptFailed));
    }

    #[test]
    fn tampered_ciphertext_fails() {
        let env_str = encrypt_payload("123456", SAMPLE).unwrap();
        let mut env: Envelope = serde_json::from_str(&env_str).unwrap();
        // Flip a bit in the ciphertext.
        let mut bytes = b64().decode(env.ct.as_bytes()).unwrap();
        bytes[0] ^= 0x01;
        env.ct = b64().encode(&bytes);
        let tampered = serde_json::to_string(&env).unwrap();
        let err = decrypt_payload("123456", &tampered).unwrap_err();
        assert!(matches!(err, PairingError::DecryptFailed));
    }

    #[test]
    fn tampered_nonce_fails() {
        let env_str = encrypt_payload("123456", SAMPLE).unwrap();
        let mut env: Envelope = serde_json::from_str(&env_str).unwrap();
        let mut bytes = b64().decode(env.nonce.as_bytes()).unwrap();
        bytes[0] ^= 0x01;
        env.nonce = b64().encode(&bytes);
        let tampered = serde_json::to_string(&env).unwrap();
        let err = decrypt_payload("123456", &tampered).unwrap_err();
        assert!(matches!(err, PairingError::DecryptFailed));
    }

    #[test]
    fn tampered_salt_fails() {
        let env_str = encrypt_payload("123456", SAMPLE).unwrap();
        let mut env: Envelope = serde_json::from_str(&env_str).unwrap();
        let mut bytes = b64().decode(env.salt.as_bytes()).unwrap();
        bytes[0] ^= 0x01;
        env.salt = b64().encode(&bytes);
        let tampered = serde_json::to_string(&env).unwrap();
        let err = decrypt_payload("123456", &tampered).unwrap_err();
        assert!(matches!(err, PairingError::DecryptFailed));
    }

    #[test]
    fn invalid_pin_length_rejected() {
        assert!(matches!(
            encrypt_payload("12345", SAMPLE).unwrap_err(),
            PairingError::InvalidPin
        ));
        assert!(matches!(
            encrypt_payload("1234567", SAMPLE).unwrap_err(),
            PairingError::InvalidPin
        ));
    }

    #[test]
    fn invalid_pin_non_digit_rejected() {
        assert!(matches!(
            encrypt_payload("12345a", SAMPLE).unwrap_err(),
            PairingError::InvalidPin
        ));
        assert!(matches!(
            decrypt_payload(" 12345", "{}").unwrap_err(),
            PairingError::InvalidPin
        ));
    }

    #[test]
    fn oversized_payload_rejected() {
        let big = vec![0u8; MAX_PAYLOAD_BYTES + 1];
        let err = encrypt_payload("123456", &big).unwrap_err();
        assert!(matches!(
            err,
            PairingError::PayloadTooLarge {
                size,
                limit
            } if size == MAX_PAYLOAD_BYTES + 1 && limit == MAX_PAYLOAD_BYTES
        ));
    }

    #[test]
    fn exactly_max_payload_accepted() {
        let max = vec![0u8; MAX_PAYLOAD_BYTES];
        let env = encrypt_payload("123456", &max).unwrap();
        let plain = decrypt_payload("123456", &env).unwrap();
        assert_eq!(plain, max);
    }

    #[test]
    fn malformed_envelope_rejected() {
        assert!(matches!(
            decrypt_payload("123456", "not json").unwrap_err(),
            PairingError::InvalidEnvelope(_)
        ));
        assert!(matches!(
            decrypt_payload("123456", r#"{"v":1,"salt":"!!!","nonce":"","ct":""}"#).unwrap_err(),
            PairingError::InvalidEnvelope(_)
        ));
    }

    #[test]
    fn unsupported_version_rejected() {
        let env = r#"{"v":99,"salt":"AAAAAAAAAAAAAAAAAAAAAA","nonce":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","ct":"AA"}"#;
        let err = decrypt_payload("123456", env).unwrap_err();
        assert!(matches!(err, PairingError::UnsupportedVersion(99)));
    }

    #[test]
    fn envelopes_vary_between_calls_with_same_input() {
        // Random salt + nonce per call → ciphertext must differ.
        let a = encrypt_payload("123456", SAMPLE).unwrap();
        let b = encrypt_payload("123456", SAMPLE).unwrap();
        assert_ne!(a, b);
    }
}
