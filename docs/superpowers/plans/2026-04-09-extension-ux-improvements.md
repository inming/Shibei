# Extension UX Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-capture on panel open with timer progress, auto-close after save, and per-tab side panel visibility.

**Architecture:** Move SingleFile capture from save-button click to panel init. Store captured HTML in MAIN world variable `window.__shibeiCapturedHtml` so both full-page and region save can reuse it. Use `chrome.sidePanel.setOptions({ tabId, enabled })` to control per-tab visibility. Background.js manages panel lifecycle via `action.onClicked`.

**Tech Stack:** Chrome Extension MV3 Side Panel API, SingleFile

**Spec:** `docs/superpowers/specs/2026-04-09-extension-ux-improvements.md`

---

### Task 1: Per-tab side panel + background.js panel lifecycle

**Files:**
- Modify: `extension/manifest.json`
- Modify: `extension/src/background/background.js`

- [ ] **Step 1: Update manifest.json**

Remove `side_panel.default_path` (panel will be opened programmatically). Keep the `sidePanel` permission:

```json
{
  "manifest_version": 3,
  "name": "拾贝 — 网页收藏助手",
  "version": "0.1.0",
  "description": "一键保存网页快照到拾贝桌面端",
  "permissions": [
    "activeTab",
    "scripting",
    "storage",
    "sidePanel"
  ],
  "host_permissions": [
    "<all_urls>"
  ],
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  },
  "action": {
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png"
    }
  },
  "background": {
    "service_worker": "src/background/background.js",
    "type": "module"
  }
}
```

- [ ] **Step 2: Rewrite background.js**

```javascript
// Default: panel disabled for all tabs
chrome.sidePanel.setOptions({ enabled: false });

// Click extension icon → enable + open panel for current tab only
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.setOptions({
    tabId: tab.id,
    enabled: true,
    path: "src/popup/popup.html",
  });
  await chrome.sidePanel.open({ tabId: tab.id });
});

// Close panel for a specific tab (called by popup.js after save)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "close-panel" && message.tabId) {
    chrome.sidePanel.setOptions({ tabId: message.tabId, enabled: false });
    sendResponse({ success: true });
  }
  return false;
});
```

- [ ] **Step 3: Commit**

```bash
git add extension/manifest.json extension/src/background/background.js
git commit -m "feat(extension): per-tab side panel, only visible on initiating tab"
```

---

### Task 2: Add capture status UI to popup.html + popup.css

**Files:**
- Modify: `extension/src/popup/popup.html`
- Modify: `extension/src/popup/popup.css`

- [ ] **Step 1: Add capture-status element to popup.html**

Add `#capture-status` between `#url-warning` and the first `.field` div:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <link rel="stylesheet" href="popup.css">
</head>
<body>
  <div class="header">
    <h1>拾贝</h1>
    <span id="status" class="status"></span>
  </div>

  <div id="offline-notice" class="offline-notice" style="display:none">
    请先启动拾贝桌面端
  </div>

  <div id="main-content" style="display:none">
    <div class="page-info">
      <div id="page-title" class="page-title"></div>
      <div id="page-url" class="page-url"></div>
    </div>

    <div id="url-warning" class="url-warning" style="display:none"></div>

    <div id="capture-status" class="capture-status" style="display:none">
      <span id="capture-text"></span>
      <span id="capture-timer"></span>
    </div>

    <div class="field">
      <label>保存到文件夹</label>
      <select id="folder-select"></select>
    </div>

    <div class="field">
      <label>标签（逗号分隔）</label>
      <input type="text" id="tags-input" placeholder="如: Rust, Web">
    </div>

    <div class="btn-group">
      <button id="save-btn" class="save-btn" disabled>保存整页</button>
      <button id="select-save-btn" class="save-btn save-btn-outline">选区保存</button>
    </div>

    <div id="message" class="message" style="display:none"></div>
  </div>

  <script src="popup.js"></script>
</body>
</html>
```

Key changes from previous version:
- Added `#capture-status` div with `#capture-text` and `#capture-timer` spans
- Save button starts with `disabled` attribute (enabled after capture completes)

- [ ] **Step 2: Add capture-status styles to popup.css**

Append after `.offline-notice` styles (after line 183):

```css
.capture-status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 12px;
}

.capture-status.capturing {
  background: #dbeafe;
  color: #1e40af;
}

.capture-status.capture-done {
  background: #dcfce7;
  color: #166534;
}

.capture-status.capture-error {
  background: #fee2e2;
  color: #991b1b;
}

#capture-timer {
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}
```

- [ ] **Step 3: Commit**

```bash
git add extension/src/popup/popup.html extension/src/popup/popup.css
git commit -m "feat(extension): add capture status UI with timer"
```

---

### Task 3: Auto-capture on init + progress timer + save flow refactor

This is the main task. Rewrite `popup.js` to:
1. Start capture immediately in `init()` after page info loads
2. Show timer progress during capture
3. Save button only writes pre-captured HTML to DOM + POSTs (no more SingleFile call)
4. Auto-close after save

**Files:**
- Modify: `extension/src/popup/popup.js`

- [ ] **Step 1: Rewrite popup.js**

```javascript
const API_BASE = "http://127.0.0.1:21519";

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

function authHeader(token) {
  return { "Authorization": `Bearer ${token}` };
}

const statusEl = document.getElementById("status");
const offlineNotice = document.getElementById("offline-notice");
const mainContent = document.getElementById("main-content");
const pageTitleEl = document.getElementById("page-title");
const pageUrlEl = document.getElementById("page-url");
const folderSelect = document.getElementById("folder-select");
const tagsInput = document.getElementById("tags-input");
const saveBtn = document.getElementById("save-btn");
const selectSaveBtn = document.getElementById("select-save-btn");
const messageEl = document.getElementById("message");
const captureStatusEl = document.getElementById("capture-status");
const captureTextEl = document.getElementById("capture-text");
const captureTimerEl = document.getElementById("capture-timer");

let pageInfo = null;
let captureReady = false; // true when SingleFile capture is done

function showMessage(text, type) {
  console.log(`[shibei] ${type}: ${text}`);
  messageEl.textContent = text;
  messageEl.className = `message message-${type}`;
  messageEl.style.display = "block";
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

// ── Auto-capture ──

async function startCapture() {
  captureStatusEl.style.display = "flex";
  captureStatusEl.className = "capture-status capturing";
  captureTextEl.textContent = "正在抓取页面...";

  // Start timer
  const startTime = Date.now();
  const timerInterval = setInterval(() => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    captureTimerEl.textContent = elapsed + "s";
  }, 100);

  try {
    // Inject SingleFile bundle
    await chrome.scripting.executeScript({
      target: { tabId: pageInfo.tabId },
      files: ["lib/single-file-bundle.js"],
      world: "MAIN",
    });

    // Run capture, strip media, store in MAIN world variable
    const results = await chrome.scripting.executeScript({
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

          let content = pageData.content;
          content = content.replace(/<video[\s>][\s\S]*?<\/video>/gi, "");
          content = content.replace(/<audio[\s>][\s\S]*?<\/audio>/gi, "");
          content = content.replace(/<noscript[\s>][\s\S]*?<\/noscript>/gi, "");

          // Store in MAIN world variable (reused by region-selector.js)
          window.__shibeiCapturedHtml = content;

          return { success: true, size: content.length };
        } catch (err) {
          return { success: false, error: String(err) };
        }
      },
    });

    clearInterval(timerInterval);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const result = results?.[0]?.result;

    if (!result?.success) {
      throw new Error(result?.error || "抓取返回空结果");
    }

    captureReady = true;
    captureStatusEl.className = "capture-status capture-done";
    captureTextEl.textContent = `抓取完成 (${formatSize(result.size)})`;
    captureTimerEl.textContent = elapsed + "s";
    saveBtn.disabled = false;
    console.log("[shibei] capture done:", result.size, "bytes in", elapsed, "s");
  } catch (err) {
    clearInterval(timerInterval);
    captureStatusEl.className = "capture-status capture-error";
    captureTextEl.textContent = "抓取失败: " + (err.message || String(err));
    captureTimerEl.textContent = "";
    console.error("[shibei] capture error:", err);
  }
}

// ── Init ──

async function init() {
  // Check if desktop app is running
  try {
    const res = await fetch(`${API_BASE}/api/ping`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error("not ok");
    await getToken();
    statusEl.textContent = "已连接";
    statusEl.className = "status status-online";
    offlineNotice.style.display = "none";
    mainContent.style.display = "block";
  } catch (err) {
    statusEl.textContent = "未连接";
    statusEl.className = "status status-offline";
    offlineNotice.style.display = "block";
    mainContent.style.display = "none";
    return;
  }

  // Get current tab info
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (tab) {
      const url = tab.url || "";
      if (url.startsWith("chrome://") || url.startsWith("about:") || url.startsWith("edge://") || url.startsWith("chrome-extension://")) {
        showMessage("不支持保存系统页面", "error");
        saveBtn.disabled = true;
        selectSaveBtn.disabled = true;
        pageTitleEl.textContent = tab.title || "系统页面";
        pageUrlEl.textContent = url;
        return;
      }

      let domain = "";
      try { domain = new URL(url).hostname; } catch { domain = ""; }

      pageInfo = {
        tabId: tab.id,
        title: tab.title || "无标题",
        url,
        domain,
        author: null,
        description: null,
      };

      // Extract meta info
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const getMeta = (name) =>
              document.querySelector(`meta[name="${name}"]`)?.content ||
              document.querySelector(`meta[property="${name}"]`)?.content ||
              null;
            return {
              author: getMeta("author") || getMeta("article:author"),
              description: getMeta("description") || getMeta("og:description"),
            };
          },
        });
        const meta = results?.[0]?.result;
        if (meta) {
          pageInfo.author = meta.author;
          pageInfo.description = meta.description;
        }
      } catch (e) {
        console.log("[shibei] meta extraction failed (ok):", e.message);
      }

      pageTitleEl.textContent = pageInfo.title;
      pageUrlEl.textContent = pageInfo.url;

      // Check for duplicate URL
      try {
        const token = await getToken();
        const checkRes = await fetch(
          `${API_BASE}/api/check-url?url=${encodeURIComponent(pageInfo.url)}`,
          { signal: AbortSignal.timeout(2000), headers: authHeader(token) }
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

      // Start capture immediately (non-blocking)
      startCapture();
    }
  } catch (err) {
    console.error("[shibei] tab query failed:", err);
  }

  // Load folders
  try {
    const token = await getToken();
    const res = await fetch(`${API_BASE}/api/folders`, { headers: authHeader(token) });
    const folders = await res.json();
    populateFolderSelect(folders, 0);
  } catch (err) {
    console.error("[shibei] folder load failed:", err);
    showMessage("加载文件夹失败", "error");
  }
}

function populateFolderSelect(folders, depth) {
  for (const folder of folders) {
    const option = document.createElement("option");
    option.value = folder.id;
    option.textContent = "\u00A0\u00A0".repeat(depth) + folder.name;
    folderSelect.appendChild(option);
    if (folder.children && folder.children.length > 0) {
      populateFolderSelect(folder.children, depth + 1);
    }
  }
}

// ── Save full page ──

saveBtn.addEventListener("click", async () => {
  if (!pageInfo?.tabId || !captureReady) return;

  const folderId = folderSelect.value;
  if (!folderId) {
    showMessage("请选择文件夹", "error");
    return;
  }

  saveBtn.disabled = true;
  showMessage("正在保存...", "loading");

  try {
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

    // Write pre-captured HTML from MAIN world variable to DOM element,
    // then POST from ISOLATED world
    const saveResults = await chrome.scripting.executeScript({
      target: { tabId: pageInfo.tabId },
      func: async (meta) => {
        const API = "http://127.0.0.1:21519";
        try {
          // Move captured HTML from JS variable to DOM element for ISOLATED world access
          const capturedHtml = window.__shibeiCapturedHtml;
          if (!capturedHtml) return { success: false, error: "No captured content available" };

          let el = document.getElementById("__shibei_transfer__");
          if (!el) {
            el = document.createElement("script");
            el.type = "text/shibei-transfer";
            el.id = "__shibei_transfer__";
            el.style.display = "none";
            document.documentElement.appendChild(el);
          }
          el.textContent = capturedHtml;
          delete window.__shibeiCapturedHtml;

          return { success: true };
        } catch (err) {
          return { success: false, error: String(err) };
        }
      },
      args: [metadata],
      world: "MAIN",
    });

    const writeResult = saveResults?.[0]?.result;
    if (!writeResult?.success) {
      throw new Error(writeResult?.error || "Failed to prepare content");
    }

    // POST from ISOLATED world
    const postResults = await chrome.scripting.executeScript({
      target: { tabId: pageInfo.tabId },
      func: async (meta) => {
        const API = "http://127.0.0.1:21519";
        try {
          const el = document.getElementById("__shibei_transfer__");
          const content = el?.textContent || "";
          if (el) el.remove();
          if (!content) return { success: false, error: "No content in transfer element" };

          const tokenRes = await fetch(`${API}/token`, { signal: AbortSignal.timeout(2000) });
          if (!tokenRes.ok) return { success: false, error: `Token fetch failed: HTTP ${tokenRes.status}` };
          const { token } = await tokenRes.json();

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

    const saveResult = postResults?.[0]?.result;
    if (!saveResult?.success) {
      throw new Error(saveResult?.error || "保存失败");
    }

    showMessage("保存成功！", "success");

    // Auto-close after 1 second
    setTimeout(() => {
      chrome.runtime.sendMessage({ type: "close-panel", tabId: pageInfo.tabId });
      window.close();
    }, 1000);
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

// ── Region save ──

selectSaveBtn.addEventListener("click", async () => {
  selectSaveBtn.disabled = true;

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

  const saveParams = {
    title: pageInfo.title,
    url: pageInfo.url,
    domain: pageInfo.domain,
    author: pageInfo.author || null,
    description: pageInfo.description || null,
    folderId,
    tags,
  };

  // Inject save parameters into MAIN world
  try {
    await chrome.scripting.executeScript({
      target: { tabId: pageInfo.tabId },
      world: "MAIN",
      func: (params) => {
        window.__shibeiSaveParams = params;
      },
      args: [saveParams],
    });
  } catch (e) {
    showMessage("注入参数失败: " + e.message, "error");
    return;
  }

  // Inject relay script in ISOLATED world
  try {
    await chrome.scripting.executeScript({
      target: { tabId: pageInfo.tabId },
      files: ["src/content/relay.js"],
    });
  } catch (e) {
    console.log("[shibei] relay inject failed:", e.message);
  }

  // Inject SingleFile bundle if not already (capture may still be running)
  try {
    await chrome.scripting.executeScript({
      target: { tabId: pageInfo.tabId },
      files: ["lib/single-file-bundle.js"],
      world: "MAIN",
    });
  } catch (e) {
    console.log("[shibei] SingleFile pre-inject (may already exist):", e.message);
  }

  // Inject region selector
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

  showMessage("请在页面中选择要保存的区域", "loading");
});

init();
```

- [ ] **Step 2: Commit**

```bash
git add extension/src/popup/popup.js
git commit -m "feat(extension): auto-capture on init, progress timer, auto-close after save"
```

---

### Task 4: Region selector reuses pre-captured HTML

**Files:**
- Modify: `extension/src/content/region-selector.js:330-369`

- [ ] **Step 1: Modify doSave() to reuse pre-captured HTML**

Replace the SingleFile capture block in `doSave()` (lines 345-369, from `// Run SingleFile capture` through the closing `}` of the catch block) with logic that checks for pre-captured HTML first:

Find this code in region-selector.js:

```javascript
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
        maxResourceSizeEnabled: true,
        maxResourceSize: 5,
      });
      fullHtml = pageData.content;
      fullHtml = fullHtml.replace(/<video[\s>][\s\S]*?<\/video>/gi, '');
      fullHtml = fullHtml.replace(/<audio[\s>][\s\S]*?<\/audio>/gi, '');
      fullHtml = fullHtml.replace(/<noscript[\s>][\s\S]*?<\/noscript>/gi, '');
    } catch (err) {
      showToast("页面抓取失败: " + err.message, "#dc2626");
      setTimeout(cleanup, 2000);
      return;
    }
```

Replace with:

```javascript
    // Reuse pre-captured HTML from auto-capture if available
    let fullHtml;
    if (window.__shibeiCapturedHtml) {
      fullHtml = window.__shibeiCapturedHtml;
    } else {
      // Wait for auto-capture to finish (poll every 200ms, max 60s)
      showToast("等待页面抓取完成...", "#1e40af");
      const waitStart = Date.now();
      while (!window.__shibeiCapturedHtml && Date.now() - waitStart < 60000) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if (window.__shibeiCapturedHtml) {
        fullHtml = window.__shibeiCapturedHtml;
      } else {
        // Fallback: capture now (panel wasn't opened or capture failed)
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
            maxResourceSizeEnabled: true,
            maxResourceSize: 5,
          });
          fullHtml = pageData.content;
          fullHtml = fullHtml.replace(/<video[\s>][\s\S]*?<\/video>/gi, "");
          fullHtml = fullHtml.replace(/<audio[\s>][\s\S]*?<\/audio>/gi, "");
          fullHtml = fullHtml.replace(/<noscript[\s>][\s\S]*?<\/noscript>/gi, "");
        } catch (err) {
          showToast("页面抓取失败: " + err.message, "#dc2626");
          setTimeout(cleanup, 2000);
          return;
        }
      }
    }
```

- [ ] **Step 2: Commit**

```bash
git add extension/src/content/region-selector.js
git commit -m "feat(extension): region selector reuses pre-captured HTML from auto-capture"
```

---

### Task 5: Manual verification

- [ ] **Step 1: Test per-tab panel**

1. Reload extension at `chrome://extensions/`
2. Open Tab A with any webpage, click extension icon → panel opens
3. Switch to Tab B → panel should hide
4. Switch back to Tab A → panel should reappear with same state
5. Verify panel state (form inputs, capture progress) is preserved

- [ ] **Step 2: Test auto-capture + timer**

1. Open extension on a page → should immediately show "正在抓取页面... 0.1s"
2. Timer should count up every 100ms
3. When done: "抓取完成 (X.X MB) Ns" in green
4. Save button should be disabled during capture, enabled after

- [ ] **Step 3: Test full-page save + auto-close**

1. After capture completes, select folder, click save
2. Should show "保存成功！" briefly then auto-close the panel

- [ ] **Step 4: Test region save (non-blocking)**

1. Open extension, while capture timer is still running, click "选区保存"
2. Should be able to select a region on the page immediately
3. After confirming selection, if capture is done → saves immediately; if still running → shows "等待页面抓取完成..."

- [ ] **Step 5: Test on the problematic page with audio**

1. Open the page that previously crashed
2. Verify capture completes without crash
3. Test both full-page and region save
