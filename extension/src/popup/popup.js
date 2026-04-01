const API_BASE = "http://127.0.0.1:21519";

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

let pageInfo = null;

function showMessage(text, type) {
  console.log(`[shibei] ${type}: ${text}`);
  messageEl.textContent = text;
  messageEl.className = `message message-${type}`;
  messageEl.style.display = "block";
}

async function init() {
  console.log("[shibei] popup init started");

  // Check if desktop app is running
  try {
    const res = await fetch(`${API_BASE}/api/ping`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error("not ok");
    console.log("[shibei] ping ok");

    statusEl.textContent = "已连接";
    statusEl.className = "status status-online";
    offlineNotice.style.display = "none";
    mainContent.style.display = "block";
  } catch (err) {
    console.log("[shibei] ping failed:", err);
    statusEl.textContent = "未连接";
    statusEl.className = "status status-offline";
    offlineNotice.style.display = "block";
    mainContent.style.display = "none";
    return;
  }

  // Get current tab info
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    console.log("[shibei] current tab:", tab?.url);

    if (tab) {
      // Check for restricted pages
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

      // Try to extract more meta info (may fail on restricted pages)
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
    }
  } catch (err) {
    console.error("[shibei] tab query failed:", err);
  }

  // Load folders
  try {
    const res = await fetch(`${API_BASE}/api/folders`);
    const folders = await res.json();
    console.log("[shibei] folders loaded:", folders.length);
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
    // Step 1: Inject SingleFile bundle
    showMessage("注入 SingleFile...", "loading");
    console.log("[shibei] injecting SingleFile bundle into tab", pageInfo.tabId);

    await chrome.scripting.executeScript({
      target: { tabId: pageInfo.tabId },
      files: ["lib/single-file-bundle.js"],
      world: "MAIN",
    });
    console.log("[shibei] bundle injected");

    // Step 2: Run capture
    showMessage("正在抓取页面（可能需要几秒）...", "loading");
    console.log("[shibei] running SingleFile capture");

    const captureResults = await chrome.scripting.executeScript({
      target: { tabId: pageInfo.tabId },
      world: "MAIN",
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
          });
          return { success: true, content: pageData.content, size: pageData.content.length };
        } catch (err) {
          return { success: false, error: String(err) };
        }
      },
    });

    console.log("[shibei] capture results:", JSON.stringify(captureResults?.[0]?.result).slice(0, 200));

    const captureResult = captureResults?.[0]?.result;
    if (!captureResult || !captureResult.success) {
      throw new Error(captureResult?.error || "抓取返回空结果");
    }

    console.log("[shibei] captured", captureResult.size, "bytes");

    // Step 3: Base64 encode and POST
    showMessage("正在保存...", "loading");

    const tags = tagsInput.value
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    // Encode content as base64
    const encoder = new TextEncoder();
    const bytes = encoder.encode(captureResult.content);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64Content = btoa(binary);

    const payload = {
      title: pageInfo.title,
      url: pageInfo.url,
      domain: pageInfo.domain,
      author: pageInfo.author || null,
      description: pageInfo.description || null,
      content: base64Content,
      content_type: "html",
      folder_id: folderId,
      tags,
      captured_at: new Date().toISOString(),
    };

    console.log("[shibei] posting to server, payload size:", base64Content.length);

    const res = await fetch(`${API_BASE}/api/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`HTTP ${res.status}: ${err}`);
    }

    const result = await res.json();
    console.log("[shibei] saved:", result);

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

init();
