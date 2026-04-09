# Sync Bugfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 5 sync bugs causing data loss during encryption transition and cross-device sync.

**Architecture:** All fixes are in `src-tauri/src/sync/engine.rs` and `src-tauri/src/commands/mod.rs`. No new files, no schema changes. Bug 1 (critical) removes one line in `build_sync_engine`. Bugs 2-5 are additive changes to the sync engine.

**Tech Stack:** Rust, rusqlite, tokio (async tests)

---

### Task 1: Fix `is_first_unlock` short-circuit (Bug 1 — Critical)

**Files:**
- Modify: `src-tauri/src/commands/mod.rs:567-570`

**Context:** `build_sync_engine()` detects remote `keyring.json` and immediately writes `config:encryption_enabled = "true"` to DB. This causes `cmd_unlock_encryption` to see `is_first_unlock = false`, skipping the sync state reset that's needed for the encryption transition. The fix: remove the DB write from `build_sync_engine`, keep the in-memory decision.

- [ ] **Step 1: Write the failing test**

There is no unit test infrastructure for `build_sync_engine` (it's an async fn using Tauri state). Instead, we verify via a manual integration scenario. First, write a doc comment explaining the fix rationale, then make the change.

- [ ] **Step 2: Apply the fix**

In `src-tauri/src/commands/mod.rs`, find lines 567-570:

```rust
        if remote_has_keyring {
            // Another device enabled encryption — mark locally
            crate::sync::sync_state::set(&conn, "config:encryption_enabled", "true")?;
            true
```

Replace with:

```rust
        if remote_has_keyring {
            // Don't persist here — let cmd_unlock_encryption set this flag
            // so that is_first_unlock correctly detects the first unlock and
            // resets sync state (last_sync_at, remote:* progress, sync_log).
            true
```

This removes the `sync_state::set` call. The `encryption_enabled` flag will still be set later by `cmd_unlock_encryption` at line 720.

- [ ] **Step 3: Run cargo check**

Run: `cd /Users/work/workspace/Shibei && cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5`
Expected: no errors (the removed line was the only usage of `conn` in that branch, but `conn` is still used elsewhere in the function so no unused-variable warning).

- [ ] **Step 4: Run existing sync tests**

Run: `cd /Users/work/workspace/Shibei && cargo test --manifest-path src-tauri/Cargo.toml -- sync 2>&1 | tail -20`
Expected: all existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/mod.rs
git commit -m "fix(sync): don't persist encryption flag in build_sync_engine

build_sync_engine was setting config:encryption_enabled=true during
auto-detection, causing cmd_unlock_encryption's is_first_unlock to be
false. This skipped the critical sync state reset needed when a device
first joins encrypted sync, resulting in tags/resources not syncing."
```

---

### Task 2: Fix `upsert_tag` name unique constraint conflict (Bug 2 — Critical)

**Files:**
- Modify: `src-tauri/src/sync/engine.rs:662-683` (upsert_tag function)
- Test: `src-tauri/src/sync/engine.rs` (add test in existing `mod tests`)

**Context:** The `tags` table has `idx_tags_name_active` partial unique index: `UNIQUE(name) WHERE deleted_at IS NULL`. When two devices independently create a tag with the same name but different IDs, `upsert_tag`'s `ON CONFLICT(id)` doesn't catch the name conflict, causing a UNIQUE constraint violation that aborts the entire `apply_entries`. Fix: delete the conflicting local tag before INSERT, same pattern as `upsert_folder`.

- [ ] **Step 1: Write the failing test**

Add to the `mod tests` block in `src-tauri/src/sync/engine.rs`:

```rust
    #[tokio::test]
    async fn test_upsert_tag_name_conflict() {
        // Device A creates tag "reading" with id "tag-a"
        // Device B has a local tag "reading" with id "tag-b"
        // Syncing Device A's tag to Device B should succeed (not hit UNIQUE constraint)
        let backend = Arc::new(MockBackend::new());

        let (_dir_a, pool_a) = test_pool();
        mark_synced(&pool_a);
        let engine_a = make_engine(pool_a.clone(), backend.clone(), "dev-a", _dir_a.path().to_path_buf());

        // Device A creates tag and syncs
        {
            let conn = pool_a.get().unwrap();
            let payload = serde_json::json!({
                "id": "tag-a",
                "name": "reading",
                "color": "#FF0000"
            });
            sync_log::append(
                &conn, "tag", "tag-a", "INSERT",
                &payload.to_string(),
                "1711987200000-0000-dev-a", "dev-a",
            ).unwrap();
        }
        engine_a.sync(None).await.unwrap();

        // Device B has a local tag with the same name but different id
        let (_dir_b, pool_b) = test_pool();
        mark_synced(&pool_b);
        let engine_b = make_engine(pool_b.clone(), backend.clone(), "dev-b", _dir_b.path().to_path_buf());

        {
            let conn = pool_b.get().unwrap();
            conn.execute(
                "INSERT INTO tags (id, name, color, hlc) VALUES ('tag-b', 'reading', '#00FF00', '1711987100000-0000-dev-b')",
                [],
            ).unwrap();
        }

        // Sync should succeed, not fail with UNIQUE constraint violation
        let result = engine_b.sync(None).await;
        assert!(result.is_ok(), "sync failed: {:?}", result.err());

        // Verify Device A's tag replaced Device B's (newer HLC wins)
        {
            let conn = pool_b.get().unwrap();
            let color: String = conn.query_row(
                "SELECT color FROM tags WHERE name = 'reading' AND deleted_at IS NULL",
                [], |row| row.get(0),
            ).unwrap();
            assert_eq!(color, "#FF0000");
        }
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/work/workspace/Shibei && cargo test --manifest-path src-tauri/Cargo.toml -- test_upsert_tag_name_conflict 2>&1 | tail -10`
Expected: FAIL with UNIQUE constraint violation.

- [ ] **Step 3: Write minimal implementation**

In `src-tauri/src/sync/engine.rs`, find the `upsert_tag` function (line ~662). Change it from:

```rust
    fn upsert_tag(
        &self,
        conn: &rusqlite::Connection,
        id: &str,
        payload: &serde_json::Value,
        hlc: &str,
    ) -> Result<(), SyncError> {
        let name = payload["name"].as_str().unwrap_or("");
        let color = payload["color"].as_str().unwrap_or("#808080");

        conn.execute(
            "INSERT INTO tags (id, name, color, hlc, deleted_at)
```

to:

```rust
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
        // to avoid UNIQUE constraint violation on idx_tags_name_active.
        conn.execute(
            "DELETE FROM tags WHERE name = ?1 AND id != ?2 AND deleted_at IS NULL",
            params![name, id],
        )?;

        conn.execute(
            "INSERT INTO tags (id, name, color, hlc, deleted_at)
```

Only the 5 lines adding the DELETE statement are new; the rest of the function stays the same.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/work/workspace/Shibei && cargo test --manifest-path src-tauri/Cargo.toml -- test_upsert_tag_name_conflict 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 5: Run all sync tests**

Run: `cd /Users/work/workspace/Shibei && cargo test --manifest-path src-tauri/Cargo.toml -- sync 2>&1 | tail -20`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/sync/engine.rs
git commit -m "fix(sync): handle tag name unique constraint in upsert_tag

When two devices independently create tags with the same name but
different IDs, upsert_tag now removes the conflicting local tag before
INSERT, matching the pattern used by upsert_folder."
```

---

### Task 3: Fix cascade soft-delete not propagating across devices (Bug 3)

**Files:**
- Modify: `src-tauri/src/sync/engine.rs:810-833` (soft_delete_entity function)
- Test: `src-tauri/src/sync/engine.rs` (add test in existing `mod tests`)

**Context:** When a folder DELETE is synced remotely, `soft_delete_entity` only soft-deletes the folder itself. It doesn't cascade to child folders, resources, highlights, comments, or resource_tags. The local `db::folders::delete_folder` does cascade via `soft_delete_folder_tree`, but the sync apply path bypasses that. Fix: add cascade logic for folder deletes in `soft_delete_entity`.

- [ ] **Step 1: Write the failing test**

Add to `mod tests` in `src-tauri/src/sync/engine.rs`:

```rust
    #[tokio::test]
    async fn test_sync_folder_delete_cascades() {
        let backend = Arc::new(MockBackend::new());

        // Device A: create folder with a resource, sync, then delete the folder
        let (_dir_a, pool_a) = test_pool();
        mark_synced(&pool_a);
        let engine_a = make_engine(pool_a.clone(), backend.clone(), "dev-a", _dir_a.path().to_path_buf());

        {
            let conn = pool_a.get().unwrap();
            // Create folder
            let folder_payload = serde_json::json!({
                "id": "f1", "name": "Folder", "parent_id": "__root__",
                "sort_order": 1, "created_at": "2026-04-01T00:00:00Z",
                "updated_at": "2026-04-01T00:00:00Z"
            });
            sync_log::append(&conn, "folder", "f1", "INSERT",
                &folder_payload.to_string(), "1711987200000-0000-dev-a", "dev-a").unwrap();

            // Create resource in that folder
            let res_payload = serde_json::json!({
                "id": "r1", "title": "Page", "url": "https://example.com",
                "folder_id": "f1", "resource_type": "webpage", "file_path": "r1/snapshot.html",
                "created_at": "2026-04-01T00:00:00Z", "captured_at": "2026-04-01T00:00:00Z"
            });
            sync_log::append(&conn, "resource", "r1", "INSERT",
                &res_payload.to_string(), "1711987200001-0000-dev-a", "dev-a").unwrap();
        }
        engine_a.sync(None).await.unwrap();

        // Upload the folder DELETE
        {
            let conn = pool_a.get().unwrap();
            let del_payload = serde_json::json!({
                "id": "f1", "deleted_at": "2026-04-02T00:00:00Z"
            });
            sync_log::append(&conn, "folder", "f1", "DELETE",
                &del_payload.to_string(), "1711987200002-0000-dev-a", "dev-a").unwrap();
        }
        engine_a.sync(None).await.unwrap();

        // Device B: sync everything
        let (_dir_b, pool_b) = test_pool();
        let engine_b = make_engine(pool_b.clone(), backend.clone(), "dev-b", _dir_b.path().to_path_buf());
        engine_b.sync(None).await.unwrap();

        // Verify: folder is deleted, and resource is also cascade-deleted
        {
            let conn = pool_b.get().unwrap();
            let folder_deleted: Option<String> = conn.query_row(
                "SELECT deleted_at FROM folders WHERE id = 'f1'", [], |row| row.get(0),
            ).unwrap();
            assert!(folder_deleted.is_some(), "folder should be soft-deleted");

            let resource_deleted: Option<String> = conn.query_row(
                "SELECT deleted_at FROM resources WHERE id = 'r1'", [], |row| row.get(0),
            ).unwrap();
            assert!(resource_deleted.is_some(), "resource in deleted folder should be cascade soft-deleted");
        }
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/work/workspace/Shibei && cargo test --manifest-path src-tauri/Cargo.toml -- test_sync_folder_delete_cascades 2>&1 | tail -10`
Expected: FAIL — resource `r1` still has `deleted_at = NULL`.

- [ ] **Step 3: Write minimal implementation**

In `src-tauri/src/sync/engine.rs`, replace the `soft_delete_entity` function (lines ~810-833) with:

```rust
    /// Soft-delete an entity if it hasn't been deleted yet.
    /// For folders, cascade soft-delete to child folders, resources, and their annotations.
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

        // Cascade for folder deletes: soft-delete child resources and their annotations
        if entity_type == "folder" {
            self.cascade_folder_delete(conn, entity_id, deleted_at)?;
        }

        Ok(())
    }

    /// Cascade soft-delete for a folder: child folders (recursive), resources, and annotations.
    fn cascade_folder_delete(
        &self,
        conn: &rusqlite::Connection,
        folder_id: &str,
        deleted_at: &str,
    ) -> Result<(), SyncError> {
        // Soft-delete resources in this folder and their annotations
        let mut stmt = conn.prepare(
            "SELECT id FROM resources WHERE folder_id = ?1 AND deleted_at IS NULL"
        )?;
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
        let mut stmt = conn.prepare(
            "SELECT id FROM folders WHERE parent_id = ?1 AND deleted_at IS NULL"
        )?;
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/work/workspace/Shibei && cargo test --manifest-path src-tauri/Cargo.toml -- test_sync_folder_delete_cascades 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 5: Run all sync tests**

Run: `cd /Users/work/workspace/Shibei && cargo test --manifest-path src-tauri/Cargo.toml -- sync 2>&1 | tail -20`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/sync/engine.rs
git commit -m "fix(sync): cascade soft-delete when applying remote folder deletion

soft_delete_entity now cascades to child folders, resources, highlights,
comments, and resource_tags when the deleted entity is a folder. This
prevents orphaned resources on the receiving device."
```

---

### Task 4: Fix resource_tags import missing hlc (Bug 4)

**Files:**
- Modify: `src-tauri/src/sync/engine.rs:364-374` (resource_tags import in maybe_import_snapshot)

**Context:** `maybe_import_snapshot` inserts resource_tags without the `hlc` field. This causes LWW comparison to fail later (NULL hlc is always considered "older"). Fix: include hlc in the INSERT.

- [ ] **Step 1: Apply the fix**

In `src-tauri/src/sync/engine.rs`, find lines 368-373 (resource_tags import in `maybe_import_snapshot`):

```rust
            if rt["deleted_at"].is_null() && !rid.is_empty() && !tid.is_empty() {
                conn.execute(
                    "INSERT OR IGNORE INTO resource_tags (resource_id, tag_id) VALUES (?1, ?2)",
                    params![rid, tid],
                )?;
            }
```

Replace with:

```rust
            if rt["deleted_at"].is_null() && !rid.is_empty() && !tid.is_empty() {
                let rt_hlc = rt["hlc"].as_str().unwrap_or("");
                conn.execute(
                    "INSERT OR IGNORE INTO resource_tags (resource_id, tag_id, hlc) VALUES (?1, ?2, ?3)",
                    params![rid, tid, rt_hlc],
                )?;
            }
```

- [ ] **Step 2: Run cargo check**

Run: `cd /Users/work/workspace/Shibei && cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5`
Expected: no errors.

- [ ] **Step 3: Run all sync tests**

Run: `cd /Users/work/workspace/Shibei && cargo test --manifest-path src-tauri/Cargo.toml -- sync 2>&1 | tail -20`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/sync/engine.rs
git commit -m "fix(sync): include hlc when importing resource_tags from snapshot

The hlc field was missing, causing LWW comparisons to fail for
resource-tag associations imported via full snapshot."
```

---

### Task 5: Auto-download pending snapshots after sync (Bug 5)

**Files:**
- Modify: `src-tauri/src/sync/engine.rs:82-118` (sync method — add Phase 4)
- Modify: `src-tauri/src/sync/sync_state.rs` (add `list_by_prefix_value` helper)
- Test: `src-tauri/src/sync/engine.rs` (add test in existing `mod tests`)

**Context:** When resources are imported via sync, their HTML snapshots are only marked `snapshot:{id} = "pending"` in sync_state, but never downloaded. Users see resources in the list but can't open them. Fix: add a Phase 4 to the sync method that downloads all pending snapshots.

- [ ] **Step 1: Write the failing test**

Add to `mod tests` in `src-tauri/src/sync/engine.rs`:

```rust
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/work/workspace/Shibei && cargo test --manifest-path src-tauri/Cargo.toml -- test_sync_auto_downloads_snapshots 2>&1 | tail -10`
Expected: FAIL — snapshot file doesn't exist on Device B.

- [ ] **Step 3: Write implementation**

First, add a helper to `src-tauri/src/sync/sync_state.rs` to query pending snapshots. Add before the `#[cfg(test)]` block:

```rust
/// Return all resource IDs that have pending snapshot downloads.
pub fn get_pending_snapshot_ids(conn: &Connection) -> Result<Vec<String>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT key FROM sync_state WHERE key LIKE 'snapshot:%' AND value = 'pending'"
    )?;
    let ids = stmt
        .query_map([], |row| {
            let key: String = row.get(0)?;
            // key is "snapshot:<resource_id>", strip prefix
            Ok(key.strip_prefix("snapshot:").unwrap_or("").to_string())
        })?
        .filter_map(|r| r.ok())
        .filter(|id| !id.is_empty())
        .collect();
    Ok(ids)
}
```

Then, in `src-tauri/src/sync/engine.rs`, add Phase 4 in the `sync()` method. Find lines 107-117 (after Phase 2+3, before compaction):

```rust
        // Phase 2+3: Download and apply remote changes
        let (downloaded, applied) = self.download_and_apply(on_progress).await?;

        // Update last_sync_at
        {
            let conn = self.pool.get().map_err(DbError::Pool)?;
            sync_state::set(&conn, "last_sync_at", &crate::db::now_iso8601())?;
        }

        // Phase 5: Compaction check
```

Replace with:

```rust
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
```

Then add the `download_pending_snapshots` method to `impl SyncEngine`, before the `upload_snapshot` method:

```rust
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/work/workspace/Shibei && cargo test --manifest-path src-tauri/Cargo.toml -- test_sync_auto_downloads_snapshots 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 5: Run all sync tests**

Run: `cd /Users/work/workspace/Shibei && cargo test --manifest-path src-tauri/Cargo.toml -- sync 2>&1 | tail -20`
Expected: all tests pass.

- [ ] **Step 6: Run cargo clippy**

Run: `cd /Users/work/workspace/Shibei && cargo clippy --manifest-path src-tauri/Cargo.toml 2>&1 | tail -20`
Expected: no warnings on changed code.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/sync/sync_state.rs src-tauri/src/sync/engine.rs
git commit -m "fix(sync): auto-download pending resource snapshots after sync

Added Phase 4 to the sync cycle that downloads HTML snapshots for
newly imported resources. Previously they were only marked 'pending'
and required separate manual download."
```
