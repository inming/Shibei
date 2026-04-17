// Background service worker — owns all communication with the local HTTP
// server at 127.0.0.1:21519. Running under chrome-extension:// origin bypasses
// Chrome's Private Network Access prompt that would otherwise fire when
// content scripts on public HTTPS pages fetch private network addresses.

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

const API_BASE = "http://127.0.0.1:21519";
const MAX_PAYLOAD_BYTES = 80 * 1024 * 1024;

let cachedToken = null;

async function getToken({ force = false } = {}) {
  if (!force && cachedToken) return cachedToken;
  cachedToken = null;
  const res = await fetch(`${API_BASE}/token`, { signal: AbortSignal.timeout(2000) });
  if (!res.ok) throw new Error(`Token fetch failed: HTTP ${res.status}`);
  const { token } = await res.json();
  cachedToken = token;
  return token;
}

function buildHeaders(meta, contentType, token) {
  const headers = {
    "Content-Type": contentType,
    "Authorization": `Bearer ${token}`,
    "X-Shibei-Title": encodeURIComponent(meta.title || ""),
    "X-Shibei-Url": encodeURIComponent(meta.url || ""),
    "X-Shibei-Domain": encodeURIComponent(meta.domain || ""),
    "X-Shibei-Folder-Id": meta.folderId || "",
    "X-Shibei-Captured-At": new Date().toISOString(),
  };
  if (meta.author) headers["X-Shibei-Author"] = encodeURIComponent(meta.author);
  if (meta.description) headers["X-Shibei-Description"] = encodeURIComponent(meta.description);
  if (meta.selection_meta) headers["X-Shibei-Selection-Meta"] = encodeURIComponent(meta.selection_meta);
  if (meta.tags?.length) headers["X-Shibei-Tags"] = meta.tags.map(encodeURIComponent).join(",");
  return headers;
}

async function postSaveRaw(body, contentType, meta) {
  let token = await getToken();
  let res = await fetch(`${API_BASE}/api/save-raw`, {
    method: "POST",
    headers: buildHeaders(meta, contentType, token),
    body,
  });
  if (res.status === 401) {
    token = await getToken({ force: true });
    res = await fetch(`${API_BASE}/api/save-raw`, {
      method: "POST",
      headers: buildHeaders(meta, contentType, token),
      body,
    });
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "fetch-pdf") {
    fetch(message.url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then((buffer) => {
        sendResponse({ success: true, data: Array.from(new Uint8Array(buffer)) });
      })
      .catch((err) => {
        sendResponse({ success: false, error: String(err) });
      });
    return true;
  }

  if (message.type === "api:save-html") {
    const body = message.body;
    if (typeof body !== "string") {
      sendResponse({ success: false, error: "Invalid body" });
      return false;
    }
    if (body.length > MAX_PAYLOAD_BYTES) {
      sendResponse({ success: false, error: chrome.i18n.getMessage("errorPageTooLarge") });
      return false;
    }
    postSaveRaw(body, "text/html; charset=utf-8", message.meta || {})
      .then((data) => sendResponse({ success: true, resource_id: data.resource_id }))
      .catch((err) => sendResponse({ success: false, error: String(err?.message || err) }));
    return true;
  }
});
