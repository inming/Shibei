// Relay script — runs in ISOLATED world.
// Bridges postMessage from MAIN world (region-selector.js) to local HTTP server.
// Posts directly to avoid chrome.runtime.sendMessage 64MiB limit.

const RELAY_API_BASE = "http://127.0.0.1:21519";

async function relaySaveRegion(data) {
  // Get auth token
  const tokenRes = await fetch(`${RELAY_API_BASE}/token`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!tokenRes.ok) throw new Error(`Token fetch failed: HTTP ${tokenRes.status}`);
  const { token } = await tokenRes.json();

  // Base64 encode content (chunked to avoid O(n²) string concat)
  const bytes = new TextEncoder().encode(data.content);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  }
  const base64 = btoa(chunks.join(""));

  const payload = {
    title: data.title,
    url: data.url,
    domain: data.domain,
    author: data.author || null,
    description: data.description || null,
    content: base64,
    content_type: "html",
    folder_id: data.folderId,
    tags: data.tags || [],
    captured_at: new Date().toISOString(),
    selection_meta: data.selection_meta,
  };

  const res = await fetch(`${RELAY_API_BASE}/api/save`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  return res.json();
}

window.addEventListener("message", (event) => {
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
});
