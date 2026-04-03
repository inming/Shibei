pub mod backend;
pub mod credentials;
pub mod crypto;
pub mod keyring;
pub mod encrypted_backend;
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
