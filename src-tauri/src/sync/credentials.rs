use keyring::{Entry, Error as KeyringError};
use thiserror::Error;

const SERVICE_NAME: &str = "shibei-sync";
const ACCESS_KEY_USER: &str = "access_key";
const SECRET_KEY_USER: &str = "secret_key";

#[derive(Error, Debug)]
pub enum CredentialError {
    #[error("keyring error: {0}")]
    Keyring(String),
}

impl From<KeyringError> for CredentialError {
    fn from(e: KeyringError) -> Self {
        CredentialError::Keyring(e.to_string())
    }
}

pub fn store_credentials(access_key: &str, secret_key: &str) -> Result<(), CredentialError> {
    let access_entry = Entry::new(SERVICE_NAME, ACCESS_KEY_USER)?;
    access_entry.set_password(access_key)?;

    let secret_entry = Entry::new(SERVICE_NAME, SECRET_KEY_USER)?;
    secret_entry.set_password(secret_key)?;

    Ok(())
}

pub fn load_credentials() -> Result<Option<(String, String)>, CredentialError> {
    let access_entry = Entry::new(SERVICE_NAME, ACCESS_KEY_USER)?;
    let access_key = match access_entry.get_password() {
        Ok(val) => val,
        Err(KeyringError::NoEntry) => return Ok(None),
        Err(e) => return Err(CredentialError::Keyring(e.to_string())),
    };

    let secret_entry = Entry::new(SERVICE_NAME, SECRET_KEY_USER)?;
    let secret_key = match secret_entry.get_password() {
        Ok(val) => val,
        Err(KeyringError::NoEntry) => return Ok(None),
        Err(e) => return Err(CredentialError::Keyring(e.to_string())),
    };

    Ok(Some((access_key, secret_key)))
}

pub fn delete_credentials() -> Result<(), CredentialError> {
    let access_entry = Entry::new(SERVICE_NAME, ACCESS_KEY_USER)?;
    match access_entry.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => {}
        Err(e) => return Err(CredentialError::Keyring(e.to_string())),
    }

    let secret_entry = Entry::new(SERVICE_NAME, SECRET_KEY_USER)?;
    match secret_entry.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => {}
        Err(e) => return Err(CredentialError::Keyring(e.to_string())),
    }

    Ok(())
}
