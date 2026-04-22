# Phase 3a: ArkWeb Reader + 标注系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 替换 `pages/Reader.ets` 占位符,让鸿蒙端能真正加载 snapshot.html、做 highlight / comment 标注,数据经 sync_log 走 LWW 同步,与桌面端互通。

**Architecture:**
- Rust NAPI 新增 7 个命令:`get_resource_html`(读 snapshot + 注入脚本)、`list_annotations`、`create_highlight` / `delete_highlight` / `update_highlight_color`、`create_comment` / `update_comment` / `delete_comment`。全部经 `SyncContext` 写 sync_log,保证和桌面同步语义一致。
- 新增一份独立的 `rawfile/annotator-mobile.js`(~350 行):从桌面 `annotator.js` 挪来 text_position / text_quote 锚点算法 + 高亮包裹 DOM,去掉桌面专属 UI(右键菜单、多色选择器),改用 `window.shibeiBridge` 调 ArkTS 方法。
- `pages/Reader.ets` 用 ArkWeb `Web` 组件 + `loadData(html, ...)` 加载已注入脚本的 HTML,`registerJavaScriptProxy` 暴露桥对象。右侧标注面板 `SideBarContainer(Overlay, End)`,默认折叠,点击展开。

**Tech Stack:** Rust + NAPI codegen / ArkTS / HarmonyOS NEXT @kit.ArkWeb / shibei-db highlights+comments

---

## File Structure

**新增文件:**
- `src-harmony-napi/src/annotations.rs` — NAPI 命令薄包装,转发到 shibei-db
- `shibei-harmony/entry/src/main/resources/rawfile/annotator-mobile.js` — 移动版标注脚本
- `shibei-harmony/entry/src/main/ets/components/AnnotationPanel.ets` — 右侧抽屉面板
- `shibei-harmony/entry/src/main/ets/components/AnnotationBridge.ets` — JS-bridge 实现
- `shibei-harmony/entry/src/main/ets/services/AnnotationsService.ets` — NAPI 包装,事件驱动

**修改文件:**
- `src-harmony-napi/src/commands.rs` — 加 7 个 `#[shibei_napi]`,加 `get_resource_html`
- `src-harmony-napi/src/lib.rs` — 暴露 annotations 模块
- `src-harmony-napi/src/state.rs` — `SyncContext::new_for_local()` 辅助(device_id + clock)
- `shibei-harmony/entry/src/main/ets/services/ShibeiService.ets` — 声明 NAPI 类型 + 封装
- `shibei-harmony/entry/src/main/ets/pages/Reader.ets` — 从占位符替换成真正的 ArkWeb + 抽屉
- `shibei-harmony/entry/types/libshibei_core/Index.d.ts` — 由 codegen 重新生成

---

## Task 1: Rust 侧 — 新增读 snapshot HTML 命令

**Files:**
- Modify: `src-harmony-napi/src/commands.rs` — 加 `get_resource_html`

- [ ] **Step 1: 写测试** — shibei-db 的 get_resource 已有测试;这个命令只是桥,行为测试靠手测。跳过单元测试,直接加 cargo check。

- [ ] **Step 2: 加命令 at `commands.rs` 末尾**

```rust
// ────────────────────────────────────────────────────────────
// Reader (Phase 3a)
// ────────────────────────────────────────────────────────────

/// Returns the snapshot HTML for a resource with the mobile annotator
/// injected into `<head>`. Script tags from the original page are stripped
/// first (same policy as desktop — `strip_script_tags`) so page JS can't
/// mutate the DOM on load and break anchor offsets.
///
/// Returns the HTML string, or `error.*` prefixed string on failure.
/// ArkTS checks `starts_with("error.")` before feeding to WebView.
///
/// The `annotator-mobile.js` content is embedded at compile time via
/// `include_str!`. The HAP ships a copy in `rawfile/` for reference
/// but this NAPI version is the one actually injected.
const ANNOTATOR_MOBILE_JS: &str = include_str!("../annotator-mobile.js");

#[shibei_napi]
pub fn get_resource_html(id: String) -> String {
    let app = match state::get() {
        Ok(a) => a,
        Err(e) => return format!("error.notInitialized: {e}"),
    };
    let html_path = app
        .data_dir
        .join("storage")
        .join(&id)
        .join("snapshot.html");
    let html = match std::fs::read_to_string(&html_path) {
        Ok(s) => s,
        Err(e) => return format!("error.snapshotNotFound: {e}"),
    };
    // Strip page scripts, then inject the annotator.
    let stripped = strip_scripts_and_inject(&html);
    stripped
}

fn strip_scripts_and_inject(html: &str) -> String {
    let stripped = strip_script_tags(html);
    let override_css = "<style>*{-webkit-user-select:text!important;user-select:text!important;}</style>";
    let script_tag = format!("{}<script>{}</script>", override_css, ANNOTATOR_MOBILE_JS);
    if let Some(pos) = stripped.find("</head>") {
        let mut r = stripped;
        r.insert_str(pos, &script_tag);
        r
    } else if let Some(pos) = stripped.find("<body") {
        let mut r = stripped;
        r.insert_str(pos, &script_tag);
        r
    } else {
        format!("{}{}", script_tag, stripped)
    }
}

/// Strip `<script …>…</script>` blocks. Matches only when the char after
/// "<script" is `>`, `/`, or ASCII whitespace. Copy of desktop lib.rs logic.
fn strip_script_tags(html: &str) -> String {
    let bytes = html.as_bytes();
    let mut out = String::with_capacity(html.len());
    let mut cursor = 0usize;
    while cursor < bytes.len() {
        let hit = match find_ci(bytes, cursor, b"<script") {
            Some(p) => p,
            None => break,
        };
        let after = hit + 7;
        let boundary = after >= bytes.len()
            || matches!(
                bytes[after],
                b'>' | b'/' | b' ' | b'\t' | b'\n' | b'\r' | 0x0c
            );
        if !boundary {
            out.push_str(&html[cursor..hit + 1]);
            cursor = hit + 1;
            continue;
        }
        out.push_str(&html[cursor..hit]);
        let open_end = match bytes[after..].iter().position(|&b| b == b'>') {
            Some(p) => after + p + 1,
            None => { cursor = bytes.len(); break; }
        };
        let close_hit = match find_ci(bytes, open_end, b"</script") {
            Some(p) => p,
            None => { cursor = bytes.len(); break; }
        };
        let close_end = match bytes[close_hit + 8..].iter().position(|&b| b == b'>') {
            Some(p) => close_hit + 8 + p + 1,
            None => { cursor = bytes.len(); break; }
        };
        cursor = close_end;
    }
    if cursor < bytes.len() { out.push_str(&html[cursor..]); }
    out
}

fn find_ci(haystack: &[u8], start: usize, needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || start >= haystack.len() { return None; }
    let mut i = start;
    while i + needle.len() <= haystack.len() {
        let mut ok = true;
        for j in 0..needle.len() {
            let a = haystack[i + j].to_ascii_lowercase();
            let b = needle[j].to_ascii_lowercase();
            if a != b { ok = false; break; }
        }
        if ok { return Some(i); }
        i += 1;
    }
    None
}
```

- [ ] **Step 3: 先占位 annotator-mobile.js 让 include_str! 编得过**

```bash
touch /Users/work/workspace/Shibei/src-harmony-napi/src/annotator-mobile.js
```

文件内容暂时留空,Task 4 再填。

- [ ] **Step 4: 跑 codegen**

```bash
cd /Users/work/workspace/Shibei && cargo run -p shibei-napi-codegen
```

预期:`shibei-harmony/entry/types/libshibei_core/Index.d.ts` 多出 `getResourceHtml(id: string): string`。

- [ ] **Step 5: cargo check**

```bash
cd /Users/work/workspace/Shibei && cargo check -p shibei-napi
```

预期:PASS。

- [ ] **Step 6: 提交**

```bash
git add src-harmony-napi/src/commands.rs src-harmony-napi/src/annotator-mobile.js shibei-harmony/entry/types/libshibei_core/
git commit -m "feat(harmony): NAPI getResourceHtml with annotator injection"
```

---

## Task 2: Rust 侧 — SyncContext 本地辅助 + annotations 模块骨架

每个标注命令都要传 `SyncContext { device_id, clock }`,但 `AppState` 已经存了 `device_id`,没存 clock。桌面端每个命令临时构造 clock;鸿蒙端沿用这个模式。

**Files:**
- Create: `src-harmony-napi/src/annotations.rs`
- Modify: `src-harmony-napi/src/lib.rs`
- Modify: `src-harmony-napi/src/state.rs`

- [ ] **Step 1: state.rs 加 `make_sync_context()` 辅助**

在 `src-harmony-napi/src/state.rs` 中已有的 `AppState` impl 块末尾加:

```rust
impl AppState {
    /// Build a SyncContext tied to this device for writing sync_log.
    /// Returned handle owns the clock, safe to pass `Some(&ctx)` to db ops.
    pub fn make_sync_context(&self) -> shibei_db::SyncContext<'_> {
        // Clock is created per-call; HLC is monotonic per logical-entry
        // regardless of clock-instance identity — only the device_id in
        // sync_log matters for LWW conflict resolution.
        shibei_db::SyncContext {
            device_id: &self.device_id,
            clock: Box::leak(Box::new(shibei_db::hlc::HlcClock::new(self.device_id.clone()))),
        }
    }
}
```

**⚠️ 注意:** 要先看 `shibei_db::SyncContext` 的实际字段。如果 `clock` 是 `&HlcClock` 引用,leak 是 OK 的(每命令泄露 ~40B 内存可忽略)。如果 `clock: Arc<HlcClock>` 则换 Arc::new。先读 `crates/shibei-db/src/lib.rs` 的 SyncContext 定义再决定。

- [ ] **Step 2: 读 SyncContext 定义**

```bash
grep -n "SyncContext" /Users/work/workspace/Shibei/crates/shibei-db/src/lib.rs
```

根据实际签名调整 Step 1 的代码(把 `Box::leak` 换成 `Arc::new` 如果是 Arc)。

- [ ] **Step 3: 创建 `annotations.rs`**

文件骨架(空 mod,Task 3 填命令):

```rust
//! Annotation NAPI bindings (Phase 3a).
//!
//! Thin wrappers around `shibei_db::highlights` / `shibei_db::comments`
//! that surface i18n-shaped error codes to ArkTS and always write to
//! sync_log via `AppState::make_sync_context()`.

// Implementations live directly in commands.rs per project convention —
// this file is kept only so future larger annotation features have a
// clear home. Delete if still empty in Phase 3b.
```

实际命令直接加在 `commands.rs` 里(和 list_folders 同级风格)。先留空注释文件备用。

- [ ] **Step 4: lib.rs 声明模块(如果需要)** — 如果只留注释文件,skip。直接 cargo check 确保上一步改动编过:

```bash
cd /Users/work/workspace/Shibei && cargo check -p shibei-napi
```

- [ ] **Step 5: 提交**

```bash
git add src-harmony-napi/src/state.rs src-harmony-napi/src/annotations.rs
git commit -m "chore(harmony): SyncContext helper for annotation commands"
```

---

## Task 3: Rust 侧 — 7 个标注 NAPI 命令

**Files:**
- Modify: `src-harmony-napi/src/commands.rs`

- [ ] **Step 1: 加 `list_annotations`**

在 `commands.rs` 的 "Reader (Phase 3a)" 段之后:

```rust
// ────────────────────────────────────────────────────────────
// Annotations (Phase 3a)
// ────────────────────────────────────────────────────────────

/// Returns JSON envelope `{"highlights":[...], "comments":[...]}` for a
/// resource. Soft-deleted rows are filtered server-side.
#[shibei_napi]
pub fn list_annotations(resource_id: String) -> String {
    let result = with_conn(|conn| {
        let highlights = shibei_db::highlights::get_highlights_for_resource(conn, &resource_id)?;
        let comments = shibei_db::comments::get_comments_for_resource(conn, &resource_id)?;
        Ok((highlights, comments))
    });
    match result {
        Ok((h, c)) => {
            let h_json = serde_json::to_string(&h).unwrap_or_else(|_| "[]".into());
            let c_json = serde_json::to_string(&c).unwrap_or_else(|_| "[]".into());
            format!(r#"{{"highlights":{h_json},"comments":{c_json}}}"#)
        }
        Err(e) => format!(r#"{{"error":"{e}"}}"#),
    }
}

/// Input JSON: `{"resourceId":"...", "textContent":"...", "anchor":{...}, "color":"#RRGGBB"}`.
/// Returns: `{"highlight":{...}}` | `{"error":"..."}`.
/// Anchor stored verbatim as JSON — mobile annotator emits HTML-shaped
/// anchors `{text_position, text_quote}`.
#[shibei_napi]
pub fn create_highlight(input_json: String) -> String {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Input {
        resource_id: String,
        text_content: String,
        anchor: serde_json::Value,
        color: String,
    }
    let input: Input = match serde_json::from_str(&input_json) {
        Ok(v) => v,
        Err(e) => return format!(r#"{{"error":"error.badInput: {e}"}}"#),
    };
    let app = match state::get() {
        Ok(a) => a,
        Err(e) => return format!(r#"{{"error":"{e}"}}"#),
    };
    let ctx = app.make_sync_context();
    let result = with_conn(|conn| {
        shibei_db::highlights::create_highlight(
            conn,
            &input.resource_id,
            &input.text_content,
            &input.anchor,
            &input.color,
            Some(&ctx),
        )
    });
    match result {
        Ok(h) => {
            let h_json = serde_json::to_string(&h).unwrap_or_default();
            format!(r#"{{"highlight":{h_json}}}"#)
        }
        Err(e) => format!(r#"{{"error":"{e}"}}"#),
    }
}

#[shibei_napi]
pub fn delete_highlight(id: String) -> String {
    let app = match state::get() {
        Ok(a) => a,
        Err(e) => return format!("error.{e}"),
    };
    let ctx = app.make_sync_context();
    let result = with_conn(|conn| shibei_db::highlights::delete_highlight(conn, &id, Some(&ctx)));
    match result {
        Ok(()) => "ok".to_string(),
        Err(e) => format!("error.{e}"),
    }
}

#[shibei_napi]
pub fn update_highlight_color(id: String, color: String) -> String {
    let app = match state::get() {
        Ok(a) => a,
        Err(e) => return format!(r#"{{"error":"{e}"}}"#),
    };
    let ctx = app.make_sync_context();
    let result = with_conn(|conn| {
        shibei_db::highlights::update_highlight_color(conn, &id, &color, Some(&ctx))
    });
    match result {
        Ok(h) => format!(r#"{{"highlight":{}}}"#, serde_json::to_string(&h).unwrap_or_default()),
        Err(e) => format!(r#"{{"error":"{e}"}}"#),
    }
}

/// Input JSON: `{"resourceId":"...", "highlightId":"..."|null, "content":"..."}`.
#[shibei_napi]
pub fn create_comment(input_json: String) -> String {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Input {
        resource_id: String,
        highlight_id: Option<String>,
        content: String,
    }
    let input: Input = match serde_json::from_str(&input_json) {
        Ok(v) => v,
        Err(e) => return format!(r#"{{"error":"error.badInput: {e}"}}"#),
    };
    let app = match state::get() {
        Ok(a) => a,
        Err(e) => return format!(r#"{{"error":"{e}"}}"#),
    };
    let ctx = app.make_sync_context();
    let result = with_conn(|conn| {
        shibei_db::comments::create_comment(
            conn,
            &input.resource_id,
            input.highlight_id.as_deref(),
            &input.content,
            Some(&ctx),
        )
    });
    match result {
        Ok(c) => format!(r#"{{"comment":{}}}"#, serde_json::to_string(&c).unwrap_or_default()),
        Err(e) => format!(r#"{{"error":"{e}"}}"#),
    }
}

#[shibei_napi]
pub fn update_comment(id: String, content: String) -> String {
    let app = match state::get() {
        Ok(a) => a,
        Err(e) => return format!("error.{e}"),
    };
    let ctx = app.make_sync_context();
    let result = with_conn(|conn| shibei_db::comments::update_comment(conn, &id, &content, Some(&ctx)));
    match result {
        Ok(()) => "ok".to_string(),
        Err(e) => format!("error.{e}"),
    }
}

#[shibei_napi]
pub fn delete_comment(id: String) -> String {
    let app = match state::get() {
        Ok(a) => a,
        Err(e) => return format!("error.{e}"),
    };
    let ctx = app.make_sync_context();
    let result = with_conn(|conn| shibei_db::comments::delete_comment(conn, &id, Some(&ctx)));
    match result {
        Ok(()) => "ok".to_string(),
        Err(e) => format!("error.{e}"),
    }
}
```

- [ ] **Step 2: 跑 codegen + cargo check**

```bash
cd /Users/work/workspace/Shibei && cargo run -p shibei-napi-codegen && cargo check -p shibei-napi
```

预期:`Index.d.ts` 新增 7 个函数,check PASS。

- [ ] **Step 3: 提交**

```bash
git add src-harmony-napi/src/commands.rs shibei-harmony/entry/types/libshibei_core/
git commit -m "feat(harmony): 7 NAPI commands for highlights + comments"
```

---

## Task 4: annotator-mobile.js — 移动版标注脚本

从桌面 `src-tauri/src/annotator.js` 抄 text_position/text_quote 锚点算法,去掉桌面专属的右键菜单+多色选择器,改用 `window.shibeiBridge`。

**Files:**
- Modify: `src-harmony-napi/src/annotator-mobile.js`(Task 1 已建空文件)

- [ ] **Step 1: 通读桌面 annotator.js 确认要抄的部分**

```bash
wc -l /Users/work/workspace/Shibei/src-tauri/src/annotator.js
```

目标函数(按桌面 annotator.js 内的节名):
- 所有 `getTextNodes` / `normalizedLength` / `rawOffset`(text offset utilities)
- `buildAnchor(range)` / `resolveAnchor(anchor)`(anchor core)
- `wrapHighlight(range, id, color)`(dom wrap)
- 不要:context menu、flash animation、comment-on-text inline UI、postMessage 桥

- [ ] **Step 2: 写 annotator-mobile.js**

完整文件内容(覆盖 Task 1 占位):

```javascript
"use strict";
// Shibei annotator — mobile (ArkWeb) edition.
//
// Communicates with ArkTS via window.shibeiBridge (registerJavaScriptProxy):
//   shibeiBridge.emit(type: string, json: string)      — fire-and-forget event
//   shibeiBridge.ack(id: string, json: string)         — response to a request
//
// Event types emitted to ArkTS:
//   "selection"  → { textContent, anchor, rectJson }
//   "click"      → { highlightId, rectJson }
//   "ready"      → { resourceId: "" }  (annotator loaded; ArkTS can call paintHighlights)
//
// ArkTS calls into JS via webviewController.runJavaScript:
//   window.__shibei.paintHighlights(list)   — apply list of highlights
//   window.__shibei.flashHighlight(id)      — scroll-to and flash
//   window.__shibei.clearSelection()        — clear current window selection
//
// No page-script stripping here — Rust did that before sending HTML.

(function () {
  const bridge = window.shibeiBridge;
  if (!bridge) {
    console.warn("[annotator-mobile] shibeiBridge missing, skipping init");
    return;
  }
  const state = { highlightsById: new Map() };

  // ── Styles ──
  const style = document.createElement("style");
  style.textContent = `
    shibei-hl {
      background: var(--shibei-hl-color, #ffeb3b) !important;
      color: inherit !important;
      border-radius: 2px !important;
    }
    shibei-hl.shibei-flash {
      animation: shibei-flash-anim 0.6s ease-in-out !important;
    }
    @keyframes shibei-flash-anim {
      0%, 100% { filter: brightness(1); }
      50% { filter: brightness(0.6); }
    }
  `;
  document.documentElement.appendChild(style);

  // ── Text offset utilities ──
  const EXCLUDED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
  const ZERO_WIDTH_RE = /[​‌‍﻿]/g;
  function normalizedLength(text) { return text.replace(ZERO_WIDTH_RE, "").length; }
  function normalizedText(text) { return text.replace(ZERO_WIDTH_RE, ""); }

  function getTextNodes(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_ACCEPT;
        if (EXCLUDED_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  function nodeOffset(targetNode, targetOffset) {
    const nodes = getTextNodes(document.body);
    let acc = 0;
    for (const n of nodes) {
      if (n === targetNode) {
        const raw = n.nodeValue || "";
        const prefix = raw.slice(0, targetOffset);
        return acc + normalizedLength(prefix);
      }
      acc += normalizedLength(n.nodeValue || "");
    }
    return -1;
  }

  function locateOffset(offset) {
    const nodes = getTextNodes(document.body);
    let acc = 0;
    for (const n of nodes) {
      const raw = n.nodeValue || "";
      const len = normalizedLength(raw);
      if (offset <= acc + len) {
        let rem = offset - acc;
        let i = 0;
        while (i < raw.length && rem > 0) {
          if (!/[​‌‍﻿]/.test(raw[i])) rem--;
          i++;
        }
        return { node: n, offset: i };
      }
      acc += len;
    }
    return null;
  }

  function buildAnchor(range) {
    const startOff = nodeOffset(range.startContainer, range.startOffset);
    const endOff = nodeOffset(range.endContainer, range.endOffset);
    if (startOff < 0 || endOff < 0 || endOff <= startOff) return null;
    const text = normalizedText(range.toString());
    const bodyText = normalizedText(document.body.innerText || "");
    const prefix = bodyText.slice(Math.max(0, startOff - 32), startOff);
    const suffix = bodyText.slice(endOff, Math.min(bodyText.length, endOff + 32));
    return {
      text_position: { start: startOff, end: endOff },
      text_quote: { exact: text, prefix, suffix }
    };
  }

  function resolveAnchor(anchor) {
    if (!anchor || !anchor.text_position) return null;
    const start = locateOffset(anchor.text_position.start);
    const end = locateOffset(anchor.text_position.end);
    if (!start || !end) return null;
    const range = document.createRange();
    try {
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
    } catch (_) { return null; }
    // Verify by exact text; if mismatch, fallback to text_quote search (Phase 3b).
    const got = normalizedText(range.toString());
    const want = anchor.text_quote && anchor.text_quote.exact;
    if (want && got !== want) return null;
    return range;
  }

  function wrapHighlight(range, id, color) {
    const nodes = [];
    const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) {
      if (range.intersectsNode(n)) nodes.push(n);
    }
    const wrapped = [];
    for (const node of nodes) {
      const startOff = node === range.startContainer ? range.startOffset : 0;
      const endOff = node === range.endContainer ? range.endOffset : (node.nodeValue || "").length;
      if (endOff <= startOff) continue;
      const before = (node.nodeValue || "").slice(0, startOff);
      const mid = (node.nodeValue || "").slice(startOff, endOff);
      const after = (node.nodeValue || "").slice(endOff);
      const hl = document.createElement("shibei-hl");
      hl.setAttribute("data-shibei-id", id);
      hl.style.setProperty("--shibei-hl-color", color || "#ffeb3b");
      hl.textContent = mid;
      const parent = node.parentNode;
      if (!parent) continue;
      const frag = document.createDocumentFragment();
      if (before) frag.appendChild(document.createTextNode(before));
      frag.appendChild(hl);
      if (after) frag.appendChild(document.createTextNode(after));
      parent.replaceChild(frag, node);
      wrapped.push(hl);
    }
    for (const el of wrapped) {
      el.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const rect = el.getBoundingClientRect();
        bridge.emit("click", JSON.stringify({
          highlightId: id,
          rectJson: { x: rect.left, y: rect.top, w: rect.width, h: rect.height }
        }));
      });
    }
  }

  function unwrapHighlight(id) {
    const els = document.querySelectorAll(`shibei-hl[data-shibei-id="${CSS.escape(id)}"]`);
    els.forEach(el => {
      const parent = el.parentNode;
      if (!parent) return;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
      parent.normalize();
    });
  }

  // ── Public API (called by ArkTS via runJavaScript) ──
  window.__shibei = {
    paintHighlights(listJson) {
      let list;
      try { list = JSON.parse(listJson); } catch (_) { return; }
      for (const h of list || []) {
        if (state.highlightsById.has(h.id)) continue;
        const range = resolveAnchor(h.anchor);
        if (!range) continue;
        wrapHighlight(range, h.id, h.color);
        state.highlightsById.set(h.id, h);
      }
    },
    removeHighlight(id) {
      unwrapHighlight(id);
      state.highlightsById.delete(id);
    },
    flashHighlight(id) {
      const el = document.querySelector(`shibei-hl[data-shibei-id="${CSS.escape(id)}"]`);
      if (!el) return;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.add("shibei-flash");
      setTimeout(() => el.classList.remove("shibei-flash"), 800);
    },
    clearSelection() {
      const sel = window.getSelection();
      if (sel) sel.removeAllRanges();
    }
  };

  // ── Selection watcher ──
  // Fires "selection" when user finishes selecting; debounced to the
  // selectionchange settled state (250ms after last change).
  let selectionTimer = null;
  document.addEventListener("selectionchange", () => {
    if (selectionTimer) clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        bridge.emit("selection", JSON.stringify({ collapsed: true }));
        return;
      }
      const range = sel.getRangeAt(0);
      const text = range.toString().trim();
      if (!text) {
        bridge.emit("selection", JSON.stringify({ collapsed: true }));
        return;
      }
      const anchor = buildAnchor(range);
      if (!anchor) return;
      const rect = range.getBoundingClientRect();
      bridge.emit("selection", JSON.stringify({
        collapsed: false,
        textContent: text,
        anchor,
        rectJson: { x: rect.left, y: rect.top, w: rect.width, h: rect.height }
      }));
    }, 250);
  });

  // Signal ready after DOMContentLoaded (idempotent if already past).
  function fireReady() {
    bridge.emit("ready", JSON.stringify({ resourceId: "" }));
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", fireReady);
  } else {
    fireReady();
  }
})();
```

- [ ] **Step 3: cargo check(确认 include_str! 仍成立)**

```bash
cd /Users/work/workspace/Shibei && cargo check -p shibei-napi
```

- [ ] **Step 4: 提交**

```bash
git add src-harmony-napi/src/annotator-mobile.js
git commit -m "feat(harmony): mobile annotator script for ArkWeb"
```

---

## Task 5: ShibeiService.ets — 封装 7 个新 NAPI + getResourceHtml

**Files:**
- Modify: `shibei-harmony/entry/src/main/ets/services/ShibeiService.ets`

- [ ] **Step 1: 更新 import 列表**

在文件顶部 named imports 里追加:

```typescript
  getResourceHtml as napiGetResourceHtml,
  listAnnotations as napiListAnnotations,
  createHighlight as napiCreateHighlight,
  deleteHighlight as napiDeleteHighlight,
  updateHighlightColor as napiUpdateHighlightColor,
  createComment as napiCreateComment,
  updateComment as napiUpdateComment,
  deleteComment as napiDeleteComment,
```

- [ ] **Step 2: 新增接口类型**

在 types 区(Resource 附近):

```typescript
export interface Highlight {
  id: string;
  resource_id: string;
  text_content: string;
  anchor: Object;
  color: string;
  created_at: string;
}

export interface Comment {
  id: string;
  highlight_id: string | null;
  resource_id: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface AnnotationsBundle {
  highlights: Highlight[];
  comments: Comment[];
}

interface HighlightEnvelope { highlight?: Highlight; error?: string; }
interface CommentEnvelope { comment?: Comment; error?: string; }
interface AnnotationsEnvelope { highlights?: Highlight[]; comments?: Comment[]; error?: string; }
```

- [ ] **Step 3: 新增方法到 ShibeiService 类**

```typescript
  // ── Reader ────────────────────────────────────────────────

  /// Returns the snapshot HTML for `id` with annotator-mobile.js already
  /// injected. Throws ShibeiError if the resource has no snapshot on disk
  /// (e.g. sync hasn't downloaded it yet — caller should trigger download).
  getResourceHtml(id: string): string {
    const result: string = napiGetResourceHtml(id);
    if (result.startsWith('error.')) {
      throw new ShibeiError(result);
    }
    return result;
  }

  // ── Annotations ───────────────────────────────────────────

  listAnnotations(resourceId: string): AnnotationsBundle {
    const raw: string = napiListAnnotations(resourceId);
    const parsed = JSON.parse(raw) as AnnotationsEnvelope;
    if (parsed.error) throw new ShibeiError(parsed.error);
    return {
      highlights: parsed.highlights ?? [],
      comments: parsed.comments ?? [],
    };
  }

  createHighlight(
    resourceId: string,
    textContent: string,
    anchor: Object,
    color: string,
  ): Highlight {
    const payload = JSON.stringify({
      resourceId,
      textContent,
      anchor,
      color,
    });
    const raw: string = napiCreateHighlight(payload);
    const parsed = JSON.parse(raw) as HighlightEnvelope;
    if (parsed.error) throw new ShibeiError(parsed.error);
    if (!parsed.highlight) throw new ShibeiError('error.unexpectedResponse');
    return parsed.highlight;
  }

  deleteHighlight(id: string): void {
    const result: string = napiDeleteHighlight(id);
    if (result !== 'ok') throw new ShibeiError(result);
  }

  updateHighlightColor(id: string, color: string): Highlight {
    const raw: string = napiUpdateHighlightColor(id, color);
    const parsed = JSON.parse(raw) as HighlightEnvelope;
    if (parsed.error) throw new ShibeiError(parsed.error);
    if (!parsed.highlight) throw new ShibeiError('error.unexpectedResponse');
    return parsed.highlight;
  }

  createComment(
    resourceId: string,
    highlightId: string | null,
    content: string,
  ): Comment {
    const payload = JSON.stringify({ resourceId, highlightId, content });
    const raw: string = napiCreateComment(payload);
    const parsed = JSON.parse(raw) as CommentEnvelope;
    if (parsed.error) throw new ShibeiError(parsed.error);
    if (!parsed.comment) throw new ShibeiError('error.unexpectedResponse');
    return parsed.comment;
  }

  updateComment(id: string, content: string): void {
    const result: string = napiUpdateComment(id, content);
    if (result !== 'ok') throw new ShibeiError(result);
  }

  deleteComment(id: string): void {
    const result: string = napiDeleteComment(id);
    if (result !== 'ok') throw new ShibeiError(result);
  }
```

- [ ] **Step 4: build HAP 不会跑,先靠 hvigor IDE 手测 编译。如果没 IDE,移至 Task 9 集成测。** 跳过编译步骤。

- [ ] **Step 5: 提交**

```bash
git add shibei-harmony/entry/src/main/ets/services/ShibeiService.ets
git commit -m "feat(harmony): ShibeiService methods for annotations + reader HTML"
```

---

## Task 6: AnnotationsService.ets — 事件 + 通知层

让 Reader 和未来的其他页面订阅"某资料的标注变了"。**选择实现路径:** 直接用 emitter,不引入新的 ArkTS event bus——每次 mutation 后在 AnnotationsService 里 emit DOM-like callback。

**Files:**
- Create: `shibei-harmony/entry/src/main/ets/services/AnnotationsService.ets`

- [ ] **Step 1: 写文件**

```typescript
// Façade over ShibeiService that tracks annotations per-resource with a
// local in-memory cache and notifies subscribers on mutation. Reader uses
// this instead of calling ShibeiService directly so painting highlights
// and updating the panel stay in sync.

import { ShibeiService, Highlight, Comment, AnnotationsBundle } from './ShibeiService';

type Listener = (bundle: AnnotationsBundle) => void;

export class AnnotationsService {
  private static _instance: AnnotationsService | null = null;

  static get instance(): AnnotationsService {
    if (!AnnotationsService._instance) {
      AnnotationsService._instance = new AnnotationsService();
    }
    return AnnotationsService._instance;
  }

  private cache: Map<string, AnnotationsBundle> = new Map();
  private listeners: Map<string, Listener[]> = new Map();

  private notify(resourceId: string): void {
    const bundle = this.cache.get(resourceId);
    if (!bundle) return;
    const subs = this.listeners.get(resourceId) ?? [];
    // Copy before iterating so a listener can unsubscribe itself mid-dispatch.
    for (const fn of subs.slice()) fn(bundle);
  }

  subscribe(resourceId: string, fn: Listener): () => void {
    const list = this.listeners.get(resourceId) ?? [];
    list.push(fn);
    this.listeners.set(resourceId, list);
    return () => {
      const cur = this.listeners.get(resourceId) ?? [];
      this.listeners.set(resourceId, cur.filter(x => x !== fn));
    };
  }

  async load(resourceId: string): Promise<AnnotationsBundle> {
    const bundle = ShibeiService.instance.listAnnotations(resourceId);
    this.cache.set(resourceId, bundle);
    this.notify(resourceId);
    return bundle;
  }

  get(resourceId: string): AnnotationsBundle {
    return this.cache.get(resourceId) ?? { highlights: [], comments: [] };
  }

  createHighlight(
    resourceId: string,
    textContent: string,
    anchor: Object,
    color: string,
  ): Highlight {
    const h = ShibeiService.instance.createHighlight(resourceId, textContent, anchor, color);
    const cur = this.get(resourceId);
    const next: AnnotationsBundle = { highlights: cur.highlights.concat([h]), comments: cur.comments };
    this.cache.set(resourceId, next);
    this.notify(resourceId);
    return h;
  }

  deleteHighlight(resourceId: string, id: string): void {
    ShibeiService.instance.deleteHighlight(id);
    const cur = this.get(resourceId);
    const next: AnnotationsBundle = {
      highlights: cur.highlights.filter(h => h.id !== id),
      comments: cur.comments.filter(c => c.highlight_id !== id),
    };
    this.cache.set(resourceId, next);
    this.notify(resourceId);
  }

  updateHighlightColor(resourceId: string, id: string, color: string): void {
    const updated = ShibeiService.instance.updateHighlightColor(id, color);
    const cur = this.get(resourceId);
    const next: AnnotationsBundle = {
      highlights: cur.highlights.map(h => h.id === id ? updated : h),
      comments: cur.comments,
    };
    this.cache.set(resourceId, next);
    this.notify(resourceId);
  }

  createComment(
    resourceId: string,
    highlightId: string | null,
    content: string,
  ): Comment {
    const c = ShibeiService.instance.createComment(resourceId, highlightId, content);
    const cur = this.get(resourceId);
    const next: AnnotationsBundle = { highlights: cur.highlights, comments: cur.comments.concat([c]) };
    this.cache.set(resourceId, next);
    this.notify(resourceId);
    return c;
  }

  updateComment(resourceId: string, id: string, content: string): void {
    ShibeiService.instance.updateComment(id, content);
    const cur = this.get(resourceId);
    const now = new Date().toISOString();
    const next: AnnotationsBundle = {
      highlights: cur.highlights,
      comments: cur.comments.map(c => c.id === id ? { ...c, content, updated_at: now } : c),
    };
    this.cache.set(resourceId, next);
    this.notify(resourceId);
  }

  deleteComment(resourceId: string, id: string): void {
    ShibeiService.instance.deleteComment(id);
    const cur = this.get(resourceId);
    const next: AnnotationsBundle = {
      highlights: cur.highlights,
      comments: cur.comments.filter(c => c.id !== id),
    };
    this.cache.set(resourceId, next);
    this.notify(resourceId);
  }
}
```

- [ ] **Step 2: 提交**

```bash
git add shibei-harmony/entry/src/main/ets/services/AnnotationsService.ets
git commit -m "feat(harmony): AnnotationsService cache + subscriber API"
```

---

## Task 7: AnnotationBridge.ets — JS bridge 对象 + 事件路由

`registerJavaScriptProxy(this.bridge, 'shibeiBridge', ['emit'])` 里的 `this.bridge` 必须是一个普通 ArkTS 对象(非 @ObservedV2 类),方法签名 `(...args: string[]) => string` 或 `() => void`。

**Files:**
- Create: `shibei-harmony/entry/src/main/ets/components/AnnotationBridge.ets`

- [ ] **Step 1: 写文件**

```typescript
import { hilog } from '@kit.PerformanceAnalysisKit';

// Payloads emitted by annotator-mobile.js.
// Every field may be absent on error paths — guard in the handler.
export interface SelectionPayload {
  collapsed?: boolean;
  textContent?: string;
  anchor?: Object;
  rectJson?: { x: number; y: number; w: number; h: number };
}

export interface ClickPayload {
  highlightId?: string;
  rectJson?: { x: number; y: number; w: number; h: number };
}

export interface ReadyPayload {
  resourceId?: string;
}

export interface BridgeHandlers {
  onSelection: (p: SelectionPayload) => void;
  onClick: (p: ClickPayload) => void;
  onReady: (p: ReadyPayload) => void;
}

/// The object that gets wired into the WebView via registerJavaScriptProxy.
/// `emit(type, json)` is called from annotator-mobile.js; we route by `type`.
/// Sync-only because registerJavaScriptProxy doesn't support async returns.
export class AnnotationBridge {
  private handlers: BridgeHandlers;

  constructor(handlers: BridgeHandlers) {
    this.handlers = handlers;
  }

  emit(type: string, json: string): void {
    try {
      const payload = JSON.parse(json) as Object;
      if (type === 'selection') {
        this.handlers.onSelection(payload as SelectionPayload);
      } else if (type === 'click') {
        this.handlers.onClick(payload as ClickPayload);
      } else if (type === 'ready') {
        this.handlers.onReady(payload as ReadyPayload);
      } else {
        hilog.warn(0x0000, 'shibei', 'bridge unknown type=%{public}s', type);
      }
    } catch (err) {
      hilog.warn(0x0000, 'shibei', 'bridge parse fail: %{public}s', (err as Error).message);
    }
  }
}
```

- [ ] **Step 2: 提交**

```bash
git add shibei-harmony/entry/src/main/ets/components/AnnotationBridge.ets
git commit -m "feat(harmony): JS-bridge class for annotator events"
```

---

## Task 8: AnnotationPanel.ets — 右侧抽屉组件

折叠态 32px 宽竖条,显示高亮色点 + 数量;展开态列表,按高亮分组显示评论,可编辑/删除。

**Files:**
- Create: `shibei-harmony/entry/src/main/ets/components/AnnotationPanel.ets`

- [ ] **Step 1: 写文件**

```typescript
import { Highlight, Comment, AnnotationsBundle } from '../services/ShibeiService';

@Component
export struct AnnotationPanel {
  @Prop bundle: AnnotationsBundle = { highlights: [], comments: [] };
  // Emits the highlight id to scroll to; Reader calls runJavaScript to flash.
  onTapHighlight: (id: string) => void = () => {};
  onDeleteHighlight: (id: string) => void = () => {};
  onAddResourceComment: () => void = () => {};
  onEditComment: (id: string) => void = () => {};
  onDeleteComment: (id: string) => void = () => {};

  build() {
    Column() {
      // Header
      Row() {
        Text(`标注 (${this.bundle.highlights.length})`)
          .fontSize(16).fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .layoutWeight(1);
        Text('+ 备注')
          .fontSize(13).fontColor($r('sys.color.ohos_id_color_emphasize'))
          .padding({ left: 8, right: 8, top: 4, bottom: 4 })
          .onClick(() => this.onAddResourceComment());
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 12, bottom: 8 });

      Divider().strokeWidth(0.5).color($r('sys.color.ohos_id_color_list_separator'));

      // Body — scrollable list
      Scroll() {
        Column() {
          ForEach(this.bundle.highlights, (h: Highlight) => {
            this.HighlightCard(h);
          }, (h: Highlight) => h.id);

          if (this.resourceComments().length > 0) {
            Text('笔记').fontSize(13)
              .fontColor($r('sys.color.ohos_id_color_text_secondary'))
              .padding({ left: 12, right: 12, top: 16, bottom: 4 });
            ForEach(this.resourceComments(), (c: Comment) => {
              this.CommentCard(c);
            }, (c: Comment) => c.id);
          }

          if (this.bundle.highlights.length === 0 && this.resourceComments().length === 0) {
            Column() {
              Text('长按页面文字创建高亮').fontSize(13)
                .fontColor($r('sys.color.ohos_id_color_text_tertiary'))
                .textAlign(TextAlign.Center);
            }
            .width('100%').padding(32);
          }
        }
        .width('100%');
      }
      .layoutWeight(1)
      .width('100%')
      .align(Alignment.Top);
    }
    .width('100%').height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'));
  }

  private resourceComments(): Comment[] {
    return this.bundle.comments.filter((c: Comment) => !c.highlight_id);
  }

  private commentsFor(hlId: string): Comment[] {
    return this.bundle.comments.filter((c: Comment) => c.highlight_id === hlId);
  }

  @Builder HighlightCard(h: Highlight) {
    Column() {
      Row() {
        // Color dot.
        Circle({ width: 10, height: 10 }).fill(h.color);
        Text(h.text_content)
          .fontSize(14).maxLines(3).textOverflow({ overflow: TextOverflow.Ellipsis })
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .layoutWeight(1)
          .margin({ left: 8 });
        Text('×').fontSize(18)
          .fontColor($r('sys.color.ohos_id_color_text_tertiary'))
          .width(28).height(28).textAlign(TextAlign.Center)
          .onClick(() => this.onDeleteHighlight(h.id));
      }
      .width('100%').alignItems(VerticalAlign.Top);

      ForEach(this.commentsFor(h.id), (c: Comment) => {
        Row() {
          Text(c.content).fontSize(13)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .layoutWeight(1);
        }
        .width('100%')
        .padding({ left: 18, top: 4, right: 4 })
        .onClick(() => this.onEditComment(c.id));
      }, (c: Comment) => c.id);
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 8, bottom: 8 })
    .onClick(() => this.onTapHighlight(h.id));
  }

  @Builder CommentCard(c: Comment) {
    Row() {
      Text(c.content).fontSize(14)
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
        .layoutWeight(1);
      Text('×').fontSize(18)
        .fontColor($r('sys.color.ohos_id_color_text_tertiary'))
        .width(28).height(28).textAlign(TextAlign.Center)
        .onClick(() => this.onDeleteComment(c.id));
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 8, bottom: 8 })
    .onClick(() => this.onEditComment(c.id));
  }
}
```

- [ ] **Step 2: 提交**

```bash
git add shibei-harmony/entry/src/main/ets/components/AnnotationPanel.ets
git commit -m "feat(harmony): AnnotationPanel right-drawer component"
```

---

## Task 9: Reader.ets — 替换占位符

集成所有之前的部件:ArkWeb 加载 HTML、bridge 路由事件、选择浮动条创建高亮、右抽屉切换展开/折叠。

**Files:**
- Modify: `shibei-harmony/entry/src/main/ets/pages/Reader.ets`

- [ ] **Step 1: 先读当前占位符记录 import/结构**

```bash
cat /Users/work/workspace/Shibei/shibei-harmony/entry/src/main/ets/pages/Reader.ets
```

- [ ] **Step 2: 整文件重写**

```typescript
import { webview } from '@kit.ArkWeb';
import { router } from '@kit.ArkUI';
import { promptAction } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { ShibeiService, Resource } from '../services/ShibeiService';
import { AnnotationsService } from '../services/AnnotationsService';
import {
  AnnotationBridge,
  SelectionPayload,
  ClickPayload,
  ReadyPayload,
} from '../components/AnnotationBridge';
import { AnnotationPanel } from '../components/AnnotationPanel';
import { AnnotationsBundle } from '../services/ShibeiService';

// Route param shape.
interface ReaderParams { resourceId?: string; }

const DEFAULT_HL_COLOR = '#ffeb3b';

@Entry
@Component
struct Reader {
  @State resource: Resource | null = null;
  @State html: string = '';
  @State loading: boolean = true;
  @State loadError: string = '';
  @State bundle: AnnotationsBundle = { highlights: [], comments: [] };
  @State panelOpen: boolean = false;
  @State pendingSelection: SelectionPayload | null = null;

  private webController: webview.WebviewController = new webview.WebviewController();
  private bridge: AnnotationBridge = new AnnotationBridge({
    onSelection: (p) => this.handleSelection(p),
    onClick: (p) => this.handleClick(p),
    onReady: (p) => this.handleReady(p),
  });
  private unsubscribe: (() => void) | null = null;

  aboutToAppear(): void {
    const params = (router.getParams() ?? {}) as ReaderParams;
    const id = params.resourceId ?? '';
    if (!id) {
      this.loadError = 'error.missingResourceId';
      this.loading = false;
      return;
    }
    try {
      this.resource = ShibeiService.instance.getResource(id);
      if (!this.resource) {
        this.loadError = 'error.resourceNotFound';
        this.loading = false;
        return;
      }
      this.html = ShibeiService.instance.getResourceHtml(id);
    } catch (err) {
      this.loadError = (err as Error).message;
      this.loading = false;
      hilog.error(0x0000, 'shibei', 'Reader init fail: %{public}s', this.loadError);
      return;
    }
    // Load cached annotations; fire-and-forget refresh.
    AnnotationsService.instance.load(id).then((b) => {
      this.bundle = b;
      this.paintHighlights();
    }).catch((err: Error) => {
      hilog.warn(0x0000, 'shibei', 'annotations load fail: %{public}s', err.message);
    });
    this.unsubscribe = AnnotationsService.instance.subscribe(id, (b) => {
      this.bundle = b;
      this.paintHighlights();
    });
    this.loading = false;
  }

  aboutToDisappear(): void {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
  }

  private paintHighlights(): void {
    if (!this.resource) return;
    const json = JSON.stringify(this.bundle.highlights);
    // Escape single quotes and backslashes for safe interpolation into the JS string.
    const safe = json.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    this.webController.runJavaScript(`window.__shibei && window.__shibei.paintHighlights('${safe}');`)
      .catch((err: Error) => {
        hilog.warn(0x0000, 'shibei', 'paintHighlights fail: %{public}s', err.message);
      });
  }

  private handleSelection(p: SelectionPayload): void {
    if (p.collapsed || !p.textContent || !p.anchor) {
      this.pendingSelection = null;
      return;
    }
    this.pendingSelection = p;
  }

  private handleClick(p: ClickPayload): void {
    if (!p.highlightId) return;
    this.panelOpen = true;
  }

  private handleReady(_: ReadyPayload): void {
    this.paintHighlights();
  }

  private createHighlightFromPending(): void {
    const sel = this.pendingSelection;
    if (!sel || !this.resource || !sel.textContent || !sel.anchor) return;
    try {
      AnnotationsService.instance.createHighlight(
        this.resource.id,
        sel.textContent,
        sel.anchor,
        DEFAULT_HL_COLOR,
      );
      this.pendingSelection = null;
      this.webController.runJavaScript(`window.__shibei && window.__shibei.clearSelection();`)
        .catch(() => {});
    } catch (err) {
      promptAction.showToast({ message: `创建失败: ${(err as Error).message}` });
    }
  }

  private flashHighlight(id: string): void {
    this.webController.runJavaScript(`window.__shibei && window.__shibei.flashHighlight('${id}');`)
      .catch(() => {});
  }

  private deleteHighlight(id: string): void {
    if (!this.resource) return;
    try {
      AnnotationsService.instance.deleteHighlight(this.resource.id, id);
      this.webController.runJavaScript(`window.__shibei && window.__shibei.removeHighlight('${id}');`)
        .catch(() => {});
    } catch (err) {
      promptAction.showToast({ message: (err as Error).message });
    }
  }

  build() {
    Stack() {
      if (this.loading) {
        Column() {
          Text('加载中…').fontColor($r('sys.color.ohos_id_color_text_tertiary'));
        }.width('100%').height('100%').justifyContent(FlexAlign.Center);
      } else if (this.loadError) {
        Column() {
          Text(`加载失败: ${this.loadError}`).fontColor($r('sys.color.ohos_id_color_warning'));
        }.width('100%').height('100%').justifyContent(FlexAlign.Center);
      } else {
        SideBarContainer(SideBarContainerType.Overlay) {
          // Main content: top bar + Web
          Column() {
            Row() {
              Text('←').fontSize(22)
                .fontColor($r('sys.color.ohos_id_color_text_primary'))
                .width(44).height(44).textAlign(TextAlign.Center)
                .onClick(() => router.back());
              Text(this.resource ? this.resource.title : '')
                .fontSize(15).fontWeight(FontWeight.Medium).layoutWeight(1)
                .fontColor($r('sys.color.ohos_id_color_text_primary'))
                .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis });
              Text(`☰ ${this.bundle.highlights.length}`)
                .fontSize(14)
                .fontColor($r('sys.color.ohos_id_color_text_primary'))
                .padding({ left: 8, right: 8 }).height(44)
                .onClick(() => { this.panelOpen = !this.panelOpen; });
            }
            .width('100%')
            .backgroundColor($r('sys.color.ohos_id_color_background'))
            .padding({ left: 4, right: 4 });

            // Web area
            Stack() {
              Web({ src: '', controller: this.webController })
                .domStorageAccess(true)
                .javaScriptAccess(true)
                .onControllerAttached(() => {
                  // Expose bridge before page loads so annotator-mobile.js
                  // sees window.shibeiBridge on first evaluation.
                  this.webController.registerJavaScriptProxy(
                    this.bridge, 'shibeiBridge', ['emit'],
                  );
                  this.webController.refresh();
                  // Load the HTML string. baseUrl uses shibei scheme so the
                  // annotator's href check doesn't reject it.
                  const baseUrl = `shibei://resource/${this.resource ? this.resource.id : ''}`;
                  this.webController.loadData(this.html, 'text/html', 'UTF-8', baseUrl, null);
                })
                .width('100%').height('100%')
                .backgroundColor($r('sys.color.ohos_id_color_sub_background'));

              // Floating selection action bar — shown when user has an active selection.
              if (this.pendingSelection && !this.pendingSelection.collapsed) {
                Row() {
                  Text('高亮').fontSize(14)
                    .fontColor(Color.White)
                    .backgroundColor($r('sys.color.ohos_id_color_emphasize'))
                    .padding({ left: 16, right: 16, top: 8, bottom: 8 })
                    .borderRadius(18)
                    .onClick(() => this.createHighlightFromPending());
                }
                .width('100%').justifyContent(FlexAlign.Center)
                .position({ y: '90%' });
              }
            }
            .layoutWeight(1).width('100%');
          }
          .width('100%').height('100%');

          // Side panel
          AnnotationPanel({
            bundle: this.bundle,
            onTapHighlight: (id) => this.flashHighlight(id),
            onDeleteHighlight: (id) => this.deleteHighlight(id),
            onAddResourceComment: () => { /* Phase 3a: basic prompt in Task 10 */ },
            onEditComment: (_id) => { /* Phase 3a: basic prompt in Task 10 */ },
            onDeleteComment: (id) => {
              if (!this.resource) return;
              try {
                AnnotationsService.instance.deleteComment(this.resource.id, id);
              } catch (err) {
                promptAction.showToast({ message: (err as Error).message });
              }
            },
          });
        }
        .showSideBar(this.panelOpen)
        .sideBarWidth(280)
        .minSideBarWidth(240)
        .maxSideBarWidth(360)
        .sideBarPosition(SideBarPosition.End)
        .showControlButton(false)
        .width('100%').height('100%');
      }
    }
    .width('100%').height('100%');
  }
}
```

- [ ] **Step 3: 提交**

```bash
git add shibei-harmony/entry/src/main/ets/pages/Reader.ets
git commit -m "feat(harmony): Reader page ArkWeb + annotation drawer"
```

---

## Task 10: 资料级笔记 prompt + 评论编辑

Reader 里 `onAddResourceComment` / `onEditComment` 目前是空。补一个简易的 AlertDialog + TextInput 输入。

**Files:**
- Modify: `shibei-harmony/entry/src/main/ets/pages/Reader.ets`

- [ ] **Step 1: 加 `@State commentDialog: { open: boolean; id: string | null; draft: string } = ...` 状态**

在 `@State panelOpen` 下面加:

```typescript
  @State commentDialogOpen: boolean = false;
  @State commentDialogId: string | null = null;  // null = new resource-level note
  @State commentDialogDraft: string = '';
```

- [ ] **Step 2: 替换 onAddResourceComment / onEditComment 回调**

```typescript
            onAddResourceComment: () => {
              this.commentDialogId = null;
              this.commentDialogDraft = '';
              this.commentDialogOpen = true;
            },
            onEditComment: (id) => {
              const c = this.bundle.comments.find((x) => x.id === id);
              if (!c) return;
              this.commentDialogId = id;
              this.commentDialogDraft = c.content;
              this.commentDialogOpen = true;
            },
```

- [ ] **Step 3: 在 build() 的最外层 Stack 里加 bindDialog**

Stack 末尾、closing `.width('100%').height('100%')` 之前,挂一个 sheet:

```typescript
    .bindSheet($$this.commentDialogOpen, this.CommentSheet(), {
      height: 320,
      title: { title: this.commentDialogId ? '编辑备注' : '新建备注' },
    });
```

- [ ] **Step 4: 加 @Builder CommentSheet()**

```typescript
  @Builder CommentSheet() {
    Column() {
      TextArea({ text: this.commentDialogDraft, placeholder: '写下你的想法…' })
        .fontSize(15)
        .width('100%')
        .height(160)
        .onChange((v: string) => { this.commentDialogDraft = v; });
      Row() {
        Text('取消')
          .fontSize(15)
          .padding({ left: 20, right: 20, top: 10, bottom: 10 })
          .onClick(() => {
            this.commentDialogOpen = false;
            this.commentDialogDraft = '';
            this.commentDialogId = null;
          });
        Text('保存')
          .fontSize(15).fontColor($r('sys.color.ohos_id_color_emphasize'))
          .padding({ left: 20, right: 20, top: 10, bottom: 10 })
          .onClick(() => this.saveComment());
      }
      .width('100%').justifyContent(FlexAlign.End);
    }
    .width('100%').padding(16);
  }

  private saveComment(): void {
    if (!this.resource) return;
    const content = this.commentDialogDraft.trim();
    if (!content) {
      this.commentDialogOpen = false;
      return;
    }
    try {
      if (this.commentDialogId) {
        AnnotationsService.instance.updateComment(this.resource.id, this.commentDialogId, content);
      } else {
        AnnotationsService.instance.createComment(this.resource.id, null, content);
      }
      this.commentDialogOpen = false;
      this.commentDialogDraft = '';
      this.commentDialogId = null;
    } catch (err) {
      promptAction.showToast({ message: (err as Error).message });
    }
  }
```

- [ ] **Step 5: 提交**

```bash
git add shibei-harmony/entry/src/main/ets/pages/Reader.ets
git commit -m "feat(harmony): resource-level comments via bottom sheet"
```

---

## Task 11: Build HAP + 手测

鸿蒙端只能在真机跑起来才算通过(Web组件行为跨 simulator 差异大)。

- [ ] **Step 1: 重建 .so**

```bash
cd /Users/work/workspace/Shibei && ./scripts/build-harmony-napi.sh
```

预期:`shibei-harmony/entry/libs/arm64-v8a/libshibei_core.so` 更新,大小接近 7.96 MB(新增代码不多,可能 +20 KB)。

- [ ] **Step 2: hvigor build(若有 CLI;否则 IDE 手测)**

```bash
cd /Users/work/workspace/Shibei/shibei-harmony && ./hvigorw assembleHap 2>&1 | tail -80
```

预期:BUILD SUCCESSFUL。若 ArkTS 编译错误:按报错修(strict 模式常见问题见 CLAUDE.md 里 ArkTS 章节)。

- [ ] **Step 3: 手测 checklist(用户驱动,AI 读日志辅助)**

- [ ] a. 冷启动 → Library,点任一资料 → Reader 打开,网页内容正常渲染
- [ ] b. 长按选文字 → 底部出现"高亮"按钮 → 点击 → 选区被黄色包裹
- [ ] c. 点击黄色高亮 → 右侧抽屉自动展开,能看到这条
- [ ] d. 在抽屉里点 × → 高亮从页面和抽屉同时消失
- [ ] e. 抽屉顶部点 "+ 备注" → 弹出 sheet → 输入保存 → 抽屉下方"笔记"区显示
- [ ] f. 退出 Reader 再回来 → 高亮和备注持久化恢复
- [ ] g. 桌面端(已同步过的同一 bucket)能看到鸿蒙端新建的高亮(等一次 syncMetadata)

- [ ] **Step 4: 提交手测结果记录(若需要)**

若发现 bug 修完后再提交:

```bash
git commit -am "fix(harmony): <bug description>"
```

---

## Task 12: 文档 + 记忆更新

- [ ] **Step 1: 在 CLAUDE.md 补鸿蒙 Reader 架构要点**

在 CLAUDE.md 的 "架构要点" 里搜索 "鸿蒙" 相关条目,追加一条:

```markdown
- **鸿蒙 Reader（Phase 3a）**：ArkWeb `Web` + `loadData()` 加载 Rust 端注入脚本后的 HTML（自定义 scheme `shibei://resource/{id}` 做 baseUrl 给 annotator href 校验用）；`registerJavaScriptProxy` 暴露 `window.shibeiBridge.emit(type, json)` 让 `annotator-mobile.js` 把选区/点击事件回传 ArkTS；ArkTS 通过 `webController.runJavaScript()` 调 `window.__shibei.{paintHighlights, flashHighlight, removeHighlight, clearSelection}`。`AnnotationsService` 做内存缓存 + subscriber,任一 CRUD 写入后 notify 订阅的 Reader 重绘。标注数据经 `SyncContext` 写 sync_log,和桌面 LWW 互通
```

- [ ] **Step 2: 更新 memory**

创建 `/Users/work/.claude/projects/-Users-work-workspace-Shibei/memory/feedback_arkweb_reader.md`:

```markdown
---
name: ArkWeb Reader architecture
description: How the Harmony reader loads HTML and bridges annotator events
type: feedback
---

The Harmony Reader page (`pages/Reader.ets`) uses ArkWeb `Web` component with `loadData(html, mime, enc, baseUrl)` rather than a custom URI scheme. Rust (`src-harmony-napi`) pre-strips `<script>` tags and injects `annotator-mobile.js` into `<head>` before returning HTML, so ArkTS never touches the HTML string.

**Why:** registerUriSchemeProtocol-equivalents on ArkWeb NEXT are available but more fragile than `loadData`; SingleFile inlines all assets so no relative-resource fetch is needed.

**How to apply:** When adding a new type of embedded renderer (e.g. PDF reader in Phase 3b), prefer `loadData` + a dummy base URL over custom scheme handlers unless you need relative-URL fetches. Bridge JS↔ArkTS via `registerJavaScriptProxy` (sync only — no async returns).
```

然后把 `MEMORY.md` 索引加一行:

```markdown
- [ArkWeb Reader architecture](feedback_arkweb_reader.md) — Rust pre-injects script, ArkTS uses loadData + bridge proxy
```

- [ ] **Step 3: 提交**

```bash
git add CLAUDE.md
git commit -m "docs: Harmony Reader architecture notes"
```

---

## Self-Review Checklist

- [x] Task 1 引用了 `ANNOTATOR_MOBILE_JS` include_str 路径(`../annotator-mobile.js`);Task 4 真的在那个路径写文件 ✓
- [x] Task 3 的 7 个命令名称在 Task 5 的 ShibeiService 里被一一 alias import(getResourceHtml + 7) ✓
- [x] Task 5 的 `AnnotationsBundle` 类型在 Task 6 的 AnnotationsService 里使用一致 ✓
- [x] Task 8 AnnotationPanel 的 Prop 名(`bundle`, `onTapHighlight` 等)在 Task 9 Reader 里对应传入 ✓
- [x] Task 9 Web 组件的 onControllerAttached 时序:注册 proxy 必须在 loadData 之前,代码里顺序正确 ✓
- [x] `paintHighlights` 的 JS 单引号转义考虑了 `\\` 和 `'`,但要注意 HTML 里若 text 含 `<` 之类字符 JSON.stringify 已处理 ✓
- [x] Task 2 的 `SyncContext::new_for_local()` 依赖 shibei-db 实际签名——Step 2 要求先读源码再定;若是 `Arc<HlcClock>` 版本要调整 ✓(明确标注了)
- [x] Task 11 手测 g 条依赖桌面端已经配置过同步——这是用户手上的一次性环境,不是每次跑测试都能复现;合理 ✓
- [x] 没有 TBD/TODO/"implement later";每个代码步骤都有完整代码 ✓

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-22-phase3a-arkweb-reader.md`.**

**Two execution options:**

**1. Subagent-Driven (recommended)** — 我每个 task 派一个 fresh subagent 执行,每两个 task 回来 review;上下文隔离、出错好回退。12 个 task 大概 6 轮对话能过。

**2. Inline Execution** — 我在当前会话里挨个跑 task,每 3 task 一个 checkpoint 让你看。上下文会持续增长,但每步我都看得见你的原话反馈。

**哪种?**
