# Unified Data Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ad-hoc manual refresh chains with a centralized event-based invalidation mechanism so all UI state auto-refreshes after mutations.

**Architecture:** Backend Tauri commands emit domain events after DB writes; frontend hooks subscribe to events they care about and auto-refresh. Old refresh mechanisms (onDataChanged callbacks, refreshKey state, folderTreeRefreshRef, custom window events) are removed entirely.

**Tech Stack:** Rust (Tauri Emitter), TypeScript (Tauri listen API), React hooks

**Spec:** `docs/superpowers/specs/2026-04-03-unified-data-events-design.md`

---

### Task 1: Define Rust event constants

**Files:**
- Create: `src-tauri/src/events.rs`
- Modify: `src-tauri/src/lib.rs:1`

- [ ] **Step 1: Create `src-tauri/src/events.rs`**

```rust
/// Centralized event name constants for Tauri emit.
/// Frontend mirrors these in `src/lib/events.ts`.
///
/// Audit: `grep "emit_event\|DATA_" src-tauri/src/` to find all emit sites.

// Domain data events
pub const DATA_RESOURCE_CHANGED: &str = "data:resource-changed";
pub const DATA_FOLDER_CHANGED: &str = "data:folder-changed";
pub const DATA_TAG_CHANGED: &str = "data:tag-changed";
pub const DATA_ANNOTATION_CHANGED: &str = "data:annotation-changed";
pub const DATA_SYNC_COMPLETED: &str = "data:sync-completed";
pub const DATA_CONFIG_CHANGED: &str = "data:config-changed";

// Sync status events (UI-only, not data events)
pub const SYNC_STARTED: &str = "sync-started";
pub const SYNC_FAILED: &str = "sync-failed";
```

- [ ] **Step 2: Register module in `lib.rs`**

Add `mod events;` after the existing module declarations in `src-tauri/src/lib.rs`:

```rust
mod commands;
mod db;
mod events;
mod server;
mod storage;
pub mod sync;
```

- [ ] **Step 3: Run `cargo check`**

Run: `cd src-tauri && cargo check`
Expected: compiles with no errors (unused warnings OK at this point)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/events.rs src-tauri/src/lib.rs
git commit -m "feat: add centralized Rust event name constants"
```

---

### Task 2: Define frontend event constants and TypeScript types

**Files:**
- Create: `src/lib/events.ts`

- [ ] **Step 1: Create `src/lib/events.ts`**

```typescript
/**
 * Centralized event name constants — mirrors src-tauri/src/events.rs.
 * All Tauri event listeners must import from here; never use raw strings.
 *
 * Audit: `grep "listen(DataEvents\|listen(SyncEvents" src/` to find all subscribers.
 */

export const DataEvents = {
  RESOURCE_CHANGED: "data:resource-changed",
  FOLDER_CHANGED: "data:folder-changed",
  TAG_CHANGED: "data:tag-changed",
  ANNOTATION_CHANGED: "data:annotation-changed",
  SYNC_COMPLETED: "data:sync-completed",
  CONFIG_CHANGED: "data:config-changed",
} as const;

export const SyncEvents = {
  STARTED: "sync-started",
  FAILED: "sync-failed",
} as const;

// ── Payload types ──

export interface ResourceChangedPayload {
  action: "created" | "updated" | "deleted" | "moved";
  resource_id?: string;
  folder_id?: string;
}

export interface FolderChangedPayload {
  action: "created" | "updated" | "deleted" | "moved" | "reordered";
  folder_id?: string;
  parent_id?: string;
}

export interface TagChangedPayload {
  action: "created" | "updated" | "deleted";
  tag_id?: string;
  resource_id?: string;
}

export interface AnnotationChangedPayload {
  action: "created" | "updated" | "deleted";
  resource_id: string;
}

export interface ConfigChangedPayload {
  scope: "sync" | "encryption";
}

export interface SyncFailedPayload {
  message: string;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors related to events.ts

- [ ] **Step 3: Commit**

```bash
git add src/lib/events.ts
git commit -m "feat: add frontend event constants and payload types"
```

---

### Task 3: Add event emit to all backend Tauri commands

**Files:**
- Modify: `src-tauri/src/commands/mod.rs`

Every mutation command needs: (1) an `app: tauri::AppHandle` parameter, (2) an `app.emit()` call after the successful DB write.

- [ ] **Step 1: Add `use crate::events;` import at top of commands/mod.rs**

After the existing `use` statements (line 4), add:

```rust
use crate::events;
```

- [ ] **Step 2: Add event emit to folder commands**

**cmd_create_folder** — add `app` parameter and emit after success:

```rust
#[tauri::command]
pub async fn cmd_create_folder(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    name: String,
    parent_id: String,
) -> Result<folders::Folder, CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    let folder = folders::create_folder(&conn, &name, &parent_id, sync_ctx.as_ref())?;
    let _ = app.emit(events::DATA_FOLDER_CHANGED, serde_json::json!({
        "action": "created", "parent_id": parent_id
    }));
    Ok(folder)
}
```

**cmd_rename_folder** — add `app` parameter and emit:

```rust
#[tauri::command]
pub async fn cmd_rename_folder(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
    name: String,
) -> Result<(), CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    folders::rename_folder(&conn, &id, &name, sync_ctx.as_ref())?;
    let _ = app.emit(events::DATA_FOLDER_CHANGED, serde_json::json!({
        "action": "updated", "folder_id": id
    }));
    Ok(())
}
```

**cmd_delete_folder** — add `app` parameter and emit two events (folder + resource cascade):

```rust
#[tauri::command]
pub async fn cmd_delete_folder(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
) -> Result<Vec<String>, CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    let resource_ids = folders::delete_folder(&conn, &id, sync_ctx.as_ref())?;
    for rid in &resource_ids {
        let dir = storage::resource_dir(&state.base_dir, rid);
        let _ = std::fs::remove_dir_all(dir);
    }
    let _ = app.emit(events::DATA_FOLDER_CHANGED, serde_json::json!({
        "action": "deleted", "folder_id": id
    }));
    let _ = app.emit(events::DATA_RESOURCE_CHANGED, serde_json::json!({
        "action": "deleted"
    }));
    Ok(resource_ids)
}
```

**cmd_move_folder** — add `app` parameter and emit:

```rust
#[tauri::command]
pub async fn cmd_move_folder(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
    new_parent_id: String,
) -> Result<(), CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    folders::move_folder(&conn, &id, &new_parent_id, sync_ctx.as_ref())?;
    let _ = app.emit(events::DATA_FOLDER_CHANGED, serde_json::json!({
        "action": "moved", "folder_id": id
    }));
    Ok(())
}
```

**cmd_reorder_folder** — add `app` parameter and emit:

```rust
#[tauri::command]
pub async fn cmd_reorder_folder(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
    new_sort_order: i64,
) -> Result<(), CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    folders::reorder_folder(&conn, &id, new_sort_order, sync_ctx.as_ref())?;
    let _ = app.emit(events::DATA_FOLDER_CHANGED, serde_json::json!({
        "action": "reordered", "folder_id": id
    }));
    Ok(())
}
```

- [ ] **Step 3: Add event emit to resource commands**

**cmd_delete_resource** — add `app` parameter and emit:

```rust
#[tauri::command]
pub async fn cmd_delete_resource(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
) -> Result<(), CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    let rid = resources::delete_resource(&conn, &id, sync_ctx.as_ref())?;
    drop(conn);
    let dir = storage::resource_dir(&state.base_dir, &rid);
    if let Err(e) = std::fs::remove_dir_all(&dir) {
        eprintln!("[shibei] Failed to clean up resource directory {:?}: {}", dir, e);
    }
    let _ = app.emit(events::DATA_RESOURCE_CHANGED, serde_json::json!({
        "action": "deleted", "resource_id": id
    }));
    Ok(())
}
```

**cmd_move_resource** — add `app` parameter and emit:

```rust
#[tauri::command]
pub async fn cmd_move_resource(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
    new_folder_id: String,
) -> Result<(), CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    resources::move_resource(&conn, &id, &new_folder_id, sync_ctx.as_ref())?;
    let _ = app.emit(events::DATA_RESOURCE_CHANGED, serde_json::json!({
        "action": "moved", "resource_id": id, "folder_id": new_folder_id
    }));
    Ok(())
}
```

**cmd_update_resource** — add `app` parameter and emit:

```rust
#[tauri::command]
pub async fn cmd_update_resource(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
    title: String,
    description: Option<String>,
) -> Result<(), CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    resources::update_resource(&conn, &id, &title, description.as_deref(), sync_ctx.as_ref())?;
    let _ = app.emit(events::DATA_RESOURCE_CHANGED, serde_json::json!({
        "action": "updated", "resource_id": id
    }));
    Ok(())
}
```

- [ ] **Step 4: Add event emit to tag commands**

**cmd_create_tag**:

```rust
#[tauri::command]
pub async fn cmd_create_tag(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    name: String,
    color: String,
) -> Result<tags::Tag, CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    let tag = tags::create_tag(&conn, &name, &color, sync_ctx.as_ref())?;
    let _ = app.emit(events::DATA_TAG_CHANGED, serde_json::json!({
        "action": "created", "tag_id": tag.id
    }));
    Ok(tag)
}
```

**cmd_update_tag**:

```rust
#[tauri::command]
pub async fn cmd_update_tag(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
    name: String,
    color: String,
) -> Result<(), CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    tags::update_tag(&conn, &id, &name, &color, sync_ctx.as_ref())?;
    let _ = app.emit(events::DATA_TAG_CHANGED, serde_json::json!({
        "action": "updated", "tag_id": id
    }));
    Ok(())
}
```

**cmd_delete_tag**:

```rust
#[tauri::command]
pub async fn cmd_delete_tag(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
) -> Result<(), CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    tags::delete_tag(&conn, &id, sync_ctx.as_ref())?;
    let _ = app.emit(events::DATA_TAG_CHANGED, serde_json::json!({
        "action": "deleted", "tag_id": id
    }));
    Ok(())
}
```

**cmd_add_tag_to_resource**:

```rust
#[tauri::command]
pub async fn cmd_add_tag_to_resource(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    resource_id: String,
    tag_id: String,
) -> Result<(), CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    tags::add_tag_to_resource(&conn, &resource_id, &tag_id, sync_ctx.as_ref())?;
    let _ = app.emit(events::DATA_TAG_CHANGED, serde_json::json!({
        "action": "updated", "tag_id": tag_id, "resource_id": resource_id
    }));
    Ok(())
}
```

**cmd_remove_tag_from_resource**:

```rust
#[tauri::command]
pub async fn cmd_remove_tag_from_resource(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    resource_id: String,
    tag_id: String,
) -> Result<(), CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    tags::remove_tag_from_resource(&conn, &resource_id, &tag_id, sync_ctx.as_ref())?;
    let _ = app.emit(events::DATA_TAG_CHANGED, serde_json::json!({
        "action": "updated", "tag_id": tag_id, "resource_id": resource_id
    }));
    Ok(())
}
```

- [ ] **Step 5: Add event emit to annotation commands**

**cmd_create_highlight**:

```rust
#[tauri::command]
pub async fn cmd_create_highlight(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    resource_id: String,
    text_content: String,
    anchor: highlights::Anchor,
    color: String,
) -> Result<highlights::Highlight, CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    let hl = highlights::create_highlight(&conn, &resource_id, &text_content, &anchor, &color, sync_ctx.as_ref())?;
    let _ = app.emit(events::DATA_ANNOTATION_CHANGED, serde_json::json!({
        "action": "created", "resource_id": resource_id
    }));
    Ok(hl)
}
```

**cmd_delete_highlight**:

```rust
#[tauri::command]
pub async fn cmd_delete_highlight(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
    resource_id: String,
) -> Result<(), CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    highlights::delete_highlight(&conn, &id, sync_ctx.as_ref())?;
    let _ = app.emit(events::DATA_ANNOTATION_CHANGED, serde_json::json!({
        "action": "deleted", "resource_id": resource_id
    }));
    Ok(())
}
```

Note: `cmd_delete_highlight` now takes `resource_id` as an additional parameter so the event payload can include it. The frontend caller (`useAnnotations.removeHighlight`) already has access to `resourceId` and will pass it.

**cmd_create_comment**:

```rust
#[tauri::command]
pub async fn cmd_create_comment(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    resource_id: String,
    highlight_id: Option<String>,
    content: String,
) -> Result<comments::Comment, CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    let comment = comments::create_comment(&conn, &resource_id, highlight_id.as_deref(), &content, sync_ctx.as_ref())?;
    let _ = app.emit(events::DATA_ANNOTATION_CHANGED, serde_json::json!({
        "action": "created", "resource_id": resource_id
    }));
    Ok(comment)
}
```

**cmd_update_comment** — needs `resource_id` added as parameter:

```rust
#[tauri::command]
pub async fn cmd_update_comment(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
    content: String,
    resource_id: String,
) -> Result<(), CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    comments::update_comment(&conn, &id, &content, sync_ctx.as_ref())?;
    let _ = app.emit(events::DATA_ANNOTATION_CHANGED, serde_json::json!({
        "action": "updated", "resource_id": resource_id
    }));
    Ok(())
}
```

**cmd_delete_comment** — needs `resource_id` added as parameter:

```rust
#[tauri::command]
pub async fn cmd_delete_comment(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
    resource_id: String,
) -> Result<(), CommandError> {
    let conn = state.pool.get().map_err(|e| CommandError { message: e.to_string() })?;
    let sync_ctx = state.sync_context();
    comments::delete_comment(&conn, &id, sync_ctx.as_ref())?;
    let _ = app.emit(events::DATA_ANNOTATION_CHANGED, serde_json::json!({
        "action": "deleted", "resource_id": resource_id
    }));
    Ok(())
}
```

- [ ] **Step 6: Add event emit to sync command**

Replace the existing `cmd_sync_now` with `sync-started`/`sync-failed` and the new `data:sync-completed`:

```rust
#[tauri::command]
pub async fn cmd_sync_now(
    state: tauri::State<'_, Arc<AppState>>,
    encryption_state: tauri::State<'_, Arc<crate::sync::EncryptionState>>,
    app: tauri::AppHandle,
) -> Result<String, CommandError> {
    let _ = app.emit(events::SYNC_STARTED, ());
    let engine = match build_sync_engine(&state, &encryption_state).await {
        Ok(e) => e,
        Err(e) => {
            let _ = app.emit(events::SYNC_FAILED, serde_json::json!({
                "message": e.message
            }));
            return Err(e);
        }
    };
    match engine.sync().await {
        Ok(result) => {
            let _ = app.emit(events::DATA_SYNC_COMPLETED, ());
            Ok(format!("{:?}", result))
        }
        Err(e) => {
            let _ = app.emit(events::SYNC_FAILED, serde_json::json!({
                "message": e.to_string()
            }));
            Err(CommandError { message: e.to_string() })
        }
    }
}
```

- [ ] **Step 7: Add event emit to config commands**

**cmd_setup_encryption** — add `app` parameter. Insert emit at end (before `Ok(())`):

```rust
    let _ = app.emit(events::DATA_CONFIG_CHANGED, serde_json::json!({
        "scope": "encryption"
    }));
    Ok(())
```

Full signature becomes:
```rust
pub async fn cmd_setup_encryption(
    state: tauri::State<'_, Arc<AppState>>,
    encryption_state: tauri::State<'_, Arc<crate::sync::EncryptionState>>,
    app: tauri::AppHandle,
    password: String,
) -> Result<(), CommandError> {
```

**cmd_unlock_encryption** — same pattern:

```rust
pub async fn cmd_unlock_encryption(
    state: tauri::State<'_, Arc<AppState>>,
    encryption_state: tauri::State<'_, Arc<crate::sync::EncryptionState>>,
    app: tauri::AppHandle,
    password: String,
) -> Result<(), CommandError> {
```

Insert before `Ok(())`:
```rust
    let _ = app.emit(events::DATA_CONFIG_CHANGED, serde_json::json!({
        "scope": "encryption"
    }));
```

**cmd_change_encryption_password** — add `app`, emit at end:

```rust
pub async fn cmd_change_encryption_password(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    old_password: String,
    new_password: String,
) -> Result<(), CommandError> {
```

Insert before `Ok(())`:
```rust
    let _ = app.emit(events::DATA_CONFIG_CHANGED, serde_json::json!({
        "scope": "encryption"
    }));
```

**cmd_save_sync_config** — add `app`, emit at end:

```rust
pub async fn cmd_save_sync_config(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    endpoint: String,
    region: String,
    bucket: String,
    access_key: String,
    secret_key: String,
) -> Result<(), CommandError> {
```

Insert before `Ok(())`:
```rust
    let _ = app.emit(events::DATA_CONFIG_CHANGED, serde_json::json!({
        "scope": "sync"
    }));
```

**cmd_set_sync_interval** — add `app`, emit at end:

```rust
pub async fn cmd_set_sync_interval(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    minutes: i64,
) -> Result<(), CommandError> {
```

Insert before `Ok(())`:
```rust
    let _ = app.emit(events::DATA_CONFIG_CHANGED, serde_json::json!({
        "scope": "sync"
    }));
```

- [ ] **Step 8: Update HTTP handler event**

In `src-tauri/src/server/mod.rs`, change the `resource-saved` emit to use the new event constant. The server handler already has `state.app_handle` available.

Add `use crate::events;` at the top of server/mod.rs, then change line ~421:

```rust
// Before:
let _ = state.app_handle.emit("resource-saved", serde_json::json!({
    "resource_id": resource.id,
    "folder_id": resource.folder_id,
}));

// After:
let _ = state.app_handle.emit(events::DATA_RESOURCE_CHANGED, serde_json::json!({
    "action": "created",
    "resource_id": resource.id,
    "folder_id": resource.folder_id,
}));
```

- [ ] **Step 9: Run `cargo check` and `cargo clippy`**

Run: `cd src-tauri && cargo check && cargo clippy`
Expected: compiles with no errors. Clippy may warn about unused parameters in newly added `app` params — that's fine since frontend calls haven't been updated yet.

- [ ] **Step 10: Commit**

```bash
git add src-tauri/src/commands/mod.rs src-tauri/src/server/mod.rs
git commit -m "feat: emit domain events from all mutation commands"
```

---

### Task 4: Update frontend invoke wrappers for changed command signatures

**Files:**
- Modify: `src/lib/commands.ts`

Some commands gained new parameters (`resource_id` for delete_highlight, update_comment, delete_comment). Update the invoke wrappers.

- [ ] **Step 1: Update `deleteHighlight` to pass `resource_id`**

```typescript
// Before:
export function deleteHighlight(id: string): Promise<void> {
  return invoke("cmd_delete_highlight", { id });
}

// After:
export function deleteHighlight(id: string, resourceId: string): Promise<void> {
  return invoke("cmd_delete_highlight", { id, resourceId });
}
```

- [ ] **Step 2: Update `updateComment` to pass `resource_id`**

```typescript
// Before:
export function updateComment(id: string, content: string): Promise<void> {
  return invoke("cmd_update_comment", { id, content });
}

// After:
export function updateComment(id: string, content: string, resourceId: string): Promise<void> {
  return invoke("cmd_update_comment", { id, content, resourceId });
}
```

- [ ] **Step 3: Update `deleteComment` to pass `resource_id`**

```typescript
// Before:
export function deleteComment(id: string): Promise<void> {
  return invoke("cmd_delete_comment", { id });
}

// After:
export function deleteComment(id: string, resourceId: string): Promise<void> {
  return invoke("cmd_delete_comment", { id, resourceId });
}
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: errors in hooks that call these functions with old signatures — that's expected, will be fixed in Task 5-8.

- [ ] **Step 5: Commit**

```bash
git add src/lib/commands.ts
git commit -m "feat: update invoke wrappers for new command signatures"
```

---

### Task 5: Rewrite `useResources` hook to use events

**Files:**
- Modify: `src/hooks/useResources.ts`

- [ ] **Step 1: Rewrite `useResources.ts`**

```typescript
import { useState, useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import toast from "react-hot-toast";
import type { Resource, Tag } from "@/types";
import * as cmd from "@/lib/commands";
import { DataEvents } from "@/lib/events";

export function useResources(
  folderId: string | null,
  sortBy: "created_at" | "annotated_at" = "created_at",
  sortOrder: "asc" | "desc" = "desc",
) {
  const [resources, setResources] = useState<Resource[]>([]);
  const [resourceTags, setResourceTags] = useState<Record<string, Tag[]>>({});
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!folderId) {
      setResources([]);
      setResourceTags({});
      return;
    }
    setLoading(true);
    try {
      const list = await cmd.listResources(folderId, sortBy, sortOrder);
      setResources(list);
      const tagEntries = await Promise.all(
        list.map(async (r) => {
          const tags = await cmd.getTagsForResource(r.id);
          return [r.id, tags] as const;
        }),
      );
      setResourceTags(Object.fromEntries(tagEntries));
    } catch (err) {
      console.error("Failed to load resources:", err);
      toast.error("加载资料列表失败");
    } finally {
      setLoading(false);
    }
  }, [folderId, sortBy, sortOrder]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-refresh on data events
  useEffect(() => {
    const u1 = listen(DataEvents.RESOURCE_CHANGED, () => { refresh(); });
    const u2 = listen(DataEvents.TAG_CHANGED, () => { refresh(); });
    const u3 = listen(DataEvents.SYNC_COMPLETED, () => { refresh(); });
    return () => {
      u1.then((f) => f());
      u2.then((f) => f());
      u3.then((f) => f());
    };
  }, [refresh]);

  return { resources, resourceTags, loading, refresh };
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors in useResources.ts

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useResources.ts
git commit -m "refactor: useResources subscribes to data events instead of manual refresh"
```

---

### Task 6: Rewrite `useFolders` hook and `FolderTree` component to use events

**Files:**
- Modify: `src/hooks/useFolders.ts`
- Modify: `src/components/Sidebar/FolderTree.tsx`

- [ ] **Step 1: Rewrite `useFolders.ts`**

```typescript
import { useState, useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import toast from "react-hot-toast";
import type { Folder } from "@/types";
import * as cmd from "@/lib/commands";
import { DataEvents } from "@/lib/events";

export function useFolders(parentId: string) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await cmd.listFolders(parentId);
      setFolders(data);
    } catch (err) {
      console.error("Failed to load folders:", err);
      toast.error("加载文件夹失败");
    } finally {
      setLoading(false);
    }
  }, [parentId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-refresh on folder structure changes
  useEffect(() => {
    const u1 = listen(DataEvents.FOLDER_CHANGED, () => { refresh(); });
    const u2 = listen(DataEvents.SYNC_COMPLETED, () => { refresh(); });
    return () => {
      u1.then((f) => f());
      u2.then((f) => f());
    };
  }, [refresh]);

  return { folders, loading, refresh };
}
```

Note: `refreshKey` parameter removed — no longer needed.

- [ ] **Step 2: Update `FolderTree.tsx` — remove `onRefreshRef` prop and old refresh mechanisms**

Key changes to FolderTree.tsx:
1. Remove `onRefreshRef` prop from `FolderTreeProps`
2. Remove `refreshKey` state and `refreshAll()` function
3. Remove the `useEffect` that sets `onRefreshRef.current`
4. Remove `resource-saved` event listener
5. `loadMeta` subscribes to `data:resource-changed`, `data:folder-changed`, `data:sync-completed`
6. After mutations (`handleCreate`, `doDelete`, `handleCreateSubfolder`), remove `refreshAll()` calls — events handle refresh
7. `FolderNode` no longer receives `refreshKey` prop
8. `DraggableFolderItem` no longer receives `refreshKey` prop

Updated `FolderTreeProps`:
```typescript
interface FolderTreeProps {
  selectedFolderId: string | null;
  onSelectFolder: (id: string) => void;
}
```

In the component body, replace the `loadMeta` + `resource-saved` listener section with event subscriptions:

```typescript
const loadMeta = useCallback(async () => {
  try {
    const [counts, ids] = await Promise.all([
      cmd.getFolderCounts(),
      cmd.getNonLeafFolderIds(),
    ]);
    setFolderCounts(counts);
    setNonLeafIds(new Set(ids));
  } catch (err) {
    console.error("Failed to load folder metadata:", err);
  }
}, []);

useEffect(() => {
  loadMeta();
}, [loadMeta]);

// Auto-refresh metadata on data events
useEffect(() => {
  const u1 = listen(DataEvents.RESOURCE_CHANGED, () => { loadMeta(); });
  const u2 = listen(DataEvents.FOLDER_CHANGED, () => { loadMeta(); });
  const u3 = listen(DataEvents.SYNC_COMPLETED, () => { loadMeta(); });
  return () => {
    u1.then((f) => f());
    u2.then((f) => f());
    u3.then((f) => f());
  };
}, [loadMeta]);
```

Remove these lines entirely:
- `const [refreshKey, setRefreshKey] = useState(0);`
- `function refreshAll() { ... }`
- `useEffect` that assigns `onRefreshRef.current`
- `useEffect` that listens to `"resource-saved"`

In `handleCreate`, `doDelete`, `handleCreateSubfolder`, and `onSaved={refreshAll}` — remove the manual `refreshAll()` calls. The events emitted by the backend commands will trigger the hook subscriptions automatically.

Update `FolderNode` and `DraggableFolderItem` interfaces to remove `refreshKey` prop. `FolderNode` calls `useFolders(parentId)` without `refreshKey`.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: may have errors in Layout.tsx (it still references `folderTreeRefreshRef` and `onRefreshRef`) — will be fixed in Task 9.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useFolders.ts src/components/Sidebar/FolderTree.tsx
git commit -m "refactor: useFolders and FolderTree subscribe to data events"
```

---

### Task 7: Rewrite `useTags` hook to use events

**Files:**
- Modify: `src/hooks/useTags.ts`

- [ ] **Step 1: Rewrite `useTags.ts`**

Remove manual `refresh()` calls from mutation functions — backend events handle refresh.

```typescript
import { useState, useCallback, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import * as cmd from "@/lib/commands";
import type { Tag } from "@/types";
import { DataEvents } from "@/lib/events";

export function useTags() {
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      const list = await cmd.listTags();
      setTags(list);
    } catch (err) {
      console.error("Failed to load tags:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-refresh on data events
  useEffect(() => {
    const u1 = listen(DataEvents.TAG_CHANGED, () => { refresh(); });
    const u2 = listen(DataEvents.SYNC_COMPLETED, () => { refresh(); });
    return () => {
      u1.then((f) => f());
      u2.then((f) => f());
    };
  }, [refresh]);

  const createTag = useCallback(
    async (name: string, color: string) => {
      return await cmd.createTag(name, color);
    },
    [],
  );

  const updateTag = useCallback(
    async (id: string, name: string, color: string) => {
      await cmd.updateTag(id, name, color);
    },
    [],
  );

  const deleteTag = useCallback(
    async (id: string) => {
      await cmd.deleteTag(id);
    },
    [],
  );

  return { tags, loading, refresh, createTag, updateTag, deleteTag };
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors in useTags.ts

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useTags.ts
git commit -m "refactor: useTags subscribes to data events, removes manual refresh after mutations"
```

---

### Task 8: Rewrite `useAnnotations` hook to use events

**Files:**
- Modify: `src/hooks/useAnnotations.ts`

- [ ] **Step 1: Rewrite `useAnnotations.ts`**

Remove: `notifyChange()`, `shibei:annotations-changed` listener, all manual `setHighlights`/`setComments` updates in mutation functions. Mutations now just call the backend command; the event triggers refresh.

```typescript
import { useState, useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import toast from "react-hot-toast";
import type { Highlight, Comment } from "@/types";
import * as cmd from "@/lib/commands";
import { DataEvents } from "@/lib/events";

export function useAnnotations(resourceId: string) {
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [hl, cm] = await Promise.all([
        cmd.getHighlights(resourceId),
        cmd.getComments(resourceId),
      ]);
      setHighlights(hl);
      setComments(cm);
    } catch (err) {
      console.error("Failed to load annotations:", err);
      toast.error("加载标注失败");
    } finally {
      setLoading(false);
    }
  }, [resourceId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-refresh on data events
  useEffect(() => {
    const u1 = listen(DataEvents.ANNOTATION_CHANGED, () => { refresh(); });
    const u2 = listen(DataEvents.SYNC_COMPLETED, () => { refresh(); });
    return () => {
      u1.then((f) => f());
      u2.then((f) => f());
    };
  }, [refresh]);

  const addHighlight = useCallback(
    (highlight: Highlight) => {
      // Highlight already persisted by caller (cmd.createHighlight).
      // Backend emits data:annotation-changed which triggers refresh.
      // This function is kept for the caller to get the highlight object
      // for immediate iframe postMessage (before the async refresh completes).
      setHighlights((prev) => [...prev, highlight]);
    },
    [],
  );

  const removeHighlight = useCallback(
    async (id: string) => {
      try {
        await cmd.deleteHighlight(id, resourceId);
      } catch (err) {
        console.error("Failed to delete highlight:", err);
        toast.error("删除高亮失败");
      }
    },
    [resourceId],
  );

  const addComment = useCallback(
    async (highlightId: string | null, content: string) => {
      try {
        const comment = await cmd.createComment(resourceId, highlightId, content);
        return comment;
      } catch (err) {
        console.error("Failed to create comment:", err);
        toast.error("创建评论失败");
        return null;
      }
    },
    [resourceId],
  );

  const removeComment = useCallback(
    async (id: string) => {
      try {
        await cmd.deleteComment(id, resourceId);
      } catch (err) {
        console.error("Failed to delete comment:", err);
        toast.error("删除评论失败");
      }
    },
    [resourceId],
  );

  const editComment = useCallback(
    async (id: string, content: string) => {
      try {
        await cmd.updateComment(id, content, resourceId);
      } catch (err) {
        console.error("Failed to update comment:", err);
        toast.error("编辑评论失败");
      }
    },
    [resourceId],
  );

  const getCommentsForHighlight = useCallback(
    (highlightId: string) => {
      return comments.filter((c) => c.highlight_id === highlightId);
    },
    [comments],
  );

  const resourceNotes = comments.filter((c) => c.highlight_id === null);

  return {
    highlights,
    comments,
    resourceNotes,
    loading,
    refresh,
    addHighlight,
    removeHighlight,
    addComment,
    removeComment,
    editComment,
    getCommentsForHighlight,
  };
}
```

Note: `addHighlight` is kept with an immediate `setHighlights` update. This is NOT "optimistic update" in the traditional sense — the highlight is already persisted when `addHighlight` is called. It's needed so the caller (ReaderView) can immediately postMessage the highlight to the iframe without waiting for the async event → refresh cycle. The subsequent event-triggered refresh will reconcile state.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors in useAnnotations.ts

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useAnnotations.ts
git commit -m "refactor: useAnnotations subscribes to data events, removes manual state updates"
```

---

### Task 9: Rewrite `useSync` hook to use events

**Files:**
- Modify: `src/hooks/useSync.ts`

- [ ] **Step 1: Rewrite `useSync.ts`**

Replace old event names with new constants. Add `data:config-changed` listener for encryption status.

```typescript
import { useState, useEffect, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import * as cmd from "@/lib/commands";
import toast from "react-hot-toast";
import { DataEvents, SyncEvents, type ConfigChangedPayload } from "@/lib/events";

export type SyncStatusType = "idle" | "syncing" | "success" | "error";

export function useSync() {
  const [status, setStatus] = useState<SyncStatusType>("idle");
  const [lastSyncAt, setLastSyncAt] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [intervalMinutes, setIntervalMinutes] = useState(0);
  const syncingRef = useRef(false);
  const [encryptionEnabled, setEncryptionEnabled] = useState(false);
  const [encryptionUnlocked, setEncryptionUnlocked] = useState(false);

  // Load config on mount
  useEffect(() => {
    cmd.getSyncConfig().then((c) => {
      if (c.last_sync_at) setLastSyncAt(c.last_sync_at);
      setIntervalMinutes(c.sync_interval ?? 5);
    }).catch(() => {});
    cmd.getEncryptionStatus().then((es) => {
      setEncryptionEnabled(es.enabled);
      setEncryptionUnlocked(es.unlocked);
    }).catch(() => {});
  }, []);

  // Listen for sync and config events
  useEffect(() => {
    const u1 = listen(DataEvents.SYNC_COMPLETED, () => {
      setStatus("success");
      setLastSyncAt(new Date().toISOString());
      setError("");
    });
    const u2 = listen(SyncEvents.STARTED, () => {
      setStatus("syncing");
    });
    const u3 = listen<{ message: string }>(SyncEvents.FAILED, (event) => {
      setStatus("error");
      setError(event.payload.message);
    });
    const u4 = listen<ConfigChangedPayload>(DataEvents.CONFIG_CHANGED, (event) => {
      if (event.payload.scope === "encryption") {
        cmd.getEncryptionStatus().then((es) => {
          setEncryptionEnabled(es.enabled);
          setEncryptionUnlocked(es.unlocked);
        }).catch(() => {});
      }
    });

    return () => {
      u1.then((f) => f());
      u2.then((f) => f());
      u3.then((f) => f());
      u4.then((f) => f());
    };
  }, []);

  const doSync = useCallback(async () => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    // Note: sync-started event is now emitted by the backend cmd_sync_now
    try {
      await cmd.syncNow();
      // sync-completed and sync-failed events are emitted by backend
    } catch (err: unknown) {
      // Backend already emits sync-failed, but if the invoke itself fails
      // (e.g. network error before reaching the command), handle here
      const msg = err && typeof err === "object" && "message" in err
        ? String((err as { message: string }).message)
        : String(err);
      toast.error(`同步失败: ${msg}`);
    } finally {
      syncingRef.current = false;
    }
  }, []);

  // Auto-sync timer
  useEffect(() => {
    if (intervalMinutes <= 0) return;
    const ms = intervalMinutes * 60 * 1000;
    const timer = setInterval(() => {
      doSync();
    }, ms);
    return () => clearInterval(timer);
  }, [intervalMinutes, doSync]);

  const refreshEncryptionStatus = useCallback(() => {
    cmd.getEncryptionStatus().then((es) => {
      setEncryptionEnabled(es.enabled);
      setEncryptionUnlocked(es.unlocked);
    }).catch(() => {});
  }, []);

  return { status, lastSyncAt, error, intervalMinutes, setIntervalMinutes, triggerSync: doSync, encryptionEnabled, encryptionUnlocked, refreshEncryptionStatus };
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors in useSync.ts

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useSync.ts
git commit -m "refactor: useSync subscribes to new event constants, adds config-changed listener"
```

---

### Task 10: Update `Layout.tsx` — remove all old refresh plumbing

**Files:**
- Modify: `src/components/Layout.tsx`

- [ ] **Step 1: Remove old refresh state and refs from Layout**

Remove these from the component body:
- `const [resourceRefreshKey, setResourceRefreshKey] = useState(0);` (line 29)
- `const folderTreeRefreshRef = useRef<(() => void) | null>(null);` (line 39)
- The `useEffect` listening to `"sync-completed"` (lines 42-48) — hooks now handle this
- `import { listen } from "@tauri-apps/api/event";` (line 3) — no longer needed in Layout

Update `ResourceList` usage — remove `refreshKey` and `onDataChanged` props:

```typescript
<ResourceList
  folderId={selectedFolderId}
  selectedResourceIds={selectedResourceIds}
  selectedTagIds={selectedTagIds}
  sortBy={sortBy}
  sortOrder={sortOrder}
  onSelectResource={handleResourceSelect}
  onOpen={(resource) => onOpenResource(resource)}
  onSortByChange={setSortBy}
  onSortOrderChange={setSortOrder}
/>
```

Update `FolderTree` usage — remove `onRefreshRef` prop:

```typescript
<FolderTree
  selectedFolderId={selectedFolderId}
  onSelectFolder={setSelectedFolderId}
/>
```

In `handleDragEnd` for resource move (lines 117-131), remove `setResourceRefreshKey` and `folderTreeRefreshRef` calls — events handle refresh:

```typescript
if (activeData.type === "resource") {
  const targetFolderId = resolveTargetFolderId();
  if (!targetFolderId) return;
  try {
    const idsToMove = selectedResourceIds.has(String(active.id))
      ? Array.from(selectedResourceIds)
      : [String(active.id)];
    for (const id of idsToMove) {
      await cmd.moveResource(id, targetFolderId);
    }
    setSelectedResourceIds(new Set());
    setSelectedResource(null);
  } catch (err) {
    console.error("Failed to move resource:", err);
    toast.error("移动资料失败");
  }
  return;
}
```

In `handleDragEnd` for folder move (lines 136-152), remove `folderTreeRefreshRef.current?.()`:

```typescript
if (activeData.type === "folder" && active.id !== over.id) {
  const targetFolderId = resolveTargetFolderId();
  if (!targetFolderId || String(active.id) === targetFolderId) return;
  try {
    await cmd.moveFolder(String(active.id), targetFolderId);
  } catch (err) {
    console.error("Failed to move folder:", err);
    const msg = String(err);
    if (msg.includes("own subtree")) {
      toast.error("不能将文件夹移入自身的子文件夹中");
    } else {
      toast.error("移动文件夹失败");
    }
  }
  return;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/components/Layout.tsx
git commit -m "refactor: remove refresh plumbing from Layout, events handle all data refresh"
```

---

### Task 11: Update `ResourceList.tsx` — remove old refresh props

**Files:**
- Modify: `src/components/Sidebar/ResourceList.tsx`

- [ ] **Step 1: Simplify `ResourceListProps` and remove old refresh logic**

Update the interface:

```typescript
interface ResourceListProps {
  folderId: string | null;
  selectedResourceIds: Set<string>;
  selectedTagIds: Set<string>;
  sortBy: "created_at" | "annotated_at";
  sortOrder: "asc" | "desc";
  onSelectResource: (resource: Resource, resources: Resource[], event: { metaKey: boolean; shiftKey: boolean }) => void;
  onOpen: (resource: Resource) => void;
  onSortByChange: (sortBy: "created_at" | "annotated_at") => void;
  onSortOrderChange: (sortOrder: "asc" | "desc") => void;
}
```

Remove from the component:
- `refreshKey` and `onDataChanged` from the destructured props
- The `useEffect` that refreshes on `refreshKey` change (lines 73-77)
- `onDataChanged?.()` calls from `handleDelete`, `handleMove`, `onTagsChanged`, and `onSave` callbacks

In `handleDelete` (simplified):
```typescript
const handleDelete = useCallback(async () => {
  setDeleteConfirm(false);
  setContextMenu(null);
  try {
    for (const id of contextResourceIds) {
      await cmd.deleteResource(id);
    }
  } catch (err: unknown) {
    toast.error(`删除失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}, [contextResourceIds]);
```

In `handleMove` (simplified):
```typescript
const handleMove = useCallback(async (targetFolderId: string) => {
  setContextMenu(null);
  try {
    for (const id of contextResourceIds) {
      await cmd.moveResource(id, targetFolderId);
    }
  } catch (err: unknown) {
    toast.error(`移动失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}, [contextResourceIds]);
```

Update `ResourceContextMenu` `onTagsChanged` callback — remove `refresh()` and `onDataChanged`:
```typescript
onTagsChanged={() => {}}
```

Actually, since the backend now emits `data:tag-changed` on tag add/remove, and `useResources` listens to it, we can simply remove the callback entirely or pass a no-op. Better: remove `onTagsChanged` prop from `ResourceContextMenu` if it's no longer needed.

Update `ResourceEditDialog` `onSave` — remove `refresh()` and `onDataChanged`:
```typescript
onSave={() => {}}
```

Same as above — backend `cmd_update_resource` emits `data:resource-changed`, `useResources` will refresh. Remove `onSave` prop if possible, or leave as no-op.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: may have errors in ResourceContextMenu/ResourceEditDialog if prop types changed — fix in next steps.

- [ ] **Step 3: Clean up `ResourceContextMenu` and `ResourceEditDialog` callbacks if needed**

Check if `onTagsChanged` and `onSave` props can be removed from those components. If they only exist for the refresh callback, remove the prop entirely. If they serve other purposes (like closing a dialog), keep the relevant logic.

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/components/Sidebar/ResourceList.tsx src/components/Sidebar/ResourceContextMenu.tsx src/components/Sidebar/ResourceEditDialog.tsx
git commit -m "refactor: remove refresh props from ResourceList, events handle data refresh"
```

---

### Task 12: Update `PreviewPanel.tsx` — subscribe to events for resource meta refresh

**Files:**
- Modify: `src/components/PreviewPanel.tsx`

- [ ] **Step 1: Replace `refreshKey` prop with event subscriptions**

Remove `refreshKey` prop. Add event listeners for `data:resource-changed` and `data:tag-changed`.

```typescript
import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import type { Resource, Tag } from "@/types";
import * as cmd from "@/lib/commands";
import { useAnnotations } from "@/hooks/useAnnotations";
import { DataEvents } from "@/lib/events";
import { PreviewPanelSkeleton } from "@/components/Skeleton";
import styles from "./PreviewPanel.module.css";

interface PreviewPanelProps {
  resource: Resource;
  onOpenInReader: (highlightId?: string) => void;
}

export function PreviewPanel({ resource: initialResource, onOpenInReader }: PreviewPanelProps) {
  const [resource, setResource] = useState<Resource>(initialResource);
  const { highlights, getCommentsForHighlight, resourceNotes, loading } = useAnnotations(resource.id);
  const [expandedHighlightId, setExpandedHighlightId] = useState<string | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);

  // Sync initial resource prop
  useEffect(() => {
    setResource(initialResource);
  }, [initialResource]);

  // Load tags
  useEffect(() => {
    cmd.getTagsForResource(resource.id).then(setTags).catch(() => setTags([]));
  }, [resource.id]);

  // Auto-refresh resource meta and tags on data events
  useEffect(() => {
    const u1 = listen(DataEvents.RESOURCE_CHANGED, () => {
      cmd.getResource(resource.id).then(setResource).catch(() => {});
      cmd.getTagsForResource(resource.id).then(setTags).catch(() => setTags([]));
    });
    const u2 = listen(DataEvents.TAG_CHANGED, () => {
      cmd.getTagsForResource(resource.id).then(setTags).catch(() => setTags([]));
    });
    return () => {
      u1.then((f) => f());
      u2.then((f) => f());
    };
  }, [resource.id]);

  // ... rest of the render (unchanged from current)
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/components/PreviewPanel.tsx
git commit -m "refactor: PreviewPanel subscribes to data events instead of refreshKey prop"
```

---

### Task 13: Full compilation check and manual testing prep

**Files:** None (verification only)

- [ ] **Step 1: Full TypeScript compilation check**

Run: `npx tsc --noEmit`
Expected: zero errors

- [ ] **Step 2: Full Rust compilation check**

Run: `cd src-tauri && cargo check && cargo clippy`
Expected: zero errors, no relevant warnings

- [ ] **Step 3: Run existing tests**

Run: `cd src-tauri && cargo test`
Run: `npx vitest run` (if frontend tests exist)
Expected: all pass

- [ ] **Step 4: Grep audit — verify all emit points use constants**

Run: `grep -rn "app.emit\|app_handle.emit" src-tauri/src/ | grep -v "events::"`
Expected: zero matches (all emits use `events::` constants)

Run: `grep -rn 'listen(' src/ | grep -v "DataEvents\|SyncEvents\|@tauri-apps"`
Expected: zero matches from hooks/components (all listeners use event constants)

- [ ] **Step 5: Grep audit — verify old mechanisms removed**

Run: `grep -rn "resource-saved\|shibei:annotations-changed\|refreshKey\|onDataChanged\|folderTreeRefreshRef\|refreshAll\|notifyChange" src/`
Expected: zero matches

- [ ] **Step 6: Commit (if any fixups needed)**

```bash
git add -A
git commit -m "chore: cleanup and verification of unified data events migration"
```

---

### Task 14: Update CLAUDE.md architecture constraints

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add data events documentation to CLAUDE.md**

In the "架构约束" section, add a new constraint:

```markdown
- **数据变更事件**：所有 mutation Tauri command 在 DB 写入成功后 emit 领域事件（`data:resource-changed` 等 6 个），前端 hook 自行订阅刷新。事件常量定义在 `src-tauri/src/events.rs`（Rust）和 `src/lib/events.ts`（TS）。新增 mutation command 必须 emit 对应事件；新增 hook 需检查订阅矩阵（见 `docs/superpowers/specs/2026-04-03-unified-data-events-design.md`）。不使用 callback prop、refreshKey、ref 等手动刷新机制。
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add data events architecture constraint to CLAUDE.md"
```
