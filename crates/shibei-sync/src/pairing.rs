//! Desktop-side glue for the `shibei-pairing` envelope.
//!
//! Reads current S3 configuration + credentials from `sync_state` and hands
//! them to `shibei_pairing::encrypt_payload`. Pure plumbing — all crypto
//! lives in the `shibei-pairing` crate.

use rusqlite::Connection;
use serde::Serialize;
use shibei_pairing::PairingError;
use thiserror::Error;

use super::credentials;
use super::sync_state;
use shibei_db::DbError;

#[derive(Error, Debug)]
pub enum PairError {
    #[error("error.pairingInvalidPin")]
    InvalidPin,
    #[error("error.pairingSyncNotConfigured")]
    SyncNotConfigured,
    #[error("error.pairingCredentialsMissing")]
    CredentialsMissing,
    #[error("error.pairingPayloadTooLarge")]
    PayloadTooLarge,
    #[error("error.pairingInternal")]
    Internal,
    #[error("{0}")]
    Db(#[from] DbError),
}

impl From<PairingError> for PairError {
    fn from(e: PairingError) -> Self {
        match e {
            PairingError::InvalidPin => PairError::InvalidPin,
            PairingError::PayloadTooLarge { .. } => PairError::PayloadTooLarge,
            _ => PairError::Internal,
        }
    }
}

#[derive(Serialize)]
struct PlainPayload<'a> {
    version: u8,
    endpoint: &'a str,
    region: &'a str,
    bucket: &'a str,
    access_key: &'a str,
    secret_key: &'a str,
}

/// Build a pairing envelope for the currently-configured S3 sync.
///
/// Returns the JSON envelope string (intended to be embedded in a QR code).
/// Fails if S3 is not fully configured or credentials are missing.
pub fn build_pairing_envelope(conn: &Connection, pin: &str) -> Result<String, PairError> {
    let endpoint = sync_state::get(conn, "config:s3_endpoint")?.unwrap_or_default();
    let region = sync_state::get(conn, "config:s3_region")?.unwrap_or_default();
    let bucket = sync_state::get(conn, "config:s3_bucket")?.unwrap_or_default();

    if region.is_empty() || bucket.is_empty() {
        return Err(PairError::SyncNotConfigured);
    }

    let (access_key, secret_key) = credentials::load_credentials(conn)?
        .ok_or(PairError::CredentialsMissing)?;

    let plain = PlainPayload {
        version: 1,
        endpoint: &endpoint,
        region: &region,
        bucket: &bucket,
        access_key: &access_key,
        secret_key: &secret_key,
    };

    let plain_bytes = serde_json::to_vec(&plain).map_err(|_| PairError::Internal)?;
    let envelope = shibei_pairing::encrypt_payload(pin, &plain_bytes)?;
    Ok(envelope)
}

#[cfg(test)]
mod tests {
    use super::*;
    use shibei_db::init_db;
    use serde_json::Value;
    use tempfile::tempdir;

    fn setup_db() -> (tempfile::TempDir, Connection) {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.db");
        let conn = init_db(&path).unwrap();
        (dir, conn)
    }

    #[test]
    fn fails_when_sync_not_configured() {
        let (_tmp, conn) = setup_db();
        let err = build_pairing_envelope(&conn, "123456").unwrap_err();
        assert!(matches!(err, PairError::SyncNotConfigured));
    }

    #[test]
    fn fails_when_credentials_missing() {
        let (_tmp, conn) = setup_db();
        sync_state::set(&conn, "config:s3_region", "us-east-1").unwrap();
        sync_state::set(&conn, "config:s3_bucket", "my-bucket").unwrap();
        let err = build_pairing_envelope(&conn, "123456").unwrap_err();
        assert!(matches!(err, PairError::CredentialsMissing));
    }

    #[test]
    fn fails_on_invalid_pin() {
        let (_tmp, conn) = setup_db();
        sync_state::set(&conn, "config:s3_region", "us-east-1").unwrap();
        sync_state::set(&conn, "config:s3_bucket", "my-bucket").unwrap();
        credentials::store_credentials(&conn, "AKIA...", "SECRET...").unwrap();
        let err = build_pairing_envelope(&conn, "12345").unwrap_err();
        assert!(matches!(err, PairError::InvalidPin));
    }

    #[test]
    fn round_trip_through_shibei_pairing() {
        let (_tmp, conn) = setup_db();
        sync_state::set(&conn, "config:s3_endpoint", "https://s3.example.com").unwrap();
        sync_state::set(&conn, "config:s3_region", "us-east-1").unwrap();
        sync_state::set(&conn, "config:s3_bucket", "my-bucket").unwrap();
        credentials::store_credentials(&conn, "AKIAEXAMPLE", "SecretExampleKey").unwrap();

        let envelope = build_pairing_envelope(&conn, "987654").unwrap();
        let plain = shibei_pairing::decrypt_payload("987654", &envelope).unwrap();
        let decoded: Value = serde_json::from_slice(&plain).unwrap();
        assert_eq!(decoded["endpoint"], "https://s3.example.com");
        assert_eq!(decoded["region"], "us-east-1");
        assert_eq!(decoded["bucket"], "my-bucket");
        assert_eq!(decoded["access_key"], "AKIAEXAMPLE");
        assert_eq!(decoded["secret_key"], "SecretExampleKey");
        assert_eq!(decoded["version"], 1);
    }
}
