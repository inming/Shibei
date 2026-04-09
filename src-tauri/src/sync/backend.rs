use async_trait::async_trait;
use s3::{creds::Credentials, Bucket, Region};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum BackendError {
    #[error("S3 error: {0}")]
    S3(String),
    #[error("not found: {0}")]
    NotFound(String),
}

pub struct ObjectInfo {
    pub key: String,
    pub size: u64,
}

pub struct ObjectMeta {
    pub etag: String,
    pub size: u64,
}

#[async_trait]
pub trait SyncBackend: Send + Sync {
    async fn upload(&self, key: &str, data: &[u8]) -> Result<String, BackendError>;
    async fn download(&self, key: &str) -> Result<Vec<u8>, BackendError>;
    async fn list(&self, prefix: &str) -> Result<Vec<ObjectInfo>, BackendError>;
    async fn delete(&self, key: &str) -> Result<(), BackendError>;
    async fn head(&self, key: &str) -> Result<Option<ObjectMeta>, BackendError>;
}

pub struct S3Config {
    pub endpoint: Option<String>,
    pub region: String,
    pub bucket: String,
    pub access_key: String,
    pub secret_key: String,
}

pub struct S3Backend {
    bucket: Box<Bucket>,
}

impl S3Backend {
    pub fn new(config: S3Config) -> Result<Self, BackendError> {
        let region = match config.endpoint {
            Some(endpoint) => Region::Custom {
                region: config.region,
                endpoint,
            },
            None => config
                .region
                .parse()
                .map_err(|e| BackendError::S3(format!("invalid region: {e}")))?,
        };

        let credentials =
            Credentials::new(Some(&config.access_key), Some(&config.secret_key), None, None, None)
                .map_err(|e| BackendError::S3(format!("credentials error: {e}")))?;

        let bucket = Bucket::new(&config.bucket, region, credentials)
            .map_err(|e| BackendError::S3(format!("bucket init error: {e}")))?;

        Ok(Self { bucket })
    }
}

#[async_trait]
impl SyncBackend for S3Backend {
    async fn upload(&self, key: &str, data: &[u8]) -> Result<String, BackendError> {
        let response = self
            .bucket
            .put_object(key, data)
            .await
            .map_err(|e| BackendError::S3(e.to_string()))?;

        if response.status_code() >= 400 {
            return Err(BackendError::S3(format!(
                "upload failed with status {}",
                response.status_code()
            )));
        }

        // Return the ETag from the response headers by fetching head after upload
        let (head, _) = self
            .bucket
            .head_object(key)
            .await
            .map_err(|e| BackendError::S3(e.to_string()))?;

        let etag = head.e_tag.unwrap_or_default();
        Ok(etag)
    }

    async fn download(&self, key: &str) -> Result<Vec<u8>, BackendError> {
        let response = self
            .bucket
            .get_object(key)
            .await
            .map_err(|e| BackendError::S3(e.to_string()))?;

        if response.status_code() == 404 {
            return Err(BackendError::NotFound(key.to_string()));
        }
        if response.status_code() >= 400 {
            return Err(BackendError::S3(format!(
                "download failed with status {}",
                response.status_code()
            )));
        }

        Ok(response.to_vec())
    }

    async fn list(&self, prefix: &str) -> Result<Vec<ObjectInfo>, BackendError> {
        let results = self
            .bucket
            .list(prefix.to_string(), None)
            .await
            .map_err(|e| BackendError::S3(e.to_string()))?;

        let objects = results
            .into_iter()
            .flat_map(|page| page.contents)
            .map(|obj| ObjectInfo {
                key: obj.key,
                size: obj.size,
            })
            .collect();

        Ok(objects)
    }

    async fn delete(&self, key: &str) -> Result<(), BackendError> {
        let response = self
            .bucket
            .delete_object(key)
            .await
            .map_err(|e| BackendError::S3(e.to_string()))?;

        if response.status_code() >= 400 {
            return Err(BackendError::S3(format!(
                "delete failed with status {}",
                response.status_code()
            )));
        }

        Ok(())
    }

    async fn head(&self, key: &str) -> Result<Option<ObjectMeta>, BackendError> {
        match self.bucket.head_object(key).await {
            Ok((head, status)) => {
                if status == 404 {
                    return Ok(None);
                }
                if status >= 400 {
                    return Err(BackendError::S3(format!(
                        "head failed with status {status}"
                    )));
                }
                let etag = head.e_tag.unwrap_or_default();
                let size = head.content_length.unwrap_or(0) as u64;
                Ok(Some(ObjectMeta { etag, size }))
            }
            Err(e) => {
                let msg = e.to_string();
                // rust-s3 may surface 404 as an error rather than a status code
                if msg.contains("404") {
                    Ok(None)
                } else {
                    Err(BackendError::S3(msg))
                }
            }
        }
    }
}

pub mod mock {
    use super::{BackendError, ObjectInfo, ObjectMeta, SyncBackend};
    use async_trait::async_trait;
    use std::collections::HashMap;
    use tokio::sync::Mutex;

    pub struct MockBackend {
        pub store: Mutex<HashMap<String, Vec<u8>>>,
    }

    impl Default for MockBackend {
        fn default() -> Self {
            Self::new()
        }
    }

    impl MockBackend {
        pub fn new() -> Self {
            Self {
                store: Mutex::new(HashMap::new()),
            }
        }
    }

    #[async_trait]
    impl SyncBackend for MockBackend {
        async fn upload(&self, key: &str, data: &[u8]) -> Result<String, BackendError> {
            let mut store = self.store.lock().await;
            store.insert(key.to_string(), data.to_vec());
            // Return a fake ETag based on data length
            Ok(format!("{:032x}", data.len()))
        }

        async fn download(&self, key: &str) -> Result<Vec<u8>, BackendError> {
            let store = self.store.lock().await;
            store
                .get(key)
                .cloned()
                .ok_or_else(|| BackendError::NotFound(key.to_string()))
        }

        async fn list(&self, prefix: &str) -> Result<Vec<ObjectInfo>, BackendError> {
            let store = self.store.lock().await;
            let objects = store
                .iter()
                .filter(|(k, _)| k.starts_with(prefix))
                .map(|(k, v)| ObjectInfo {
                    key: k.clone(),
                    size: v.len() as u64,
                })
                .collect();
            Ok(objects)
        }

        async fn delete(&self, key: &str) -> Result<(), BackendError> {
            let mut store = self.store.lock().await;
            store.remove(key);
            Ok(())
        }

        async fn head(&self, key: &str) -> Result<Option<ObjectMeta>, BackendError> {
            let store = self.store.lock().await;
            Ok(store.get(key).map(|v| ObjectMeta {
                etag: format!("{:032x}", v.len()),
                size: v.len() as u64,
            }))
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[tokio::test]
        async fn test_mock_upload_download() {
            let backend = MockBackend::new();
            let data = b"hello world";

            let etag = backend.upload("test/key.txt", data).await.unwrap();
            assert!(!etag.is_empty());

            let downloaded = backend.download("test/key.txt").await.unwrap();
            assert_eq!(downloaded, data);
        }

        #[tokio::test]
        async fn test_mock_not_found() {
            let backend = MockBackend::new();
            let result = backend.download("missing/key.txt").await;
            assert!(matches!(result, Err(BackendError::NotFound(_))));
        }

        #[tokio::test]
        async fn test_mock_head() {
            let backend = MockBackend::new();
            let data = b"some content";

            let none = backend.head("no/key").await.unwrap();
            assert!(none.is_none());

            backend.upload("exists/key", data).await.unwrap();
            let meta = backend.head("exists/key").await.unwrap();
            assert!(meta.is_some());
            let meta = meta.unwrap();
            assert_eq!(meta.size, data.len() as u64);
        }

        #[tokio::test]
        async fn test_mock_list() {
            let backend = MockBackend::new();
            backend.upload("prefix/a.txt", b"a").await.unwrap();
            backend.upload("prefix/b.txt", b"b").await.unwrap();
            backend.upload("other/c.txt", b"c").await.unwrap();

            let items = backend.list("prefix/").await.unwrap();
            assert_eq!(items.len(), 2);
        }

        #[tokio::test]
        async fn test_mock_delete() {
            let backend = MockBackend::new();
            backend.upload("del/key", b"data").await.unwrap();

            backend.delete("del/key").await.unwrap();

            let result = backend.download("del/key").await;
            assert!(matches!(result, Err(BackendError::NotFound(_))));
        }
    }
}
