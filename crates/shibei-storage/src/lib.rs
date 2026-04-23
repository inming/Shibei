pub mod plain_text;
pub mod pdf_text;
#[cfg(feature = "mobile-cache")]
pub mod cache;

use std::fs;
use std::path::{Path, PathBuf};

use thiserror::Error;

#[derive(Error, Debug)]
pub enum StorageError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Initialize the storage directory structure under the given base path.
pub fn init_storage(base_path: &Path) -> Result<(), StorageError> {
    fs::create_dir_all(base_path.join("storage"))?;
    Ok(())
}

/// Returns the directory path for a specific resource: `{base}/storage/{resource_id}/`
pub fn resource_dir(base_path: &Path, resource_id: &str) -> PathBuf {
    base_path.join("storage").join(resource_id)
}

/// Save a snapshot file with a specified extension (e.g., "html", "pdf").
pub fn save_snapshot_ext(
    base_path: &Path,
    resource_id: &str,
    content: &[u8],
    extension: &str,
) -> Result<PathBuf, StorageError> {
    let dir = resource_dir(base_path, resource_id);
    fs::create_dir_all(&dir)?;
    let filename = format!("snapshot.{}", extension);
    let file_path = dir.join(&filename);
    fs::write(&file_path, content)?;
    Ok(PathBuf::from("storage")
        .join(resource_id)
        .join(filename))
}

/// Save snapshot content to disk.
/// Creates `{base}/storage/{resource_id}/snapshot.html` and returns the relative path.
pub fn save_snapshot(
    base_path: &Path,
    resource_id: &str,
    content: &[u8],
) -> Result<PathBuf, StorageError> {
    let dir = resource_dir(base_path, resource_id);
    fs::create_dir_all(&dir)?;
    let file_path = dir.join("snapshot.html");
    fs::write(&file_path, content)?;
    Ok(PathBuf::from("storage")
        .join(resource_id)
        .join("snapshot.html"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_init_storage_creates_directory() {
        let dir = tempfile::tempdir().unwrap();
        init_storage(dir.path()).unwrap();
        assert!(dir.path().join("storage").is_dir());
    }

    #[test]
    fn test_init_storage_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        init_storage(dir.path()).unwrap();
        init_storage(dir.path()).unwrap();
        assert!(dir.path().join("storage").is_dir());
    }

    #[test]
    fn test_resource_dir() {
        let base = Path::new("/tmp/shibei");
        let path = resource_dir(base, "abc-123");
        assert_eq!(path, PathBuf::from("/tmp/shibei/storage/abc-123"));
    }

    #[test]
    fn test_save_and_read_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        init_storage(dir.path()).unwrap();

        let content = b"<html>test content</html>";
        let rel_path = save_snapshot(dir.path(), "res-001", content).unwrap();

        assert_eq!(
            rel_path,
            PathBuf::from("storage/res-001/snapshot.html")
        );

        let abs_path = dir.path().join(&rel_path);
        let read_back = fs::read(&abs_path).unwrap();
        assert_eq!(read_back, content);
    }

    #[test]
    fn test_save_snapshot_with_extension_pdf() {
        let tmp = tempfile::tempdir().unwrap();
        let content = b"%PDF-1.4 fake pdf content";
        let rel = save_snapshot_ext(tmp.path(), "res-pdf-1", content, "pdf").unwrap();
        assert_eq!(
            rel,
            PathBuf::from("storage").join("res-pdf-1").join("snapshot.pdf")
        );
        let abs = tmp.path().join("storage").join("res-pdf-1").join("snapshot.pdf");
        assert!(abs.exists());
        assert_eq!(std::fs::read(&abs).unwrap(), content);
    }

    #[test]
    fn test_save_snapshot_with_extension_html() {
        let tmp = tempfile::tempdir().unwrap();
        let content = b"<html>hello</html>";
        let rel = save_snapshot_ext(tmp.path(), "res-html-1", content, "html").unwrap();
        assert_eq!(
            rel,
            PathBuf::from("storage").join("res-html-1").join("snapshot.html")
        );
    }
}
