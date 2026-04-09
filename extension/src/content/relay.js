// Relay script — runs in ISOLATED world.
// Bridges postMessage from MAIN world (region-selector.js) to local HTTP server.
// Reads large content from a shared DOM element and POSTs raw HTML to avoid
// base64 encoding and JSON wrapping that cause memory exhaustion on large pages.

// Guard against double-injection
if (window.__shibeiRelayInjected) {
  window.removeEventListener("message", window.__shibeiRelayHandler);
}
window.__shibeiRelayInjected = true;

const RELAY_API_BASE = "http://127.0.0.1:21519";

async function relaySaveRegion(data) {
  // Read content from shared DOM element (written by region-selector.js in MAIN world)
  const transferEl = document.getElementById("__shibei_transfer__");
  const content = transferEl?.textContent || "";
  if (transferEl) transferEl.remove();

  if (!content) {
    throw new Error("No content found in transfer element");
  }

  // Get auth token
  const tokenRes = await fetch(`${RELAY_API_BASE}/token`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!tokenRes.ok) throw new Error(`Token fetch failed: HTTP ${tokenRes.status}`);
  const { token } = await tokenRes.json();

  // POST raw HTML body with metadata in headers (no base64, no JSON wrapping)
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Authorization": `Bearer ${token}`,
    "X-Shibei-Title": encodeURIComponent(data.title || ""),
    "X-Shibei-Url": encodeURIComponent(data.url || ""),
    "X-Shibei-Domain": encodeURIComponent(data.domain || ""),
    "X-Shibei-Folder-Id": data.folderId || "",
    "X-Shibei-Captured-At": new Date().toISOString(),
  };
  if (data.author) headers["X-Shibei-Author"] = encodeURIComponent(data.author);
  if (data.description) headers["X-Shibei-Description"] = encodeURIComponent(data.description);
  if (data.selection_meta) headers["X-Shibei-Selection-Meta"] = encodeURIComponent(data.selection_meta);
  if (data.tags && data.tags.length > 0) {
    headers["X-Shibei-Tags"] = data.tags.map(encodeURIComponent).join(",");
  }

  const res = await fetch(`${RELAY_API_BASE}/api/save-raw`, {
    method: "POST",
    headers,
    body: content,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  return res.json();
}

window.__shibeiRelayHandler = (event) => {
  if (event.source !== window) return;
  if (event.data?.type !== "shibei:save-region") return;

  relaySaveRegion(event.data.payload)
    .then(() => {
      window.postMessage({
        type: "shibei:save-region-result",
        success: true,
        error: null,
      });
    })
    .catch((err) => {
      window.postMessage({
        type: "shibei:save-region-result",
        success: false,
        error: err.message || "保存失败",
      });
    });
};
window.addEventListener("message", window.__shibeiRelayHandler);
