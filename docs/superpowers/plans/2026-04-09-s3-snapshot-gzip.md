# S3 Snapshot Gzip Compression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gzip-compress snapshot HTML files before uploading to S3, reducing storage cost by 70-85%.

**Architecture:** Add `flate2` crate for gzip. Compress in `upload_snapshot`, decompress in `download_snapshot`. S3 key changes from `snapshot.html` to `snapshot.html.gz`. Auto-migrate existing uncompressed snapshots on first sync.

**Tech Stack:** Rust, flate2 (gzip), existing SyncEngine/MockBackend

---

### Task 1: Add `flate2` dependency

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add flate2 to Cargo.toml**

Add to `[dependencies]`:

```toml
flate2 = "1.1"
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: compiles with no errors

- [ ] **Step 3: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore: add flate2 dependency for snapshot gzip compression"
```

---

### Task 2: Compress upload, decompress download (TDD)

**Files:**
- Modify: `src-tauri/src/sync/engine.rs:1395-1433` (upload_snapshot, download_snapshot)
- Test: existing `test_snapshot_upload_download` at line 1797

- [ ] **Step 1: Update the existing test to verify gzip round-trip**

In `test_snapshot_upload_download` (line 1797), add a check that the data stored in MockBackend is actually gzip-compressed (not raw HTML), and that the downloaded file is decompressed back to original HTML. Replace the existing test:

```rust
#[tokio::test]
async fn test_snapshot_upload_download() {
    let backend = Arc::new(MockBackend::new());
    let dir = tempfile::tempdir().unwrap();

    let resource_dir = dir.path().join("storage").join("res-1");
    std::fs::create_dir_all(&resource_dir).unwrap();
    std::fs::write(resource_dir.join("snapshot.html"), b"<html>test</html>").unwrap();

    let (_db_dir, pool) = test_pool();
    let engine = make_engine(pool.clone(), backend.clone(), "dev-a", dir.path().to_path_buf());

    // Upload
    engine.upload_snapshot("res-1").await.unwrap();

    // Verify S3 key is .html.gz
    {
        let store = backend.store.lock().await;
        assert!(store.contains_key("snapshots/res-1/snapshot.html.gz"),
            "S3 key should be snapshot.html.gz");
        assert!(!store.contains_key("snapshots/res-1/snapshot.html"),
            "old key should not exist");
        // Verify stored data is gzip (magic bytes 1f 8b)
        let compressed = store.get("snapshots/res-1/snapshot.html.gz").unwrap();
        assert_eq!(&compressed[..2], &[0x1f, 0x8b], "data should be gzip-compressed");
    }

    // Download to a different location
    let dir2 = tempfile::tempdir().unwrap();
    let (_db_dir2, pool2) = test_pool();
    let engine2 = make_engine(pool2.clone(), backend.clone(), "dev-b", dir2.path().to_path_buf());

    engine2.download_snapshot("res-1").await.unwrap();

    // Verify file is decompressed back to original HTML
    let downloaded = std::fs::read_to_string(dir2.path().join("storage/res-1/snapshot.html")).unwrap();
    assert_eq!(downloaded, "<html>test</html>");

    // Verify sync_state updated
    {
        let conn = pool2.get().unwrap();
        let state = sync_state::get(&conn, "snapshot:res-1").unwrap();
        assert_eq!(state, Some("synced".to_string()));
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test test_snapshot_upload_download -- --nocapture`
Expected: FAIL — upload still uses old key `snapshot.html`, assertion on `snapshot.html.gz` fails.

- [ ] **Step 3: Implement gzip in upload_snapshot**

Replace `upload_snapshot` (line 1395-1406):

```rust
/// Upload a local snapshot.html to the backend (gzip-compressed).
pub async fn upload_snapshot(&self, resource_id: &str) -> Result<(), SyncError> {
    let snapshot_path = self.base_dir.join("storage").join(resource_id).join("snapshot.html");
    if !snapshot_path.exists() {
        return Ok(()); // No snapshot to upload
    }

    let data = std::fs::read(&snapshot_path)?;

    // Gzip compress before upload
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    std::io::Write::write_all(&mut encoder, &data)?;
    let compressed = encoder.finish()?;

    let key = format!("snapshots/{}/snapshot.html.gz", resource_id);
    self.backend.upload(&key, &compressed).await?;
    Ok(())
}
```

Add the import at the top of `engine.rs` (with the other `use` statements):

```rust
use std::io::Read as _;
```

- [ ] **Step 4: Implement gzip decompression in download_snapshot**

Replace `download_snapshot` (line 1408-1433):

```rust
/// Download a snapshot from the backend (gzip-compressed) and save locally.
pub async fn download_snapshot(&self, resource_id: &str) -> Result<(), SyncError> {
    let key = format!("snapshots/{}/snapshot.html.gz", resource_id);
    let compressed = self.backend.download(&key).await?;

    // Gzip decompress
    let mut decoder = flate2::read::GzDecoder::new(&compressed[..]);
    let mut data = Vec::new();
    decoder.read_to_end(&mut data)?;

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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd src-tauri && cargo test test_snapshot_upload_download -- --nocapture`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/sync/engine.rs
git commit -m "feat(sync): gzip-compress snapshots for S3 upload/download"
```

---

### Task 3: Update all other S3 key references

**Files:**
- Modify: `src-tauri/src/sync/engine.rs` — lines 160 (comment), 199, 296

- [ ] **Step 1: Update `purge_orphan_snapshots` key (line 199)**

Change:
```rust
let key = format!("snapshots/{}/snapshot.html", resource_id);
```
To:
```rust
let key = format!("snapshots/{}/snapshot.html.gz", resource_id);
```

- [ ] **Step 2: Update compaction snapshot check key (line 296)**

Change:
```rust
let s3_key = format!("snapshots/{}/snapshot.html", id);
```
To:
```rust
let s3_key = format!("snapshots/{}/snapshot.html.gz", id);
```

- [ ] **Step 3: Update comment (line 160)**

Change:
```rust
// Extract resource IDs from S3 keys like "snapshots/{id}/snapshot.html"
```
To:
```rust
// Extract resource IDs from S3 keys like "snapshots/{id}/snapshot.html.gz"
```

- [ ] **Step 4: Run all sync tests**

Run: `cd src-tauri && cargo test sync -- --nocapture`
Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/sync/engine.rs
git commit -m "refactor(sync): update all S3 key references to .html.gz"
```

---

### Task 4: Update cross-device sync test

**Files:**
- Modify: `src-tauri/src/sync/engine.rs` — `test_sync_auto_downloads_snapshots` (line 2040)

The test creates a snapshot on device A, syncs, then verifies device B downloads it. With gzip, the S3 key changes but the local file path stays `snapshot.html`. The test should still pass after Tasks 2-3 since `upload_snapshot`/`download_snapshot` handle compression transparently. Verify this:

- [ ] **Step 1: Run the cross-device sync test**

Run: `cd src-tauri && cargo test test_sync_auto_downloads_snapshots -- --nocapture`
Expected: PASS — the test doesn't reference S3 keys directly, it relies on `upload_snapshot`/`download_snapshot` which now handle gzip.

- [ ] **Step 2: If it fails, diagnose and fix**

The test at line 2076 checks `storage/res-1/snapshot.html` locally — this should still work since `download_snapshot` writes decompressed HTML to `snapshot.html`. If it fails, the issue is likely in a sync phase that references the old S3 key.

---

### Task 5: Auto-migration of existing S3 snapshots

**Files:**
- Modify: `src-tauri/src/sync/engine.rs` — add `migrate_snapshots_to_gzip` method, call it from sync flow

- [ ] **Step 1: Write test for migration**

Add after the existing tests:

```rust
#[tokio::test]
async fn test_migrate_snapshots_to_gzip() {
    let backend = Arc::new(MockBackend::new());
    let dir = tempfile::tempdir().unwrap();
    let (_db_dir, pool) = test_pool();
    let engine = make_engine(pool.clone(), backend.clone(), "dev-a", dir.path().to_path_buf());

    // Simulate pre-existing uncompressed snapshots on S3
    let html_data = b"<html>old snapshot</html>";
    backend.upload("snapshots/res-old/snapshot.html", html_data).await.unwrap();

    // Run migration
    engine.migrate_snapshots_to_gzip().await.unwrap();

    // Verify: old key deleted, new .gz key exists with gzip data
    {
        let store = backend.store.lock().await;
        assert!(!store.contains_key("snapshots/res-old/snapshot.html"),
            "old uncompressed key should be deleted");
        assert!(store.contains_key("snapshots/res-old/snapshot.html.gz"),
            "new gzip key should exist");
        let compressed = store.get("snapshots/res-old/snapshot.html.gz").unwrap();
        assert_eq!(&compressed[..2], &[0x1f, 0x8b], "should be gzip data");

        // Verify round-trip: decompress and check content
        let mut decoder = flate2::read::GzDecoder::new(&compressed[..]);
        let mut decompressed = Vec::new();
        std::io::Read::read_to_end(&mut decoder, &mut decompressed).unwrap();
        assert_eq!(&decompressed, html_data);
    }

    // Verify: sync_state flag set
    {
        let conn = pool.get().unwrap();
        let flag = sync_state::get(&conn, "config:snapshots_gzip_migrated").unwrap();
        assert_eq!(flag, Some("done".to_string()));
    }

    // Verify: running again is a no-op (idempotent)
    engine.migrate_snapshots_to_gzip().await.unwrap();
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test test_migrate_snapshots_to_gzip -- --nocapture`
Expected: FAIL — `migrate_snapshots_to_gzip` method doesn't exist.

- [ ] **Step 3: Implement migrate_snapshots_to_gzip**

Add to `impl SyncEngine`, before `upload_snapshot`:

```rust
/// One-time migration: re-upload existing uncompressed snapshots as gzip.
/// Skips if already done (sync_state flag `config:snapshots_gzip_migrated`).
pub async fn migrate_snapshots_to_gzip(&self) -> Result<(), SyncError> {
    // Check if already migrated
    {
        let conn = self.pool.get().map_err(DbError::Pool)?;
        if sync_state::get(&conn, "config:snapshots_gzip_migrated")? == Some("done".to_string()) {
            return Ok(());
        }
    }

    eprintln!("[sync] Migrating existing snapshots to gzip...");

    // List all objects under snapshots/ prefix
    let objects = self.backend.list("snapshots/").await?;

    // Find uncompressed snapshot.html keys (exclude already-migrated .html.gz)
    let old_keys: Vec<String> = objects
        .iter()
        .filter(|obj| obj.key.ends_with("/snapshot.html"))
        .map(|obj| obj.key.clone())
        .collect();

    if old_keys.is_empty() {
        eprintln!("[sync] No uncompressed snapshots to migrate.");
    } else {
        eprintln!("[sync] Found {} uncompressed snapshot(s) to migrate.", old_keys.len());

        for old_key in &old_keys {
            // Download raw HTML
            let data = match self.backend.download(old_key).await {
                Ok(d) => d,
                Err(e) => {
                    eprintln!("[sync] Warning: failed to download {}: {}", old_key, e);
                    continue;
                }
            };

            // Gzip compress
            let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            std::io::Write::write_all(&mut encoder, &data)?;
            let compressed = encoder.finish()?;

            // Upload as .html.gz
            let new_key = format!("{}.gz", old_key);
            self.backend.upload(&new_key, &compressed).await?;

            // Delete old key
            self.backend.delete(old_key).await?;

            eprintln!("[sync] Migrated: {} -> {}", old_key, new_key);
        }
    }

    // Mark migration complete
    let conn = self.pool.get().map_err(DbError::Pool)?;
    sync_state::set(&conn, "config:snapshots_gzip_migrated", "done")?;

    eprintln!("[sync] Snapshot gzip migration complete.");
    Ok(())
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test test_migrate_snapshots_to_gzip -- --nocapture`
Expected: PASS

- [ ] **Step 5: Wire migration into sync flow**

In the `sync` method, call `migrate_snapshots_to_gzip` early — after acquiring the sync lock but before any snapshot upload/download phases. Find where the sync phases begin and add:

```rust
// Auto-migrate uncompressed snapshots (one-time)
self.migrate_snapshots_to_gzip().await?;
```

This should go after the lock acquisition and before Phase 0 (initial snapshot upload).

- [ ] **Step 6: Run all sync tests**

Run: `cd src-tauri && cargo test sync -- --nocapture`
Expected: all tests pass

- [ ] **Step 7: Run clippy**

Run: `cd src-tauri && cargo clippy -- -D warnings`
Expected: no warnings

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/sync/engine.rs
git commit -m "feat(sync): auto-migrate existing S3 snapshots to gzip on first sync"
```

---

### Task 6: Update orphan cleanup to handle both keys during transition

**Files:**
- Modify: `src-tauri/src/sync/engine.rs` — `purge_orphan_snapshots` (line 192)

After migration, orphan cleanup only needs `.html.gz`. But to be safe during the migration window (if sync is interrupted mid-migration), also try deleting the old `.html` key for orphans:

- [ ] **Step 1: Update purge_orphan_snapshots**

In `purge_orphan_snapshots` (line 192), after deleting the `.html.gz` key, also attempt to delete the old `.html` key (best-effort):

```rust
for (resource_id, size) in &orphans {
    let key_gz = format!("snapshots/{}/snapshot.html.gz", resource_id);
    let key_html = format!("snapshots/{}/snapshot.html", resource_id);
    // Delete both possible keys (best-effort)
    match self.backend.delete(&key_gz).await {
        Ok(()) => {
            deleted += 1;
            freed += size;
            eprintln!("[sync] Deleted orphan snapshot: {}", key_gz);
        }
        Err(e) => {
            eprintln!("[sync] Warning: failed to delete orphan {}: {}", key_gz, e);
        }
    }
    // Also clean up any leftover uncompressed key
    let _ = self.backend.delete(&key_html).await;
}
```

- [ ] **Step 2: Run all sync tests**

Run: `cd src-tauri && cargo test sync -- --nocapture`
Expected: all tests pass

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/sync/engine.rs
git commit -m "fix(sync): orphan cleanup handles both .html and .html.gz keys"
```
