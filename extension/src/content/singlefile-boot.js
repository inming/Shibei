// This script runs SingleFile in the target tab.
// The SingleFile bundle must be injected first via executeScript.

(async function () {
  try {
    // The bundle exposes window.SingleFile with .getPageData()
    if (typeof SingleFile === "undefined" || !SingleFile.getPageData) {
      throw new Error("SingleFile not available");
    }

    const options = {
      removeHiddenElements: false,
      removeUnusedStyles: true,
      removeUnusedFonts: true,
      compressHTML: true,
      loadDeferredImages: true,
      loadDeferredImagesMaxIdleTime: 3000,
    };

    const pageData = await SingleFile.getPageData(options);

    // Send result back to extension
    chrome.runtime.sendMessage({
      type: "capture-result",
      success: true,
      content: pageData.content,
    });
  } catch (err) {
    chrome.runtime.sendMessage({
      type: "capture-result",
      success: false,
      error: String(err.message || err),
    });
  }
})();
