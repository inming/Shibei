// Relay script — runs in ISOLATED world.
// Bridges postMessage from MAIN world (region-selector.js) to background service worker.

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.data?.type !== "shibei:save-region") return;

  chrome.runtime.sendMessage(
    { type: "save-region", data: event.data.payload },
    (response) => {
      window.postMessage({
        type: "shibei:save-region-result",
        success: response?.success ?? false,
        error: response?.error || null,
      });
    }
  );
});
