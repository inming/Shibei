use std::path::Path;

pub fn get_or_create_device_id(base_dir: &Path) -> Result<String, std::io::Error> {
    let device_id_path = base_dir.join("device_id");

    if device_id_path.exists() {
        let contents = std::fs::read_to_string(&device_id_path)?;
        let trimmed = contents.trim().to_string();
        if !trimmed.is_empty() {
            return Ok(trimmed);
        }
    }

    let id = uuid::Uuid::new_v4().to_string();
    std::fs::write(&device_id_path, &id)?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_creates_new_device_id() {
        let dir = tempfile::tempdir().unwrap();
        let id = get_or_create_device_id(dir.path()).unwrap();
        assert!(!id.is_empty());
        assert_eq!(id.len(), 36); // UUID format
    }

    #[test]
    fn test_returns_existing_device_id() {
        let dir = tempfile::tempdir().unwrap();
        let id1 = get_or_create_device_id(dir.path()).unwrap();
        let id2 = get_or_create_device_id(dir.path()).unwrap();
        assert_eq!(id1, id2);
    }
}
