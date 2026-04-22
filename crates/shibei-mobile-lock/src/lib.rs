//! Mobile lock-screen crypto primitives. Pure Rust, no Tauri/SQLite/HUKS
//! dependencies — lives in its own crate so src-harmony-napi can use it
//! without dragging in the rest of shibei-sync.
//!
//! Modules:
//!   pin      — Argon2id hash of the 4-digit PIN (stored to disk in pin_hash.blob)
//!   wrap     — HKDF-SHA256 PIN-KEK + XChaCha20-Poly1305 wrap/unwrap of MK (32 bytes)
//!   throttle — failed-attempts counter + lockout_until, persisted as JSON
//!
//! Threat model: attacker has `secure/*.blob` files off-device. They must
//! brute-force the 4-digit PIN against the Argon2id parameters below;
//! Argon2id(19MiB, 2 iters) ≈ 250ms per try on a modern phone, so 10000
//! candidates is roughly 40 minutes per device. Throttle prevents online
//! brute force.

pub mod pin;
pub mod wrap;

#[derive(thiserror::Error, Debug)]
pub enum LockError {
    #[error("error.pinMustBe4Digits")]
    PinFormat,
    #[error("error.pinIncorrect")]
    WrongPin,
    #[error("error.secureStoreCorrupted: {0}")]
    Corrupted(String),
    #[error("error.lockThrottled:{0}")]
    Throttled(i64),
}

pub type Result<T> = std::result::Result<T, LockError>;
