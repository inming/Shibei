use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use rusqlite::params;
use thiserror::Error;

use crate::db::{DbError, DbPool};
use crate::sync::backend::{BackendError, SyncBackend};
use crate::sync::hlc::HlcClock;
use crate::sync::sync_log::{self, SyncLogEntry};
use crate::sync::sync_state;

#[derive(Error, Debug)]
pub enum SyncError {
    #[error("database error: {0}")]
    Db(#[from] DbError),
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("backend error: {0}")]
    Backend(#[from] BackendError),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("sync already running")]
    AlreadyRunning,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("encryption required: remote has encryption enabled")]
    EncryptionRequired,
    #[error("wrong password")]
    WrongPassword,
    #[error("keyring tampered")]
    KeyringTampered,
    #[error("keyring not found on remote")]
    KeyringNotFound,
    #[error("decryption failed: {0}")]
    DecryptionFailed(String),
}

#[derive(Debug)]
pub enum SyncResult {
    Success {
        uploaded: usize,
        downloaded: usize,
        applied: usize,
    },
    Skipped,
}

pub struct SyncEngine {
    pool: DbPool,
    backend: Arc<dyn SyncBackend>,
    device_id: String,
    clock: Arc<HlcClock>,
    lock: tokio::sync::Mutex<()>,
    base_dir: PathBuf,
}

/// Callback for reporting sync progress to the UI.
/// Arguments: (phase, current, total)
pub type ProgressCallback = Box<dyn Fn(&str, usize, usize) + Send + Sync>;

impl SyncEngine {
    pub fn new(
        pool: DbPool,
        backend: Arc<dyn SyncBackend>,
        device_id: String,
        clock: Arc<HlcClock>,
        base_dir: PathBuf,
    ) -> Self {
        Self {
            pool,
            backend,
            device_id,
            clock,
            lock: tokio::sync::Mutex::new(()),
            base_dir,
        }
    }

    /// Run the full sync cycle: upload local changes, download and apply remote changes.
    pub async fn sync(&self, on_progress: Option<&ProgressCallback>) -> Result<SyncResult, SyncError> {
        // Try lock — skip if already syncing
        let _guard = match self.lock.try_lock() {
            Ok(guard) => guard,
            Err(_) => return Err(SyncError::AlreadyRunning),
        };

        // Phase 0: First-time sync — upload full state snapshot if never synced before
        self.ensure_initial_snapshot().await?;

        // Phase 1: Upload local changes
        let uploaded = self.upload_local_changes(on_progress).await?;

        // Phase 1.5: Import full snapshot if this is a new device
        let snapshot_imported = self.maybe_import_snapshot().await?;

        // Phase 2+3: Download and apply remote changes
        let (downloaded, applied) = self.download_and_apply(on_progress).await?;

        // Update last_sync_at
        {
            let conn = self.pool.get().map_err(DbError::Pool)?;
            sync_state::set(&conn, "last_sync_at", &crate::db::now_iso8601())?;
        }

        // Phase 4: Download pending resource snapshots
        self.download_pending_snapshots(on_progress).await;

        // Phase 5: Compaction check
        if let Err(e) = self.maybe_compact().await {
            eprintln!("[sync] Compaction failed: {}", e);
            // Don't fail the sync for compaction errors
        }

        Ok(SyncResult::Success {
            uploaded,
            downloaded,
            applied: applied + snapshot_imported,
        })
    }

    /// Run compaction if the device's sync directory has grown too large.
    ///
    /// Compaction:
    /// 1. Export full DB state and upload as a snapshot JSON.
    /// 2. Delete files that were marked pending-deletion from the previous compaction (two-phase).
    /// 3. Mark current sync files as pending deletion for the next compaction.
    /// 4. Hard-delete soft-deleted rows older than 90 days.
    /// 5. Remove uploaded sync_log entries.
    ///
    /// Returns `true` if compaction ran, `false` if it was not needed.
    pub async fn maybe_compact(&self) -> Result<bool, SyncError> {
        let prefix = format!("sync/{}/", self.device_id);
        let files = self.backend.list(&prefix).await?;
        let total_size: u64 = files.iter().map(|f| f.size).sum();

        if files.len() < 100 && total_size < 10 * 1024 * 1024 {
            return Ok(false); // No compaction needed
        }

        let conn = self.pool.get().map_err(|e| SyncError::Db(DbError::Pool(e)))?;

        // 1. Export full state and upload as snapshot
        let snapshot = super::export::export_full_state(&conn, &self.device_id)?;
        let snapshot_json = serde_json::to_vec_pretty(&snapshot)?;
        let ts = crate::db::now_iso8601().replace(':', "-");
        let snapshot_key = format!("state/snapshot-{}.json", ts);
        self.backend.upload(&snapshot_key, &snapshot_json).await?;

        // 2. Delete previously-pending files (two-phase cleanup)
        let pending_key = "state/compaction-pending.json";
        if let Ok(pending_data) = self.backend.download(pending_key).await {
            if let Ok(pending_files) = serde_json::from_slice::<Vec<String>>(&pending_data) {
                for file_key in &pending_files {
                    let _ = self.backend.delete(file_key).await;
                }
            }
        }

        // 3. Mark current files as pending deletion for next compaction
        let file_keys: Vec<String> = files.iter().map(|f| f.key.clone()).collect();
        let pending_json = serde_json::to_vec(&file_keys)?;
        self.backend.upload(pending_key, &pending_json).await?;

        // 4. Physical cleanup: hard-delete soft-deleted rows older than 90 days
        let cutoff = (chrono::Utc::now() - chrono::Duration::days(90)).to_rfc3339();
        for table in &["folders", "resources", "tags", "highlights", "comments", "resource_tags"] {
            conn.execute(
                &format!(
                    "DELETE FROM {} WHERE deleted_at IS NOT NULL AND deleted_at < ?1",
                    table
                ),
                rusqlite::params![cutoff],
            )?;
        }

        // 5. Clean up uploaded sync_log entries
        super::sync_log::delete_uploaded(&conn)?;

        Ok(true)
    }

    /// Phase 0: On first sync, upload a full state snapshot + all existing snapshots.
    /// This ensures pre-existing data (created before sync was enabled) gets uploaded.
    async fn ensure_initial_snapshot(&self) -> Result<(), SyncError> {
        // Check if we've ever synced
        {
            let conn = self.pool.get().map_err(DbError::Pool)?;
            if sync_state::get(&conn, "last_sync_at")?.is_some() {
                return Ok(());
            }
        }

        // Check if snapshot already exists on S3
        let existing = self.backend.list("state/snapshot-").await?;
        if !existing.is_empty() {
            return Ok(());
        }

        eprintln!("[sync] First-time sync: uploading full state snapshot");

        // Export full state (scoped to drop conn before await)
        let (snapshot_json, resource_ids, max_id) = {
            let conn = self.pool.get().map_err(DbError::Pool)?;
            let snapshot = super::export::export_full_state(&conn, &self.device_id)?;
            let json = serde_json::to_vec_pretty(&snapshot)?;

            let mut stmt = conn.prepare("SELECT id FROM resources WHERE deleted_at IS NULL")?;
            let ids: Vec<String> = stmt
                .query_map([], |row| row.get::<_, String>(0))?
                .filter_map(|r| r.ok())
                .collect();
            drop(stmt);

            let max: i64 = conn.query_row(
                "SELECT COALESCE(MAX(id), 0) FROM sync_log", [], |row| row.get(0),
            )?;
            (json, ids, max)
        };

        // Upload snapshot
        let ts = crate::db::now_iso8601().replace(':', "-");
        let key = format!("state/snapshot-{}.json", ts);
        self.backend.upload(&key, &snapshot_json).await?;

        // Upload all existing resource snapshots
        for resource_id in &resource_ids {
            if let Err(e) = self.upload_snapshot(resource_id).await {
                eprintln!("[sync] Warning: failed to upload snapshot for {}: {}", resource_id, e);
            }
        }

        // Mark existing sync_log as uploaded
        if max_id > 0 {
            let conn = self.pool.get().map_err(DbError::Pool)?;
            sync_log::mark_uploaded(&conn, max_id)?;
        }

        eprintln!("[sync] Initial snapshot uploaded ({} resources)", resource_ids.len());
        Ok(())
    }

    /// Phase 1: Upload pending sync_log entries and associated snapshots.
    async fn upload_local_changes(&self, on_progress: Option<&ProgressCallback>) -> Result<usize, SyncError> {
        let pending = {
            let conn = self.pool.get().map_err(DbError::Pool)?;
            sync_log::get_pending(&conn)?
        };

        if pending.is_empty() {
            return Ok(0);
        }

        let count = pending.len();

        // Serialize to JSONL
        let mut jsonl = String::new();
        for entry in &pending {
            let line = serde_json::to_string(entry)?;
            jsonl.push_str(&line);
            jsonl.push('\n');
        }

        // Upload JSONL to sync/<device_id>/<timestamp>.jsonl
        let timestamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%3fZ").to_string();
        let key = format!("sync/{}/{}.jsonl", self.device_id, timestamp);
        self.backend.upload(&key, jsonl.as_bytes()).await?;

        // Mark entries as uploaded
        let max_id = pending.last().map(|e| e.id).unwrap_or(0);
        {
            let conn = self.pool.get().map_err(DbError::Pool)?;
            sync_log::mark_uploaded(&conn, max_id)?;
            sync_state::set(&conn, "last_uploaded_log_id", &max_id.to_string())?;
        }

        // Upload snapshots for new resources
        let snapshot_entries: Vec<_> = pending
            .iter()
            .filter(|e| e.entity_type == "resource" && e.operation == "INSERT")
            .collect();
        let snapshot_total = snapshot_entries.len();

        for (i, entry) in snapshot_entries.iter().enumerate() {
            if let Err(e) = self.upload_snapshot(&entry.entity_id).await {
                eprintln!(
                    "warning: failed to upload snapshot for {}: {}",
                    entry.entity_id, e
                );
            }
            if let Some(cb) = on_progress {
                cb("uploading", i + 1, snapshot_total);
            }
        }

        Ok(count)
    }

    /// Phase 1.5: On first sync for a new device, download and import the latest full snapshot.
    async fn maybe_import_snapshot(&self) -> Result<usize, SyncError> {
        // Only run if we've never synced before
        {
            let conn = self.pool.get().map_err(DbError::Pool)?;
            if sync_state::get(&conn, "last_sync_at")?.is_some() {
                return Ok(0);
            }
        }

        // Find the latest snapshot on S3
        let snapshots = self.backend.list("state/snapshot-").await?;
        if snapshots.is_empty() {
            return Ok(0);
        }

        // Pick the latest by key (lexicographic = chronological due to timestamp format)
        let latest_key = snapshots.iter()
            .map(|o| &o.key)
            .max()
            .unwrap()
            .clone();

        eprintln!("[sync] Importing full snapshot: {}", latest_key);

        let data = self.backend.download(&latest_key).await?;
        let snapshot: super::export::FullSnapshot = serde_json::from_slice(&data)?;

        let conn = self.pool.get().map_err(DbError::Pool)?;
        // Temporarily disable FK checks — snapshot import is in topo order but
        // some cross-references may not resolve until the full import completes
        conn.execute_batch("PRAGMA foreign_keys = OFF")?;
        let mut imported = 0usize;

        // Import in topo order: folders → tags → resources (with tags) → highlights → comments
        for folder in &snapshot.folders {
            let hlc = folder["hlc"].as_str().unwrap_or("");
            if let Some(deleted_at) = folder["deleted_at"].as_str() {
                let id = folder["id"].as_str().unwrap_or_default();
                self.soft_delete_entity(&conn, "folder", id, deleted_at, hlc)?;
            } else {
                self.upsert_entity(&conn, "folder", folder["id"].as_str().unwrap_or_default(), folder, hlc)?;
            }
            imported += 1;
        }

        for tag in &snapshot.tags {
            let hlc = tag["hlc"].as_str().unwrap_or("");
            if let Some(deleted_at) = tag["deleted_at"].as_str() {
                self.soft_delete_entity(&conn, "tag", tag["id"].as_str().unwrap_or_default(), deleted_at, hlc)?;
            } else {
                self.upsert_entity(&conn, "tag", tag["id"].as_str().unwrap_or_default(), tag, hlc)?;
            }
            imported += 1;
        }

        for resource in &snapshot.resources {
            let hlc = resource["hlc"].as_str().unwrap_or("");
            let id = resource["id"].as_str().unwrap_or_default();
            if let Some(deleted_at) = resource["deleted_at"].as_str() {
                self.soft_delete_entity(&conn, "resource", id, deleted_at, hlc)?;
            } else {
                self.upsert_entity(&conn, "resource", id, resource, hlc)?;
            }
            imported += 1;
        }

        // Import resource_tags
        for rt in &snapshot.resource_tags {
            let rid = rt["resource_id"].as_str().unwrap_or_default();
            let tid = rt["tag_id"].as_str().unwrap_or_default();
            if rt["deleted_at"].is_null() && !rid.is_empty() && !tid.is_empty() {
                let rt_hlc = rt["hlc"].as_str().unwrap_or("");
                conn.execute(
                    "INSERT OR IGNORE INTO resource_tags (resource_id, tag_id, hlc) VALUES (?1, ?2, ?3)",
                    params![rid, tid, rt_hlc],
                )?;
            }
        }

        for highlight in &snapshot.highlights {
            let hlc = highlight["hlc"].as_str().unwrap_or("");
            let id = highlight["id"].as_str().unwrap_or_default();
            if let Some(deleted_at) = highlight["deleted_at"].as_str() {
                self.soft_delete_entity(&conn, "highlight", id, deleted_at, hlc)?;
            } else {
                self.upsert_entity(&conn, "highlight", id, highlight, hlc)?;
            }
            imported += 1;
        }

        for comment in &snapshot.comments {
            let hlc = comment["hlc"].as_str().unwrap_or("");
            let id = comment["id"].as_str().unwrap_or_default();
            if let Some(deleted_at) = comment["deleted_at"].as_str() {
                self.soft_delete_entity(&conn, "comment", id, deleted_at, hlc)?;
            } else {
                self.upsert_entity(&conn, "comment", id, comment, hlc)?;
            }
            imported += 1;
        }

        // Re-enable FK checks
        conn.execute_batch("PRAGMA foreign_keys = ON")?;

        eprintln!("[sync] Snapshot imported: {} entities", imported);
        Ok(imported)
    }

    /// Phase 2+3: Download remote changes and apply with LWW.
    async fn download_and_apply(&self, on_progress: Option<&ProgressCallback>) -> Result<(usize, usize), SyncError> {
        // List all device directories under sync/
        let objects = self.backend.list("sync/").await?;

        // Extract unique device IDs from keys like "sync/<device_id>/..."
        let mut remote_devices: Vec<String> = objects
            .iter()
            .filter_map(|obj| {
                let parts: Vec<&str> = obj.key.split('/').collect();
                if parts.len() >= 3 {
                    Some(parts[1].to_string())
                } else {
                    None
                }
            })
            .collect();
        remote_devices.sort();
        remote_devices.dedup();

        // Skip self
        remote_devices.retain(|d| d != &self.device_id);

        // Pre-collect per-device file lists for progress counting
        struct DeviceFiles {
            last_seq_key: String,
            files: Vec<crate::sync::backend::ObjectInfo>,
        }

        let mut device_file_list: Vec<DeviceFiles> = Vec::new();
        let mut total_files = 0usize;

        for device in &remote_devices {
            let last_seq_key = format!("remote:{}:last_seq", device);
            let last_seq = {
                let conn = self.pool.get().map_err(DbError::Pool)?;
                sync_state::get(&conn, &last_seq_key)?
            };

            let prefix = format!("sync/{}/", device);
            let mut files: Vec<_> = self
                .backend
                .list(&prefix)
                .await?
                .into_iter()
                .filter(|obj| obj.key.ends_with(".jsonl"))
                .collect();
            files.sort_by(|a, b| a.key.cmp(&b.key));

            if let Some(ref seq) = last_seq {
                files.retain(|f| {
                    if let Some(fname) = f.key.rsplit('/').next() {
                        fname > seq.as_str()
                    } else {
                        false
                    }
                });
            }

            total_files += files.len();
            device_file_list.push(DeviceFiles {
                last_seq_key,
                files,
            });
        }

        let mut total_downloaded = 0usize;
        let mut all_entries: Vec<SyncLogEntry> = Vec::new();

        for df in &device_file_list {
            let mut latest_seq: Option<String> = None;

            for file_obj in &df.files {
                let data = self.backend.download(&file_obj.key).await?;
                let content = String::from_utf8_lossy(&data);
                total_downloaded += 1;

                if let Some(cb) = on_progress {
                    cb("downloading", total_downloaded, total_files);
                }

                for line in content.lines() {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    let entry: SyncLogEntry = serde_json::from_str(line)?;
                    all_entries.push(entry);
                }

                // Track latest file as seq
                if let Some(fname) = file_obj.key.rsplit('/').next() {
                    latest_seq = Some(fname.to_string());
                }
            }

            // Update last_seq for this device
            if let Some(seq) = latest_seq {
                let conn = self.pool.get().map_err(DbError::Pool)?;
                sync_state::set(&conn, &df.last_seq_key, &seq)?;
            }
        }

        // Phase 3: Apply with topo-sort
        let applied = self.apply_entries(all_entries)?;

        Ok((total_downloaded, applied))
    }

    /// Apply remote entries with LWW conflict resolution and topo-sort ordering.
    fn apply_entries(&self, mut entries: Vec<SyncLogEntry>) -> Result<usize, SyncError> {
        if entries.is_empty() {
            return Ok(0);
        }

        // Topo-sort: assign order based on (operation, entity_type)
        entries.sort_by_key(|e| topo_order(&e.operation, &e.entity_type));

        let conn = self.pool.get().map_err(DbError::Pool)?;
        conn.execute_batch("PRAGMA foreign_keys = OFF")?;
        let mut applied = 0usize;
        let mut affected_resource_ids = HashSet::new();

        for entry in &entries {
            // Skip entries from self
            if entry.device_id == self.device_id {
                continue;
            }

            // LWW check: get local entity's hlc
            let local_hlc = get_entity_hlc(&conn, &entry.entity_type, &entry.entity_id)?;
            if let Some(ref local) = local_hlc {
                // If local hlc >= remote hlc, skip (local wins)
                if local.as_str() >= entry.hlc.as_str() {
                    continue;
                }
            }

            // Advance local clock with remote HLC
            if let Ok(remote_hlc) = entry.hlc.parse::<crate::sync::hlc::Hlc>() {
                self.clock.receive(&remote_hlc);
            }

            let payload: serde_json::Value = serde_json::from_str(&entry.payload)?;

            match entry.operation.as_str() {
                "INSERT" | "UPDATE" => {
                    self.upsert_entity(&conn, &entry.entity_type, &entry.entity_id, &payload, &entry.hlc)?;
                    applied += 1;
                    match entry.entity_type.as_str() {
                        "resource" => { affected_resource_ids.insert(entry.entity_id.clone()); }
                        "highlight" | "comment" => {
                            if let Some(rid) = payload["resource_id"].as_str() {
                                affected_resource_ids.insert(rid.to_string());
                            }
                        }
                        _ => {}
                    }
                }
                "DELETE" => {
                    let now = crate::db::now_iso8601();
                    let deleted_at = payload["deleted_at"]
                        .as_str()
                        .unwrap_or(&now);
                    self.soft_delete_entity(&conn, &entry.entity_type, &entry.entity_id, deleted_at, &entry.hlc)?;
                    applied += 1;
                    match entry.entity_type.as_str() {
                        "resource" => { affected_resource_ids.insert(entry.entity_id.clone()); }
                        "highlight" | "comment" => {
                            if let Some(rid) = payload["resource_id"].as_str() {
                                affected_resource_ids.insert(rid.to_string());
                            }
                        }
                        _ => {}
                    }
                }
                _ => {
                    // Unknown operation, skip
                }
            }
        }

        conn.execute_batch("PRAGMA foreign_keys = ON")?;

        // Rebuild FTS for affected resources
        for rid in &affected_resource_ids {
            let is_deleted: bool = conn
                .query_row(
                    "SELECT deleted_at IS NOT NULL FROM resources WHERE id = ?1",
                    rusqlite::params![rid],
                    |row| row.get(0),
                )
                .unwrap_or(true);
            if is_deleted {
                let _ = crate::db::search::delete_search_index(&conn, rid);
            } else {
                let _ = crate::db::search::rebuild_search_index(&conn, rid);
            }
        }

        Ok(applied)
    }

    /// Upsert an entity from a remote sync entry.
    fn upsert_entity(
        &self,
        conn: &rusqlite::Connection,
        entity_type: &str,
        entity_id: &str,
        payload: &serde_json::Value,
        hlc: &str,
    ) -> Result<(), SyncError> {
        match entity_type {
            "folder" => self.upsert_folder(conn, entity_id, payload, hlc),
            "tag" => self.upsert_tag(conn, entity_id, payload, hlc),
            "resource" => self.upsert_resource(conn, entity_id, payload, hlc),
            "highlight" => self.upsert_highlight(conn, entity_id, payload, hlc),
            "comment" => self.upsert_comment(conn, entity_id, payload, hlc),
            _ => Ok(()), // Unknown entity type, skip
        }
    }

    fn upsert_folder(
        &self,
        conn: &rusqlite::Connection,
        id: &str,
        payload: &serde_json::Value,
        hlc: &str,
    ) -> Result<(), SyncError> {
        let name = payload["name"].as_str().unwrap_or("");
        let parent_id = payload["parent_id"].as_str().unwrap_or("__root__");
        let sort_order = payload["sort_order"].as_i64().unwrap_or(0);
        let created_at = payload["created_at"].as_str().unwrap_or("");
        let updated_at = payload["updated_at"].as_str().unwrap_or("");

        // Remove any local folder with the same (parent_id, name) but different id,
        // to avoid UNIQUE constraint violation during cross-device sync.
        conn.execute(
            "DELETE FROM folders WHERE parent_id = ?1 AND name = ?2 AND id != ?3",
            params![parent_id, name, id],
        )?;

        conn.execute(
            "INSERT INTO folders (id, name, parent_id, sort_order, created_at, updated_at, hlc, deleted_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               parent_id = excluded.parent_id,
               sort_order = excluded.sort_order,
               updated_at = excluded.updated_at,
               hlc = excluded.hlc,
               deleted_at = NULL",
            params![id, name, parent_id, sort_order, created_at, updated_at, hlc],
        )?;
        Ok(())
    }

    fn upsert_tag(
        &self,
        conn: &rusqlite::Connection,
        id: &str,
        payload: &serde_json::Value,
        hlc: &str,
    ) -> Result<(), SyncError> {
        let name = payload["name"].as_str().unwrap_or("");
        let color = payload["color"].as_str().unwrap_or("#808080");

        // Remove any local tag with the same name but different id,
        // to avoid UNIQUE constraint violation during cross-device sync.
        conn.execute(
            "DELETE FROM tags WHERE name = ?1 AND id != ?2 AND deleted_at IS NULL",
            params![name, id],
        )?;

        conn.execute(
            "INSERT INTO tags (id, name, color, hlc, deleted_at)
             VALUES (?1, ?2, ?3, ?4, NULL)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               color = excluded.color,
               hlc = excluded.hlc,
               deleted_at = NULL",
            params![id, name, color, hlc],
        )?;
        Ok(())
    }

    fn upsert_resource(
        &self,
        conn: &rusqlite::Connection,
        id: &str,
        payload: &serde_json::Value,
        hlc: &str,
    ) -> Result<(), SyncError> {
        let title = payload["title"].as_str().unwrap_or("");
        let url = payload["url"].as_str().unwrap_or("");
        let domain = payload["domain"].as_str();
        let author = payload["author"].as_str();
        let description = payload["description"].as_str();
        let folder_id = payload["folder_id"].as_str().unwrap_or("__root__");
        let resource_type = payload["resource_type"].as_str().unwrap_or("webpage");
        let file_path = payload["file_path"].as_str().unwrap_or("");
        let created_at = payload["created_at"].as_str().unwrap_or("");
        let captured_at = payload["captured_at"].as_str().unwrap_or("");
        let selection_meta = payload["selection_meta"].as_str();

        conn.execute(
            "INSERT INTO resources (id, title, url, domain, author, description, folder_id, resource_type, file_path, created_at, captured_at, selection_meta, hlc, deleted_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, NULL)
             ON CONFLICT(id) DO UPDATE SET
               title = excluded.title,
               url = excluded.url,
               domain = excluded.domain,
               author = excluded.author,
               description = excluded.description,
               folder_id = excluded.folder_id,
               resource_type = excluded.resource_type,
               file_path = excluded.file_path,
               selection_meta = excluded.selection_meta,
               hlc = excluded.hlc,
               deleted_at = NULL",
            params![id, title, url, domain, author, description, folder_id, resource_type, file_path, created_at, captured_at, selection_meta, hlc],
        )?;

        // Handle tag_ids if present
        if let Some(tag_ids) = payload["tag_ids"].as_array() {
            // Delete existing resource_tags for this resource
            conn.execute(
                "DELETE FROM resource_tags WHERE resource_id = ?1",
                params![id],
            )?;

            // Re-insert all tag associations
            for tag_val in tag_ids {
                if let Some(tag_id) = tag_val.as_str() {
                    conn.execute(
                        "INSERT OR IGNORE INTO resource_tags (resource_id, tag_id, hlc)
                         VALUES (?1, ?2, ?3)",
                        params![id, tag_id, hlc],
                    )?;
                }
            }
        }

        // Mark snapshot as pending download
        let snapshot_key = format!("snapshot:{}", id);
        sync_state::set(conn, &snapshot_key, "pending")?;

        Ok(())
    }

    fn upsert_highlight(
        &self,
        conn: &rusqlite::Connection,
        id: &str,
        payload: &serde_json::Value,
        hlc: &str,
    ) -> Result<(), SyncError> {
        let resource_id = payload["resource_id"].as_str().unwrap_or("");
        let text_content = payload["text_content"].as_str().unwrap_or("");
        // anchor is stored as JSON string in DB, but may arrive as object or string in payload
        let anchor = if payload["anchor"].is_string() {
            payload["anchor"].as_str().unwrap_or("").to_string()
        } else {
            payload["anchor"].to_string()
        };
        let color = payload["color"].as_str().unwrap_or("#FFEB3B");
        let created_at = payload["created_at"].as_str().unwrap_or("");

        conn.execute(
            "INSERT INTO highlights (id, resource_id, text_content, anchor, color, created_at, hlc, deleted_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)
             ON CONFLICT(id) DO UPDATE SET
               resource_id = excluded.resource_id,
               text_content = excluded.text_content,
               anchor = excluded.anchor,
               color = excluded.color,
               hlc = excluded.hlc,
               deleted_at = NULL",
            params![id, resource_id, text_content, anchor, color, created_at, hlc],
        )?;
        Ok(())
    }

    fn upsert_comment(
        &self,
        conn: &rusqlite::Connection,
        id: &str,
        payload: &serde_json::Value,
        hlc: &str,
    ) -> Result<(), SyncError> {
        let highlight_id = payload["highlight_id"].as_str();
        let resource_id = payload["resource_id"].as_str().unwrap_or("");
        let content = payload["content"].as_str().unwrap_or("");
        let created_at = payload["created_at"].as_str().unwrap_or("");
        let updated_at = payload["updated_at"].as_str().unwrap_or("");

        conn.execute(
            "INSERT INTO comments (id, highlight_id, resource_id, content, created_at, updated_at, hlc, deleted_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)
             ON CONFLICT(id) DO UPDATE SET
               highlight_id = excluded.highlight_id,
               resource_id = excluded.resource_id,
               content = excluded.content,
               updated_at = excluded.updated_at,
               hlc = excluded.hlc,
               deleted_at = NULL",
            params![id, highlight_id, resource_id, content, created_at, updated_at, hlc],
        )?;
        Ok(())
    }

    /// Soft-delete an entity if it hasn't been deleted yet.
    fn soft_delete_entity(
        &self,
        conn: &rusqlite::Connection,
        entity_type: &str,
        entity_id: &str,
        deleted_at: &str,
        hlc: &str,
    ) -> Result<(), SyncError> {
        let table = match entity_type {
            "folder" => "folders",
            "resource" => "resources",
            "tag" => "tags",
            "highlight" => "highlights",
            "comment" => "comments",
            _ => return Ok(()),
        };

        let sql = format!(
            "UPDATE {} SET deleted_at = ?1, hlc = ?2 WHERE id = ?3 AND deleted_at IS NULL",
            table
        );
        conn.execute(&sql, params![deleted_at, hlc, entity_id])?;

        if entity_type == "folder" {
            self.cascade_folder_delete(conn, entity_id, deleted_at)?;
        }

        Ok(())
    }

    /// Cascade soft-delete all resources (and their annotations) in a folder,
    /// then recurse into child folders.
    fn cascade_folder_delete(
        &self,
        conn: &rusqlite::Connection,
        folder_id: &str,
        deleted_at: &str,
    ) -> Result<(), SyncError> {
        // Get resource IDs in this folder
        let mut stmt =
            conn.prepare("SELECT id FROM resources WHERE folder_id = ?1 AND deleted_at IS NULL")?;
        let resource_ids: Vec<String> = stmt
            .query_map(params![folder_id], |row| row.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect();

        for rid in &resource_ids {
            conn.execute(
                "UPDATE resource_tags SET deleted_at = ?1 WHERE resource_id = ?2 AND deleted_at IS NULL",
                params![deleted_at, rid],
            )?;
            conn.execute(
                "UPDATE highlights SET deleted_at = ?1 WHERE resource_id = ?2 AND deleted_at IS NULL",
                params![deleted_at, rid],
            )?;
            conn.execute(
                "UPDATE comments SET deleted_at = ?1 WHERE resource_id = ?2 AND deleted_at IS NULL",
                params![deleted_at, rid],
            )?;
        }

        conn.execute(
            "UPDATE resources SET deleted_at = ?1 WHERE folder_id = ?2 AND deleted_at IS NULL",
            params![deleted_at, folder_id],
        )?;

        // Recurse into child folders
        let mut stmt =
            conn.prepare("SELECT id FROM folders WHERE parent_id = ?1 AND deleted_at IS NULL")?;
        let child_ids: Vec<String> = stmt
            .query_map(params![folder_id], |row| row.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect();

        for child_id in &child_ids {
            conn.execute(
                "UPDATE folders SET deleted_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
                params![deleted_at, child_id],
            )?;
            self.cascade_folder_delete(conn, child_id, deleted_at)?;
        }

        Ok(())
    }

    /// Phase 4: Download all resource snapshots that are marked as pending.
    /// Best-effort: failures are logged but don't abort sync.
    async fn download_pending_snapshots(&self, on_progress: Option<&ProgressCallback>) {
        let pending_ids = {
            let conn = match self.pool.get() {
                Ok(c) => c,
                Err(_) => return,
            };
            sync_state::get_pending_snapshot_ids(&conn).unwrap_or_default()
        };

        if pending_ids.is_empty() {
            return;
        }

        let total = pending_ids.len();
        for (i, resource_id) in pending_ids.iter().enumerate() {
            if let Err(e) = self.download_snapshot(resource_id).await {
                eprintln!("[sync] Warning: snapshot download failed for {}: {}", resource_id, e);
            }
            if let Some(cb) = on_progress {
                cb("downloading_snapshots", i + 1, total);
            }
        }
    }

    /// Upload a local snapshot.html to the backend.
    pub async fn upload_snapshot(&self, resource_id: &str) -> Result<(), SyncError> {
        let snapshot_path = self.base_dir.join("storage").join(resource_id).join("snapshot.html");
        if !snapshot_path.exists() {
            return Ok(()); // No snapshot to upload
        }

        let data = std::fs::read(&snapshot_path)?;
        let key = format!("snapshots/{}/snapshot.html", resource_id);
        self.backend.upload(&key, &data).await?;
        Ok(())
    }

    /// Download a snapshot from the backend and save locally.
    pub async fn download_snapshot(&self, resource_id: &str) -> Result<(), SyncError> {
        let key = format!("snapshots/{}/snapshot.html", resource_id);
        let data = self.backend.download(&key).await?;

        let local_dir = self.base_dir.join("storage").join(resource_id);
        std::fs::create_dir_all(&local_dir)?;

        let local_path = local_dir.join("snapshot.html");
        std::fs::write(&local_path, &data)?;

        // Update sync_state to "synced"
        let conn = self.pool.get().map_err(DbError::Pool)?;
        let state_key = format!("snapshot:{}", resource_id);
        sync_state::set(&conn, &state_key, "synced")?;

        // Extract and store plain text (best-effort)
        if let Ok(html_str) = std::str::from_utf8(&data) {
            let text = crate::plain_text::extract_plain_text(html_str);
            if !text.is_empty() {
                let _ = crate::db::resources::set_plain_text(&conn, resource_id, &text);
            }
        }

        Ok(())
    }
}

/// Topo-sort order for sync entries.
/// INSERT/UPDATE: folder(0) → tag(1) → resource(2) → highlight(3) → comment(4)
/// DELETE: comment(5) → highlight(6) → resource(7) → tag(8) → folder(9)
fn topo_order(operation: &str, entity_type: &str) -> u8 {
    match operation {
        "INSERT" | "UPDATE" => match entity_type {
            "folder" => 0,
            "tag" => 1,
            "resource" => 2,
            "highlight" => 3,
            "comment" => 4,
            _ => 5,
        },
        "DELETE" => match entity_type {
            "comment" => 6,
            "highlight" => 7,
            "resource" => 8,
            "tag" => 9,
            "folder" => 10,
            _ => 11,
        },
        _ => 12,
    }
}

/// Get the HLC of an entity, including soft-deleted entities.
fn get_entity_hlc(
    conn: &rusqlite::Connection,
    entity_type: &str,
    entity_id: &str,
) -> Result<Option<String>, SyncError> {
    let table = match entity_type {
        "folder" => "folders",
        "resource" => "resources",
        "tag" => "tags",
        "highlight" => "highlights",
        "comment" => "comments",
        _ => return Ok(None),
    };

    let sql = format!("SELECT hlc FROM {} WHERE id = ?1", table);
    let result = conn.query_row(&sql, params![entity_id], |row| row.get::<_, Option<String>>(0));

    match result {
        Ok(hlc) => Ok(hlc),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(SyncError::Sqlite(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::backend::mock::MockBackend;

    fn test_pool() -> (tempfile::TempDir, DbPool) {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = crate::db::init_pool(&db_path).unwrap();
        (dir, pool)
    }

    fn make_engine(
        pool: DbPool,
        backend: Arc<dyn SyncBackend>,
        device_id: &str,
        base_dir: PathBuf,
    ) -> SyncEngine {
        let clock = Arc::new(HlcClock::new(device_id.to_string()));
        SyncEngine::new(pool, backend, device_id.to_string(), clock, base_dir)
    }

    /// Mark a pool as "already synced" so ensure_initial_snapshot is skipped.
    fn mark_synced(pool: &DbPool) {
        let conn = pool.get().unwrap();
        sync_state::set(&conn, "last_sync_at", "2026-01-01T00:00:00Z").unwrap();
    }

    #[tokio::test]
    async fn test_sync_no_changes() {
        let (_dir, pool) = test_pool();
        let backend = Arc::new(MockBackend::new());
        let engine = make_engine(pool, backend, "dev-a", _dir.path().to_path_buf());

        let result = engine.sync(None).await.unwrap();
        match result {
            SyncResult::Success {
                uploaded,
                downloaded,
                applied,
            } => {
                assert_eq!(uploaded, 0);
                assert_eq!(downloaded, 0);
                assert_eq!(applied, 0);
            }
            SyncResult::Skipped => panic!("expected Success"),
        }
    }

    #[tokio::test]
    async fn test_upload_local_changes() {
        let (_dir, pool) = test_pool();
        mark_synced(&pool);
        let backend = Arc::new(MockBackend::new());
        let engine = make_engine(pool.clone(), backend.clone(), "dev-a", _dir.path().to_path_buf());

        // Insert a sync_log entry
        {
            let conn = pool.get().unwrap();
            let payload = serde_json::json!({
                "id": "f1",
                "name": "Test Folder",
                "parent_id": "__root__",
                "sort_order": 1,
                "created_at": "2026-04-01T00:00:00Z",
                "updated_at": "2026-04-01T00:00:00Z"
            });
            sync_log::append(
                &conn,
                "folder",
                "f1",
                "INSERT",
                &payload.to_string(),
                "1711987200000-0000-dev-a",
                "dev-a",
            )
            .unwrap();
        }

        let result = engine.sync(None).await.unwrap();
        match result {
            SyncResult::Success { uploaded, .. } => {
                assert_eq!(uploaded, 1);
            }
            SyncResult::Skipped => panic!("expected Success"),
        }

        // Verify JSONL was uploaded to backend
        let objects = backend.list("sync/dev-a/").await.unwrap();
        assert_eq!(objects.len(), 1);
        assert!(objects[0].key.ends_with(".jsonl"));

        // Verify entry is marked as uploaded
        {
            let conn = pool.get().unwrap();
            let pending = sync_log::get_pending(&conn).unwrap();
            assert!(pending.is_empty());
        }
    }

    #[tokio::test]
    async fn test_two_device_sync() {
        let backend = Arc::new(MockBackend::new());

        // Device A: create folder and sync (upload)
        let (_dir_a, pool_a) = test_pool();
        mark_synced(&pool_a);
        let engine_a = make_engine(pool_a.clone(), backend.clone(), "dev-a", _dir_a.path().to_path_buf());

        {
            let conn = pool_a.get().unwrap();
            let payload = serde_json::json!({
                "id": "f1",
                "name": "Shared Folder",
                "parent_id": "__root__",
                "sort_order": 1,
                "created_at": "2026-04-01T00:00:00Z",
                "updated_at": "2026-04-01T00:00:00Z"
            });
            sync_log::append(
                &conn,
                "folder",
                "f1",
                "INSERT",
                &payload.to_string(),
                "1711987200000-0000-dev-a",
                "dev-a",
            )
            .unwrap();
        }

        let result_a = engine_a.sync(None).await.unwrap();
        match result_a {
            SyncResult::Success { uploaded, .. } => assert_eq!(uploaded, 1),
            _ => panic!("expected Success"),
        }

        // Device B: sync (download + apply)
        let (_dir_b, pool_b) = test_pool();
        let engine_b = make_engine(pool_b.clone(), backend.clone(), "dev-b", _dir_b.path().to_path_buf());

        let result_b = engine_b.sync(None).await.unwrap();
        match result_b {
            SyncResult::Success {
                downloaded,
                applied,
                ..
            } => {
                assert_eq!(downloaded, 1);
                assert_eq!(applied, 1);
            }
            _ => panic!("expected Success"),
        }

        // Verify folder exists on Device B
        {
            let conn = pool_b.get().unwrap();
            let name: String = conn
                .query_row(
                    "SELECT name FROM folders WHERE id = 'f1'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(name, "Shared Folder");
        }
    }

    #[tokio::test]
    async fn test_lww_local_wins() {
        let backend = Arc::new(MockBackend::new());

        // Device A: create a folder with an older HLC
        let (_dir_a, pool_a) = test_pool();
        let engine_a = make_engine(pool_a.clone(), backend.clone(), "dev-a", _dir_a.path().to_path_buf());

        {
            let conn = pool_a.get().unwrap();
            let payload = serde_json::json!({
                "id": "f1",
                "name": "Old Name",
                "parent_id": "__root__",
                "sort_order": 1,
                "created_at": "2026-04-01T00:00:00Z",
                "updated_at": "2026-04-01T00:00:00Z"
            });
            sync_log::append(
                &conn,
                "folder",
                "f1",
                "INSERT",
                &payload.to_string(),
                "1000000000000-0000-dev-a",
                "dev-a",
            )
            .unwrap();
        }

        engine_a.sync(None).await.unwrap();

        // Device B: create same folder locally with a NEWER HLC, then sync
        let (_dir_b, pool_b) = test_pool();
        let engine_b = make_engine(pool_b.clone(), backend.clone(), "dev-b", _dir_b.path().to_path_buf());

        {
            let conn = pool_b.get().unwrap();
            // Insert the folder locally with a newer HLC
            conn.execute(
                "INSERT INTO folders (id, name, parent_id, sort_order, created_at, updated_at, hlc)
                 VALUES ('f1', 'New Name', '__root__', 1, '2026-04-02T00:00:00Z', '2026-04-02T00:00:00Z', '9999999999999-0000-dev-b')",
                [],
            )
            .unwrap();
        }

        engine_b.sync(None).await.unwrap();

        // Verify that Device B's local (newer) name is preserved
        {
            let conn = pool_b.get().unwrap();
            let name: String = conn
                .query_row("SELECT name FROM folders WHERE id = 'f1'", [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(name, "New Name");
        }
    }

    #[tokio::test]
    async fn test_sync_delete() {
        let backend = Arc::new(MockBackend::new());

        // Device A: create folder, sync, then delete it and sync again
        let (_dir_a, pool_a) = test_pool();
        mark_synced(&pool_a);
        let engine_a = make_engine(pool_a.clone(), backend.clone(), "dev-a", _dir_a.path().to_path_buf());

        // Create and upload
        {
            let conn = pool_a.get().unwrap();
            let payload = serde_json::json!({
                "id": "f1",
                "name": "To Delete",
                "parent_id": "__root__",
                "sort_order": 1,
                "created_at": "2026-04-01T00:00:00Z",
                "updated_at": "2026-04-01T00:00:00Z"
            });
            sync_log::append(
                &conn,
                "folder",
                "f1",
                "INSERT",
                &payload.to_string(),
                "1711987200000-0000-dev-a",
                "dev-a",
            )
            .unwrap();
        }
        engine_a.sync(None).await.unwrap();

        // Delete and upload
        {
            let conn = pool_a.get().unwrap();
            let payload = serde_json::json!({
                "id": "f1",
                "deleted_at": "2026-04-02T00:00:00Z"
            });
            sync_log::append(
                &conn,
                "folder",
                "f1",
                "DELETE",
                &payload.to_string(),
                "1711987200001-0000-dev-a",
                "dev-a",
            )
            .unwrap();
        }
        engine_a.sync(None).await.unwrap();

        // Device B: sync both changes
        let (_dir_b, pool_b) = test_pool();
        let engine_b = make_engine(pool_b.clone(), backend.clone(), "dev-b", _dir_b.path().to_path_buf());

        engine_b.sync(None).await.unwrap();

        // Verify folder is soft-deleted on Device B
        {
            let conn = pool_b.get().unwrap();
            let deleted_at: Option<String> = conn
                .query_row(
                    "SELECT deleted_at FROM folders WHERE id = 'f1'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(deleted_at.is_some());
        }
    }

    #[tokio::test]
    async fn test_snapshot_upload_download() {
        let backend = Arc::new(MockBackend::new());
        let dir = tempfile::tempdir().unwrap();

        // Create a snapshot file locally (under storage/<id>/)
        let resource_dir = dir.path().join("storage").join("res-1");
        std::fs::create_dir_all(&resource_dir).unwrap();
        std::fs::write(resource_dir.join("snapshot.html"), b"<html>test</html>").unwrap();

        let (_db_dir, pool) = test_pool();
        let engine = make_engine(pool.clone(), backend.clone(), "dev-a", dir.path().to_path_buf());

        // Upload
        engine.upload_snapshot("res-1").await.unwrap();

        // Download to a different location
        let dir2 = tempfile::tempdir().unwrap();
        let (_db_dir2, pool2) = test_pool();
        let engine2 = make_engine(pool2.clone(), backend.clone(), "dev-b", dir2.path().to_path_buf());

        engine2.download_snapshot("res-1").await.unwrap();

        // Verify file exists
        let downloaded = std::fs::read_to_string(dir2.path().join("storage/res-1/snapshot.html")).unwrap();
        assert_eq!(downloaded, "<html>test</html>");

        // Verify sync_state updated
        {
            let conn = pool2.get().unwrap();
            let state = sync_state::get(&conn, "snapshot:res-1").unwrap();
            assert_eq!(state, Some("synced".to_string()));
        }
    }

    #[tokio::test]
    async fn test_topo_order() {
        // INSERT/UPDATE: folder < tag < resource < highlight < comment
        assert!(topo_order("INSERT", "folder") < topo_order("INSERT", "tag"));
        assert!(topo_order("INSERT", "tag") < topo_order("INSERT", "resource"));
        assert!(topo_order("INSERT", "resource") < topo_order("INSERT", "highlight"));
        assert!(topo_order("INSERT", "highlight") < topo_order("INSERT", "comment"));

        // DELETE: comment < highlight < resource < tag < folder
        assert!(topo_order("DELETE", "comment") < topo_order("DELETE", "highlight"));
        assert!(topo_order("DELETE", "highlight") < topo_order("DELETE", "resource"));
        assert!(topo_order("DELETE", "resource") < topo_order("DELETE", "tag"));
        assert!(topo_order("DELETE", "tag") < topo_order("DELETE", "folder"));

        // All INSERT/UPDATE before DELETE
        assert!(topo_order("INSERT", "comment") < topo_order("DELETE", "comment"));
    }

    #[tokio::test]
    async fn test_upsert_tag_name_conflict() {
        let backend = Arc::new(MockBackend::new());

        // Device A: create tag "reading" with id "tag-a" (newer HLC), sync to backend
        let (_dir_a, pool_a) = test_pool();
        mark_synced(&pool_a);
        let engine_a = make_engine(pool_a.clone(), backend.clone(), "dev-a", _dir_a.path().to_path_buf());

        {
            let conn = pool_a.get().unwrap();
            let payload = serde_json::json!({
                "name": "reading",
                "color": "#808080"
            });
            sync_log::append(
                &conn,
                "tag",
                "tag-a",
                "INSERT",
                &payload.to_string(),
                "1711987200000-0000-dev-a",
                "dev-a",
            )
            .unwrap();
        }

        engine_a.sync(None).await.unwrap();

        // Device B: has a local tag "reading" with id "tag-b" (older HLC)
        let (_dir_b, pool_b) = test_pool();
        mark_synced(&pool_b);
        let engine_b = make_engine(pool_b.clone(), backend.clone(), "dev-b", _dir_b.path().to_path_buf());

        {
            let conn = pool_b.get().unwrap();
            // Insert local tag "reading" with id "tag-b" (older HLC)
            conn.execute(
                "INSERT INTO tags (id, name, color, hlc, deleted_at) VALUES ('tag-b', 'reading', '#808080', '1711987100000-0000-dev-b', NULL)",
                [],
            ).unwrap();
        }

        // Device B syncs → should succeed without UNIQUE constraint violation
        let result_b = engine_b.sync(None).await;
        assert!(result_b.is_ok(), "sync failed: {:?}", result_b);

        // Verify Device A's tag (newer HLC) replaced Device B's local tag
        {
            let conn = pool_b.get().unwrap();
            let (id, name): (String, String) = conn
                .query_row(
                    "SELECT id, name FROM tags WHERE name = 'reading' AND deleted_at IS NULL",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(id, "tag-a", "Device A's tag should have won (newer HLC)");
            assert_eq!(name, "reading");
        }
    }

    #[tokio::test]
    async fn test_already_running() {
        let (_dir, pool) = test_pool();
        let backend = Arc::new(MockBackend::new());
        let engine = Arc::new(make_engine(pool, backend, "dev-a", _dir.path().to_path_buf()));

        // Acquire the lock manually
        let _guard = engine.lock.lock().await;

        // Trying to sync should return AlreadyRunning
        let result = engine.sync(None).await;
        assert!(matches!(result, Err(SyncError::AlreadyRunning)));
    }

    #[tokio::test]
    async fn test_sync_folder_delete_cascades() {
        let backend = Arc::new(MockBackend::new());

        // Device A: create folder f1 and resource r1 (in f1), sync, then delete f1, sync again
        let (_dir_a, pool_a) = test_pool();
        mark_synced(&pool_a);
        let engine_a = make_engine(pool_a.clone(), backend.clone(), "dev-a", _dir_a.path().to_path_buf());

        {
            let conn = pool_a.get().unwrap();

            // Create folder f1
            let folder_payload = serde_json::json!({
                "id": "f1",
                "name": "Folder",
                "parent_id": "__root__",
                "sort_order": 1,
                "created_at": "2026-04-01T00:00:00Z",
                "updated_at": "2026-04-01T00:00:00Z"
            });
            sync_log::append(
                &conn,
                "folder",
                "f1",
                "INSERT",
                &folder_payload.to_string(),
                "1711987200000-0000-dev-a",
                "dev-a",
            )
            .unwrap();

            // Create resource r1 in folder f1
            let resource_payload = serde_json::json!({
                "id": "r1",
                "title": "Page",
                "url": "https://example.com",
                "folder_id": "f1",
                "resource_type": "webpage",
                "file_path": "r1/snapshot.html",
                "created_at": "2026-04-01T00:00:00Z",
                "captured_at": "2026-04-01T00:00:00Z"
            });
            sync_log::append(
                &conn,
                "resource",
                "r1",
                "INSERT",
                &resource_payload.to_string(),
                "1711987200001-0000-dev-a",
                "dev-a",
            )
            .unwrap();
        }

        engine_a.sync(None).await.unwrap();

        // Delete folder f1 and sync again
        {
            let conn = pool_a.get().unwrap();
            let delete_payload = serde_json::json!({
                "id": "f1",
                "deleted_at": "2026-04-02T00:00:00Z"
            });
            sync_log::append(
                &conn,
                "folder",
                "f1",
                "DELETE",
                &delete_payload.to_string(),
                "1711987200002-0000-dev-a",
                "dev-a",
            )
            .unwrap();
        }

        engine_a.sync(None).await.unwrap();

        // Device B: sync all changes
        let (_dir_b, pool_b) = test_pool();
        let engine_b = make_engine(pool_b.clone(), backend.clone(), "dev-b", _dir_b.path().to_path_buf());

        engine_b.sync(None).await.unwrap();

        // Verify folder f1 is soft-deleted on Device B
        {
            let conn = pool_b.get().unwrap();
            let deleted_at: Option<String> = conn
                .query_row(
                    "SELECT deleted_at FROM folders WHERE id = 'f1'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(deleted_at.is_some(), "folder f1 should be soft-deleted on Device B");
        }

        // Verify resource r1 is also cascade soft-deleted on Device B
        {
            let conn = pool_b.get().unwrap();
            let deleted_at: Option<String> = conn
                .query_row(
                    "SELECT deleted_at FROM resources WHERE id = 'r1'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(
                deleted_at.is_some(),
                "resource r1 should be cascade soft-deleted when its folder f1 is deleted"
            );
        }
    }

    #[tokio::test]
    async fn test_sync_auto_downloads_snapshots() {
        let backend = Arc::new(MockBackend::new());

        // Device A: create resource with snapshot, sync
        let dir_a = tempfile::tempdir().unwrap();
        let (_db_dir_a, pool_a) = test_pool();
        mark_synced(&pool_a);
        let engine_a = make_engine(pool_a.clone(), backend.clone(), "dev-a", dir_a.path().to_path_buf());

        // Create snapshot file locally on device A
        let snap_dir = dir_a.path().join("storage").join("res-1");
        std::fs::create_dir_all(&snap_dir).unwrap();
        std::fs::write(snap_dir.join("snapshot.html"), b"<html>hello</html>").unwrap();

        {
            let conn = pool_a.get().unwrap();
            let payload = serde_json::json!({
                "id": "res-1", "title": "Test", "url": "https://example.com",
                "folder_id": "__root__", "resource_type": "webpage",
                "file_path": "res-1/snapshot.html",
                "created_at": "2026-04-01T00:00:00Z", "captured_at": "2026-04-01T00:00:00Z"
            });
            sync_log::append(&conn, "resource", "res-1", "INSERT",
                &payload.to_string(), "1711987200000-0000-dev-a", "dev-a").unwrap();
        }
        engine_a.sync(None).await.unwrap();

        // Device B: sync — should auto-download the snapshot
        let dir_b = tempfile::tempdir().unwrap();
        let (_db_dir_b, pool_b) = test_pool();
        let engine_b = make_engine(pool_b.clone(), backend.clone(), "dev-b", dir_b.path().to_path_buf());

        engine_b.sync(None).await.unwrap();

        // Verify: snapshot file exists locally on Device B
        let local_snapshot = dir_b.path().join("storage").join("res-1").join("snapshot.html");
        assert!(local_snapshot.exists(), "snapshot should be auto-downloaded");
        let content = std::fs::read_to_string(&local_snapshot).unwrap();
        assert_eq!(content, "<html>hello</html>");

        // Verify: sync_state shows "synced" not "pending"
        {
            let conn = pool_b.get().unwrap();
            let status = sync_state::get(&conn, "snapshot:res-1").unwrap();
            assert_eq!(status, Some("synced".to_string()));
        }
    }
}
