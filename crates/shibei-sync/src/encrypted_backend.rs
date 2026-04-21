use std::sync::Arc;

use async_trait::async_trait;
use zeroize::Zeroizing;

use super::backend::{BackendError, ObjectInfo, ObjectMeta, SyncBackend};
use super::crypto;

pub struct EncryptedBackend<B: SyncBackend> {
    inner: Arc<B>,
    master_key: Zeroizing<[u8; 32]>,
}

impl<B: SyncBackend> EncryptedBackend<B> {
    pub fn new(inner: Arc<B>, master_key: Zeroizing<[u8; 32]>) -> Self {
        Self { inner, master_key }
    }
}

#[async_trait]
impl<B: SyncBackend + 'static> SyncBackend for EncryptedBackend<B> {
    async fn upload(&self, key: &str, data: &[u8]) -> Result<String, BackendError> {
        let encrypted = crypto::encrypt(data, &self.master_key, key.as_bytes())
            .map_err(|e| BackendError::S3(format!("encryption failed: {}", e)))?;
        self.inner.upload(key, &encrypted).await
    }

    async fn download(&self, key: &str) -> Result<Vec<u8>, BackendError> {
        let encrypted = self.inner.download(key).await?;
        crypto::decrypt(&encrypted, &self.master_key, key.as_bytes())
            .map_err(|e| BackendError::S3(format!("decryption failed: {}", e)))
    }

    async fn list(&self, prefix: &str) -> Result<Vec<ObjectInfo>, BackendError> {
        self.inner.list(prefix).await
    }

    async fn delete(&self, key: &str) -> Result<(), BackendError> {
        self.inner.delete(key).await
    }

    async fn head(&self, key: &str) -> Result<Option<ObjectMeta>, BackendError> {
        self.inner.head(key).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::mock::MockBackend;
    use std::sync::Arc;

    fn test_key() -> Zeroizing<[u8; 32]> {
        Zeroizing::new([42u8; 32])
    }

    #[tokio::test]
    async fn test_upload_encrypts_data() {
        let mock = Arc::new(MockBackend::new());
        let eb = EncryptedBackend::new(mock.clone(), test_key());

        eb.upload("test/file.txt", b"hello world").await.unwrap();

        // Data in mock backend should NOT be plaintext
        let raw = mock.download("test/file.txt").await.unwrap();
        assert_ne!(raw, b"hello world");
        assert_eq!(raw[0], 0x01); // version byte
    }

    #[tokio::test]
    async fn test_upload_download_roundtrip() {
        let mock = Arc::new(MockBackend::new());
        let eb = EncryptedBackend::new(mock, test_key());

        let original = b"test data for roundtrip";
        eb.upload("path/key", original).await.unwrap();
        let decrypted = eb.download("path/key").await.unwrap();

        assert_eq!(decrypted, original);
    }

    #[tokio::test]
    async fn test_list_passthrough() {
        let mock = Arc::new(MockBackend::new());
        let eb = EncryptedBackend::new(mock, test_key());

        eb.upload("prefix/a.txt", b"a").await.unwrap();
        eb.upload("prefix/b.txt", b"b").await.unwrap();
        eb.upload("other/c.txt", b"c").await.unwrap();

        let items = eb.list("prefix/").await.unwrap();
        assert_eq!(items.len(), 2);
    }

    #[tokio::test]
    async fn test_delete_passthrough() {
        let mock = Arc::new(MockBackend::new());
        let eb = EncryptedBackend::new(mock, test_key());

        eb.upload("del/key", b"data").await.unwrap();
        eb.delete("del/key").await.unwrap();

        let result = eb.download("del/key").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_head_passthrough() {
        let mock = Arc::new(MockBackend::new());
        let eb = EncryptedBackend::new(mock, test_key());

        assert!(eb.head("missing").await.unwrap().is_none());
        eb.upload("exists", b"data").await.unwrap();
        assert!(eb.head("exists").await.unwrap().is_some());
    }

    #[tokio::test]
    async fn test_different_keys_cannot_decrypt() {
        let mock = Arc::new(MockBackend::new());
        let eb1 = EncryptedBackend::new(mock.clone(), test_key());
        let other_key = Zeroizing::new([99u8; 32]);
        let eb2 = EncryptedBackend::new(mock, other_key);

        eb1.upload("secret", b"confidential").await.unwrap();
        let result = eb2.download("secret").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_aad_prevents_path_swap() {
        let mock = Arc::new(MockBackend::new());
        let eb = EncryptedBackend::new(mock.clone(), test_key());

        eb.upload("path/a", b"data-a").await.unwrap();

        // Manually copy encrypted data from path/a to path/b in mock
        let raw = mock.download("path/a").await.unwrap();
        mock.upload("path/b", &raw).await.unwrap();

        // Decrypting path/b should fail because AAD won't match
        let result = eb.download("path/b").await;
        assert!(result.is_err());
    }
}
