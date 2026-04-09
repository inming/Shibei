// Region Selector for Shibei — injected into MAIN world
// Allows user to hover-select a DOM element, then saves the clipped subtree via SingleFile.

(function () {
  "use strict";

  // Guard against double-injection
  if (window.__shibeiRegionSelector) return;
  window.__shibeiRegionSelector = true;

  const ATTR = "data-shibei-selector";
  const Z = 2147483647;

  // ── State ──
  let currentElement = null; // The element under the cursor (or navigated to)
  let lockedElement = null; // The element the user clicked to lock
  let ancestorChain = []; // For scroll/keyboard navigation: [child, ..., parent]
  let ancestorIndex = 0; // Current position in ancestorChain

  // ── UI Elements ──
  let overlay = null; // Highlight overlay
  let topBar = null; // Instruction bar
  let confirmBar = null; // Confirm/reselect bar
  let toast = null; // Status toast

  // ── Filtered tags ──
  const IGNORED_TAGS = new Set([
    "HTML", "BODY", "HEAD", "SCRIPT", "STYLE", "LINK", "META",
    "NOSCRIPT", "BR", "HR",
  ]);

  const MIN_SIZE = 20;

  // ═══════════════════════════════════════════
  // UI Creation
  // ═══════════════════════════════════════════

  function createOverlay() {
    const el = document.createElement("div");
    el.setAttribute(ATTR, "overlay");
    Object.assign(el.style, {
      position: "absolute",
      pointerEvents: "none",
      border: "2px solid #3b82f6",
      backgroundColor: "rgba(59, 130, 246, 0.08)",
      borderRadius: "2px",
      zIndex: Z,
      display: "none",
      transition: "top 0.05s, left 0.05s, width 0.05s, height 0.05s",
    });
    document.body.appendChild(el);
    return el;
  }

  function createTopBar() {
    const el = document.createElement("div");
    el.setAttribute(ATTR, "topbar");
    Object.assign(el.style, {
      position: "fixed",
      top: "0",
      left: "0",
      right: "0",
      padding: "8px 16px",
      backgroundColor: "#1e40af",
      color: "white",
      fontSize: "13px",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      textAlign: "center",
      zIndex: Z,
      boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
    });
    el.textContent = "选择要保存的区域 — 滚轮或方向键调整层级 — ESC 退出";
    document.body.appendChild(el);
    return el;
  }

  function createConfirmBar() {
    const el = document.createElement("div");
    el.setAttribute(ATTR, "confirmbar");
    Object.assign(el.style, {
      position: "fixed",
      bottom: "16px",
      left: "50%",
      transform: "translateX(-50%)",
      display: "none",
      gap: "12px",
      padding: "10px 20px",
      backgroundColor: "white",
      borderRadius: "8px",
      boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      fontSize: "14px",
      zIndex: Z,
    });

    const confirmBtn = document.createElement("button");
    confirmBtn.textContent = "\u2713 确认保存";
    confirmBtn.setAttribute(ATTR, "btn");
    Object.assign(confirmBtn.style, {
      padding: "6px 16px",
      backgroundColor: "#3b82f6",
      color: "white",
      border: "none",
      borderRadius: "4px",
      cursor: "pointer",
      fontSize: "14px",
      fontWeight: "500",
    });
    confirmBtn.addEventListener("click", onConfirm);

    const reselectBtn = document.createElement("button");
    reselectBtn.textContent = "\u2717 重新选择";
    reselectBtn.setAttribute(ATTR, "btn");
    Object.assign(reselectBtn.style, {
      padding: "6px 16px",
      backgroundColor: "#f3f4f6",
      color: "#374151",
      border: "1px solid #d1d5db",
      borderRadius: "4px",
      cursor: "pointer",
      fontSize: "14px",
    });
    reselectBtn.addEventListener("click", onReselect);

    el.appendChild(confirmBtn);
    el.appendChild(reselectBtn);
    document.body.appendChild(el);
    return el;
  }

  function createToast() {
    const el = document.createElement("div");
    el.setAttribute(ATTR, "toast");
    Object.assign(el.style, {
      position: "fixed",
      top: "48px",
      left: "50%",
      transform: "translateX(-50%)",
      padding: "10px 24px",
      backgroundColor: "#1e40af",
      color: "white",
      borderRadius: "8px",
      fontSize: "14px",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      zIndex: Z,
      display: "none",
      boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
    });
    document.body.appendChild(el);
    return el;
  }

  function showToast(text, color) {
    toast.textContent = text;
    toast.style.backgroundColor = color || "#1e40af";
    toast.style.display = "block";
  }

  // ═══════════════════════════════════════════
  // Element Filtering & Selection
  // ═══════════════════════════════════════════

  function isShibeiElement(el) {
    return el && el.hasAttribute && el.hasAttribute(ATTR);
  }

  function isValidTarget(el) {
    if (!el || !el.tagName) return false;
    if (IGNORED_TAGS.has(el.tagName)) return false;
    if (isShibeiElement(el)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) return false;
    return true;
  }

  function findValidTarget(el) {
    while (el && !isValidTarget(el)) {
      el = el.parentElement;
    }
    return el || null;
  }

  function buildAncestorChain(el) {
    const chain = [];
    let cur = el;
    while (cur && cur.tagName !== "BODY" && cur.tagName !== "HTML") {
      if (isValidTarget(cur)) {
        chain.push(cur);
      }
      cur = cur.parentElement;
    }
    return chain; // [current, parent, grandparent, ...]
  }

  function positionOverlay(el) {
    if (!el) {
      overlay.style.display = "none";
      return;
    }
    const rect = el.getBoundingClientRect();
    overlay.style.display = "block";
    overlay.style.top = (rect.top + window.scrollY) + "px";
    overlay.style.left = (rect.left + window.scrollX) + "px";
    overlay.style.width = rect.width + "px";
    overlay.style.height = rect.height + "px";
  }

  // ═══════════════════════════════════════════
  // CSS Selector Generation
  // ═══════════════════════════════════════════

  function generateSelector(el) {
    // Try ID first
    if (el.id) {
      const sel = "#" + CSS.escape(el.id);
      if (document.querySelectorAll(sel).length === 1) return sel;
    }

    // Build path from element to a unique ancestor
    const parts = [];
    let cur = el;
    while (cur && cur.tagName !== "BODY" && cur.tagName !== "HTML") {
      let seg = cur.tagName.toLowerCase();

      if (cur.id) {
        seg = "#" + CSS.escape(cur.id);
        parts.unshift(seg);
        break;
      }

      // Add nth-of-type for uniqueness
      if (cur.parentElement) {
        const siblings = Array.from(cur.parentElement.children).filter(
          (s) => s.tagName === cur.tagName
        );
        if (siblings.length > 1) {
          const idx = siblings.indexOf(cur) + 1;
          seg += ":nth-of-type(" + idx + ")";
        }
      }

      // Add classes (first two, skip utility-style long class names)
      const classes = Array.from(cur.classList || [])
        .filter((c) => c.length < 30 && !c.includes(":"))
        .slice(0, 2);
      if (classes.length > 0) {
        seg += "." + classes.map((c) => CSS.escape(c)).join(".");
      }

      parts.unshift(seg);
      cur = cur.parentElement;
    }

    return parts.join(" > ");
  }

  // ═══════════════════════════════════════════
  // HTML Clipping
  // ═══════════════════════════════════════════

  function isSafeAttr(name, value) {
    if (name.toLowerCase().startsWith("on")) return false;
    if (["href", "src", "action"].includes(name.toLowerCase())) {
      if (typeof value === "string" && value.trim().toLowerCase().startsWith("javascript:")) {
        return false;
      }
    }
    return true;
  }

  function clipHtml(fullHtml, selector) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(fullHtml, "text/html");
    const target = doc.querySelector(selector);

    if (!target) {
      console.error("[shibei] selector not found in captured HTML:", selector);
      return null;
    }

    // Rebuild body with ancestor chain as style wrappers
    const newBody = doc.createElement("body");

    // Copy body attributes (class, id, style)
    const origBody = doc.body;
    if (origBody) {
      for (const attr of origBody.attributes) {
        if (isSafeAttr(attr.name, attr.value)) {
          newBody.setAttribute(attr.name, attr.value);
        }
      }
    }

    // Build ancestor wrappers from target up to body
    const ancestors = [];
    let cur = target.parentElement;
    while (cur && cur.tagName !== "BODY" && cur.tagName !== "HTML") {
      ancestors.push(cur);
      cur = cur.parentElement;
    }
    ancestors.reverse(); // now [outermost, ..., direct parent]

    // Create nested wrappers
    let container = newBody;
    for (const anc of ancestors) {
      const wrapper = doc.createElement(anc.tagName.toLowerCase());
      for (const attr of anc.attributes) {
        if (isSafeAttr(attr.name, attr.value)) {
          wrapper.setAttribute(attr.name, attr.value);
        }
      }
      container.appendChild(wrapper);
      container = wrapper;
    }

    // Append the target element into the innermost wrapper
    container.appendChild(target);

    // Replace body
    doc.body.replaceWith(newBody);

    // Serialize
    return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
  }

  // ═══════════════════════════════════════════
  // Save Flow
  // ═══════════════════════════════════════════

  async function doSave(element) {
    showToast("正在抓取页面...", "#1e40af");

    const selector = generateSelector(element);
    const textPreview = (element.textContent || "").trim().slice(0, 50);
    const tagName = element.tagName.toLowerCase();

    // Get save parameters from global variable (set by popup via executeScript)
    const params = window.__shibeiSaveParams;
    if (!params) {
      showToast("保存参数丢失，请重新操作", "#dc2626");
      setTimeout(cleanup, 2000);
      return;
    }

    // Run SingleFile capture (bundle was pre-injected by popup)
    let fullHtml;
    try {
      if (typeof SingleFile === "undefined" || !SingleFile.getPageData) {
        throw new Error("SingleFile not available");
      }
      const pageData = await SingleFile.getPageData({
        removeHiddenElements: false,
        removeUnusedStyles: true,
        removeUnusedFonts: true,
        compressHTML: true,
        loadDeferredImages: true,
        loadDeferredImagesMaxIdleTime: 3000,
        maxResourceSizeEnabled: true,
        maxResourceSize: 5,
      });
      fullHtml = pageData.content;
      fullHtml = fullHtml.replace(/<video[\s>][\s\S]*?<\/video>/gi, '');
      fullHtml = fullHtml.replace(/<audio[\s>][\s\S]*?<\/audio>/gi, '');
      fullHtml = fullHtml.replace(/<noscript[\s>][\s\S]*?<\/noscript>/gi, '');
    } catch (err) {
      showToast("页面抓取失败: " + err.message, "#dc2626");
      setTimeout(cleanup, 2000);
      return;
    }

    // Clip HTML to selected subtree
    showToast("正在裁剪选区...", "#1e40af");
    const clippedHtml = clipHtml(fullHtml, selector);

    if (!clippedHtml) {
      showToast("裁剪失败 — 未找到选区元素", "#dc2626");
      setTimeout(cleanup, 2000);
      return;
    }

    // Send to relay via DOM element (avoids postMessage IPC size limits).
    // MAIN and ISOLATED worlds share the DOM, so this bypasses the 64MiB limit.
    showToast("正在保存...", "#1e40af");

    // Write large content to a hidden DOM element instead of postMessage
    let transferEl = document.getElementById("__shibei_transfer__");
    if (!transferEl) {
      transferEl = document.createElement("script");
      transferEl.type = "text/shibei-transfer";
      transferEl.id = "__shibei_transfer__";
      transferEl.style.display = "none";
      document.documentElement.appendChild(transferEl);
    }
    transferEl.textContent = clippedHtml;

    const saveData = {
      title: params.title,
      url: params.url,
      domain: params.domain,
      author: params.author,
      description: params.description,
      // content is in DOM element, not in postMessage payload
      folderId: params.folderId,
      tags: params.tags,
      selection_meta: JSON.stringify({
        selector: selector,
        tag_name: tagName,
        text_preview: textPreview,
      }),
    };

    // Listen for result from relay
    const resultHandler = (event) => {
      if (event.source !== window) return;
      if (event.data?.type !== "shibei:save-region-result") return;
      window.removeEventListener("message", resultHandler);

      if (event.data.success) {
        showToast("保存成功!", "#16a34a");
        delete window.__shibeiSaveParams;
        setTimeout(cleanup, 1500);
      } else {
        showToast("保存失败: " + (event.data.error || "未知错误"), "#dc2626");
        setTimeout(cleanup, 3000);
      }
    };
    window.addEventListener("message", resultHandler);

    // Send small metadata message to relay (content is in DOM)
    window.postMessage({
      type: "shibei:save-region",
      payload: saveData,
    });
  }

  // ═══════════════════════════════════════════
  // Event Handlers
  // ═══════════════════════════════════════════

  function onMouseMove(e) {
    if (lockedElement) return; // Locked — don't change highlight

    const el = findValidTarget(document.elementFromPoint(e.clientX, e.clientY));
    if (el === currentElement) return;

    currentElement = el;
    ancestorChain = el ? buildAncestorChain(el) : [];
    ancestorIndex = 0;
    positionOverlay(currentElement);
  }

  function onWheel(e) {
    if (lockedElement) return;
    if (ancestorChain.length === 0) return;

    e.preventDefault();
    e.stopPropagation();

    if (e.deltaY < 0) {
      // Scroll up → go to parent
      if (ancestorIndex < ancestorChain.length - 1) {
        ancestorIndex++;
      }
    } else {
      // Scroll down → go to child
      if (ancestorIndex > 0) {
        ancestorIndex--;
      }
    }

    currentElement = ancestorChain[ancestorIndex];
    positionOverlay(currentElement);
  }

  function onKeyDown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      cleanup();
      return;
    }

    if (lockedElement) return;

    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (ancestorChain.length > 0 && ancestorIndex < ancestorChain.length - 1) {
        ancestorIndex++;
        currentElement = ancestorChain[ancestorIndex];
        positionOverlay(currentElement);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (ancestorIndex > 0) {
        ancestorIndex--;
        currentElement = ancestorChain[ancestorIndex];
        positionOverlay(currentElement);
      }
    }
  }

  function onClick(e) {
    if (isShibeiElement(e.target)) return; // Don't capture clicks on our UI

    // Always block page clicks while selector is active — prevent navigation/reload
    e.preventDefault();
    e.stopPropagation();

    if (lockedElement) return; // Already locked

    if (!currentElement) return;

    // Lock the selection
    lockedElement = currentElement;

    // Update overlay to solid selection style
    overlay.style.borderColor = "#2563eb";
    overlay.style.backgroundColor = "rgba(37, 99, 235, 0.12)";
    overlay.style.borderWidth = "3px";

    // Update top bar
    topBar.textContent = "已选择: <" + lockedElement.tagName.toLowerCase() + "> — 确认保存或重新选择";

    // Show confirm bar
    confirmBar.style.display = "flex";
  }

  let saving = false;
  function onConfirm() {
    if (saving) return;
    saving = true;
    confirmBar.style.display = "none";
    topBar.textContent = "正在保存...";
    doSave(lockedElement);
  }

  function onReselect() {
    lockedElement = null;
    confirmBar.style.display = "none";
    topBar.textContent = "选择要保存的区域 — 滚轮或方向键调整层级 — ESC 退出";

    // Reset overlay style
    overlay.style.borderColor = "#3b82f6";
    overlay.style.backgroundColor = "rgba(59, 130, 246, 0.08)";
    overlay.style.borderWidth = "2px";
  }

  // ═══════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════

  function init() {
    overlay = createOverlay();
    topBar = createTopBar();
    confirmBar = createConfirmBar();
    toast = createToast();

    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("wheel", onWheel, { capture: true, passive: false });
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("click", onClick, true);
  }

  function cleanup() {
    // Remove event listeners
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("wheel", onWheel, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("click", onClick, true);

    // Remove UI elements
    document.querySelectorAll("[" + ATTR + "]").forEach((el) => el.remove());

    // Reset state
    window.__shibeiRegionSelector = false;
    currentElement = null;
    lockedElement = null;
    ancestorChain = [];
    ancestorIndex = 0;
  }

  init();
})();
