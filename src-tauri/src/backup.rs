use std::fs;
use std::io::Write;
use std::path::Path;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

pub const BACKUP_VERSION: u32 = 1;

#[derive(Debug, Serialize, Deserialize)]
pub struct BackupManifest {
    pub version: u32,
    pub app_version: String,
    pub created_at: String,
    pub device_id: String,
    pub resource_count: u64,
    pub snapshot_count: u64,
}

#[derive(Debug, Serialize)]
pub struct BackupResult {
    pub resource_count: u64,
    pub snapshot_count: u64,
    pub file_size: u64,
}

#[derive(Debug, Serialize)]
pub struct RestoreResult {
    pub resource_count: u64,
}

pub fn export_backup(
    db_path: &Path,
    base_dir: &Path,
    output_path: &Path,
    device_id: &str,
) -> Result<BackupResult, String> {
    // 1. VACUUM INTO a temp file using a dedicated connection
    let tmp_db = base_dir.join("backup-tmp.db");
    {
        let conn = Connection::open(db_path)
            .map_err(|e| format!("error.backup_temp_failed: {e}"))?;
        conn.execute_batch("PRAGMA busy_timeout = 5000;")
            .map_err(|e| format!("error.backup_temp_failed: {e}"))?;
        conn.execute(
            &format!("VACUUM INTO '{}'", tmp_db.to_string_lossy()),
            [],
        )
        .map_err(|e| format!("error.backup_temp_failed: {e}"))?;
    }

    // 2. Count resources from the tmp db
    let resource_count = {
        let conn = Connection::open(&tmp_db)
            .map_err(|e| format!("error.backup_temp_failed: {e}"))?;
        let count: u64 = conn
            .query_row(
                "SELECT COUNT(*) FROM resources WHERE deleted_at IS NULL",
                [],
                |row| row.get(0),
            )
            .map_err(|e| format!("error.backup_temp_failed: {e}"))?;
        count
    };

    // 3. Create zip
    let file =
        fs::File::create(output_path).map_err(|e| format!("error.backup_write_failed: {e}"))?;
    let mut zip = ZipWriter::new(file);
    let options =
        SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    // 4. Write manifest
    let storage_dir = base_dir.join("storage");
    let snapshot_count = count_snapshots(&storage_dir);

    let manifest = BackupManifest {
        version: BACKUP_VERSION,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        created_at: chrono::Utc::now().to_rfc3339(),
        device_id: device_id.to_string(),
        resource_count,
        snapshot_count,
    };
    let manifest_json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("error.backup_write_failed: {e}"))?;

    zip.start_file("manifest.json", options)
        .map_err(|e| format!("error.backup_write_failed: {e}"))?;
    zip.write_all(manifest_json.as_bytes())
        .map_err(|e| format!("error.backup_write_failed: {e}"))?;

    // 5. Write db
    let db_bytes =
        fs::read(&tmp_db).map_err(|e| format!("error.backup_write_failed: {e}"))?;
    zip.start_file("shibei.db", options)
        .map_err(|e| format!("error.backup_write_failed: {e}"))?;
    zip.write_all(&db_bytes)
        .map_err(|e| format!("error.backup_write_failed: {e}"))?;

    // 6. Write snapshots
    if storage_dir.exists() {
        add_directory_to_zip(&mut zip, &storage_dir, "storage", options)?;
    }

    zip.finish()
        .map_err(|e| format!("error.backup_write_failed: {e}"))?;

    // 7. Cleanup tmp db
    let _ = fs::remove_file(&tmp_db);

    let file_size = fs::metadata(output_path).map(|m| m.len()).unwrap_or(0);

    Ok(BackupResult {
        resource_count,
        snapshot_count,
        file_size,
    })
}

fn count_snapshots(storage_dir: &Path) -> u64 {
    let mut count = 0u64;
    if let Ok(entries) = fs::read_dir(storage_dir) {
        for entry in entries.flatten() {
            if entry.path().join("snapshot.html").exists() {
                count += 1;
            }
        }
    }
    count
}

fn add_directory_to_zip(
    zip: &mut ZipWriter<fs::File>,
    dir: &Path,
    prefix: &str,
    options: SimpleFileOptions,
) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }
    let entries =
        fs::read_dir(dir).map_err(|e| format!("error.backup_write_failed: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let zip_path = format!("{}/{}", prefix, name.to_string_lossy());
        if path.is_dir() {
            add_directory_to_zip(zip, &path, &zip_path, options)?;
        } else if path.is_file() {
            let data =
                fs::read(&path).map_err(|e| format!("error.backup_write_failed: {e}"))?;
            zip.start_file(&zip_path, options)
                .map_err(|e| format!("error.backup_write_failed: {e}"))?;
            zip.write_all(&data)
                .map_err(|e| format!("error.backup_write_failed: {e}"))?;
        }
    }
    Ok(())
}
