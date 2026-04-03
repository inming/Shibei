use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use rand::rngs::OsRng;
use rand::RngCore;
use thiserror::Error;

const VERSION: u8 = 0x01;
const NONCE_LEN: usize = 24;

#[derive(Error, Debug)]
pub enum CryptoError {
    #[error("encryption failed")]
    EncryptFailed,
    #[error("decryption failed")]
    DecryptFailed,
    #[error("invalid encrypted data: {0}")]
    InvalidFormat(String),
}

/// Encrypt plaintext with XChaCha20-Poly1305.
/// Format: [1B version][24B nonce][ciphertext + 16B tag]
/// AAD (associated data) is included in authentication but not encrypted.
pub fn encrypt(plaintext: &[u8], key: &[u8; 32], aad: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let cipher = XChaCha20Poly1305::new(key.into());

    let mut nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = XNonce::from_slice(&nonce_bytes);

    let payload = Payload {
        msg: plaintext,
        aad,
    };

    let ciphertext = cipher
        .encrypt(nonce, payload)
        .map_err(|_| CryptoError::EncryptFailed)?;

    let mut output = Vec::with_capacity(1 + NONCE_LEN + ciphertext.len());
    output.push(VERSION);
    output.extend_from_slice(&nonce_bytes);
    output.extend_from_slice(&ciphertext);
    Ok(output)
}

/// Decrypt data produced by `encrypt`.
pub fn decrypt(data: &[u8], key: &[u8; 32], aad: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let min_len = 1 + NONCE_LEN + 16; // version + nonce + tag (minimum, no plaintext)
    if data.len() < min_len {
        return Err(CryptoError::InvalidFormat(format!(
            "data too short: {} bytes, need at least {}",
            data.len(),
            min_len
        )));
    }

    if data[0] != VERSION {
        return Err(CryptoError::InvalidFormat(format!(
            "unsupported version: 0x{:02x}",
            data[0]
        )));
    }

    let nonce = XNonce::from_slice(&data[1..1 + NONCE_LEN]);
    let ciphertext = &data[1 + NONCE_LEN..];

    let cipher = XChaCha20Poly1305::new(key.into());
    let payload = Payload {
        msg: ciphertext,
        aad,
    };

    cipher
        .decrypt(nonce, payload)
        .map_err(|_| CryptoError::DecryptFailed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let key = [42u8; 32];
        let plaintext = b"hello world";
        let aad = b"test/key.txt";

        let encrypted = encrypt(plaintext, &key, aad).unwrap();
        let decrypted = decrypt(&encrypted, &key, aad).unwrap();

        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_encrypted_format_has_version_and_nonce() {
        let key = [1u8; 32];
        let encrypted = encrypt(b"data", &key, b"aad").unwrap();

        assert_eq!(encrypted[0], 0x01); // version byte
        assert!(encrypted.len() > 1 + 24 + 16); // version + nonce + tag + ciphertext
    }

    #[test]
    fn test_decrypt_wrong_key_fails() {
        let key1 = [1u8; 32];
        let key2 = [2u8; 32];
        let encrypted = encrypt(b"secret", &key1, b"aad").unwrap();

        let result = decrypt(&encrypted, &key2, b"aad");
        assert!(result.is_err());
    }

    #[test]
    fn test_decrypt_wrong_aad_fails() {
        let key = [1u8; 32];
        let encrypted = encrypt(b"secret", &key, b"path/a").unwrap();

        let result = decrypt(&encrypted, &key, b"path/b");
        assert!(result.is_err());
    }

    #[test]
    fn test_decrypt_corrupted_data_fails() {
        let key = [1u8; 32];
        let mut encrypted = encrypt(b"secret", &key, b"aad").unwrap();

        // Flip a byte in the ciphertext
        let last = encrypted.len() - 1;
        encrypted[last] ^= 0xff;

        let result = decrypt(&encrypted, &key, b"aad");
        assert!(result.is_err());
    }

    #[test]
    fn test_decrypt_too_short_data_fails() {
        let key = [1u8; 32];
        let result = decrypt(&[0x01, 0x02], &key, b"aad");
        assert!(result.is_err());
    }

    #[test]
    fn test_decrypt_wrong_version_fails() {
        let key = [1u8; 32];
        let mut encrypted = encrypt(b"data", &key, b"aad").unwrap();
        encrypted[0] = 0x99; // wrong version

        let result = decrypt(&encrypted, &key, b"aad");
        assert!(result.is_err());
    }
}
