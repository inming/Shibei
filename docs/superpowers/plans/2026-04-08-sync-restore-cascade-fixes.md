# Sync Restore & Cascade Bug Fixes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 4 sync bugs: engine cascade missing HLC, restore_resource not syncing children, restore_folder not cascading, purge_folder not recursive.

**Architecture:** All fixes are in Rust backend (`src-tauri/src/`). Bug 1 is in sync engine, Bugs 2-4 are in DB layer. Each fix adds HLC propagation or cascading logic to match the symmetry of the corresponding delete operations. Tests use in-memory SQLite via `test_db()`.

**Tech Stack:** Rust, rusqlite, serde_json

---

### Task 1: Fix engine `cascade_folder_delete` missing HLC propagation

**Files:**
- Modify: `src-tauri/src/sync/engine.rs:1197-1257`

The engine's `cascade_folder_delete` sets `deleted_at` on child entities but doesn't update their HLC. This causes cross-device divergence: a child entity on the receiving device keeps its old HLC, so a stale UPDATE from another device can resurrect it.

Compare with the local `soft_delete_folder_tree` in `src-tauri/src/db/folders.rs:220-271` which correctly propagates HLC via `hlc = COALESCE(?2, hlc)`.

- [ ] **Step 1: Write failing test**

Add to `src-tauri/src/db/folders.rs` test module (after line 749):

```rust
#[test]
fn test_soft_delete_folder_tree_updates_child_hlc() {
    let conn = test_db();
    let folder = create_folder(&conn, "parent", "__root__", None).unwrap();

    // Insert resource with a known HLC
    conn.execute(
        "INSERT INTO resources (id, title, url, folder_id, resource_type, file_path, created_at, captured_at, hlc)
         VALUES ('r1', 'test', 'http://x', ?1, 'webpage', 'x', '2026-01-01', '2026-01-01', '0000000000100-0000-dev-old')",
        params![folder.id],
    ).unwrap();

    // Insert highlight with old HLC
    conn.execute(
        "INSERT INTO highlights (id, resource_id, text_content, anchor, color, created_at, hlc)
         VALUES ('h1', 'r1', 'hello', '{\"text_position\":{\"start\":0,\"end\":5},\"text_quote\":{\"exact\":\"hello\",\"prefix\":\"\",\"suffix\":\"\"}}', '#FFEB3B', '2026-01-01', '0000000000100-0000-dev-old')",
        [],
    ).unwrap();

    // Soft-delete folder tree with a newer HLC
    soft_delete_folder_tree(&conn, &folder.id, Some("0000000000200-0000-dev-new")).unwrap();

    // Verify child HLCs were updated
    let r_hlc: String = conn.query_row("SELECT hlc FROM resources WHERE id = 'r1'", [], |row| row.get(0)).unwrap();
    assert_eq!(r_hlc, "0000000000200-0000-dev-new");

    let h_hlc: String = conn.query_row("SELECT hlc FROM highlights WHERE id = 'h1'", [], |row| row.get(0)).unwrap();
    assert_eq!(h_hlc, "0000000000200-0000-dev-new");
}
```

This test verifies the *local* code path works correctly (it should pass already — it's our baseline).

- [ ] **Step 2: Run test to verify it passes (baseline)**

Run: `cd /Users/work/workspace/Shibei && cargo test -p shibei --lib db::folders::tests::test_soft_delete_folder_tree_updates_child_hlc`
Expected: PASS

- [ ] **Step 3: Fix `cascade_folder_delete` in engine.rs**

In `src-tauri/src/sync/engine.rs`, modify `soft_delete_entity` (line 1197-1199) to pass `hlc` to `cascade_folder_delete`:

```rust
        if entity_type == "folder" {
            self.cascade_folder_delete(conn, entity_id, deleted_at, hlc)?;
        }
```

Modify `cascade_folder_delete` signature and body (lines 1206-1257) to accept and propagate `hlc`:

```rust
    /// Cascade soft-delete all resources (and their annotations) in a folder,
    /// then recurse into child folders.
    fn cascade_folder_delete(
        &self,
        conn: &rusqlite::Connection,
        folder_id: &str,
        deleted_at: &str,
        hlc: &str,
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
                "UPDATE resource_tags SET deleted_at = ?1, hlc = ?2 WHERE resource_id = ?3 AND deleted_at IS NULL",
                params![deleted_at, hlc, rid],
            )?;
            conn.execute(
                "UPDATE highlights SET deleted_at = ?1, hlc = ?2 WHERE resource_id = ?3 AND deleted_at IS NULL",
                params![deleted_at, hlc, rid],
            )?;
            conn.execute(
                "UPDATE comments SET deleted_at = ?1, hlc = ?2 WHERE resource_id = ?3 AND deleted_at IS NULL",
                params![deleted_at, hlc, rid],
            )?;
        }

        conn.execute(
            "UPDATE resources SET deleted_at = ?1, hlc = ?2 WHERE folder_id = ?3 AND deleted_at IS NULL",
            params![deleted_at, hlc, folder_id],
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
                "UPDATE folders SET deleted_at = ?1, hlc = ?2 WHERE id = ?3 AND deleted_at IS NULL",
                params![deleted_at, hlc, child_id],
            )?;
            self.cascade_folder_delete(conn, child_id, deleted_at, hlc)?;
        }

        Ok(())
    }
```

- [ ] **Step 4: Run cargo check**

Run: `cd /Users/work/workspace/Shibei && cargo check -p shibei`
Expected: Compiles without errors.

- [ ] **Step 5: Run all existing tests**

Run: `cd /Users/work/workspace/Shibei && cargo test -p shibei --lib`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/sync/engine.rs src-tauri/src/db/folders.rs
git commit -m "fix(sync): propagate HLC in engine cascade_folder_delete to prevent cross-device divergence"
```

---

### Task 2: Fix `restore_resource` — sync child entity restores to remote

**Files:**
- Modify: `src-tauri/src/db/resources.rs:480-548`
- Modify: `src-tauri/src/db/highlights.rs` (add `list_deleted_highlights_for_resource`)
- Modify: `src-tauri/src/db/comments.rs` (add `list_deleted_comments_for_resource`)

When restoring a resource, child highlights/comments/resource_tags must:
1. Get their HLC updated (so they win LWW against stale remote deletes)
2. Have sync_log entries written (so remote devices know to restore them)

- [ ] **Step 1: Write failing test**

Add to `src-tauri/src/db/resources.rs` test module (after line 996):

```rust
#[test]
fn test_restore_resource_updates_child_hlc_and_writes_sync_log() {
    let conn = test_db();
    let clock = crate::sync::hlc::HlcClock::new("test-device".to_string());
    let ctx = crate::sync::SyncContext { clock: &clock, device_id: "test-device" };

    let folder = folders::create_folder(&conn, "docs", "__root__", Some(&ctx)).unwrap();
    let resource = create_test_resource_with_ctx(&conn, &folder.id, Some(&ctx));

    // Create a highlight and comment
    let h = crate::db::highlights::create_highlight(
        &conn, &resource.id, "hello",
        r#"{"text_position":{"start":0,"end":5},"text_quote":{"exact":"hello","prefix":"","suffix":""}}"#,
        "#FFEB3B", Some(&ctx),
    ).unwrap();
    let _c = crate::db::comments::create_comment(&conn, &resource.id, Some(&h.id), "note", Some(&ctx)).unwrap();

    // Delete resource (cascades to children)
    delete_resource(&conn, &resource.id, Some(&ctx)).unwrap();

    // Clear sync_log so we can check what restore writes
    conn.execute("DELETE FROM sync_log", []).unwrap();

    // Restore
    restore_resource(&conn, &resource.id, Some(&ctx)).unwrap();

    // Verify child HLCs were updated (not the old delete HLC)
    let h_hlc: String = conn.query_row(
        "SELECT hlc FROM highlights WHERE id = ?1", params![h.id], |row| row.get(0),
    ).unwrap();
    // The restore HLC should be newer than any previous HLC
    let r_hlc: String = conn.query_row(
        "SELECT hlc FROM resources WHERE id = ?1", params![resource.id], |row| row.get(0),
    ).unwrap();
    assert_eq!(h_hlc, r_hlc, "child HLC should match resource restore HLC");

    // Verify sync_log has entries for children
    let entries = crate::sync::sync_log::get_pending(&conn).unwrap();
    let entity_types: Vec<&str> = entries.iter().map(|e| e.entity_type.as_str()).collect();
    assert!(entity_types.contains(&"resource"), "should have resource UPDATE");
    assert!(entity_types.contains(&"highlight"), "should have highlight UPDATE");
    assert!(entity_types.contains(&"comment"), "should have comment UPDATE");
}
```

Also add a helper that accepts sync_ctx, right after the existing `create_test_resource` helper (line 738):

```rust
fn create_test_resource_with_ctx(conn: &Connection, folder_id: &str, sync_ctx: Option<&crate::sync::SyncContext>) -> Resource {
    create_resource(
        conn,
        CreateResourceInput {
            id: None,
            title: "Test Page".to_string(),
            url: "https://example.com/article".to_string(),
            domain: Some("example.com".to_string()),
            author: None,
            description: None,
            folder_id: folder_id.to_string(),
            resource_type: "webpage".to_string(),
            file_path: "storage/test/snapshot.html".to_string(),
            captured_at: "2026-01-01T00:00:00Z".to_string(),
            selection_meta: None,
        },
        sync_ctx,
    )
    .unwrap()
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/work/workspace/Shibei && cargo test -p shibei --lib db::resources::tests::test_restore_resource_updates_child_hlc_and_writes_sync_log`
Expected: FAIL — child HLC not matching, and no highlight/comment entries in sync_log.

- [ ] **Step 3: Add helper queries for deleted children**

In `src-tauri/src/db/highlights.rs`, add after `get_highlights_for_resource` (after line 113):

```rust
/// List highlights that were soft-deleted for a resource (for restore sync).
pub fn list_deleted_highlight_ids_for_resource(
    conn: &Connection,
    resource_id: &str,
) -> Result<Vec<String>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT id FROM highlights WHERE resource_id = ?1 AND deleted_at IS NOT NULL",
    )?;
    let ids = stmt
        .query_map(params![resource_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ids)
}
```

In `src-tauri/src/db/comments.rs`, add after `list_comments_for_resource` function:

```rust
/// List comments that were soft-deleted for a resource (for restore sync).
pub fn list_deleted_comment_ids_for_resource(
    conn: &Connection,
    resource_id: &str,
) -> Result<Vec<String>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT id FROM comments WHERE resource_id = ?1 AND deleted_at IS NOT NULL",
    )?;
    let ids = stmt
        .query_map(params![resource_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ids)
}
```

- [ ] **Step 4: Fix `restore_resource` to update child HLCs and write sync_log**

In `src-tauri/src/db/resources.rs`, replace lines 515-543 of `restore_resource`:

```rust
    // Collect deleted child IDs before restoring (for sync_log)
    let deleted_highlight_ids = super::highlights::list_deleted_highlight_ids_for_resource(conn, id)?;
    let deleted_comment_ids = super::comments::list_deleted_comment_ids_for_resource(conn, id)?;

    // Also restore associated highlights, comments, resource_tags (with HLC update)
    conn.execute(
        "UPDATE highlights SET deleted_at = NULL, hlc = COALESCE(?2, hlc) WHERE resource_id = ?1 AND deleted_at IS NOT NULL",
        params![id, hlc_str],
    )?;
    conn.execute(
        "UPDATE comments SET deleted_at = NULL, hlc = COALESCE(?2, hlc) WHERE resource_id = ?1 AND deleted_at IS NOT NULL",
        params![id, hlc_str],
    )?;
    conn.execute(
        "UPDATE resource_tags SET deleted_at = NULL, hlc = COALESCE(?2, hlc) WHERE resource_id = ?1 AND deleted_at IS NOT NULL",
        params![id, hlc_str],
    )?;

    let resource = get_resource(conn, id)?;

    if let Some(ctx) = sync_ctx {
        let hlc_ref = hlc_str.as_deref().unwrap_or("");

        // Write resource UPDATE
        let payload = serde_json::to_string(&resource)
            .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
        sync::sync_log::append(conn, "resource", id, "UPDATE", &payload, hlc_ref, ctx.device_id)?;

        // Write highlight UPDATEs for restored children
        for hid in &deleted_highlight_ids {
            if let Ok(h) = super::highlights::get_highlight_by_id(conn, hid) {
                let h_payload = serde_json::to_string(&h)
                    .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
                sync::sync_log::append(conn, "highlight", hid, "UPDATE", &h_payload, hlc_ref, ctx.device_id)?;
            }
        }

        // Write comment UPDATEs for restored children
        for cid in &deleted_comment_ids {
            if let Ok(c) = super::comments::get_comment_by_id(conn, cid) {
                let c_payload = serde_json::to_string(&c)
                    .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
                sync::sync_log::append(conn, "comment", cid, "UPDATE", &c_payload, hlc_ref, ctx.device_id)?;
            }
        }
    }

    let _ = super::search::rebuild_search_index(conn, id);

    Ok(resource)
```

Note: The existing `get_highlight` and `get_comment` functions filter by `deleted_at IS NULL`, so after restoring (setting deleted_at = NULL) they should work. But we need public accessors. Rename the private `get_highlight` to `get_highlight_by_id` and make it `pub`:

In `src-tauri/src/db/highlights.rs` line 173, change:
```rust
fn get_highlight(conn: &Connection, id: &str) -> Result<Highlight, DbError> {
```
to:
```rust
pub fn get_highlight_by_id(conn: &Connection, id: &str) -> Result<Highlight, DbError> {
```

And update the one call site in `delete_highlight` (line 130) from `get_highlight(conn, id)` to `get_highlight_by_id(conn, id)`.

Similarly in `src-tauri/src/db/comments.rs` line 160, change:
```rust
fn get_comment(conn: &Connection, id: &str) -> Result<Comment, DbError> {
```
to:
```rust
pub fn get_comment_by_id(conn: &Connection, id: &str) -> Result<Comment, DbError> {
```

And update the call site in `delete_comment` from `get_comment(conn, id)` to `get_comment_by_id(conn, id)`.

- [ ] **Step 5: Run cargo check**

Run: `cd /Users/work/workspace/Shibei && cargo check -p shibei`
Expected: Compiles without errors.

- [ ] **Step 6: Run the new test**

Run: `cd /Users/work/workspace/Shibei && cargo test -p shibei --lib db::resources::tests::test_restore_resource_updates_child_hlc_and_writes_sync_log`
Expected: PASS

- [ ] **Step 7: Run all tests**

Run: `cd /Users/work/workspace/Shibei && cargo test -p shibei --lib`
Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/db/resources.rs src-tauri/src/db/highlights.rs src-tauri/src/db/comments.rs
git commit -m "fix(sync): restore_resource updates child HLCs and writes sync_log for highlights/comments"
```

---

### Task 3: Fix `restore_folder` — cascade restore to children

**Files:**
- Modify: `src-tauri/src/db/folders.rs:345-397`

`restore_folder` should be symmetric with `delete_folder`: if deleting cascades to child folders/resources/annotations, restoring should cascade too. The restore should:
1. Restore child folders recursively
2. Restore resources in each folder
3. Restore highlights/comments/resource_tags for each resource
4. Update HLC on all restored entities
5. Write sync_log entries for all restored entities

- [ ] **Step 1: Write failing test**

Add to `src-tauri/src/db/folders.rs` test module:

```rust
#[test]
fn test_restore_folder_cascades_to_children() {
    let conn = test_db();
    let clock = crate::sync::hlc::HlcClock::new("test-device".to_string());
    let ctx = crate::sync::SyncContext { clock: &clock, device_id: "test-device" };

    let parent = create_folder(&conn, "parent", "__root__", Some(&ctx)).unwrap();
    let child = create_folder(&conn, "child", &parent.id, Some(&ctx)).unwrap();

    // Insert a resource in the child folder
    conn.execute(
        "INSERT INTO resources (id, title, url, folder_id, resource_type, file_path, created_at, captured_at, hlc)
         VALUES ('r1', 'test', 'http://x', ?1, 'webpage', 'x', '2026-01-01', '2026-01-01', '0000000000001-0000-dev')",
        params![child.id],
    ).unwrap();

    // Delete parent folder (cascades to child folder and resource)
    delete_folder(&conn, &parent.id, Some(&ctx)).unwrap();

    // Verify child folder and resource are deleted
    let child_deleted: bool = conn.query_row(
        "SELECT deleted_at IS NOT NULL FROM folders WHERE id = ?1", params![child.id], |row| row.get(0),
    ).unwrap();
    assert!(child_deleted);
    let r_deleted: bool = conn.query_row(
        "SELECT deleted_at IS NOT NULL FROM resources WHERE id = 'r1'", [], |row| row.get(0),
    ).unwrap();
    assert!(r_deleted);

    // Restore parent folder
    restore_folder(&conn, &parent.id, Some(&ctx)).unwrap();

    // Verify child folder is restored
    let child_deleted_after: Option<String> = conn.query_row(
        "SELECT deleted_at FROM folders WHERE id = ?1", params![child.id], |row| row.get(0),
    ).unwrap();
    assert!(child_deleted_after.is_none(), "child folder should be restored");

    // Verify resource is restored
    let r_deleted_after: Option<String> = conn.query_row(
        "SELECT deleted_at FROM resources WHERE id = 'r1'", [], |row| row.get(0),
    ).unwrap();
    assert!(r_deleted_after.is_none(), "resource should be restored");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/work/workspace/Shibei && cargo test -p shibei --lib db::folders::tests::test_restore_folder_cascades_to_children`
Expected: FAIL — child folder and resource remain deleted.

- [ ] **Step 3: Add `restore_folder_tree` helper and update `restore_folder`**

In `src-tauri/src/db/folders.rs`, add a new helper function after `soft_delete_folder_tree` (after line 271):

```rust
/// Recursively restore a folder tree and all cascaded entities.
/// Symmetric with `soft_delete_folder_tree`.
fn restore_folder_tree(
    conn: &Connection,
    folder_id: &str,
    hlc: Option<&str>,
    sync_ctx: Option<&SyncContext>,
) -> Result<(), DbError> {
    // Restore child folders first (find those deleted — they share the same parent)
    let mut stmt = conn.prepare(
        "SELECT id FROM folders WHERE parent_id = ?1 AND deleted_at IS NOT NULL",
    )?;
    let child_ids: Vec<String> = stmt
        .query_map(params![folder_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;

    for child_id in &child_ids {
        conn.execute(
            "UPDATE folders SET deleted_at = NULL, hlc = COALESCE(?1, hlc) WHERE id = ?2",
            params![hlc, child_id],
        )?;

        if let Some(ctx) = sync_ctx {
            if let Ok(folder) = get_folder(conn, child_id) {
                let payload = serde_json::to_string(&folder)
                    .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
                sync::sync_log::append(
                    conn, "folder", child_id, "UPDATE", &payload,
                    hlc.unwrap_or(""), ctx.device_id,
                )?;
            }
        }

        restore_folder_tree(conn, child_id, hlc, sync_ctx)?;
    }

    // Restore resources in this folder
    let mut stmt = conn.prepare(
        "SELECT id FROM resources WHERE folder_id = ?1 AND deleted_at IS NOT NULL",
    )?;
    let resource_ids: Vec<String> = stmt
        .query_map(params![folder_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;

    for rid in &resource_ids {
        // Collect deleted child IDs before restoring
        let deleted_highlight_ids = super::highlights::list_deleted_highlight_ids_for_resource(conn, rid)?;
        let deleted_comment_ids = super::comments::list_deleted_comment_ids_for_resource(conn, rid)?;

        conn.execute(
            "UPDATE resources SET deleted_at = NULL, hlc = COALESCE(?1, hlc) WHERE id = ?2",
            params![hlc, rid],
        )?;
        conn.execute(
            "UPDATE highlights SET deleted_at = NULL, hlc = COALESCE(?1, hlc) WHERE resource_id = ?2 AND deleted_at IS NOT NULL",
            params![hlc, rid],
        )?;
        conn.execute(
            "UPDATE comments SET deleted_at = NULL, hlc = COALESCE(?1, hlc) WHERE resource_id = ?2 AND deleted_at IS NOT NULL",
            params![hlc, rid],
        )?;
        conn.execute(
            "UPDATE resource_tags SET deleted_at = NULL, hlc = COALESCE(?1, hlc) WHERE resource_id = ?2 AND deleted_at IS NOT NULL",
            params![hlc, rid],
        )?;

        if let Some(ctx) = sync_ctx {
            let hlc_ref = hlc.unwrap_or("");

            if let Ok(resource) = super::resources::get_resource(conn, rid) {
                let payload = serde_json::to_string(&resource)
                    .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
                sync::sync_log::append(conn, "resource", rid, "UPDATE", &payload, hlc_ref, ctx.device_id)?;
            }

            for hid in &deleted_highlight_ids {
                if let Ok(h) = super::highlights::get_highlight_by_id(conn, hid) {
                    let payload = serde_json::to_string(&h)
                        .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
                    sync::sync_log::append(conn, "highlight", hid, "UPDATE", &payload, hlc_ref, ctx.device_id)?;
                }
            }

            for cid in &deleted_comment_ids {
                if let Ok(c) = super::comments::get_comment_by_id(conn, cid) {
                    let payload = serde_json::to_string(&c)
                        .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
                    sync::sync_log::append(conn, "comment", cid, "UPDATE", &payload, hlc_ref, ctx.device_id)?;
                }
            }
        }

        let _ = super::search::rebuild_search_index(conn, rid);
    }

    Ok(())
}
```

Then modify `restore_folder` (lines 345-397) to call it. Add one line after the folder itself is restored (after line 378):

```rust
    // After the existing: UPDATE folders SET deleted_at = NULL ...

    // Cascade restore to child folders, resources, and annotations
    restore_folder_tree(conn, id, hlc_str.as_deref(), sync_ctx)?;
```

The full `restore_folder` function becomes:

```rust
pub fn restore_folder(
    conn: &Connection,
    id: &str,
    sync_ctx: Option<&SyncContext>,
) -> Result<Folder, DbError> {
    let hlc_str = sync_ctx.map(|ctx| ctx.clock.tick().to_string());

    let parent_id: String = conn
        .query_row(
            "SELECT parent_id FROM folders WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(|_| DbError::NotFound(format!("folder {}", id)))?;

    let parent_exists: bool = parent_id == "__root__"
        || conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM folders WHERE id = ?1 AND deleted_at IS NULL",
                params![parent_id],
                |row| row.get(0),
            )
            .unwrap_or(false);

    let target_parent = if parent_exists {
        parent_id
    } else {
        "__root__".to_string()
    };

    conn.execute(
        "UPDATE folders SET deleted_at = NULL, parent_id = ?1, hlc = COALESCE(?2, hlc) WHERE id = ?3",
        params![target_parent, hlc_str, id],
    )?;

    // Cascade restore to child folders, resources, and annotations
    restore_folder_tree(conn, id, hlc_str.as_deref(), sync_ctx)?;

    let folder = get_folder(conn, id)?;

    if let Some(ctx) = sync_ctx {
        let payload = serde_json::to_string(&folder)
            .map_err(|e| DbError::InvalidOperation(e.to_string()))?;
        sync::sync_log::append(
            conn,
            "folder",
            id,
            "UPDATE",
            &payload,
            hlc_str.as_deref().unwrap_or(""),
            ctx.device_id,
        )?;
    }

    Ok(folder)
}
```

- [ ] **Step 4: Run cargo check**

Run: `cd /Users/work/workspace/Shibei && cargo check -p shibei`
Expected: Compiles without errors.

- [ ] **Step 5: Run the new test**

Run: `cd /Users/work/workspace/Shibei && cargo test -p shibei --lib db::folders::tests::test_restore_folder_cascades_to_children`
Expected: PASS

- [ ] **Step 6: Run all tests**

Run: `cd /Users/work/workspace/Shibei && cargo test -p shibei --lib`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/db/folders.rs
git commit -m "fix(sync): restore_folder cascades to child folders, resources, and annotations"
```

---

### Task 4: Fix `purge_folder` — recursive child folder handling

**Files:**
- Modify: `src-tauri/src/db/folders.rs:399-425`

`purge_folder` only hard-deletes resources in the immediate folder. It doesn't recursively handle child folders, leaving them as orphan soft-deleted rows. Fix it to recursively purge child folders first.

- [ ] **Step 1: Write failing test**

Add to `src-tauri/src/db/folders.rs` test module:

```rust
#[test]
fn test_purge_folder_recursive() {
    let conn = test_db();
    let parent = create_folder(&conn, "parent", "__root__", None).unwrap();
    let child = create_folder(&conn, "child", &parent.id, None).unwrap();

    // Insert resource in child folder
    conn.execute(
        "INSERT INTO resources (id, title, url, folder_id, resource_type, file_path, created_at, captured_at)
         VALUES ('r1', 'test', 'http://x', ?1, 'webpage', 'x', '2026-01-01', '2026-01-01')",
        params![child.id],
    ).unwrap();

    // Insert resource in parent folder
    conn.execute(
        "INSERT INTO resources (id, title, url, folder_id, resource_type, file_path, created_at, captured_at)
         VALUES ('r2', 'test2', 'http://y', ?1, 'webpage', 'y', '2026-01-01', '2026-01-01')",
        params![parent.id],
    ).unwrap();

    // Soft-delete parent (cascades)
    delete_folder(&conn, &parent.id, None).unwrap();

    // Purge parent
    let resource_ids = purge_folder(&conn, &parent.id).unwrap();

    // Should include resources from both parent and child folders
    assert!(resource_ids.contains(&"r1".to_string()), "should include child folder resource");
    assert!(resource_ids.contains(&"r2".to_string()), "should include parent folder resource");

    // Child folder should be gone
    let child_exists: bool = conn.query_row(
        "SELECT COUNT(*) > 0 FROM folders WHERE id = ?1", params![child.id], |row| row.get(0),
    ).unwrap();
    assert!(!child_exists, "child folder should be purged");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/work/workspace/Shibei && cargo test -p shibei --lib db::folders::tests::test_purge_folder_recursive`
Expected: FAIL — child folder resource r1 not in returned IDs, child folder still in DB.

- [ ] **Step 3: Fix `purge_folder` to recurse into child folders**

Replace `purge_folder` in `src-tauri/src/db/folders.rs` (lines 399-425):

```rust
pub fn purge_folder(conn: &Connection, id: &str) -> Result<Vec<String>, DbError> {
    // Guard: only purge folders that are already soft-deleted
    let is_deleted: bool = conn.query_row(
        "SELECT deleted_at IS NOT NULL FROM folders WHERE id = ?1",
        params![id],
        |row| row.get(0),
    ).map_err(|_| DbError::NotFound(format!("folder {}", id)))?;
    if !is_deleted {
        return Err(DbError::InvalidOperation(format!("folder {} is not deleted", id)));
    }

    let mut all_resource_ids = Vec::new();
    purge_folder_recursive(conn, id, &mut all_resource_ids)?;

    Ok(all_resource_ids)
}

fn purge_folder_recursive(
    conn: &Connection,
    folder_id: &str,
    resource_ids: &mut Vec<String>,
) -> Result<(), DbError> {
    // Recurse into child folders first
    let mut stmt = conn.prepare("SELECT id FROM folders WHERE parent_id = ?1")?;
    let child_ids: Vec<String> = stmt
        .query_map(params![folder_id], |row| row.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .collect();

    for child_id in &child_ids {
        purge_folder_recursive(conn, child_id, resource_ids)?;
    }

    // Collect and purge resources in this folder
    let mut stmt = conn.prepare("SELECT id FROM resources WHERE folder_id = ?1")?;
    let rids: Vec<String> = stmt
        .query_map(params![folder_id], |row| row.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .collect();

    for rid in &rids {
        conn.execute("DELETE FROM comments WHERE resource_id = ?1", params![rid])?;
        conn.execute("DELETE FROM highlights WHERE resource_id = ?1", params![rid])?;
        conn.execute("DELETE FROM resource_tags WHERE resource_id = ?1", params![rid])?;
        let _ = super::search::delete_search_index(conn, rid);
    }
    conn.execute("DELETE FROM resources WHERE folder_id = ?1", params![folder_id])?;
    conn.execute("DELETE FROM folders WHERE id = ?1", params![folder_id])?;

    resource_ids.extend(rids);

    Ok(())
}
```

- [ ] **Step 4: Run cargo check**

Run: `cd /Users/work/workspace/Shibei && cargo check -p shibei`
Expected: Compiles without errors.

- [ ] **Step 5: Run the new test**

Run: `cd /Users/work/workspace/Shibei && cargo test -p shibei --lib db::folders::tests::test_purge_folder_recursive`
Expected: PASS

- [ ] **Step 6: Run all tests**

Run: `cd /Users/work/workspace/Shibei && cargo test -p shibei --lib`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/db/folders.rs
git commit -m "fix(sync): purge_folder recursively handles child folders"
```

---

### Task 5: Update sync mechanism review doc

**Files:**
- Modify: `docs/superpowers/specs/2026-04-07-sync-mechanism-review.md`

- [ ] **Step 1: Add issues 13-16 to section 七**

Append to the "已修复问题总结" section:

```markdown
### 问题 13: Engine cascade_folder_delete 不传播 HLC ✅

**场景**: 远端 folder DELETE 级联删除子实体时不更新 HLC，导致子实体保留旧 HLC。后续较新的 UPDATE 会在 LWW 判定中胜出，意外复活已删除的子实体，造成跨设备数据不一致。
**修复**: `cascade_folder_delete` 接收并传播 `hlc` 参数到所有子实体的 UPDATE 语句，与本地 `soft_delete_folder_tree` 行为一致。

### 问题 14: restore_resource 子实体不同步到远端 ✅

**场景**: 恢复资料时本地级联恢复了 highlights/comments/resource_tags，但不更新子实体 HLC，且不写 sync_log 条目。远端设备不知道子实体已恢复，导致跨设备不一致。
**修复**: `restore_resource` 恢复子实体时更新 HLC (`COALESCE(?2, hlc)`)，并为每个恢复的 highlight/comment 写 UPDATE sync_log 条目。

### 问题 15: restore_folder 不级联恢复子内容 ✅

**场景**: 删除文件夹时通过 `soft_delete_folder_tree` 级联删除所有子文件夹和资料，但恢复文件夹时只恢复文件夹自身，子内容保持删除状态。
**修复**: 新增 `restore_folder_tree` 递归恢复子文件夹、资料及标注，更新 HLC 并写 sync_log 条目，与删除操作对称。

### 问题 16: purge_folder 不递归处理子文件夹 ✅

**场景**: `purge_folder` 只硬删直接子资料，不处理嵌套的子文件夹。子文件夹及其资料变成孤儿行，等 90 天 compaction 才清理。
**修复**: `purge_folder` 改为递归实现，先深度遍历子文件夹，再依次清理资料和文件夹本身。
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-04-07-sync-mechanism-review.md
git commit -m "docs(sync): add issues 13-16 to sync mechanism review"
```
