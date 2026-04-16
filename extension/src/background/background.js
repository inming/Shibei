// Let Chrome handle opening the panel when action icon is clicked
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

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
    return true; // Keep channel open for async response
  }
});
