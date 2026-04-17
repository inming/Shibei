// Relay script — runs in ISOLATED world.
// Bridges postMessage from MAIN world (region-selector.js) to the background
// service worker, which owns all communication with the local HTTP server.
// Fetching via background (chrome-extension:// origin) avoids Chrome's Private
// Network Access prompt that would fire if we fetched 127.0.0.1 from a page
// context. Large HTML payloads are passed once via chrome.runtime.sendMessage
// (structured-clone); within sendMessage's practical limit for our workload.

// Guard against double-injection
if (window.__shibeiRelayInjected) {
  window.removeEventListener("message", window.__shibeiRelayHandler);
}
window.__shibeiRelayInjected = true;

async function relaySaveRegion(data) {
  // Read content from shared DOM element (written by region-selector.js in MAIN world)
  const elId = data.transferId || "__shibei_transfer__";
  const transferEl = document.getElementById(elId);
  const content = transferEl?.textContent || "";
  if (transferEl) transferEl.remove();

  if (!content) {
    throw new Error("No content found in transfer element");
  }

  const response = await chrome.runtime.sendMessage({
    type: "api:save-html",
    body: content,
    meta: {
      title: data.title,
      url: data.url,
      domain: data.domain,
      author: data.author,
      description: data.description,
      folderId: data.folderId,
      tags: data.tags,
      selection_meta: data.selection_meta,
    },
  });

  if (!response?.success) {
    throw new Error(response?.error || "Unknown error");
  }
  return response;
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
        error: err.message || (typeof chrome !== "undefined" && chrome.i18n ? chrome.i18n.getMessage("relaySaveFailed") : "Save failed"),
      });
    });
};
window.addEventListener("message", window.__shibeiRelayHandler);
