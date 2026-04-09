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
