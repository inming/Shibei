# Extension UX Improvements — Auto-Capture, Auto-Close, Per-Tab Panel

## Overview

Three UX improvements to the Chrome extension:
1. Open side panel → immediately start SingleFile capture in background, show timer progress, enable save only when done, region selection not blocked
2. Save success → auto-close side panel after brief feedback
3. Side panel only visible on the tab where user initiated capture; switching tabs hides it, switching back restores it with state preserved

## 1. Auto-Capture on Panel Open

### Current flow
Open panel → user fills form → clicks save → SingleFile captures → strips media → writes DOM → ISOLATED world POST

### New flow
Open panel → `init()` loads page info + folders (same as now) → **immediately** calls `startCapture()` → capture runs in background → user fills form while waiting → capture done → save button enabled → user clicks save → write DOM → POST

### Capture storage
The captured HTML is stored in a MAIN world JS variable `window.__shibeiCapturedHtml` (not in DOM element). This avoids conflicts between full-page and region save flows. DOM element `__shibei_transfer__` is only written when the user clicks save.

### Progress UI
- New `#capture-status` element between page-info and form fields
- During capture: `"正在抓取页面... 3s"` — updates every second via `setInterval`
- On success: `"抓取完成 (5.2s, 1.8 MB)"` — shows elapsed time and size
- On failure: `"抓取失败: {error}"` — red background

### Button states during capture
- **Save full page**: disabled until capture succeeds
- **Region select**: always enabled (not blocked by capture)

### Region selection reuses pre-capture
`region-selector.js` currently calls `SingleFile.getPageData()` itself. Change to:
1. Check `window.__shibeiCapturedHtml` first
2. If available → use directly, skip SingleFile call
3. If not yet available (capture still running) → show toast "等待页面抓取完成...", poll `window.__shibeiCapturedHtml` until ready, then proceed
4. Fallback: if variable is somehow not set (e.g. panel wasn't opened), call SingleFile as before

This makes region selection faster — by the time the user selects a region, the capture is usually already done.

## 2. Auto-Close After Save

On successful save (both full-page and region):
- Show success message for 1 second
- Call `window.close()` to close the side panel

Region save shows success toast on the page (existing behavior), then cleanup runs. No change needed for region save's page-side toast.

For full-page save in popup.js: after `showMessage("保存成功！", "success")`, add `setTimeout(() => window.close(), 1000)`.

## 3. Per-Tab Side Panel

### Behavior
- Click extension icon on Tab A → panel opens, bound to Tab A
- Switch to Tab B → panel hidden (not enabled for Tab B)
- Switch back to Tab A → panel visible, state preserved (JS variables, form inputs, capture result all intact)
- After save/close → disable panel for that tab

### Implementation

**manifest.json**: Remove `side_panel.default_path` (panel is opened programmatically, not by default). Keep `sidePanel` permission.

**background.js**:
```javascript
// Default: panel disabled for all tabs
chrome.sidePanel.setOptions({ enabled: false });

// Click icon → enable + open for current tab only
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.setOptions({
    tabId: tab.id,
    enabled: true,
    path: 'src/popup/popup.html'
  });
  await chrome.sidePanel.open({ tabId: tab.id });
});
```

Remove `setPanelBehavior({ openPanelOnActionClick: true })`.

**popup.js**: On close (save success or manual close), send message to background to disable panel for current tab:
```javascript
chrome.runtime.sendMessage({ type: "close-panel", tabId });
```

Background handles by calling `chrome.sidePanel.setOptions({ tabId, enabled: false })`.

## File Changes

| File | Change |
|------|--------|
| `extension/manifest.json` | Remove `side_panel.default_path` |
| `extension/src/background/background.js` | Per-tab panel control, close-panel message handler |
| `extension/src/popup/popup.html` | Add `#capture-status` element |
| `extension/src/popup/popup.css` | Capture status styles |
| `extension/src/popup/popup.js` | Auto-capture in init(), progress timer, save-after-capture flow, auto-close |
| `extension/src/content/region-selector.js` | Reuse `window.__shibeiCapturedHtml` instead of calling SingleFile |
