//! Abstraction over the on-disk `secure/` directory.
//!
//! Layout (spec §3.1):
//!   secure/mk_pin.blob      — PIN-KEK wrapped MK (XChaCha20-Poly1305)
//!   secure/mk_bio.blob      — HUKS bio-gated key wrapped MK
//!   secure/pin_hash.blob    — Argon2id hash + salt of the PIN
//!   secure/s3_creds.blob    — JSON {accessKey,secretKey}, device-bound by ArkTS
//!   preferences/security.json  (not part of SecureStore — ArkTS owns this file)
//!
//! Production contract: ArkTS HuksService wraps bytes with the device-bound
//! HUKS key BEFORE handing them to NAPI for writing; reads go the other
//! direction. SecureStore itself therefore does not know about HUKS — it's
//! just a byte store. The `InMemoryStore` is for unit tests.

use std::path::PathBuf;

pub trait SecureStore: Send + Sync {
    fn read(&self, id: &str) -> Result<Option<Vec<u8>>, String>;
    fn write(&self, id: &str, bytes: &[u8]) -> Result<(), String>;
    fn delete(&self, id: &str) -> Result<(), String>;
    fn exists(&self, id: &str) -> bool {
        matches!(self.read(id), Ok(Some(_)))
    }
}

pub struct FileStore {
    base: PathBuf,
}

impl FileStore {
    pub fn new(data_dir: &std::path::Path) -> std::io::Result<Self> {
        let base = data_dir.join("secure");
        std::fs::create_dir_all(&base)?;
        Ok(Self { base })
    }

    fn path(&self, id: &str) -> PathBuf {
        self.base.join(format!("{id}.blob"))
    }
}

impl SecureStore for FileStore {
    fn read(&self, id: &str) -> Result<Option<Vec<u8>>, String> {
        match std::fs::read(self.path(id)) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("error.secureRead({id}): {e}")),
        }
    }

    fn write(&self, id: &str, bytes: &[u8]) -> Result<(), String> {
        let tmp = self.path(&format!("{id}.tmp"));
        std::fs::write(&tmp, bytes).map_err(|e| format!("error.secureWriteTmp({id}): {e}"))?;
        std::fs::rename(&tmp, self.path(id)).map_err(|e| format!("error.secureRename({id}): {e}"))?;
        Ok(())
    }

    fn delete(&self, id: &str) -> Result<(), String> {
        match std::fs::remove_file(self.path(id)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("error.secureDelete({id}): {e}")),
        }
    }
}

/// In-memory store for unit tests. Thread-safe via Mutex.
#[cfg(test)]
pub struct InMemoryStore {
    inner: std::sync::Mutex<std::collections::HashMap<String, Vec<u8>>>,
}

#[cfg(test)]
impl InMemoryStore {
    pub fn new() -> Self {
        Self { inner: std::sync::Mutex::new(std::collections::HashMap::new()) }
    }
}

#[cfg(test)]
impl Default for InMemoryStore {
    fn default() -> Self { Self::new() }
}

#[cfg(test)]
impl SecureStore for InMemoryStore {
    fn read(&self, id: &str) -> Result<Option<Vec<u8>>, String> {
        Ok(self.inner.lock().unwrap().get(id).cloned())
    }
    fn write(&self, id: &str, bytes: &[u8]) -> Result<(), String> {
        self.inner.lock().unwrap().insert(id.to_string(), bytes.to_vec());
        Ok(())
    }
    fn delete(&self, id: &str) -> Result<(), String> {
        self.inner.lock().unwrap().remove(id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn in_memory_round_trip() {
        let s = InMemoryStore::new();
        assert!(s.read("foo").unwrap().is_none());
        s.write("foo", b"bar").unwrap();
        assert_eq!(s.read("foo").unwrap(), Some(b"bar".to_vec()));
        s.delete("foo").unwrap();
        assert!(s.read("foo").unwrap().is_none());
    }

    #[test]
    fn file_round_trip() {
        let tmp = TempDir::new().unwrap();
        let s = FileStore::new(tmp.path()).unwrap();
        s.write("mk_pin", b"abc").unwrap();
        assert_eq!(s.read("mk_pin").unwrap(), Some(b"abc".to_vec()));
        assert!(s.exists("mk_pin"));
        s.delete("mk_pin").unwrap();
        assert!(!s.exists("mk_pin"));
        // delete-of-missing should be idempotent
        s.delete("mk_pin").unwrap();
    }

    #[test]
    fn file_store_overwrite() {
        let tmp = TempDir::new().unwrap();
        let s = FileStore::new(tmp.path()).unwrap();
        s.write("x", b"old").unwrap();
        s.write("x", b"new").unwrap();
        assert_eq!(s.read("x").unwrap(), Some(b"new".to_vec()));
    }
}
