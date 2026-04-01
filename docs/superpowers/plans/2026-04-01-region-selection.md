# Region Selection Save Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "region selection save" to the Chrome extension, allowing users to select a DOM element on a page and save only that subtree as a clipped snapshot.

**Architecture:** The extension popup gets a second "选区保存" button. Clicking it stores save parameters in `chrome.storage.session`, injects a region-selector script into the page, and closes the popup. The selector script provides hover-to-highlight interaction, lets the user lock a DOM element, then runs SingleFile on the full page and clips the HTML to the selected subtree before POSTing. The Rust backend adds a nullable `selection_meta` column to track clipped resources.

**Tech Stack:** Chrome Extension MV3, SingleFile, vanilla JS (content script), Rust/axum/rusqlite (backend), React/TypeScript (frontend)

---

## File Structure

| Action | Path | Responsibility |
|--------|------|---------------|
| Create | `src-tauri/migrations/002_add_selection_meta.sql` | DB migration: add `selection_meta` column |
| Modify | `src-tauri/src/db/migration.rs` | Register migration 002 |
| Modify | `src-tauri/src/db/resources.rs` | Add `selection_meta` field to structs and SQL |
| Modify | `src-tauri/src/server/mod.rs` | Add `selection_meta` to `SaveRequest` and `handle_save` |
| Create | `extension/src/content/region-selector.js` | Selection UI, HTML clipping, save orchestration |
| Modify | `extension/src/popup/popup.html` | Add "选区保存" button |
| Modify | `extension/src/popup/popup.js` | Wire selection save button |
| Modify | `extension/src/popup/popup.css` | Button group styling |
| Modify | `src/types/index.ts` | Add `selection_meta` to Resource interface |
| Modify | `src/components/Sidebar/ResourceList.tsx` | Show clip indicator for selection resources |
| Modify | `src/components/Sidebar/ResourceList.module.css` | Clip indicator styling |

---

### Task 1: Database Migration — Add `selection_meta` Column

**Files:**
- Create: `src-tauri/migrations/002_add_selection_meta.sql`
- Modify: `src-tauri/src/db/migration.rs`

- [ ] **Step 1: Create migration SQL file**

Create `src-tauri/migrations/002_add_selection_meta.sql`:

```sql
ALTER TABLE resources ADD COLUMN selection_meta TEXT;
```

- [ ] **Step 2: Register migration in migration.rs**

In `src-tauri/src/db/migration.rs`, change the `MIGRATIONS` array from:

```rust
const MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    sql: include_str!("../../migrations/001_init.sql"),
}];
```

to:

```rust
const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        sql: include_str!("../../migrations/001_init.sql"),
    },
    Migration {
        version: 2,
        sql: include_str!("../../migrations/002_add_selection_meta.sql"),
    },
];
```

- [ ] **Step 3: Update migration tests**

In `src-tauri/src/db/migration.rs`, update `test_migration_is_idempotent` — change the version assertion from `1` to `2`:

```rust
#[test]
fn test_migration_is_idempotent() {
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
    run_migrations(&mut conn).unwrap();
    run_migrations(&mut conn).unwrap();

    let version: u32 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, 2);
}
```

Also update `test_migration_sets_version` — change the `after` assertion from `1` to `2`:

```rust
#[test]
fn test_migration_sets_version() {
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();

    let before: u32 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(before, 0);

    run_migrations(&mut conn).unwrap();

    let after: u32 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(after, 2);
}
```

Add a new test to verify the column exists:

```rust
#[test]
fn test_migration_002_adds_selection_meta() {
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
    run_migrations(&mut conn).unwrap();

    // Verify column exists by inserting with it
    conn.execute(
        "INSERT INTO folders (id, name, parent_id, sort_order, created_at, updated_at)
         VALUES ('f1', 'test', '__root__', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        [],
    ).unwrap();
    conn.execute(
        "INSERT INTO resources (id, title, url, folder_id, resource_type, file_path, created_at, captured_at, selection_meta)
         VALUES ('r1', 'test', 'http://x', 'f1', 'html', 'x', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '{\"selector\":\"article\"}')",
        [],
    ).unwrap();

    let meta: Option<String> = conn
        .query_row("SELECT selection_meta FROM resources WHERE id = 'r1'", [], |row| row.get(0))
        .unwrap();
    assert_eq!(meta, Some("{\"selector\":\"article\"}".to_string()));
}
```

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test db::migration`
Expected: All migration tests pass, including the new one.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/migrations/002_add_selection_meta.sql src-tauri/src/db/migration.rs
git commit -m "feat: add migration 002 for selection_meta column"
```

---

### Task 2: Add `selection_meta` to Resource Struct and CRUD

**Files:**
- Modify: `src-tauri/src/db/resources.rs`

- [ ] **Step 1: Write failing test for selection_meta round-trip**

Add to the `tests` module in `src-tauri/src/db/resources.rs`:

```rust
#[test]
fn test_create_resource_with_selection_meta() {
    let conn = test_db();
    let folder = folders::create_folder(&conn, "docs", "__root__").unwrap();
    let resource = create_resource(
        &conn,
        CreateResourceInput {
            id: None,
            title: "Clipped Article".to_string(),
            url: "https://example.com/article".to_string(),
            domain: Some("example.com".to_string()),
            author: None,
            description: None,
            folder_id: folder.id,
            resource_type: "html".to_string(),
            file_path: "storage/test/snapshot.html".to_string(),
            captured_at: "2026-01-01T00:00:00Z".to_string(),
            selection_meta: Some("{\"selector\":\"article.post\",\"tag_name\":\"article\",\"text_preview\":\"Hello world\"}".to_string()),
        },
    )
    .unwrap();

    let fetched = get_resource(&conn, &resource.id).unwrap();
    assert_eq!(
        fetched.selection_meta,
        Some("{\"selector\":\"article.post\",\"tag_name\":\"article\",\"text_preview\":\"Hello world\"}".to_string())
    );
}

#[test]
fn test_create_resource_without_selection_meta() {
    let conn = test_db();
    let folder = folders::create_folder(&conn, "docs", "__root__").unwrap();
    let resource = create_resource(
        &conn,
        CreateResourceInput {
            id: None,
            title: "Full Page".to_string(),
            url: "https://example.com/page".to_string(),
            domain: Some("example.com".to_string()),
            author: None,
            description: None,
            folder_id: folder.id,
            resource_type: "html".to_string(),
            file_path: "storage/test/snapshot.html".to_string(),
            captured_at: "2026-01-01T00:00:00Z".to_string(),
            selection_meta: None,
        },
    )
    .unwrap();

    let fetched = get_resource(&conn, &resource.id).unwrap();
    assert_eq!(fetched.selection_meta, None);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test db::resources::tests::test_create_resource_with_selection_meta`
Expected: Compile error — `selection_meta` not a field of `CreateResourceInput`.

- [ ] **Step 3: Add `selection_meta` to structs**

In `src-tauri/src/db/resources.rs`, add the field to both structs:

`Resource` struct — add after `captured_at`:

```rust
pub selection_meta: Option<String>,
```

`CreateResourceInput` struct — add after `captured_at`:

```rust
pub selection_meta: Option<String>,
```

- [ ] **Step 4: Update `create_resource` function**

Change the INSERT SQL and params in `create_resource`:

```rust
pub fn create_resource(
    conn: &Connection,
    input: CreateResourceInput,
) -> Result<Resource, DbError> {
    let id = input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = now_iso8601();

    conn.execute(
        "INSERT INTO resources (id, title, url, domain, author, description, folder_id, resource_type, file_path, created_at, captured_at, selection_meta)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            id,
            input.title,
            input.url,
            input.domain,
            input.author,
            input.description,
            input.folder_id,
            input.resource_type,
            input.file_path,
            now,
            input.captured_at,
            input.selection_meta,
        ],
    )?;

    Ok(Resource {
        id,
        title: input.title,
        url: input.url,
        domain: input.domain,
        author: input.author,
        description: input.description,
        folder_id: input.folder_id,
        resource_type: input.resource_type,
        file_path: input.file_path,
        created_at: now,
        captured_at: input.captured_at,
        selection_meta: input.selection_meta,
    })
}
```

- [ ] **Step 5: Update all SELECT queries**

Every function that reads `Resource` rows needs `selection_meta` added. The SELECT column list changes from:

```
id, title, url, domain, author, description, folder_id, resource_type, file_path, created_at, captured_at
```

to:

```
id, title, url, domain, author, description, folder_id, resource_type, file_path, created_at, captured_at, selection_meta
```

And each `|row|` closure adds `selection_meta: row.get(11)?` after `captured_at: row.get(10)?`.

This applies to these functions:
- `get_resource` (line 74)
- `list_resources_by_folder` (line 101)
- `find_by_url` (line 172)

For `get_resource`:

```rust
pub fn get_resource(conn: &Connection, id: &str) -> Result<Resource, DbError> {
    conn.query_row(
        "SELECT id, title, url, domain, author, description, folder_id, resource_type, file_path, created_at, captured_at, selection_meta
         FROM resources WHERE id = ?1",
        params![id],
        |row| {
            Ok(Resource {
                id: row.get(0)?,
                title: row.get(1)?,
                url: row.get(2)?,
                domain: row.get(3)?,
                author: row.get(4)?,
                description: row.get(5)?,
                folder_id: row.get(6)?,
                resource_type: row.get(7)?,
                file_path: row.get(8)?,
                created_at: row.get(9)?,
                captured_at: row.get(10)?,
                selection_meta: row.get(11)?,
            })
        },
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => DbError::NotFound(format!("resource {}", id)),
        other => DbError::Sqlite(other),
    })
}
```

For `list_resources_by_folder`:

```rust
pub fn list_resources_by_folder(
    conn: &Connection,
    folder_id: &str,
) -> Result<Vec<Resource>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT id, title, url, domain, author, description, folder_id, resource_type, file_path, created_at, captured_at, selection_meta
         FROM resources WHERE folder_id = ?1
         ORDER BY created_at DESC",
    )?;
    let resources = stmt
        .query_map(params![folder_id], |row| {
            Ok(Resource {
                id: row.get(0)?,
                title: row.get(1)?,
                url: row.get(2)?,
                domain: row.get(3)?,
                author: row.get(4)?,
                description: row.get(5)?,
                folder_id: row.get(6)?,
                resource_type: row.get(7)?,
                file_path: row.get(8)?,
                created_at: row.get(9)?,
                captured_at: row.get(10)?,
                selection_meta: row.get(11)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(resources)
}
```

For `find_by_url`:

```rust
pub fn find_by_url(conn: &Connection, url: &str) -> Result<Vec<Resource>, DbError> {
    let normalized = normalize_url(url);

    let mut stmt = conn.prepare(
        "SELECT id, title, url, domain, author, description, folder_id, resource_type, file_path, created_at, captured_at, selection_meta
         FROM resources",
    )?;
    let resources = stmt
        .query_map([], |row| {
            Ok(Resource {
                id: row.get(0)?,
                title: row.get(1)?,
                url: row.get(2)?,
                domain: row.get(3)?,
                author: row.get(4)?,
                description: row.get(5)?,
                folder_id: row.get(6)?,
                resource_type: row.get(7)?,
                file_path: row.get(8)?,
                created_at: row.get(9)?,
                captured_at: row.get(10)?,
                selection_meta: row.get(11)?,
            })
        })?
        .filter_map(|r| r.ok())
        .filter(|r| normalize_url(&r.url) == normalized)
        .collect();
    Ok(resources)
}
```

- [ ] **Step 6: Fix existing test helper `create_test_resource`**

Update the existing `create_test_resource` helper to include the new field:

```rust
fn create_test_resource(conn: &Connection, folder_id: &str) -> Resource {
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
            file_path: "storage/test/snapshot.mhtml".to_string(),
            captured_at: "2026-01-01T00:00:00Z".to_string(),
            selection_meta: None,
        },
    )
    .unwrap()
}
```

- [ ] **Step 7: Run all resource tests**

Run: `cd src-tauri && cargo test db::resources`
Expected: All tests pass including the two new ones.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/db/resources.rs
git commit -m "feat: add selection_meta field to Resource struct and CRUD"
```

---

### Task 3: Update HTTP Server to Accept `selection_meta`

**Files:**
- Modify: `src-tauri/src/server/mod.rs`

- [ ] **Step 1: Add `selection_meta` to `SaveRequest`**

In `src-tauri/src/server/mod.rs`, add to the `SaveRequest` struct after `captured_at`:

```rust
#[derive(Deserialize)]
struct SaveRequest {
    title: String,
    url: String,
    domain: Option<String>,
    author: Option<String>,
    description: Option<String>,
    content: String,
    content_type: String,
    folder_id: String,
    tags: Vec<String>,
    captured_at: String,
    selection_meta: Option<String>,
}
```

- [ ] **Step 2: Pass `selection_meta` to `create_resource` in `handle_save`**

In the `handle_save` function, update the `CreateResourceInput` construction (around line 210) to include `selection_meta`:

```rust
let resource = resources::create_resource(
    &conn,
    resources::CreateResourceInput {
        id: Some(resource_id.clone()),
        title: payload.title,
        url: payload.url,
        domain: payload.domain,
        author: payload.author,
        description: payload.description,
        folder_id: payload.folder_id,
        resource_type: payload.content_type,
        file_path: rel_path.to_string_lossy().to_string(),
        captured_at: payload.captured_at,
        selection_meta: payload.selection_meta,
    },
)
```

- [ ] **Step 3: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: Compiles without errors.

- [ ] **Step 4: Run all backend tests**

Run: `cd src-tauri && cargo test`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/server/mod.rs
git commit -m "feat: accept selection_meta in /api/save endpoint"
```

---

### Task 4: Update Frontend Types and Resource List UI

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/components/Sidebar/ResourceList.tsx`
- Modify: `src/components/Sidebar/ResourceList.module.css`

- [ ] **Step 1: Add `selection_meta` to Resource interface**

In `src/types/index.ts`, add after `captured_at`:

```typescript
export interface Resource {
  id: string;
  title: string;
  url: string;
  domain: string | null;
  author: string | null;
  description: string | null;
  folder_id: string;
  resource_type: string;
  file_path: string;
  created_at: string;
  captured_at: string;
  selection_meta: string | null;
}
```

- [ ] **Step 2: Add clip indicator to ResourceList**

In `src/components/Sidebar/ResourceList.tsx`, add a clip indicator in the item title line. Change the `itemTitle` div (line 42) from:

```tsx
<div className={styles.itemTitle}>{resource.title}</div>
```

to:

```tsx
<div className={styles.itemTitle}>
  {resource.selection_meta && <span className={styles.clipBadge} title="选区保存">&#9986;</span>}
  {resource.title}
</div>
```

`&#9986;` is the scissors character (✂) — a simple visual indicator for clipped resources.

- [ ] **Step 3: Add clip badge styling**

In `src/components/Sidebar/ResourceList.module.css`, add at the end:

```css
.clipBadge {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  margin-right: 4px;
  flex-shrink: 0;
}
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
git add src/types/index.ts src/components/Sidebar/ResourceList.tsx src/components/Sidebar/ResourceList.module.css
git commit -m "feat: show clip indicator for region-selected resources"
```

---

### Task 5: Extension Popup — Add "选区保存" Button

**Files:**
- Modify: `extension/src/popup/popup.html`
- Modify: `extension/src/popup/popup.css`
- Modify: `extension/src/popup/popup.js`

- [ ] **Step 1: Update popup HTML**

In `extension/src/popup/popup.html`, replace the single save button (line 33):

```html
<button id="save-btn" class="save-btn">保存到拾贝</button>
```

with a button group:

```html
<div class="btn-group">
  <button id="save-btn" class="save-btn">保存整页</button>
  <button id="select-save-btn" class="save-btn save-btn-outline">选区保存</button>
</div>
```

- [ ] **Step 2: Add button group styles**

In `extension/src/popup/popup.css`, add after the existing `.save-btn:disabled` block (line 117):

```css
.btn-group {
  display: flex;
  gap: 8px;
}

.btn-group .save-btn {
  flex: 1;
}

.save-btn-outline {
  background: white !important;
  color: #3b82f6 !important;
  border: 1.5px solid #3b82f6 !important;
}

.save-btn-outline:hover {
  background: #eff6ff !important;
}

.save-btn-outline:disabled {
  background: white !important;
  color: #9ca3af !important;
  border-color: #9ca3af !important;
}
```

- [ ] **Step 3: Wire the "选区保存" button in popup.js**

In `extension/src/popup/popup.js`, add after line 11 (the existing element declarations):

```javascript
const selectSaveBtn = document.getElementById("select-save-btn");
```

Add the click handler before the final `init()` call (before line 256):

```javascript
selectSaveBtn.addEventListener("click", async () => {
  console.log("[shibei] select-save clicked");

  if (!pageInfo?.tabId) {
    showMessage("无法获取当前页面信息", "error");
    return;
  }

  const folderId = folderSelect.value;
  if (!folderId) {
    showMessage("请选择文件夹", "error");
    return;
  }

  const tags = tagsInput.value
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  // Store save parameters for the region selector to use later
  await chrome.storage.session.set({
    shibeiSelectSave: {
      tabId: pageInfo.tabId,
      title: pageInfo.title,
      url: pageInfo.url,
      domain: pageInfo.domain,
      author: pageInfo.author || null,
      description: pageInfo.description || null,
      folderId,
      tags,
    },
  });

  // Inject SingleFile bundle first (pre-load, don't execute capture)
  try {
    await chrome.scripting.executeScript({
      target: { tabId: pageInfo.tabId },
      files: ["lib/single-file-bundle.js"],
      world: "MAIN",
    });
  } catch (e) {
    console.log("[shibei] SingleFile pre-inject failed (may already be injected):", e.message);
  }

  // Inject the region selector script
  try {
    await chrome.scripting.executeScript({
      target: { tabId: pageInfo.tabId },
      files: ["src/content/region-selector.js"],
      world: "MAIN",
    });
  } catch (e) {
    showMessage("注入选区脚本失败: " + e.message, "error");
    return;
  }

  // Close popup — user interacts with the page now
  window.close();
});
```

- [ ] **Step 4: Disable select-save button for restricted pages**

In `popup.js`, inside the restricted page check block (around line 54), add after `saveBtn.disabled = true;`:

```javascript
selectSaveBtn.disabled = true;
```

- [ ] **Step 5: Commit**

```bash
git add extension/src/popup/popup.html extension/src/popup/popup.css extension/src/popup/popup.js
git commit -m "feat: add region select save button to extension popup"
```

---

### Task 6: Region Selector Script — Core Interaction

**Files:**
- Create: `extension/src/content/region-selector.js`

This is the largest task. The script handles: hover highlighting, parent/child navigation, click-to-lock, confirm/reselect UI, SingleFile capture, HTML clipping, and POST to server.

- [ ] **Step 1: Create region-selector.js with the full implementation**

Create `extension/src/content/region-selector.js`:

```javascript
// Region Selector for Shibei — injected into MAIN world
// Allows user to hover-select a DOM element, then saves the clipped subtree via SingleFile.

(function () {
  "use strict";

  // Guard against double-injection
  if (window.__shibeiRegionSelector) return;
  window.__shibeiRegionSelector = true;

  const API_BASE = "http://127.0.0.1:21519";
  const ATTR = "data-shibei-selector";
  const Z = 2147483647;

  // ── State ──
  let currentElement = null; // The element under the cursor (or navigated to)
  let lockedElement = null; // The element the user clicked to lock
  let ancestorChain = []; // For scroll/keyboard navigation: [child, ..., parent]
  let ancestorIndex = 0; // Current position in ancestorChain

  // ── UI Elements ──
  let overlay = null; // Highlight overlay
  let topBar = null; // Instruction bar
  let confirmBar = null; // Confirm/reselect bar
  let toast = null; // Status toast

  // ── Filtered tags ──
  const IGNORED_TAGS = new Set([
    "HTML", "BODY", "HEAD", "SCRIPT", "STYLE", "LINK", "META",
    "NOSCRIPT", "BR", "HR",
  ]);

  const MIN_SIZE = 20;

  // ═══════════════════════════════════════════
  // UI Creation
  // ═══════════════════════════════════════════

  function createOverlay() {
    const el = document.createElement("div");
    el.setAttribute(ATTR, "overlay");
    Object.assign(el.style, {
      position: "absolute",
      pointerEvents: "none",
      border: "2px solid #3b82f6",
      backgroundColor: "rgba(59, 130, 246, 0.08)",
      borderRadius: "2px",
      zIndex: Z,
      display: "none",
      transition: "top 0.05s, left 0.05s, width 0.05s, height 0.05s",
    });
    document.body.appendChild(el);
    return el;
  }

  function createTopBar() {
    const el = document.createElement("div");
    el.setAttribute(ATTR, "topbar");
    Object.assign(el.style, {
      position: "fixed",
      top: "0",
      left: "0",
      right: "0",
      padding: "8px 16px",
      backgroundColor: "#1e40af",
      color: "white",
      fontSize: "13px",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      textAlign: "center",
      zIndex: Z,
      boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
    });
    el.textContent = "选择要保存的区域 — 滚轮或方向键调整层级 — ESC 退出";
    document.body.appendChild(el);
    return el;
  }

  function createConfirmBar() {
    const el = document.createElement("div");
    el.setAttribute(ATTR, "confirmbar");
    Object.assign(el.style, {
      position: "fixed",
      bottom: "16px",
      left: "50%",
      transform: "translateX(-50%)",
      display: "none",
      gap: "12px",
      padding: "10px 20px",
      backgroundColor: "white",
      borderRadius: "8px",
      boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      fontSize: "14px",
      zIndex: Z,
    });

    const confirmBtn = document.createElement("button");
    confirmBtn.textContent = "\u2713 确认保存";
    confirmBtn.setAttribute(ATTR, "btn");
    Object.assign(confirmBtn.style, {
      padding: "6px 16px",
      backgroundColor: "#3b82f6",
      color: "white",
      border: "none",
      borderRadius: "4px",
      cursor: "pointer",
      fontSize: "14px",
      fontWeight: "500",
    });
    confirmBtn.addEventListener("click", onConfirm);

    const reselectBtn = document.createElement("button");
    reselectBtn.textContent = "\u2717 重新选择";
    reselectBtn.setAttribute(ATTR, "btn");
    Object.assign(reselectBtn.style, {
      padding: "6px 16px",
      backgroundColor: "#f3f4f6",
      color: "#374151",
      border: "1px solid #d1d5db",
      borderRadius: "4px",
      cursor: "pointer",
      fontSize: "14px",
    });
    reselectBtn.addEventListener("click", onReselect);

    el.appendChild(confirmBtn);
    el.appendChild(reselectBtn);
    document.body.appendChild(el);
    return el;
  }

  function createToast() {
    const el = document.createElement("div");
    el.setAttribute(ATTR, "toast");
    Object.assign(el.style, {
      position: "fixed",
      top: "48px",
      left: "50%",
      transform: "translateX(-50%)",
      padding: "10px 24px",
      backgroundColor: "#1e40af",
      color: "white",
      borderRadius: "8px",
      fontSize: "14px",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      zIndex: Z,
      display: "none",
      boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
    });
    document.body.appendChild(el);
    return el;
  }

  function showToast(text, color) {
    toast.textContent = text;
    toast.style.backgroundColor = color || "#1e40af";
    toast.style.display = "block";
  }

  function hideToast() {
    toast.style.display = "none";
  }

  // ═══════════════════════════════════════════
  // Element Filtering & Selection
  // ═══════════════════════════════════════════

  function isShibeiElement(el) {
    return el && el.hasAttribute && el.hasAttribute(ATTR);
  }

  function isValidTarget(el) {
    if (!el || !el.tagName) return false;
    if (IGNORED_TAGS.has(el.tagName)) return false;
    if (isShibeiElement(el)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) return false;
    return true;
  }

  function findValidTarget(el) {
    while (el && !isValidTarget(el)) {
      el = el.parentElement;
    }
    return el || null;
  }

  function buildAncestorChain(el) {
    const chain = [];
    let cur = el;
    while (cur && cur.tagName !== "BODY" && cur.tagName !== "HTML") {
      if (isValidTarget(cur)) {
        chain.push(cur);
      }
      cur = cur.parentElement;
    }
    return chain; // [current, parent, grandparent, ...]
  }

  function positionOverlay(el) {
    if (!el) {
      overlay.style.display = "none";
      return;
    }
    const rect = el.getBoundingClientRect();
    overlay.style.display = "block";
    overlay.style.top = (rect.top + window.scrollY) + "px";
    overlay.style.left = (rect.left + window.scrollX) + "px";
    overlay.style.width = rect.width + "px";
    overlay.style.height = rect.height + "px";
  }

  // ═══════════════════════════════════════════
  // CSS Selector Generation
  // ═══════════════════════════════════════════

  function generateSelector(el) {
    // Try ID first
    if (el.id) {
      const sel = "#" + CSS.escape(el.id);
      if (document.querySelectorAll(sel).length === 1) return sel;
    }

    // Build path from element to a unique ancestor
    const parts = [];
    let cur = el;
    while (cur && cur.tagName !== "BODY" && cur.tagName !== "HTML") {
      let seg = cur.tagName.toLowerCase();

      if (cur.id) {
        seg = "#" + CSS.escape(cur.id);
        parts.unshift(seg);
        break;
      }

      // Add nth-of-type for uniqueness
      if (cur.parentElement) {
        const siblings = Array.from(cur.parentElement.children).filter(
          (s) => s.tagName === cur.tagName
        );
        if (siblings.length > 1) {
          const idx = siblings.indexOf(cur) + 1;
          seg += ":nth-of-type(" + idx + ")";
        }
      }

      // Add classes (first two, skip utility-style long class names)
      const classes = Array.from(cur.classList || [])
        .filter((c) => c.length < 30 && !c.includes(":"))
        .slice(0, 2);
      if (classes.length > 0) {
        seg += "." + classes.map((c) => CSS.escape(c)).join(".");
      }

      parts.unshift(seg);
      cur = cur.parentElement;
    }

    return parts.join(" > ");
  }

  // ═══════════════════════════════════════════
  // HTML Clipping
  // ═══════════════════════════════════════════

  function clipHtml(fullHtml, selector) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(fullHtml, "text/html");
    const target = doc.querySelector(selector);

    if (!target) {
      console.error("[shibei] selector not found in captured HTML:", selector);
      return null;
    }

    // Rebuild body with ancestor chain as style wrappers
    const newBody = doc.createElement("body");

    // Copy body attributes (class, id, style)
    const origBody = doc.body;
    if (origBody) {
      for (const attr of origBody.attributes) {
        newBody.setAttribute(attr.name, attr.value);
      }
    }

    // Build ancestor wrappers from target up to body
    const ancestors = [];
    let cur = target.parentElement;
    while (cur && cur.tagName !== "BODY" && cur.tagName !== "HTML") {
      ancestors.push(cur);
      cur = cur.parentElement;
    }
    ancestors.reverse(); // now [outermost, ..., direct parent]

    // Create nested wrappers
    let container = newBody;
    for (const anc of ancestors) {
      const wrapper = doc.createElement(anc.tagName.toLowerCase());
      for (const attr of anc.attributes) {
        wrapper.setAttribute(attr.name, attr.value);
      }
      container.appendChild(wrapper);
      container = wrapper;
    }

    // Append the target element into the innermost wrapper
    container.appendChild(target);

    // Replace body
    doc.body.replaceWith(newBody);

    // Serialize
    return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
  }

  // ═══════════════════════════════════════════
  // Save Flow
  // ═══════════════════════════════════════════

  async function doSave(element) {
    showToast("正在抓取页面...", "#1e40af");

    const selector = generateSelector(element);
    const textPreview = (element.textContent || "").trim().slice(0, 50);
    const tagName = element.tagName.toLowerCase();

    // Get save parameters from session storage
    const stored = await chrome.storage.session.get("shibeiSelectSave");
    const params = stored.shibeiSelectSave;
    if (!params) {
      showToast("保存参数丢失，请重新操作", "#dc2626");
      setTimeout(cleanup, 2000);
      return;
    }

    // Run SingleFile capture (bundle was pre-injected by popup)
    let fullHtml;
    try {
      if (typeof SingleFile === "undefined" || !SingleFile.getPageData) {
        throw new Error("SingleFile not available");
      }
      const pageData = await SingleFile.getPageData({
        removeHiddenElements: false,
        removeUnusedStyles: true,
        removeUnusedFonts: true,
        compressHTML: true,
        loadDeferredImages: true,
        loadDeferredImagesMaxIdleTime: 3000,
      });
      fullHtml = pageData.content;
    } catch (err) {
      showToast("页面抓取失败: " + err.message, "#dc2626");
      setTimeout(cleanup, 2000);
      return;
    }

    // Clip HTML to selected subtree
    showToast("正在裁剪选区...", "#1e40af");
    const clippedHtml = clipHtml(fullHtml, selector);

    if (!clippedHtml) {
      showToast("裁剪失败 — 未找到选区元素", "#dc2626");
      setTimeout(cleanup, 2000);
      return;
    }

    // Base64 encode
    showToast("正在保存...", "#1e40af");
    const encoder = new TextEncoder();
    const bytes = encoder.encode(clippedHtml);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64Content = btoa(binary);

    // Build payload
    const payload = {
      title: params.title,
      url: params.url,
      domain: params.domain,
      author: params.author,
      description: params.description,
      content: base64Content,
      content_type: "html",
      folder_id: params.folderId,
      tags: params.tags,
      captured_at: new Date().toISOString(),
      selection_meta: JSON.stringify({
        selector: selector,
        tag_name: tagName,
        text_preview: textPreview,
      }),
    };

    // POST to server
    try {
      const res = await fetch(API_BASE + "/api/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error("HTTP " + res.status + ": " + errText);
      }

      showToast("保存成功!", "#16a34a");
      // Clean up session storage
      await chrome.storage.session.remove("shibeiSelectSave");
      setTimeout(cleanup, 1500);
    } catch (err) {
      showToast("保存失败: " + err.message, "#dc2626");
      setTimeout(cleanup, 3000);
    }
  }

  // ═══════════════════════════════════════════
  // Event Handlers
  // ═══════════════════════════════════════════

  function onMouseMove(e) {
    if (lockedElement) return; // Locked — don't change highlight

    const el = findValidTarget(document.elementFromPoint(e.clientX, e.clientY));
    if (el === currentElement) return;

    currentElement = el;
    ancestorChain = el ? buildAncestorChain(el) : [];
    ancestorIndex = 0;
    positionOverlay(currentElement);
  }

  function onWheel(e) {
    if (lockedElement) return;
    if (ancestorChain.length === 0) return;

    e.preventDefault();
    e.stopPropagation();

    if (e.deltaY < 0) {
      // Scroll up → go to parent
      if (ancestorIndex < ancestorChain.length - 1) {
        ancestorIndex++;
      }
    } else {
      // Scroll down → go to child
      if (ancestorIndex > 0) {
        ancestorIndex--;
      }
    }

    currentElement = ancestorChain[ancestorIndex];
    positionOverlay(currentElement);
  }

  function onKeyDown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      cleanup();
      return;
    }

    if (lockedElement) return;

    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (ancestorChain.length > 0 && ancestorIndex < ancestorChain.length - 1) {
        ancestorIndex++;
        currentElement = ancestorChain[ancestorIndex];
        positionOverlay(currentElement);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (ancestorIndex > 0) {
        ancestorIndex--;
        currentElement = ancestorChain[ancestorIndex];
        positionOverlay(currentElement);
      }
    }
  }

  function onClick(e) {
    if (isShibeiElement(e.target)) return; // Don't capture clicks on our UI
    if (lockedElement) return; // Already locked

    e.preventDefault();
    e.stopPropagation();

    if (!currentElement) return;

    // Lock the selection
    lockedElement = currentElement;

    // Update overlay to solid selection style
    overlay.style.borderColor = "#2563eb";
    overlay.style.backgroundColor = "rgba(37, 99, 235, 0.12)";
    overlay.style.borderWidth = "3px";

    // Update top bar
    topBar.textContent = "已选择: <" + lockedElement.tagName.toLowerCase() + "> — 确认保存或重新选择";

    // Show confirm bar
    confirmBar.style.display = "flex";
  }

  function onConfirm() {
    confirmBar.style.display = "none";
    topBar.textContent = "正在保存...";
    doSave(lockedElement);
  }

  function onReselect() {
    lockedElement = null;
    confirmBar.style.display = "none";
    topBar.textContent = "选择要保存的区域 — 滚轮或方向键调整层级 — ESC 退出";

    // Reset overlay style
    overlay.style.borderColor = "#3b82f6";
    overlay.style.backgroundColor = "rgba(59, 130, 246, 0.08)";
    overlay.style.borderWidth = "2px";
  }

  // ═══════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════

  function init() {
    overlay = createOverlay();
    topBar = createTopBar();
    confirmBar = createConfirmBar();
    toast = createToast();

    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("wheel", onWheel, { capture: true, passive: false });
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("click", onClick, true);
  }

  function cleanup() {
    // Remove event listeners
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("wheel", onWheel, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("click", onClick, true);

    // Remove UI elements
    document.querySelectorAll("[" + ATTR + "]").forEach((el) => el.remove());

    // Reset state
    window.__shibeiRegionSelector = false;
    currentElement = null;
    lockedElement = null;
    ancestorChain = [];
    ancestorIndex = 0;
  }

  init();
})();
```

- [ ] **Step 2: Verify the script loads**

Manual test: load the extension in Chrome, open a webpage, click "选区保存", verify:
1. Top bar appears with instruction text
2. Moving mouse highlights DOM elements with blue overlay
3. Scrolling mouse wheel changes to parent/child elements
4. Arrow keys also work for parent/child navigation
5. Clicking locks the element and shows confirm/reselect bar
6. ESC cancels and cleans up all UI
7. "重新选择" unlocks and returns to hover mode
8. "确认保存" triggers save flow

- [ ] **Step 3: Commit**

```bash
git add extension/src/content/region-selector.js
git commit -m "feat: implement region selector with hover highlight, clipping, and save"
```

---

### Task 7: End-to-End Manual Testing

This task covers manual testing of the complete flow since the Chrome extension cannot be unit-tested automatically.

- [ ] **Step 1: Run Rust backend tests**

Run: `cd src-tauri && cargo test`
Expected: All tests pass.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Manual integration test checklist**

Load the updated extension in Chrome (`chrome://extensions` → Load unpacked → select `extension/` folder) and start the desktop app. Then:

1. **Popup UI**: Open popup — verify two buttons "保存整页" and "选区保存" appear side by side
2. **Full page save still works**: Click "保存整页" → verify it saves as before (regression check)
3. **Selection mode entry**: Select folder, click "选区保存" → popup closes, page shows blue top bar
4. **Hover highlighting**: Move mouse over page elements — verify blue overlay follows
5. **Parent/child navigation**: Use mouse wheel or arrow keys — verify overlay changes to parent/child elements
6. **Mouse move resets navigation**: After scrolling to parent, move mouse to a new element — verify it resets
7. **Lock and confirm**: Click an element → verify it locks (thicker border) and confirm bar appears
8. **Reselect**: Click "重新选择" → verify it unlocks and returns to hover mode
9. **ESC exit**: Press ESC → verify all UI is removed and page returns to normal
10. **Save flow**: Lock an element → click "确认保存" → verify progress toast → verify success toast → verify resource appears in desktop app
11. **Clip indicator**: In desktop app, verify the clipped resource shows the ✂ icon in the resource list
12. **Clipped content**: Open the clipped resource in the reader → verify it shows only the selected region (not the full page), with correct styling

- [ ] **Step 4: Commit any fixes found during testing**

If issues are found during manual testing, fix and commit each fix separately.
