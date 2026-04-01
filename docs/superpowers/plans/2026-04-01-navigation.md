# Navigation Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multi-level folder tree with expand/collapse, folder editing via context menu + modal dialog, resource counts per folder, and URL dedup warnings in the extension popup.

**Architecture:** FolderTree is refactored into a recursive FolderNode component with lazy-loaded children. A new ContextMenu and Modal component provide right-click editing. Two new backend endpoints (`/api/folder-counts`, `/api/check-url`) support resource counts and URL dedup.

**Tech Stack:** React/TypeScript (frontend), Rust/axum/rusqlite (backend), Chrome Extension MV3 (popup)

---

## File Structure

| Action | Path | Responsibility |
|--------|------|---------------|
| Modify | `src-tauri/src/db/resources.rs` | New `count_by_folder` query |
| Modify | `src-tauri/src/server/mod.rs` | New `/api/folder-counts` and `/api/check-url` endpoints |
| Modify | `src-tauri/src/commands/mod.rs` | New `cmd_get_folder_counts` Tauri command |
| Modify | `src-tauri/src/lib.rs` | Register `cmd_get_folder_counts` in invoke_handler |
| Create | `src/components/ContextMenu.tsx` | Generic right-click context menu |
| Create | `src/components/ContextMenu.module.css` | Context menu styles |
| Create | `src/components/Modal.tsx` | Generic modal dialog |
| Create | `src/components/Modal.module.css` | Modal styles |
| Create | `src/components/Sidebar/FolderEditDialog.tsx` | Folder edit dialog (name input) |
| Modify | `src/components/Sidebar/FolderTree.tsx` | Recursive tree with expand/collapse, context menu, counts |
| Modify | `src/components/Sidebar/FolderTree.module.css` | Arrow, indent, count styles |
| Modify | `src/lib/commands.ts` | New `getFolderCounts` command wrapper |
| Modify | `extension/src/popup/popup.html` | Dedup warning div |
| Modify | `extension/src/popup/popup.js` | Check-url call on init |
| Modify | `extension/src/popup/popup.css` | Warning banner style |

---

### Task 1: Backend — `count_by_folder` Query and `/api/folder-counts` Endpoint

**Files:**
- Modify: `src-tauri/src/db/resources.rs`
- Modify: `src-tauri/src/server/mod.rs`

- [ ] **Step 1: Write failing test for `count_by_folder`**

Add to `src-tauri/src/db/resources.rs` in the `#[cfg(test)] mod tests` block:

```rust
#[test]
fn test_count_by_folder() {
    let conn = test_db();
    let f1 = folders::create_folder(&conn, "a", "__root__").unwrap();
    let f2 = folders::create_folder(&conn, "b", "__root__").unwrap();

    create_test_resource(&conn, &f1.id);
    create_test_resource(&conn, &f1.id);
    create_test_resource(&conn, &f2.id);

    let counts = count_by_folder(&conn).unwrap();
    assert_eq!(counts.get(&f1.id), Some(&2));
    assert_eq!(counts.get(&f2.id), Some(&1));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test db::resources::tests::test_count_by_folder`
Expected: Compile error — `count_by_folder` not defined.

- [ ] **Step 3: Implement `count_by_folder`**

Add to `src-tauri/src/db/resources.rs` before `fn normalize_url`:

```rust
pub fn count_by_folder(conn: &Connection) -> Result<std::collections::HashMap<String, i64>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT folder_id, COUNT(*) FROM resources GROUP BY folder_id",
    )?;
    let counts = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(counts)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test db::resources::tests::test_count_by_folder`
Expected: PASS

- [ ] **Step 5: Add `/api/folder-counts` endpoint**

In `src-tauri/src/server/mod.rs`, add the route in `start_server` after the `/api/tags` line:

```rust
.route("/api/folder-counts", get(handle_folder_counts))
```

Add the handler function after `handle_tags`:

```rust
async fn handle_folder_counts(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<std::collections::HashMap<String, i64>>, (StatusCode, Json<ErrorResponse>)> {
    let _ = &headers;

    let conn = state.conn.lock().await;
    let counts = resources::count_by_folder(&conn).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })?;
    Ok(Json(counts))
}
```

- [ ] **Step 6: Add Tauri command `cmd_get_folder_counts`**

In `src-tauri/src/commands/mod.rs`, add after the existing resource commands:

```rust
#[tauri::command]
pub async fn cmd_get_folder_counts(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<std::collections::HashMap<String, i64>, CommandError> {
    let conn = state.conn.lock().await;
    resources::count_by_folder(&conn).map_err(Into::into)
}
```

- [ ] **Step 7: Register command in lib.rs**

Find the `invoke_handler` line in `src-tauri/src/lib.rs` and add `commands::cmd_get_folder_counts` to the list.

- [ ] **Step 8: Add `getFolderCounts` to frontend commands.ts**

In `src/lib/commands.ts`, add after the `deleteFolder` function:

```typescript
export function getFolderCounts(): Promise<Record<string, number>> {
  return invoke("cmd_get_folder_counts");
}
```

- [ ] **Step 9: Verify compilation and run tests**

Run: `cd src-tauri && cargo test && cargo clippy`
Expected: All tests pass, no clippy warnings.

- [ ] **Step 10: Commit**

```bash
git add src-tauri/src/db/resources.rs src-tauri/src/server/mod.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src/lib/commands.ts
git commit -m "feat: add folder counts backend (API, Tauri command, frontend wrapper)"
```

---

### Task 2: Backend — `/api/check-url` Endpoint

**Files:**
- Modify: `src-tauri/src/server/mod.rs`

- [ ] **Step 1: Add `/api/check-url` route and handler**

In `src-tauri/src/server/mod.rs`, add the route after `/api/folder-counts`:

```rust
.route("/api/check-url", get(handle_check_url))
```

Add the query params struct and handler:

```rust
#[derive(Deserialize)]
struct CheckUrlQuery {
    url: String,
}

#[derive(Serialize)]
struct CheckUrlResponse {
    count: usize,
}

async fn handle_check_url(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(query): axum::extract::Query<CheckUrlQuery>,
) -> Result<Json<CheckUrlResponse>, (StatusCode, Json<ErrorResponse>)> {
    let conn = state.conn.lock().await;
    let matches = resources::find_by_url(&conn, &query.url).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })?;
    Ok(Json(CheckUrlResponse {
        count: matches.len(),
    }))
}
```

- [ ] **Step 2: Verify compilation and run tests**

Run: `cd src-tauri && cargo test`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/server/mod.rs
git commit -m "feat: add /api/check-url endpoint for URL dedup checking"
```

---

### Task 3: Frontend — ContextMenu Component

**Files:**
- Create: `src/components/ContextMenu.tsx`
- Create: `src/components/ContextMenu.module.css`

- [ ] **Step 1: Create ContextMenu component**

Create `src/components/ContextMenu.tsx`:

```tsx
import { useEffect, useRef } from "react";
import styles from "./ContextMenu.module.css";

export interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return (
    <div ref={ref} className={styles.menu} style={{ top: y, left: x }}>
      {items.map((item) => (
        <button
          key={item.label}
          className={`${styles.menuItem} ${item.danger ? styles.danger : ""}`}
          onClick={() => {
            item.onClick();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Create ContextMenu styles**

Create `src/components/ContextMenu.module.css`:

```css
.menu {
  position: fixed;
  z-index: 1000;
  min-width: 120px;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
  padding: var(--spacing-xs) 0;
}

.menuItem {
  display: block;
  width: 100%;
  padding: var(--spacing-xs) var(--spacing-md);
  font-size: var(--font-size-base);
  color: var(--color-text-primary);
  text-align: left;
  cursor: pointer;
  border: none;
  background: none;
}

.menuItem:hover {
  background: var(--color-bg-hover);
}

.danger {
  color: var(--color-danger);
}

.danger:hover {
  background: #fef2f2;
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `source ~/.nvm/nvm.sh && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/ContextMenu.tsx src/components/ContextMenu.module.css
git commit -m "feat: add generic ContextMenu component"
```

---

### Task 4: Frontend — Modal Component

**Files:**
- Create: `src/components/Modal.tsx`
- Create: `src/components/Modal.module.css`

- [ ] **Step 1: Create Modal component**

Create `src/components/Modal.tsx`:

```tsx
import { useEffect, type ReactNode } from "react";
import styles from "./Modal.module.css";

interface ModalProps {
  title: string;
  children: ReactNode;
  onClose: () => void;
}

export function Modal({ title, children, onClose }: ModalProps) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <span className={styles.title}>{title}</span>
          <button className={styles.closeBtn} onClick={onClose}>
            &times;
          </button>
        </div>
        <div className={styles.body}>{children}</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create Modal styles**

Create `src/components/Modal.module.css`:

```css
.overlay {
  position: fixed;
  inset: 0;
  z-index: 999;
  background: rgba(0, 0, 0, 0.3);
  display: flex;
  align-items: center;
  justify-content: center;
}

.dialog {
  background: var(--color-bg-primary);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
  min-width: 320px;
  max-width: 480px;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-md) var(--spacing-lg);
  border-bottom: 1px solid var(--color-border-light);
}

.title {
  font-size: var(--font-size-lg);
  font-weight: 600;
}

.closeBtn {
  font-size: 18px;
  color: var(--color-text-muted);
  padding: 2px 6px;
  border-radius: 4px;
  border: none;
  background: none;
  cursor: pointer;
}

.closeBtn:hover {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.body {
  padding: var(--spacing-lg);
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `source ~/.nvm/nvm.sh && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/Modal.tsx src/components/Modal.module.css
git commit -m "feat: add generic Modal dialog component"
```

---

### Task 5: Frontend — FolderEditDialog

**Files:**
- Create: `src/components/Sidebar/FolderEditDialog.tsx`

- [ ] **Step 1: Create FolderEditDialog component**

Create `src/components/Sidebar/FolderEditDialog.tsx`:

```tsx
import { useState } from "react";
import { Modal } from "@/components/Modal";
import * as cmd from "@/lib/commands";

interface FolderEditDialogProps {
  folderId: string;
  currentName: string;
  onClose: () => void;
  onSaved: () => void;
}

export function FolderEditDialog({
  folderId,
  currentName,
  onClose,
  onSaved,
}: FolderEditDialogProps) {
  const [name, setName] = useState(currentName);
  const [saving, setSaving] = useState(false);

  async function handleSubmit() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === currentName) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      await cmd.renameFolder(folderId, trimmed);
      onSaved();
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE constraint")) {
        alert("文件夹名称已存在，请换一个名称");
      } else {
        alert(`重命名失败: ${msg}`);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="编辑文件夹" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
      >
        <label
          style={{
            display: "block",
            fontSize: "var(--font-size-sm)",
            color: "var(--color-text-secondary)",
            marginBottom: "var(--spacing-xs)",
          }}
        >
          文件夹名称
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          style={{
            width: "100%",
            padding: "var(--spacing-sm)",
            border: "1px solid var(--color-border)",
            borderRadius: "4px",
            fontSize: "var(--font-size-base)",
            boxSizing: "border-box",
          }}
        />
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "var(--spacing-sm)",
            marginTop: "var(--spacing-lg)",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "var(--spacing-xs) var(--spacing-md)",
              borderRadius: "4px",
              border: "1px solid var(--color-border)",
              background: "var(--color-bg-primary)",
              cursor: "pointer",
              fontSize: "var(--font-size-base)",
            }}
          >
            取消
          </button>
          <button
            type="submit"
            disabled={saving || !name.trim()}
            style={{
              padding: "var(--spacing-xs) var(--spacing-md)",
              borderRadius: "4px",
              border: "none",
              background: "var(--color-accent)",
              color: "white",
              cursor: "pointer",
              fontSize: "var(--font-size-base)",
            }}
          >
            确认
          </button>
        </div>
      </form>
    </Modal>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `source ~/.nvm/nvm.sh && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/Sidebar/FolderEditDialog.tsx
git commit -m "feat: add FolderEditDialog component for renaming folders"
```

---

### Task 6: Frontend — Refactor FolderTree to Recursive Tree with Context Menu and Counts

**Files:**
- Modify: `src/components/Sidebar/FolderTree.tsx`
- Modify: `src/components/Sidebar/FolderTree.module.css`
- Modify: `src/lib/commands.ts`

This is the main refactor. FolderTree becomes a recursive tree with expand/collapse, right-click context menu, folder counts, and the edit dialog.

- [ ] **Step 1: Update FolderTree.module.css**

Replace `src/components/Sidebar/FolderTree.module.css` with:

```css
.section {
  padding: var(--spacing-sm);
  border-bottom: 1px solid var(--color-border-light);
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-xs) var(--spacing-sm);
  margin-bottom: var(--spacing-xs);
}

.title {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.addButton {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  padding: 2px 6px;
  border-radius: 4px;
}

.addButton:hover {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.item {
  display: flex;
  align-items: center;
  padding: var(--spacing-xs) var(--spacing-sm);
  border-radius: 4px;
  cursor: pointer;
  font-size: var(--font-size-base);
  gap: 2px;
  user-select: none;
}

.item:hover {
  background: var(--color-bg-hover);
}

.itemSelected {
  background: var(--color-bg-active);
  color: var(--color-accent);
  font-weight: 500;
}

.arrow {
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.folderName {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.count {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  margin-left: var(--spacing-xs);
  flex-shrink: 0;
}

.children {
  padding-left: var(--spacing-lg);
}

.empty {
  padding: var(--spacing-sm) var(--spacing-lg);
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}
```

- [ ] **Step 2: Rewrite FolderTree.tsx**

Replace `src/components/Sidebar/FolderTree.tsx` with:

```tsx
import { useState, useEffect, useCallback } from "react";
import { useFolders } from "@/hooks/useFolders";
import * as cmd from "@/lib/commands";
import { ContextMenu, type MenuItem } from "@/components/ContextMenu";
import { FolderEditDialog } from "@/components/Sidebar/FolderEditDialog";
import styles from "./FolderTree.module.css";

interface FolderTreeProps {
  selectedFolderId: string | null;
  onSelectFolder: (id: string) => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  folderId: string;
  folderName: string;
}

export function FolderTree({ selectedFolderId, onSelectFolder }: FolderTreeProps) {
  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [editFolder, setEditFolder] = useState<{ id: string; name: string } | null>(null);
  const [folderCounts, setFolderCounts] = useState<Record<string, number>>({});

  const loadCounts = useCallback(async () => {
    try {
      const counts = await cmd.getFolderCounts();
      setFolderCounts(counts);
    } catch (err) {
      console.error("Failed to load folder counts:", err);
    }
  }, []);

  useEffect(() => {
    loadCounts();
  }, [loadCounts]);

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  const parentId = selectedFolderId || "__root__";

  async function handleCreate() {
    if (!newName.trim()) return;
    try {
      await cmd.createFolder(newName.trim(), parentId);
      setNewName("");
      setIsCreating(false);
      // Expand parent so the new folder is visible
      if (selectedFolderId) {
        setExpandedIds((prev) => new Set(prev).add(selectedFolderId));
      }
      loadCounts();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE constraint")) {
        alert("文件夹名称已存在，请换一个名称");
      } else {
        alert(`创建失败: ${msg}`);
      }
    }
  }

  async function handleDelete(id: string, name: string) {
    if (!window.confirm(`确定删除文件夹「${name}」及其所有资料吗？`)) return;
    try {
      await cmd.deleteFolder(id);
      loadCounts();
    } catch (err: unknown) {
      alert(`删除失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function handleContextMenu(e: React.MouseEvent, folderId: string, folderName: string) {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, folderId, folderName });
  }

  const menuItems: MenuItem[] = contextMenu
    ? [
        {
          label: "编辑",
          onClick: () => setEditFolder({ id: contextMenu.folderId, name: contextMenu.folderName }),
        },
        {
          label: "删除",
          danger: true,
          onClick: () => handleDelete(contextMenu.folderId, contextMenu.folderName),
        },
      ]
    : [];

  return (
    <div className={styles.section}>
      <div className={styles.header}>
        <span className={styles.title}>文件夹</span>
        <button
          className={styles.addButton}
          onClick={() => setIsCreating(!isCreating)}
          title="新建文件夹"
        >
          +
        </button>
      </div>

      {isCreating && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleCreate();
          }}
          style={{ padding: "0 8px 8px" }}
        >
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="文件夹名称..."
            autoFocus
            style={{
              width: "100%",
              padding: "4px 8px",
              border: "1px solid var(--color-border)",
              borderRadius: "4px",
              fontSize: "var(--font-size-sm)",
            }}
            onBlur={() => {
              if (!newName.trim()) setIsCreating(false);
            }}
          />
        </form>
      )}

      <FolderNode
        parentId="__root__"
        depth={0}
        selectedFolderId={selectedFolderId}
        expandedIds={expandedIds}
        folderCounts={folderCounts}
        onSelect={onSelectFolder}
        onToggleExpand={toggleExpand}
        onContextMenu={handleContextMenu}
      />

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={menuItems}
          onClose={() => setContextMenu(null)}
        />
      )}

      {editFolder && (
        <FolderEditDialog
          folderId={editFolder.id}
          currentName={editFolder.name}
          onClose={() => setEditFolder(null)}
          onSaved={loadCounts}
        />
      )}
    </div>
  );
}

// ── Recursive FolderNode ──

interface FolderNodeProps {
  parentId: string;
  depth: number;
  selectedFolderId: string | null;
  expandedIds: Set<string>;
  folderCounts: Record<string, number>;
  onSelect: (id: string) => void;
  onToggleExpand: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string, name: string) => void;
}

function FolderNode({
  parentId,
  depth,
  selectedFolderId,
  expandedIds,
  folderCounts,
  onSelect,
  onToggleExpand,
  onContextMenu,
}: FolderNodeProps) {
  const { folders, loading } = useFolders(parentId);

  if (loading && depth === 0) {
    return <div className={styles.empty}>加载中...</div>;
  }

  if (!loading && folders.length === 0 && depth === 0) {
    return <div className={styles.empty}>暂无文件夹</div>;
  }

  return (
    <>
      {folders.map((folder) => {
        const isExpanded = expandedIds.has(folder.id);
        const isSelected = selectedFolderId === folder.id;
        const count = folderCounts[folder.id];

        return (
          <div key={folder.id}>
            <div
              className={`${styles.item} ${isSelected ? styles.itemSelected : ""}`}
              style={{ paddingLeft: `${8 + depth * 16}px` }}
              onClick={() => onSelect(folder.id)}
              onContextMenu={(e) => onContextMenu(e, folder.id, folder.name)}
            >
              <span
                className={styles.arrow}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleExpand(folder.id);
                }}
              >
                {isExpanded ? "▼" : "▶"}
              </span>
              <span className={styles.folderName}>📁 {folder.name}</span>
              {count ? <span className={styles.count}>{count}</span> : null}
            </div>
            {isExpanded && (
              <div className={styles.children}>
                <FolderNode
                  parentId={folder.id}
                  depth={depth + 1}
                  selectedFolderId={selectedFolderId}
                  expandedIds={expandedIds}
                  folderCounts={folderCounts}
                  onSelect={onSelect}
                  onToggleExpand={onToggleExpand}
                  onContextMenu={onContextMenu}
                />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `source ~/.nvm/nvm.sh && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/Sidebar/FolderTree.tsx src/components/Sidebar/FolderTree.module.css
git commit -m "feat: refactor FolderTree to recursive tree with expand/collapse, context menu, and counts"
```

---

### Task 7: Extension Popup — URL Dedup Warning

**Files:**
- Modify: `extension/src/popup/popup.html`
- Modify: `extension/src/popup/popup.js`
- Modify: `extension/src/popup/popup.css`

- [ ] **Step 1: Add warning div to popup.html**

In `extension/src/popup/popup.html`, add after the `page-info` div (after line 22):

```html
<div id="url-warning" class="url-warning" style="display:none"></div>
```

- [ ] **Step 2: Add warning style to popup.css**

In `extension/src/popup/popup.css`, add after the `.page-url` block:

```css
.url-warning {
  margin-bottom: 12px;
  padding: 6px 8px;
  background: #fef9c3;
  color: #854d0e;
  border-radius: 4px;
  font-size: 12px;
  text-align: center;
}
```

- [ ] **Step 3: Add dedup check to popup.js**

In `extension/src/popup/popup.js`, add after `pageUrlEl.textContent = pageInfo.url;` (around line 97):

```javascript
// Check for duplicate URL
try {
  const checkRes = await fetch(
    `${API_BASE}/api/check-url?url=${encodeURIComponent(pageInfo.url)}`,
    { signal: AbortSignal.timeout(2000) }
  );
  if (checkRes.ok) {
    const { count } = await checkRes.json();
    if (count > 0) {
      const warningEl = document.getElementById("url-warning");
      warningEl.textContent = `该 URL 已保存过 ${count} 次`;
      warningEl.style.display = "block";
    }
  }
} catch (e) {
  console.log("[shibei] url check failed (ok):", e.message);
}
```

Also add the element reference near the top (after line 8):

```javascript
const urlWarningEl = document.getElementById("url-warning");
```

- [ ] **Step 4: Commit**

```bash
git add extension/src/popup/popup.html extension/src/popup/popup.js extension/src/popup/popup.css
git commit -m "feat: show URL dedup warning in extension popup"
```

