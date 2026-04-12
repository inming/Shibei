use std::fs;
use std::io::{self, Write};
use std::path::Path;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::ZipArchive;
use zip::ZipWriter;

use crate::db::{self, SharedPool};

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

pub fn import_backup(
    shared_pool: &SharedPool,
    base_dir: &Path,
    zip_path: &Path,
) -> Result<RestoreResult, String> {
    let db_path = base_dir.join("shibei.db");
    let storage_dir = base_dir.join("storage");
    let restore_tmp = base_dir.join("restore-tmp");

    // 1. Open and validate zip
    let file = fs::File::open(zip_path).map_err(|e| format!("error.restore_invalid_format: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("error.restore_invalid_format: {e}"))?;

    // 2. Read and validate manifest
    let manifest = read_manifest(&mut archive)?;
    if manifest.version != BACKUP_VERSION {
        return Err(format!("error.restore_version_unsupported: version {}", manifest.version));
    }

    // Check that shibei.db exists in archive
    archive.by_name("shibei.db").map_err(|_| "error.restore_db_missing".to_string())?;

    // 3. Extract to temp directory
    if restore_tmp.exists() {
        fs::remove_dir_all(&restore_tmp).map_err(|e| format!("error.restore_failed: {e}"))?;
    }
    fs::create_dir_all(&restore_tmp).map_err(|e| format!("error.restore_failed: {e}"))?;

    extract_zip(&mut archive, &restore_tmp)?;

    // 4. Validate the extracted db
    let tmp_db_path = restore_tmp.join("shibei.db");
    {
        let conn = Connection::open(&tmp_db_path)
            .map_err(|e| format!("error.restore_invalid_format: {e}"))?;
        conn.query_row("SELECT COUNT(*) FROM resources", [], |_| Ok(()))
            .map_err(|e| format!("error.restore_invalid_format: {e}"))?;
    }

    // 5. Acquire write lock — blocks all concurrent access
    let mut pool_guard = shared_pool.write()
        .map_err(|e| format!("error.restore_failed: pool lock poisoned: {e}"))?;

    // 6. Backup current state
    let db_bak = base_dir.join("shibei.db.bak");
    let storage_bak = base_dir.join("storage.bak");

    if db_path.exists() {
        fs::copy(&db_path, &db_bak).map_err(|e| format!("error.restore_failed: {e}"))?;
    }
    if storage_bak.exists() {
        fs::remove_dir_all(&storage_bak).map_err(|e| format!("error.restore_failed: {e}"))?;
    }
    if storage_dir.exists() {
        fs::rename(&storage_dir, &storage_bak).map_err(|e| format!("error.restore_failed: {e}"))?;
    }

    // 7. Replace db and storage
    fs::copy(&tmp_db_path, &db_path).map_err(|e| format!("error.restore_failed: {e}"))?;

    let tmp_storage = restore_tmp.join("storage");
    if tmp_storage.exists() {
        fs::rename(&tmp_storage, &storage_dir).map_err(|e| format!("error.restore_failed: {e}"))?;
    } else {
        fs::create_dir_all(&storage_dir).map_err(|e| format!("error.restore_failed: {e}"))?;
    }

    // 8. Reinitialize pool
    let new_pool = db::init_pool(&db_path).map_err(|e| format!("error.restore_failed: {e}"))?;
    *pool_guard = new_pool;
    drop(pool_guard); // release write lock

    // 9. Rebuild FTS index
    {
        let pool_read = shared_pool.read().map_err(|e| format!("error.restore_failed: {e}"))?;
        let conn = pool_read.get().map_err(|e| format!("error.restore_failed: {e}"))?;
        let _ = db::search::clear_fts_initialized(&conn);
        let _ = db::search::backfill_plain_text(&conn, base_dir);
        let _ = db::search::rebuild_all_search_index(&conn);
        let _ = db::search::mark_fts_initialized(&conn);
    }

    // 10. Cleanup
    let _ = fs::remove_dir_all(&restore_tmp);
    let _ = fs::remove_file(&db_bak);
    let _ = fs::remove_dir_all(&storage_bak);

    Ok(RestoreResult {
        resource_count: manifest.resource_count,
    })
}

fn read_manifest(archive: &mut ZipArchive<fs::File>) -> Result<BackupManifest, String> {
    let mut manifest_file = archive.by_name("manifest.json")
        .map_err(|_| "error.restore_invalid_format".to_string())?;
    let mut buf = String::new();
    io::Read::read_to_string(&mut manifest_file, &mut buf)
        .map_err(|e| format!("error.restore_invalid_format: {e}"))?;
    serde_json::from_str(&buf).map_err(|e| format!("error.restore_invalid_format: {e}"))
}

fn extract_zip(archive: &mut ZipArchive<fs::File>, dest: &Path) -> Result<(), String> {
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("error.restore_failed: {e}"))?;
        let name = entry.name().to_string();

        // Security: path traversal protection
        if name.contains("..") || name.starts_with('/') || name.starts_with('\\') {
            return Err(format!("error.restore_invalid_format: unsafe path: {name}"));
        }

        let out_path = dest.join(&name);

        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| format!("error.restore_failed: {e}"))?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("error.restore_failed: {e}"))?;
            }
            let mut outfile = fs::File::create(&out_path).map_err(|e| format!("error.restore_failed: {e}"))?;
            io::copy(&mut entry, &mut outfile).map_err(|e| format!("error.restore_failed: {e}"))?;
        }
    }
    Ok(())
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
