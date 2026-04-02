# Code Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix ~20 issues found during code review, covering security, robustness, performance, and error feedback.

**Architecture:** Four independent commits grouped by problem domain. No architectural changes — all fixes are localized edits to existing files. Annotator source is TypeScript (`src/annotator/annotator.ts`), compiled to `src-tauri/src/annotator.js` via `npm run build:annotator`.

**Tech Stack:** Rust (Tauri backend), TypeScript/React (frontend), TypeScript (annotator), JavaScript (Chrome extension), react-hot-toast (new dependency)

---

## File Map

| File | Action | Responsibility in this plan |
|------|--------|---------------------------|
| `src/annotator/annotator.ts` | Modify | postMessage source tagging, text node caching |
| `src-tauri/src/annotator.js` | Rebuild | Compiled output of annotator.ts |
| `src/components/ReaderView.tsx` | Modify | postMessage source tagging, source checking |
| `src-tauri/src/server/mod.rs` | Modify | CORS, server startup, transaction, recursion limit, N+1 |
| `src-tauri/src/lib.rs` | Modify | Server error handling |
| `src-tauri/src/db/resources.rs` | Modify | find_by_url SQL pre-filter |
| `src-tauri/src/commands/mod.rs` | Modify | Delete resource file cleanup logging |
| `extension/src/background/background.js` | Modify | Sender validation, token concurrency |
| `extension/src/popup/popup.js` | Modify | Token concurrency |
| `extension/src/content/region-selector.js` | Modify | Attribute sanitization in clipHtml |
| `src/components/Layout.tsx` | Modify | Drag event listener leak fix |
| `src/hooks/useResources.ts` | Modify | Tauri event listener leak fix |
| `src/hooks/useAnnotations.ts` | Modify | Toast error feedback |
| `src/hooks/useFolders.ts` | Modify | Toast error feedback |
| `src/App.tsx` | Modify | Toaster component mount |
| `package.json` | Modify | react-hot-toast dependency |

---

## Task 1: Security Hardening — postMessage Source Tagging

**Files:**
- Modify: `src/annotator/annotator.ts:52-56, 534-544, 579-605, 609-668, 670-694, 696-707`
- Modify: `src/components/ReaderView.tsx:54-105, 113-116, 131-134, 152-155, 169-172, 205-208`

- [ ] **Step 1: Add `source` field to all annotator outbound message types**

In `src/annotator/annotator.ts`, add `source: string` to each outbound message interface:

```typescript
interface SelectionMsg {
  type: "shibei:selection";
  source: "shibei";
  text: string;
  anchor: Anchor;
  rect: SelectionRect;
}

interface SelectionClearedMsg {
  type: "shibei:selection-cleared";
  source: "shibei";
}

interface HighlightClickedMsg {
  type: "shibei:highlight-clicked";
  source: "shibei";
  id: string;
}

interface LinkClickedMsg {
  type: "shibei:link-clicked";
  source: "shibei";
  url: string;
}

interface AnnotatorReadyMsg {
  type: "shibei:annotator-ready";
  source: "shibei";
}

interface RenderResultMsg {
  type: "shibei:render-result";
  source: "shibei";
  failedIds: string[];
}
```

- [ ] **Step 2: Add `source` field to all inbound message types**

```typescript
interface RenderHighlightsMsg {
  type: "shibei:render-highlights";
  source: "shibei";
  highlights: HighlightData[];
}

interface AddHighlightMsg {
  type: "shibei:add-highlight";
  source: "shibei";
  highlight: HighlightData;
}

interface RemoveHighlightMsg {
  type: "shibei:remove-highlight";
  source: "shibei";
  id: string;
}

interface ScrollToHighlightMsg {
  type: "shibei:scroll-to-highlight";
  source: "shibei";
  id: string;
}
```

- [ ] **Step 3: Add source check to annotator message handler**

In `src/annotator/annotator.ts`, modify the message handler (around line 609):

```typescript
window.addEventListener("message", (event: MessageEvent<unknown>) => {
  const msg = event.data as InboundMessage;
  if (!msg || !msg.type || msg.source !== "shibei") return;
  // ... rest unchanged
});
```

- [ ] **Step 4: Add `source: "shibei"` to all annotator postMessage calls**

Every `window.parent.postMessage(msg, "*")` call already uses typed message objects. The `source` field was added to the interfaces, so now add the actual value in each message construction:

In `createHlElement` (line 538-544):
```typescript
const msg: HighlightClickedMsg = {
  type: "shibei:highlight-clicked",
  source: "shibei",
  id: highlightId,
};
```

In mouseup handler (line 584, 593-604):
```typescript
const msg: SelectionClearedMsg = { type: "shibei:selection-cleared", source: "shibei" };
```
```typescript
const msg: SelectionMsg = {
  type: "shibei:selection",
  source: "shibei",
  text: selection.toString(),
  anchor,
  rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
};
```

In link click handler (line 687-690):
```typescript
const msg: LinkClickedMsg = {
  type: "shibei:link-clicked",
  source: "shibei",
  url: (link as HTMLAnchorElement).href,
};
```

In render-highlights result (line 633-636):
```typescript
const renderResult: RenderResultMsg = {
  type: "shibei:render-result",
  source: "shibei",
  failedIds,
};
```

In signalReady (line 699):
```typescript
const readyMsg: AnnotatorReadyMsg = { type: "shibei:annotator-ready", source: "shibei" };
```

- [ ] **Step 5: Add source check and source field in ReaderView.tsx**

In `src/components/ReaderView.tsx`, modify the message handler (line 55-57):
```typescript
function handleMessage(event: MessageEvent) {
  const msg = event.data;
  if (!msg || !msg.type || msg.source !== "shibei") return;
  // ... rest unchanged
}
```

Add `source: "shibei"` to all outbound postMessage calls in ReaderView.tsx. Each call uses an inline object — add the field:

Line 113-116 (render-highlights):
```typescript
iframeRef.current.contentWindow.postMessage(
  { type: "shibei:render-highlights", source: "shibei", highlights },
  "*",
);
```

Line 131-134 (scroll-to-highlight):
```typescript
iframeRef.current.contentWindow.postMessage(
  { type: "shibei:scroll-to-highlight", source: "shibei", id: initialHighlightId },
  "*",
);
```

Line 152-155 (add-highlight):
```typescript
iframeRef.current?.contentWindow?.postMessage(
  { type: "shibei:add-highlight", source: "shibei", highlight: hl },
  "*",
);
```

Line 169-172 (remove-highlight):
```typescript
iframeRef.current?.contentWindow?.postMessage(
  { type: "shibei:remove-highlight", source: "shibei", id },
  "*",
);
```

Line 205-208 (scroll-to-highlight in panel click):
```typescript
iframeRef.current?.contentWindow?.postMessage(
  { type: "shibei:scroll-to-highlight", source: "shibei", id },
  "*",
);
```

- [ ] **Step 6: Build annotator and verify compilation**

Run:
```bash
npm run build:annotator
```
Expected: No errors. `src-tauri/src/annotator.js` updated.

Then verify Rust compiles:
```bash
cd src-tauri && cargo check
```
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add src/annotator/annotator.ts src-tauri/src/annotator.js src/components/ReaderView.tsx
git commit -m "fix: add source tagging to all postMessage calls for security"
```

---

## Task 2: Security Hardening — Extension & Server

**Files:**
- Modify: `extension/src/background/background.js:22-35`
- Modify: `extension/src/background/background.js:3-11`
- Modify: `extension/src/popup/popup.js:3-11`
- Modify: `extension/src/content/region-selector.js:261-310`
- Modify: `src-tauri/src/server/mod.rs:70-74`

- [ ] **Step 1: Add sender validation to background.js**

In `extension/src/background/background.js`, modify the message listener (line 22):

```javascript
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only accept messages from our own extension
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ success: false, error: "Unauthorized sender" });
    return false;
  }

  if (message.type === "save-page") {
    handleSavePage(message.data)
      .then((result) => sendResponse({ success: true, data: result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (message.type === "save-region") {
    handleSaveRegion(message.data)
      .then((result) => sendResponse({ success: true, data: result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});
```

- [ ] **Step 2: Add token concurrency control to background.js**

In `extension/src/background/background.js`, replace lines 3-11:

```javascript
let cachedToken = null;
let tokenPromise = null;

async function getToken() {
  if (cachedToken) return cachedToken;
  if (tokenPromise) return tokenPromise;
  tokenPromise = (async () => {
    try {
      const res = await fetch(`${API_BASE}/token`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) throw new Error(`Failed to fetch token: HTTP ${res.status}`);
      const data = await res.json();
      cachedToken = data.token;
      return cachedToken;
    } finally {
      tokenPromise = null;
    }
  })();
  return tokenPromise;
}
```

- [ ] **Step 3: Add token concurrency control to popup.js**

In `extension/src/popup/popup.js`, apply the same pattern — replace lines 3-11:

```javascript
let cachedToken = null;
let tokenPromise = null;

async function getToken() {
  if (cachedToken) return cachedToken;
  if (tokenPromise) return tokenPromise;
  tokenPromise = (async () => {
    try {
      const res = await fetch(`${API_BASE}/token`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) throw new Error(`Failed to fetch token: HTTP ${res.status}`);
      const data = await res.json();
      cachedToken = data.token;
      return cachedToken;
    } finally {
      tokenPromise = null;
    }
  })();
  return tokenPromise;
}
```

- [ ] **Step 4: Add dangerous attribute filter to clipHtml**

In `extension/src/content/region-selector.js`, add this helper before the `clipHtml` function (before line 261):

```javascript
function isSafeAttr(name, value) {
  // Block event handlers
  if (name.toLowerCase().startsWith("on")) return false;
  // Block javascript: URLs in link/src attributes
  if (["href", "src", "action"].includes(name.toLowerCase())) {
    if (typeof value === "string" && value.trim().toLowerCase().startsWith("javascript:")) {
      return false;
    }
  }
  return true;
}
```

Then modify the attribute copying loops inside `clipHtml`. Replace the body attributes loop (lines 277-279):

```javascript
if (origBody) {
  for (const attr of origBody.attributes) {
    if (isSafeAttr(attr.name, attr.value)) {
      newBody.setAttribute(attr.name, attr.value);
    }
  }
}
```

Replace the ancestor attributes loop (lines 295-297):

```javascript
for (const attr of anc.attributes) {
  if (isSafeAttr(attr.name, attr.value)) {
    wrapper.setAttribute(attr.name, attr.value);
  }
}
```

- [ ] **Step 5: Restrict CORS to localhost origins**

In `src-tauri/src/server/mod.rs`, replace the CORS setup (lines 71-74):

```rust
let cors = tower_http::cors::CorsLayer::new()
    .allow_origin(tower_http::cors::AllowOrigin::predicate(
        |origin: &axum::http::HeaderValue, _req: &axum::http::request::Parts| {
            let Ok(s) = origin.to_str() else { return false };
            s.starts_with("chrome-extension://")
                || s.starts_with("tauri://")
                || s.starts_with("http://tauri.localhost")
                || s.starts_with("http://127.0.0.1")
                || s.starts_with("http://localhost")
        },
    ))
    .allow_methods([axum::http::Method::GET, axum::http::Method::POST, axum::http::Method::OPTIONS])
    .allow_headers([axum::http::header::CONTENT_TYPE, axum::http::header::AUTHORIZATION]);
```

- [ ] **Step 6: Verify Rust compilation**

Run:
```bash
cd src-tauri && cargo check
```
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add extension/src/background/background.js extension/src/popup/popup.js extension/src/content/region-selector.js src-tauri/src/server/mod.rs
git commit -m "fix: harden extension sender validation, CORS, clipHtml XSS, token concurrency"
```

---

## Task 3: Robustness — Server Startup & Transaction

**Files:**
- Modify: `src-tauri/src/server/mod.rs:70, 88-91, 143-158, 226-328`
- Modify: `src-tauri/src/lib.rs:131`

- [ ] **Step 1: Change start_server to return Result**

In `src-tauri/src/server/mod.rs`, change the function signature (line 70) and remove unwraps (lines 88-90):

```rust
/// Start the HTTP server on 127.0.0.1:21519.
pub async fn start_server(state: Arc<AppState>) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // ... CORS and router setup unchanged ...

    let addr = SocketAddr::from(([127, 0, 0, 1], 21519));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
```

- [ ] **Step 2: Handle server error in lib.rs**

In `src-tauri/src/lib.rs`, modify the spawn call (line 131):

```rust
tauri::async_runtime::spawn(async move {
    if let Err(e) = server::start_server(server_state).await {
        eprintln!("[shibei] HTTP server failed: {}", e);
    }
});
```

- [ ] **Step 3: Add recursion depth limit to build_folder_tree**

In `src-tauri/src/server/mod.rs`, modify `build_folder_tree` (lines 143-158):

```rust
fn build_folder_tree(
    conn: &Connection,
    parent_id: &str,
    depth: u32,
) -> Result<Vec<FolderNode>, crate::db::DbError> {
    if depth > 20 {
        return Ok(Vec::new());
    }
    let children = folders::list_children(conn, parent_id)?;
    let mut nodes = Vec::new();
    for folder in children {
        let sub_children = build_folder_tree(conn, &folder.id, depth + 1)?;
        nodes.push(FolderNode {
            id: folder.id,
            name: folder.name,
            children: sub_children,
        });
    }
    Ok(nodes)
}
```

Update the call site in `handle_folders` (line 132):

```rust
let tree = build_folder_tree(&conn, "__root__", 0).map_err(|e| {
```

- [ ] **Step 4: Wrap handle_save in transaction + fix tag N+1**

In `src-tauri/src/server/mod.rs`, rewrite `handle_save` (lines 226-328). Key changes:
- Move file save after acquiring conn (inside transaction scope)
- Wrap DB operations in BEGIN/COMMIT/ROLLBACK
- Load all tags once before the loop
- Propagate tag errors instead of `let _ =`

```rust
async fn handle_save(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<SaveRequest>,
) -> Result<Json<SaveResponse>, (StatusCode, Json<ErrorResponse>)> {
    verify_token(&headers, &state.token)?;

    // Validate content_type
    if payload.content_type != "html" && payload.content_type != "html_fragment" {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "content_type must be 'html' or 'html_fragment'".to_string(),
            }),
        ));
    }

    // Decode base64 content
    let content_bytes =
        base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &payload.content)
            .map_err(|e| {
                (
                    StatusCode::BAD_REQUEST,
                    Json(ErrorResponse {
                        error: format!("invalid base64 content: {}", e),
                    }),
                )
            })?;

    // Generate resource_id and save to filesystem first
    let resource_id = uuid::Uuid::new_v4().to_string();
    let rel_path =
        storage::save_snapshot(&state.base_dir, &resource_id, &content_bytes).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("storage error: {}", e),
                }),
            )
        })?;

    let conn = state.conn.lock().await;

    // Begin transaction
    conn.execute_batch("BEGIN").map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(ErrorResponse { error: format!("db error: {}", e) }))
    })?;

    // Create resource in database
    let resource = match resources::create_resource(
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
    ) {
        Ok(r) => r,
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            let _ = std::fs::remove_dir_all(storage::resource_dir(&state.base_dir, &resource_id));
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse { error: format!("db error: {}", e) }),
            ));
        }
    };

    // Associate tags — load all tags once (fix N+1)
    let all_tags = tags::list_tags(&conn).unwrap_or_default();
    for tag_name in &payload.tags {
        let tag = all_tags.iter().find(|t| t.name == *tag_name);

        let tag_id = match tag {
            Some(t) => t.id.clone(),
            None => {
                match tags::create_tag(&conn, tag_name, "#888888") {
                    Ok(new_tag) => new_tag.id,
                    Err(e) => {
                        let _ = conn.execute_batch("ROLLBACK");
                        let _ = std::fs::remove_dir_all(storage::resource_dir(&state.base_dir, &resource_id));
                        return Err((
                            StatusCode::INTERNAL_SERVER_ERROR,
                            Json(ErrorResponse { error: format!("tag error: {}", e) }),
                        ));
                    }
                }
            }
        };

        if let Err(e) = tags::add_tag_to_resource(&conn, &resource.id, &tag_id) {
            let _ = conn.execute_batch("ROLLBACK");
            let _ = std::fs::remove_dir_all(storage::resource_dir(&state.base_dir, &resource_id));
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse { error: format!("tag association error: {}", e) }),
            ));
        }
    }

    // Commit transaction
    conn.execute_batch("COMMIT").map_err(|e| {
        let _ = std::fs::remove_dir_all(storage::resource_dir(&state.base_dir, &resource_id));
        (StatusCode::INTERNAL_SERVER_ERROR, Json(ErrorResponse { error: format!("db error: {}", e) }))
    })?;

    // Notify desktop app (best-effort, outside transaction)
    let _ = state.app_handle.emit("resource-saved", serde_json::json!({
        "resource_id": resource.id,
        "folder_id": resource.folder_id,
    }));

    Ok(Json(SaveResponse {
        resource_id: resource.id,
    }))
}
```

- [ ] **Step 5: Verify Rust compilation**

Run:
```bash
cd src-tauri && cargo check
```
Expected: No errors.

- [ ] **Step 6: Run existing Rust tests**

Run:
```bash
cd src-tauri && cargo test
```
Expected: All 49 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/server/mod.rs src-tauri/src/lib.rs
git commit -m "fix: server startup error handling, handle_save transaction, folder tree depth limit"
```

---

## Task 4: Robustness — Frontend Event Listener Leaks

**Files:**
- Modify: `src/components/Layout.tsx:17-41`
- Modify: `src/components/ReaderView.tsx:30, 178-198`
- Modify: `src/hooks/useResources.ts:31-37`
- Modify: `src-tauri/src/commands/mod.rs:118-124`

- [ ] **Step 1: Fix drag listener leak in Layout.tsx**

In `src/components/Layout.tsx`, replace the drag handling logic (lines 17-41) with a useEffect-based pattern:

```tsx
const dragging = useRef(false);
const layoutRef = useRef<HTMLDivElement>(null);

const handleMouseDown = useCallback(() => {
  dragging.current = true;
  layoutRef.current?.classList.add(styles.resizing);
}, []);

useEffect(() => {
  function onMouseMove(e: MouseEvent) {
    if (!dragging.current) return;
    const sidebarWidth = document.querySelector(`.${styles.sidebar}`)?.getBoundingClientRect().width ?? 200;
    const newWidth = e.clientX - sidebarWidth;
    setListPanelWidth(Math.max(200, Math.min(600, newWidth)));
  }

  function onMouseUp() {
    if (!dragging.current) return;
    dragging.current = false;
    layoutRef.current?.classList.remove(styles.resizing);
  }

  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
  return () => {
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
  };
}, []);
```

Note: `setListPanelWidth` is stable (from useState), `styles` is module-level, and refs don't trigger re-renders — so empty deps `[]` is correct.

- [ ] **Step 2: Fix drag listener leak in ReaderView.tsx**

In `src/components/ReaderView.tsx`, replace `handleResizeMouseDown` and its logic (lines 178-198) with the same pattern:

```tsx
const handleResizeMouseDown = useCallback(() => {
  dragging.current = true;
  containerRef.current?.classList.add(styles.resizing);
}, []);

useEffect(() => {
  function onMouseMove(e: MouseEvent) {
    if (!dragging.current || !containerRef.current) return;
    const containerRight = containerRef.current.getBoundingClientRect().right;
    const newWidth = containerRight - e.clientX;
    setPanelWidth(Math.max(220, Math.min(500, newWidth)));
  }

  function onMouseUp() {
    if (!dragging.current) return;
    dragging.current = false;
    containerRef.current?.classList.remove(styles.resizing);
  }

  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
  return () => {
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
  };
}, []);
```

- [ ] **Step 3: Fix Tauri event listener leak in useResources.ts**

In `src/hooks/useResources.ts`, replace the event listener effect (lines 31-37):

```tsx
// Auto-refresh when a new resource is saved via the extension
useEffect(() => {
  let isCancelled = false;
  const unlisten = listen("resource-saved", () => {
    if (!isCancelled) refresh();
  });
  return () => {
    isCancelled = true;
    unlisten.then((fn) => fn());
  };
}, [refresh]);
```

- [ ] **Step 4: Add logging for file cleanup failures in commands**

In `src-tauri/src/commands/mod.rs`, replace line 123:

```rust
let dir = storage::resource_dir(&state.base_dir, &rid);
if let Err(e) = std::fs::remove_dir_all(&dir) {
    eprintln!("[shibei] Failed to clean up resource directory {:?}: {}", dir, e);
}
```

- [ ] **Step 5: Verify compilation**

Run:
```bash
cd src-tauri && cargo check && cd .. && npx tsc --noEmit
```
Expected: No errors on either.

- [ ] **Step 6: Commit**

```bash
git add src/components/Layout.tsx src/components/ReaderView.tsx src/hooks/useResources.ts src-tauri/src/commands/mod.rs
git commit -m "fix: event listener leaks in Layout, ReaderView, useResources; log file cleanup errors"
```

---

## Task 5: Performance — SQL Pre-filter & Text Node Cache

**Files:**
- Modify: `src-tauri/src/db/resources.rs:191-220`
- Modify: `src/annotator/annotator.ts:235-273, 408-467, 472-474, 498-521, 609-638`

- [ ] **Step 1: Optimize find_by_url with SQL LIKE pre-filter**

In `src-tauri/src/db/resources.rs`, replace the `find_by_url` function (lines 191-220):

```rust
pub fn find_by_url(conn: &Connection, url: &str) -> Result<Vec<Resource>, DbError> {
    let normalized = normalize_url(url);

    // Extract host+path for SQL pre-filter (strip scheme)
    let like_pattern = if let Some(pos) = normalized.find("://") {
        format!("%{}%", &normalized[pos + 3..])
    } else {
        format!("%{}%", normalized)
    };

    let mut stmt = conn.prepare(
        "SELECT id, title, url, domain, author, description, folder_id, resource_type, file_path, created_at, captured_at, selection_meta
         FROM resources WHERE url LIKE ?1",
    )?;
    let resources = stmt
        .query_map(rusqlite::params![like_pattern], |row| {
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

- [ ] **Step 2: Run existing tests for resources**

Run:
```bash
cd src-tauri && cargo test resources
```
Expected: All resource tests pass (find_by_url test should still work).

- [ ] **Step 3: Add text node caching to annotator batch rendering**

In `src/annotator/annotator.ts`, modify `resolveByPosition` and `resolveByQuote` to accept an optional cached text nodes parameter.

First, update `resolveByPosition` (line 235):

```typescript
function resolveByPosition(anchor: Anchor, cachedTextNodes?: Text[]): Range | null {
  const textNodes = cachedTextNodes ?? getTextNodes(document.body);
  const { start, end } = anchor.text_position;
  // ... rest unchanged
}
```

Update `resolveByQuote` (line 408). It calls `getBodyText()` which also uses `getTextNodes` — pass cached nodes through:

```typescript
function resolveByQuote(anchor: Anchor, cachedTextNodes?: Text[]): Range | null {
  const textNodes = cachedTextNodes ?? getTextNodes(document.body);
  const bodyText = textNodes
    .map((n) => normalizedText(n.textContent ?? ""))
    .join("");
  // Normalize stored anchor text to match normalized bodyText
  const exact = normalizedText(anchor.text_quote.exact);
  const prefix = normalizedText(anchor.text_quote.prefix);
  const suffix = normalizedText(anchor.text_quote.suffix);

  // Step 1: Exact match with full context (prefix + exact + suffix)
  const contextStr = prefix + exact + suffix;
  const idx = bodyText.indexOf(contextStr);
  if (idx !== -1) {
    const start = idx + prefix.length;
    const end = start + exact.length;
    return resolveByPosition({
      text_position: { start, end },
      text_quote: { exact, prefix, suffix },
    }, cachedTextNodes);
  }

  // Step 2: Exact match on just the quote text
  const simpleIdx = bodyText.indexOf(exact);
  if (simpleIdx !== -1) {
    return resolveByPosition({
      text_position: { start: simpleIdx, end: simpleIdx + exact.length },
      text_quote: { exact, prefix, suffix },
    }, cachedTextNodes);
  }

  // Step 3: Fuzzy match on exact text (tolerant of minor differences)
  const maxErrors = Math.min(32, Math.floor(exact.length / 5));
  if (maxErrors < 1) return null;

  const match = fuzzySearch(bodyText, exact, maxErrors, anchor.text_position.start);
  if (!match) return null;

  // Validate with context
  const candidatePrefix = bodyText.slice(
    Math.max(0, match.start - prefix.length),
    match.start,
  );
  const candidateSuffix = bodyText.slice(
    match.end,
    Math.min(bodyText.length, match.end + suffix.length),
  );
  const prefixSim = prefix.length > 0 ? similarity(candidatePrefix, prefix) : 1;
  const suffixSim = suffix.length > 0 ? similarity(candidateSuffix, suffix) : 1;

  if (prefixSim < 0.5 && suffixSim < 0.5) return null;

  return resolveByPosition({
    text_position: { start: match.start, end: match.end },
    text_quote: {
      exact: bodyText.slice(match.start, match.end),
      prefix,
      suffix,
    },
  }, cachedTextNodes);
}
```

Update `resolveAnchor` (line 472):

```typescript
function resolveAnchor(anchor: Anchor, cachedTextNodes?: Text[]): Range | null {
  return resolveByPosition(anchor, cachedTextNodes) ?? resolveByQuote(anchor, cachedTextNodes);
}
```

- [ ] **Step 4: Use cached text nodes in batch render**

In the message handler's `shibei:render-highlights` case (around line 614), cache text nodes before the loop:

```typescript
case "shibei:render-highlights":
  if (Array.isArray(msg.highlights)) {
    const cachedNodes = getTextNodes(document.body);
    const failedIds: string[] = [];
    for (const hl of msg.highlights) {
      try {
        const range = resolveAnchor(hl.anchor, cachedNodes);
        if (range) {
          wrapRange(range, hl.id, hl.color);
        } else {
          console.warn("[shibei] Could not resolve anchor for:", hl.id);
          failedIds.push(hl.id);
        }
      } catch (e) {
        console.warn("[shibei] Failed to render highlight:", hl.id, e);
        failedIds.push(hl.id);
      }
    }
    const renderResult: RenderResultMsg = {
      type: "shibei:render-result",
      source: "shibei",
      failedIds,
    };
    window.parent.postMessage(renderResult, "*");
  }
  break;
```

Note: `shibei:add-highlight` continues to call `resolveAnchor(anchor)` without cache (no second argument), since DOM may have changed from previous highlight insertions.

- [ ] **Step 5: Build annotator and verify**

Run:
```bash
npm run build:annotator
cd src-tauri && cargo check
```
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/db/resources.rs src/annotator/annotator.ts src-tauri/src/annotator.js
git commit -m "perf: SQL pre-filter for find_by_url, cache text nodes in batch highlight rendering"
```

---

## Task 6: Error Feedback with Toast

**Files:**
- Modify: `package.json`
- Modify: `src/App.tsx:1-2, 51-73`
- Modify: `src/hooks/useAnnotations.ts:1, 19, 59, 74, 88, 104`
- Modify: `src/hooks/useResources.ts:1, 19`
- Modify: `src/hooks/useFolders.ts:1, 14`
- Modify: `src/components/ReaderView.tsx:1, 159`

- [ ] **Step 1: Install react-hot-toast**

Run:
```bash
npm install react-hot-toast
```
Expected: Package added to package.json and node_modules.

- [ ] **Step 2: Add Toaster to App.tsx**

In `src/App.tsx`, add the import and Toaster component:

Add import at top:
```typescript
import { Toaster } from "react-hot-toast";
```

Add `<Toaster />` inside the root div, after `TabBar`:
```tsx
return (
  <div className={styles.app}>
    <Toaster position="bottom-right" />
    <TabBar
      tabs={tabs}
      activeTabId={activeTabId}
      onSelectTab={setActiveTabId}
      onCloseTab={closeTab}
    />
    {/* ... rest unchanged */}
  </div>
);
```

- [ ] **Step 3: Add toast to useAnnotations.ts**

In `src/hooks/useAnnotations.ts`, add import:
```typescript
import toast from "react-hot-toast";
```

Replace each `console.error` with `toast.error` + `console.error`:

Line 19 (load failure):
```typescript
} catch (err) {
  console.error("Failed to load annotations:", err);
  toast.error("加载标注失败");
}
```

Line 59 (delete highlight):
```typescript
} catch (err) {
  console.error("Failed to delete highlight:", err);
  toast.error("删除高亮失败");
}
```

Line 74 (create comment):
```typescript
} catch (err) {
  console.error("Failed to create comment:", err);
  toast.error("创建评论失败");
  return null;
}
```

Line 88 (delete comment):
```typescript
} catch (err) {
  console.error("Failed to delete comment:", err);
  toast.error("删除评论失败");
}
```

Line 104 (edit comment):
```typescript
} catch (err) {
  console.error("Failed to update comment:", err);
  toast.error("编辑评论失败");
}
```

- [ ] **Step 4: Add toast to useResources.ts**

In `src/hooks/useResources.ts`, add import:
```typescript
import toast from "react-hot-toast";
```

Line 19 (load failure):
```typescript
} catch (err) {
  console.error("Failed to load resources:", err);
  toast.error("加载资料列表失败");
}
```

- [ ] **Step 5: Add toast to useFolders.ts**

In `src/hooks/useFolders.ts`, add import:
```typescript
import toast from "react-hot-toast";
```

Line 14 (load failure):
```typescript
} catch (err) {
  console.error("Failed to load folders:", err);
  toast.error("加载文件夹失败");
}
```

- [ ] **Step 6: Add toast to ReaderView.tsx**

In `src/components/ReaderView.tsx`, add import:
```typescript
import toast from "react-hot-toast";
```

Line 159 (create highlight failure):
```typescript
} catch (err) {
  console.error("Failed to create highlight:", err);
  toast.error("创建高亮失败");
}
```

- [ ] **Step 7: Verify TypeScript compilation**

Run:
```bash
npx tsc --noEmit
```
Expected: No errors.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/App.tsx src/hooks/useAnnotations.ts src/hooks/useResources.ts src/hooks/useFolders.ts src/components/ReaderView.tsx
git commit -m "feat: add react-hot-toast for user-visible error feedback"
```

---

## Verification Checklist

After all tasks are complete:

- [ ] `cd src-tauri && cargo check` — Rust compiles
- [ ] `cd src-tauri && cargo test` — All Rust tests pass
- [ ] `npx tsc --noEmit` — TypeScript compiles
- [ ] `npm run build` — Full build succeeds (includes annotator build)
- [ ] Manual test: Open app, open a resource in reader, create/delete highlights — verify toast on error, no console errors on success
- [ ] Manual test: Extension saves a page — verify sender validation doesn't break normal flow
