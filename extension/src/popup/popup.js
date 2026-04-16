const API_BASE = "http://127.0.0.1:21519";

let cachedToken = null;
let tokenPromise = null;

// ── PDF detection ──

async function detectPdf(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.contentType,
    });
    const contentType = results?.[0]?.result || "";
    return contentType === "application/pdf";
  } catch {
    return false;
  }
}

// ── i18n helpers ──

function msg(key, ...subs) {
  return chrome.i18n.getMessage(key, subs) || key;
}

function localizeHtml() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    el.textContent = msg(key);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder");
    el.placeholder = msg(key);
  });
}

// ── Auth ──

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
let captureReady = false;

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
  captureTextEl.textContent = msg("capturingPage");

  const startTime = Date.now();
  const timerInterval = setInterval(() => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    captureTimerEl.textContent = elapsed + "s";
  }, 100);

  try {
    await chrome.scripting.executeScript({
      target: { tabId: pageInfo.tabId },
      files: ["lib/single-file-bundle.js"],
      world: "MAIN",
    });

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
      throw new Error(result?.error || msg("captureEmpty"));
    }

    captureReady = true;
    captureStatusEl.className = "capture-status capture-done";
    captureTextEl.textContent = msg("captureDone", formatSize(result.size));
    captureTimerEl.textContent = elapsed + "s";
    saveBtn.disabled = false;
    console.log("[shibei] capture done:", result.size, "bytes in", elapsed, "s");
  } catch (err) {
    clearInterval(timerInterval);
    captureStatusEl.className = "capture-status capture-error";
    captureTextEl.textContent = msg("captureFailed", err.message || String(err));
    captureTimerEl.textContent = "";
    console.error("[shibei] capture error:", err);
  }
}

// ── Init ──

async function init() {
  localizeHtml();

  try {
    const res = await fetch(`${API_BASE}/api/ping`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error("not ok");
    await getToken();
    statusEl.textContent = msg("statusOnline");
    statusEl.className = "status status-online";
    offlineNotice.style.display = "none";
    mainContent.style.display = "block";
  } catch (err) {
    statusEl.textContent = msg("statusOffline");
    statusEl.className = "status status-offline";
    offlineNotice.style.display = "block";
    mainContent.style.display = "none";
    return;
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (tab) {
      const url = tab.url || "";
      if (url.startsWith("chrome://") || url.startsWith("about:") || url.startsWith("edge://") || url.startsWith("chrome-extension://")) {
        showMessage(msg("unsupportedPage"), "error");
        saveBtn.disabled = true;
        selectSaveBtn.disabled = true;
        pageTitleEl.textContent = tab.title || msg("systemPage");
        pageUrlEl.textContent = url;
        return;
      }

      let domain = "";
      try { domain = new URL(url).hostname; } catch { domain = ""; }

      pageInfo = {
        tabId: tab.id,
        title: tab.title || msg("untitled"),
        url,
        domain,
        author: null,
        description: null,
      };

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

      const isPdf = await detectPdf(pageInfo.tabId) ||
        (pageInfo.url && pageInfo.url.toLowerCase().endsWith(".pdf"));
      pageInfo.isPdf = isPdf;

      if (pageInfo.isPdf) {
        selectSaveBtn.style.display = "none";
      }

      pageTitleEl.textContent = pageInfo.title;
      pageUrlEl.textContent = pageInfo.url;

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
            warningEl.textContent = msg("urlSavedCount", String(count));
            warningEl.style.display = "block";
          }
        }
      } catch (e) {
        console.log("[shibei] url check failed (ok):", e.message);
      }

      // For PDFs, skip HTML capture and enable save button directly
      if (pageInfo.isPdf) {
        captureReady = true;
        captureStatusEl.style.display = "none";
        saveBtn.disabled = false;
      } else {
        // Start capture immediately (non-blocking)
        startCapture();
      }
    }
  } catch (err) {
    console.error("[shibei] tab query failed:", err);
  }

  try {
    const token = await getToken();
    const res = await fetch(`${API_BASE}/api/folders`, { headers: authHeader(token) });
    const folders = await res.json();
    populateFolderSelect(folders, 0);
  } catch (err) {
    console.error("[shibei] folder load failed:", err);
    showMessage(msg("folderLoadFailed"), "error");
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
    showMessage(msg("selectFolder"), "error");
    return;
  }

  saveBtn.disabled = true;
  showMessage(msg("saving"), "loading");

  try {
    const tags = tagsInput.value.split(",").map((t) => t.trim()).filter(Boolean);

    // PDF save flow: fetch via background service worker, POST binary to server
    if (pageInfo.isPdf) {
      const pdfResult = await chrome.runtime.sendMessage({
        type: "fetch-pdf",
        url: pageInfo.url,
      });

      if (!pdfResult?.success) {
        throw new Error(pdfResult?.error || "Failed to fetch PDF");
      }

      const pdfBytes = new Uint8Array(pdfResult.data);
      const token = await getToken();

      const headers = {
        "Content-Type": "application/pdf",
        "Authorization": `Bearer ${token}`,
        "X-Shibei-Title": encodeURIComponent(pageInfo.title || ""),
        "X-Shibei-Url": encodeURIComponent(pageInfo.url || ""),
        "X-Shibei-Domain": encodeURIComponent(pageInfo.domain || ""),
        "X-Shibei-Folder-Id": folderId,
        "X-Shibei-Captured-At": new Date().toISOString(),
      };
      if (tags.length) {
        headers["X-Shibei-Tags"] = tags.map(encodeURIComponent).join(",");
      }

      const res = await fetch(`${API_BASE}/api/save-raw`, {
        method: "POST",
        headers,
        body: pdfBytes,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      showMessage(msg("saveSuccess"), "success");
      setTimeout(() => window.close(), 1000);
      return; // Skip HTML save flow
    }

    const metadata = {
      title: pageInfo.title,
      url: pageInfo.url,
      domain: pageInfo.domain,
      author: pageInfo.author,
      description: pageInfo.description,
      folderId,
      tags,
    };

    // Write pre-captured HTML from MAIN world variable to DOM element
    const writeResults = await chrome.scripting.executeScript({
      target: { tabId: pageInfo.tabId },
      world: "MAIN",
      func: () => {
        try {
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
    });

    const writeResult = writeResults?.[0]?.result;
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
      throw new Error(saveResult?.error || msg("saveFailed"));
    }

    showMessage(msg("saveSuccess"), "success");
    setTimeout(() => window.close(), 1000);
  } catch (err) {
    console.error("[shibei] error:", err);
    const errMsg = err.message || String(err);
    if (errMsg.includes("Cannot access") || errMsg.includes("Cannot read")) {
      showMessage(msg("errorPageRestricted"), "error");
    } else if (errMsg.includes("No tab with id") || errMsg.includes("Invalid tab")) {
      showMessage(msg("errorNoTab"), "error");
    } else {
      showMessage(msg("errorPrefix", errMsg), "error");
    }
    saveBtn.disabled = false;
  }
});

// ── Region save ──

selectSaveBtn.addEventListener("click", async () => {
  selectSaveBtn.disabled = true;
  saveBtn.disabled = true; // Disable full-page save during region selection

  if (!pageInfo?.tabId) {
    showMessage(msg("errorNoPageInfo"), "error");
    return;
  }

  const folderId = folderSelect.value;
  if (!folderId) {
    showMessage(msg("selectFolder"), "error");
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

  // Prepare translated strings for region-selector (MAIN world cannot use chrome.i18n)
  const regionI18n = {
    regionTopBarGuide: msg("regionTopBarGuide"),
    regionConfirmBtn: msg("regionConfirmBtn"),
    regionReselectBtn: msg("regionReselectBtn"),
    regionSelected: msg("regionSelected", "$1"),
    regionWaitingCapture: msg("regionWaitingCapture", "$1"),
    regionSaving: msg("regionSaving"),
    capturingPage: msg("capturingPage"),
    regionWaitingCaptureToast: msg("regionWaitingCaptureToast"),
    regionCaptureFailed: msg("regionCaptureFailed", "$1"),
    regionClipping: msg("regionClipping"),
    regionClipFailed: msg("regionClipFailed"),
    regionParamsLost: msg("regionParamsLost"),
    saving: msg("saving"),
    saveSuccess: msg("saveSuccess"),
    regionSaveFailed: msg("regionSaveFailed", "$1"),
    unknownError: msg("unknownError"),
  };

  // Set a result flag that we'll poll for completion
  try {
    await chrome.scripting.executeScript({
      target: { tabId: pageInfo.tabId },
      world: "MAIN",
      func: (params, i18nStrings) => {
        window.__shibeiSaveParams = params;
        window.__shibeiRegionI18n = i18nStrings;
        window.__shibeiRegionSaveResult = null; // reset
      },
      args: [saveParams, regionI18n],
    });
  } catch (e) {
    showMessage(msg("injectParamsFailed", e.message), "error");
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: pageInfo.tabId },
      files: ["src/content/relay.js"],
    });
  } catch (e) {
    console.log("[shibei] relay inject failed:", e.message);
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: pageInfo.tabId },
      files: ["lib/single-file-bundle.js"],
      world: "MAIN",
    });
  } catch (e) {
    console.log("[shibei] SingleFile pre-inject (may already exist):", e.message);
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: pageInfo.tabId },
      files: ["src/content/region-selector.js"],
      world: "MAIN",
    });
  } catch (e) {
    showMessage(msg("injectSelectorFailed", e.message), "error");
    return;
  }

  showMessage(msg("selectRegionPrompt"), "loading");

  // Poll for region save result (set by region-selector.js)
  const pollInterval = setInterval(async () => {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: pageInfo.tabId },
        world: "MAIN",
        func: () => window.__shibeiRegionSaveResult,
      });
      const result = results?.[0]?.result;
      if (result === "success") {
        clearInterval(pollInterval);
        showMessage(msg("saveSuccess"), "success");
        setTimeout(() => window.close(), 1000);
      } else if (result === "cancelled") {
        clearInterval(pollInterval);
        selectSaveBtn.disabled = false;
        if (captureReady) saveBtn.disabled = false;
        messageEl.style.display = "none";
      }
    } catch {
      clearInterval(pollInterval);
    }
  }, 500);
});

init();
