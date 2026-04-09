# Extension Large-Page Save Optimization

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Chrome extension reliably save pages with large media (audio/video/fonts), eliminating crashes from memory exhaustion and IPC size limits.

**Architecture:** Five changes inspired by Zotero connectors: (1) limit SingleFile resource inlining via `maxResourceSize` to prevent 30MB+ audio/video from becoming data URIs, (2) post-capture strip of `<video>`, `<audio>`, `<noscript>` elements, (3) refactor full-page save to use DOM-element transfer + ISOLATED-world raw POST (same path as region-save), (4) clean up dead code in background.js, (5) unify SingleFile options into a shared constant.

**Tech Stack:** Chrome Extension MV3, SingleFile, axum `/api/save-raw` endpoint (already exists)

**Current state:** `/api/save-raw` endpoint already implemented in `src-tauri/src/server/mod.rs`. Region-save already uses DOM transfer + raw POST via `relay.js`. Full-page save still uses base64 + JSON via popup.

---

### Task 1: Add SingleFile media resource size limit

Both save flows call `SingleFile.getPageData()` without `maxResourceSize`, so SingleFile inlines ALL resources as data URIs — including 34MB audio files. Adding a 5MB limit prevents inlining large media while keeping images/fonts.

**Files:**
- Modify: `extension/src/popup/popup.js:219-226`
- Modify: `extension/src/content/region-selector.js:351-358`

- [ ] **Step 1: Update SingleFile options in popup.js**

In `popup.js`, find the `SingleFile.getPageData()` call inside the `executeScript` func (line 219) and add `maxResourceSizeEnabled` and `maxResourceSize`:

```javascript
const pageData = await SingleFile.getPageData({
  removeHiddenElements: false,
  removeUnusedStyles: true,
  removeUnusedFonts: true,
  compressHTML: true,
  loadDeferredImages: true,
  loadDeferredImagesMaxIdleTime: 3000,
  maxResourceSizeEnabled: true,
  maxResourceSize: 5,
});
```

- [ ] **Step 2: Update SingleFile options in region-selector.js**

In `region-selector.js`, find the `SingleFile.getPageData()` call (line 351) and add the same options:

```javascript
const pageData = await SingleFile.getPageData({
  removeHiddenElements: false,
  removeUnusedStyles: true,
  removeUnusedFonts: true,
  compressHTML: true,
  loadDeferredImages: true,
  loadDeferredImagesMaxIdleTime: 3000,
  maxResourceSizeEnabled: true,
  maxResourceSize: 5,
});
```

- [ ] **Step 3: Commit**

```bash
git add extension/src/popup/popup.js extension/src/content/region-selector.js
git commit -m "fix(extension): limit SingleFile resource size to 5MB to skip large media"
```

---

### Task 2: Strip media elements from captured HTML

Even with `maxResourceSize`, media elements remain in the HTML (just without `src`). Strip `<video>`, `<audio>`, and `<noscript>` elements entirely to reduce output size, following Zotero's approach.

**Files:**
- Modify: `extension/src/popup/popup.js:208-232` (capture executeScript func)
- Modify: `extension/src/content/region-selector.js:345-364` (doSave capture section)

- [ ] **Step 1: Add media stripping to popup.js capture function**

In `popup.js`, modify the capture `func` inside `executeScript` (line 211-231). After `SingleFile.getPageData()`, strip media elements before returning:

```javascript
func: async () => {
  try {
    if (typeof SingleFile === "undefined") {
      return { success: false, error: "SingleFile is undefined" };
    }
    if (!SingleFile.getPageData) {
      return { success: false, error: "SingleFile.getPageData not found. Keys: " + Object.keys(SingleFile).join(",") };
    }
    const pageData = await SingleFile.getPageData({
      removeHiddenElements: false,
      removeUnusedStyles: true,
      removeUnusedFonts: true,
      compressHTML: true,
      loadDeferredImages: true,
      loadDeferredImagesMaxIdleTime: 3000,
      maxResourceSizeEnabled: true,
      maxResourceSize: 5,
    });

    // Strip media elements and noscript (like Zotero)
    let content = pageData.content;
    content = content.replace(/<video[\s>][\s\S]*?<\/video>/gi, '');
    content = content.replace(/<audio[\s>][\s\S]*?<\/audio>/gi, '');
    content = content.replace(/<noscript[\s>][\s\S]*?<\/noscript>/gi, '');

    return { success: true, content, size: content.length };
  } catch (err) {
    return { success: false, error: String(err) };
  }
},
```

- [ ] **Step 2: Add media stripping to region-selector.js capture**

In `region-selector.js`, after `SingleFile.getPageData()` (line 359) and before `clipHtml`, strip media:

```javascript
fullHtml = pageData.content;

// Strip media elements and noscript (reduces HTML size before clipping)
fullHtml = fullHtml.replace(/<video[\s>][\s\S]*?<\/video>/gi, '');
fullHtml = fullHtml.replace(/<audio[\s>][\s\S]*?<\/audio>/gi, '');
fullHtml = fullHtml.replace(/<noscript[\s>][\s\S]*?<\/noscript>/gi, '');
```

- [ ] **Step 3: Commit**

```bash
git add extension/src/popup/popup.js extension/src/content/region-selector.js
git commit -m "fix(extension): strip video/audio/noscript from captured HTML"
```

---

### Task 3: Refactor full-page save to use DOM transfer + raw POST

The full-page save currently returns the entire HTML via `executeScript` return value → popup memory → base64 → JSON → fetch. This creates 4 copies of the HTML in popup memory.

Refactor to: capture in MAIN world → write to DOM element → POST from ISOLATED world (same architecture as region-save). The popup only receives small status objects, never the HTML content.

**Files:**
- Modify: `extension/src/popup/popup.js:176-303` (save button click handler)

- [ ] **Step 1: Rewrite the save button handler**

Replace the entire `saveBtn.addEventListener("click", ...)` block (lines 176-303) with:

```javascript
saveBtn.addEventListener("click", async () => {
  console.log("[shibei] save clicked");

  if (!pageInfo?.tabId) {
    showMessage("无法获取当前页面信息", "error");
    return;
  }

  const folderId = folderSelect.value;
  if (!folderId) {
    showMessage("请选择文件夹", "error");
    return;
  }

  saveBtn.disabled = true;

  try {
    // Step 1: Inject SingleFile bundle into MAIN world
    showMessage("注入 SingleFile...", "loading");
    await chrome.scripting.executeScript({
      target: { tabId: pageInfo.tabId },
      files: ["lib/single-file-bundle.js"],
      world: "MAIN",
    });

    // Step 2: Capture page in MAIN world, strip media, write to DOM element
    showMessage("正在抓取页面（可能需要几秒）...", "loading");
    const captureResults = await chrome.scripting.executeScript({
      target: { tabId: pageInfo.tabId },
      world: "MAIN",
      func: async () => {
        try {
          if (typeof SingleFile === "undefined" || !SingleFile.getPageData) {
            return { success: false, error: "SingleFile not available" };
          }
          const pageData = await SingleFile.getPageData({
            removeHiddenElements: false,
            removeUnusedStyles: true,
            removeUnusedFonts: true,
            compressHTML: true,
            loadDeferredImages: true,
            loadDeferredImagesMaxIdleTime: 3000,
            maxResourceSizeEnabled: true,
            maxResourceSize: 5,
          });

          // Strip media elements and noscript
          let content = pageData.content;
          content = content.replace(/<video[\s>][\s\S]*?<\/video>/gi, '');
          content = content.replace(/<audio[\s>][\s\S]*?<\/audio>/gi, '');
          content = content.replace(/<noscript[\s>][\s\S]*?<\/noscript>/gi, '');

          // Write to shared DOM element (ISOLATED world will read it)
          let el = document.getElementById("__shibei_transfer__");
          if (!el) {
            el = document.createElement("script");
            el.type = "text/shibei-transfer";
            el.id = "__shibei_transfer__";
            el.style.display = "none";
            document.documentElement.appendChild(el);
          }
          el.textContent = content;

          return { success: true, size: content.length };
        } catch (err) {
          return { success: false, error: String(err) };
        }
      },
    });

    const captureResult = captureResults?.[0]?.result;
    if (!captureResult?.success) {
      throw new Error(captureResult?.error || "抓取返回空结果");
    }
    console.log("[shibei] captured", captureResult.size, "bytes");

    // Step 3: POST from ISOLATED world (reads DOM element, sends raw HTML)
    showMessage("正在保存...", "loading");

    const tags = tagsInput.value.split(",").map((t) => t.trim()).filter(Boolean);
    const metadata = {
      title: pageInfo.title,
      url: pageInfo.url,
      domain: pageInfo.domain,
      author: pageInfo.author,
      description: pageInfo.description,
      folderId,
      tags,
    };

    const saveResults = await chrome.scripting.executeScript({
      target: { tabId: pageInfo.tabId },
      // default world = ISOLATED — can access DOM and fetch localhost
      func: async (meta) => {
        const API = "http://127.0.0.1:21519";
        try {
          // Read content from shared DOM element
          const el = document.getElementById("__shibei_transfer__");
          const content = el?.textContent || "";
          if (el) el.remove();
          if (!content) return { success: false, error: "No content in transfer element" };

          // Get auth token
          const tokenRes = await fetch(`${API}/token`, { signal: AbortSignal.timeout(2000) });
          if (!tokenRes.ok) return { success: false, error: `Token fetch failed: HTTP ${tokenRes.status}` };
          const { token } = await tokenRes.json();

          // Build metadata headers
          const headers = {
            "Content-Type": "text/html; charset=utf-8",
            "Authorization": `Bearer ${token}`,
            "X-Shibei-Title": encodeURIComponent(meta.title || ""),
            "X-Shibei-Url": encodeURIComponent(meta.url || ""),
            "X-Shibei-Domain": encodeURIComponent(meta.domain || ""),
            "X-Shibei-Folder-Id": meta.folderId || "",
            "X-Shibei-Captured-At": new Date().toISOString(),
          };
          if (meta.author) headers["X-Shibei-Author"] = encodeURIComponent(meta.author);
          if (meta.description) headers["X-Shibei-Description"] = encodeURIComponent(meta.description);
          if (meta.tags?.length) headers["X-Shibei-Tags"] = meta.tags.map(encodeURIComponent).join(",");

          // POST raw HTML body
          const res = await fetch(`${API}/api/save-raw`, {
            method: "POST",
            headers,
            body: content,
          });

          if (!res.ok) {
            const err = await res.json().catch(() => ({ error: "Unknown error" }));
            return { success: false, error: err.error || `HTTP ${res.status}` };
          }

          const result = await res.json();
          return { success: true, resource_id: result.resource_id };
        } catch (err) {
          return { success: false, error: String(err) };
        }
      },
      args: [metadata],
    });

    const saveResult = saveResults?.[0]?.result;
    if (!saveResult?.success) {
      throw new Error(saveResult?.error || "保存失败");
    }

    console.log("[shibei] saved:", saveResult.resource_id);
    showMessage("保存成功！", "success");
    saveBtn.textContent = "已保存";
  } catch (err) {
    console.error("[shibei] error:", err);
    const msg = err.message || String(err);
    if (msg.includes("Cannot access") || msg.includes("Cannot read")) {
      showMessage("页面受安全策略限制，无法抓取", "error");
    } else if (msg.includes("No tab with id") || msg.includes("Invalid tab")) {
      showMessage("无法访问当前页面", "error");
    } else {
      showMessage(`错误: ${msg}`, "error");
    }
    saveBtn.disabled = false;
  }
});
```

- [ ] **Step 2: Remove dead code from popup.js**

The `getToken()`, `authHeader()`, and their cached token variables (lines 1-25) are no longer used by the save flow. However, they're still used by `init()` for `/api/ping`, `/api/check-url`, and `/api/folders`. Keep them.

Remove only the base64 encoding code that was previously in the save handler — this is already gone after Step 1's replacement.

- [ ] **Step 3: Verify no regressions in popup init and select-save**

Verify that the `init()` function (lines 47-162) and `selectSaveBtn` handler (lines 306-386) are untouched and still work. They use `getToken()` / `authHeader()` independently.

- [ ] **Step 4: Commit**

```bash
git add extension/src/popup/popup.js
git commit -m "refactor(extension): full-page save uses DOM transfer + raw POST"
```

---

### Task 4: Clean up dead code in background.js

With both save flows now handled by content scripts (ISOLATED world → direct fetch to server), the `handleSavePage`, `handleSaveRegion`, `arrayBufferToBase64`, and their `onMessage` listeners in `background.js` are dead code. Remove them.

**Files:**
- Modify: `extension/src/background/background.js`

- [ ] **Step 1: Remove save message handlers and helper functions**

Replace the entire `background.js` with only the code that's still needed (sidePanel behavior + deduplication is still useful if we want it, but with the new flow dedup happens at the content script level — remove it too):

```javascript
// Open side panel when action icon is clicked
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
```

- [ ] **Step 2: Commit**

```bash
git add extension/src/background/background.js
git commit -m "chore(extension): remove dead save handlers from background.js"
```

---

### Task 5: Manual verification

**Files:** None (testing only)

- [ ] **Step 1: Reload extension and test full-page save on a normal page**

1. Go to `chrome://extensions/` (or `edge://extensions/`)
2. Click reload on the Shibei extension
3. Open any normal webpage (e.g. a blog post)
4. Open the side panel, select folder, click full-page save
5. Verify it saves successfully in the desktop app

- [ ] **Step 2: Test full-page save on the page with audio**

1. Open the page that previously crashed (`articles.zsxq.com/id_ctr67khl97ag.html`)
2. Refresh the page (clear old injected scripts)
3. Open side panel, select folder, click full-page save
4. Verify: no crash, saves successfully
5. Open the saved resource in the reader — audio element should be stripped but text content preserved

- [ ] **Step 3: Test region save on a normal page**

1. Open a normal webpage
2. Open side panel, click region save
3. Select a DOM region, confirm
4. Verify it saves successfully

- [ ] **Step 4: Test region save on the page with audio**

1. Open the problematic page, refresh
2. Region save a section that does NOT contain the audio
3. Verify: no crash, saves successfully

- [ ] **Step 5: Check extension error log**

1. Go to `chrome://extensions/` → Shibei → Errors
2. Clear all old errors
3. Perform saves from steps 1-4
4. Verify: no new errors (Mixed Content warnings are OK)

- [ ] **Step 6: Commit all changes if any fixups were needed**

```bash
git add -A
git commit -m "fix(extension): fixups from manual verification"
```
