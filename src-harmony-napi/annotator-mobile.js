"use strict";
// Shibei annotator — mobile (ArkWeb) edition.
//
// Communicates with ArkTS via window.shibeiBridge (registerJavaScriptProxy):
//   shibeiBridge.emit(type: string, json: string)      — fire-and-forget event
//   shibeiBridge.ack(id: string, json: string)         — response to a request
//
// Event types emitted to ArkTS:
//   "selection"  → { textContent, anchor, rectJson }
//   "click"      → { highlightId, rectJson }
//   "ready"      → { resourceId: "" }  (annotator loaded; ArkTS can call paintHighlights)
//
// ArkTS calls into JS via webviewController.runJavaScript:
//   window.__shibei.paintHighlights(list)   — apply list of highlights
//   window.__shibei.flashHighlight(id)      — scroll-to and flash
//   window.__shibei.clearSelection()        — clear current window selection
//
// No page-script stripping here — Rust did that before sending HTML.

(function () {
  const bridge = window.shibeiBridge;
  if (!bridge) {
    console.warn("[annotator-mobile] shibeiBridge missing, skipping init");
    return;
  }
  const state = { highlightsById: new Map() };

  // ── Styles ──
  // `--shibei-hl-text` overrides the text color inside a highlight so the
  // label stays legible across dark-mode pages (ArkWeb auto-inverts body
  // text to white; yellow hl + white text would be unreadable). Each hl
  // sets its own per-element var via getContrastText(color) below.
  const style = document.createElement("style");
  style.textContent = `
    shibei-hl {
      background: var(--shibei-hl-color, #ffeb3b) !important;
      color: var(--shibei-hl-text, inherit) !important;
      border-radius: 2px !important;
    }
    shibei-hl.shibei-flash {
      animation: shibei-flash-anim 0.6s ease-in-out !important;
    }
    @keyframes shibei-flash-anim {
      0%, 100% { filter: brightness(1); }
      50% { filter: brightness(0.6); }
    }
  `;
  document.documentElement.appendChild(style);

  // Pick #111 / #fff depending on luminance — ported from desktop annotator.
  // Weighting: 0.299 R + 0.587 G + 0.114 B (ITU-R BT.601). Threshold 0.6
  // tuned so the four HL_COLORS split correctly (yellow/green/blue/pink).
  function getContrastText(hex) {
    if (!hex) return '#111';
    const h = hex.replace('#', '');
    if (h.length !== 6) return '#111';
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    return lum > 0.6 ? '#111' : '#fff';
  }

  // ── Text offset utilities ──
  const EXCLUDED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
  const ZERO_WIDTH_RE = /[​‌‍﻿]/g;
  function normalizedLength(text) { return text.replace(ZERO_WIDTH_RE, "").length; }
  function normalizedText(text) { return text.replace(ZERO_WIDTH_RE, ""); }

  function getTextNodes(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_ACCEPT;
        if (EXCLUDED_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  function nodeOffset(targetNode, targetOffset) {
    const nodes = getTextNodes(document.body);
    let acc = 0;
    for (const n of nodes) {
      if (n === targetNode) {
        const raw = n.nodeValue || "";
        const prefix = raw.slice(0, targetOffset);
        return acc + normalizedLength(prefix);
      }
      acc += normalizedLength(n.nodeValue || "");
    }
    return -1;
  }

  function locateOffset(offset) {
    const nodes = getTextNodes(document.body);
    let acc = 0;
    for (const n of nodes) {
      const raw = n.nodeValue || "";
      const len = normalizedLength(raw);
      if (offset <= acc + len) {
        let rem = offset - acc;
        let i = 0;
        while (i < raw.length && rem > 0) {
          if (!/[​‌‍﻿]/.test(raw[i])) rem--;
          i++;
        }
        return { node: n, offset: i };
      }
      acc += len;
    }
    return null;
  }

  function buildAnchor(range) {
    const startOff = nodeOffset(range.startContainer, range.startOffset);
    const endOff = nodeOffset(range.endContainer, range.endOffset);
    if (startOff < 0 || endOff < 0 || endOff <= startOff) return null;
    const text = normalizedText(range.toString());
    const bodyText = normalizedText(document.body.innerText || "");
    const prefix = bodyText.slice(Math.max(0, startOff - 32), startOff);
    const suffix = bodyText.slice(endOff, Math.min(bodyText.length, endOff + 32));
    return {
      text_position: { start: startOff, end: endOff },
      text_quote: { exact: text, prefix, suffix }
    };
  }

  function resolveAnchor(anchor) {
    if (!anchor || !anchor.text_position) return null;
    const start = locateOffset(anchor.text_position.start);
    const end = locateOffset(anchor.text_position.end);
    if (!start || !end) return null;
    const range = document.createRange();
    try {
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
    } catch (_) { return null; }
    // Verify by exact text; if mismatch, fallback to text_quote search (Phase 3b).
    const got = normalizedText(range.toString());
    const want = anchor.text_quote && anchor.text_quote.exact;
    if (want && got !== want) return null;
    return range;
  }

  function wrapHighlight(range, id, color) {
    const nodes = [];
    const root = range.commonAncestorContainer;
    if (root.nodeType === Node.TEXT_NODE) {
      // TreeWalker with a text-node root doesn't yield the root itself.
      // Single-text-node selections are extremely common (a sentence within
      // a <p>) so handle explicitly.
      if (range.intersectsNode(root)) nodes.push(root);
    } else {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      let n;
      while ((n = walker.nextNode())) {
        if (range.intersectsNode(n)) nodes.push(n);
      }
    }
    const wrapped = [];
    for (const node of nodes) {
      const startOff = node === range.startContainer ? range.startOffset : 0;
      const endOff = node === range.endContainer ? range.endOffset : (node.nodeValue || "").length;
      if (endOff <= startOff) continue;
      const before = (node.nodeValue || "").slice(0, startOff);
      const mid = (node.nodeValue || "").slice(startOff, endOff);
      const after = (node.nodeValue || "").slice(endOff);
      const hl = document.createElement("shibei-hl");
      hl.setAttribute("data-shibei-id", id);
      const hlColor = color || "#ffeb3b";
      hl.style.setProperty("--shibei-hl-color", hlColor);
      hl.style.setProperty("--shibei-hl-text", getContrastText(hlColor));
      hl.textContent = mid;
      const parent = node.parentNode;
      if (!parent) continue;
      const frag = document.createDocumentFragment();
      if (before) frag.appendChild(document.createTextNode(before));
      frag.appendChild(hl);
      if (after) frag.appendChild(document.createTextNode(after));
      parent.replaceChild(frag, node);
      wrapped.push(hl);
    }
    for (const el of wrapped) {
      el.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const rect = el.getBoundingClientRect();
        bridge.emit("click", JSON.stringify({
          highlightId: id,
          rectJson: { x: rect.left, y: rect.top, w: rect.width, h: rect.height }
        }));
      });
    }
  }

  function unwrapHighlight(id) {
    const els = document.querySelectorAll(`shibei-hl[data-shibei-id="${CSS.escape(id)}"]`);
    els.forEach(el => {
      const parent = el.parentNode;
      if (!parent) return;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
      parent.normalize();
    });
  }

  // ── Public API (called by ArkTS via runJavaScript) ──
  window.__shibei = {
    paintHighlights(listJson) {
      let list;
      try { list = JSON.parse(listJson); } catch (_) { return; }
      for (const h of list || []) {
        const existing = state.highlightsById.get(h.id);
        if (existing) {
          // Already wrapped — just re-apply color if it changed so swatch
          // taps in the long-press menu (and remote color edits via sync)
          // repaint without a full wrap/unwrap cycle.
          if (existing.color !== h.color) {
            const sel = `shibei-hl[data-shibei-id="${CSS.escape(h.id)}"]`;
            const textColor = getContrastText(h.color);
            document.querySelectorAll(sel).forEach((el) => {
              el.style.setProperty("--shibei-hl-color", h.color);
              el.style.setProperty("--shibei-hl-text", textColor);
            });
            state.highlightsById.set(h.id, h);
          }
          continue;
        }
        const range = resolveAnchor(h.anchor);
        if (!range) continue;
        wrapHighlight(range, h.id, h.color);
        state.highlightsById.set(h.id, h);
      }
    },
    removeHighlight(id) {
      unwrapHighlight(id);
      state.highlightsById.delete(id);
    },
    flashHighlight(id) {
      const el = document.querySelector(`shibei-hl[data-shibei-id="${CSS.escape(id)}"]`);
      if (!el) return;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.add("shibei-flash");
      setTimeout(() => el.classList.remove("shibei-flash"), 800);
    },
    clearSelection() {
      const sel = window.getSelection();
      if (sel) sel.removeAllRanges();
    }
  };

  // ── Selection watcher ──
  // Fires "selection" when user finishes selecting; debounced to the
  // selectionchange settled state (250ms after last change).
  let selectionTimer = null;
  document.addEventListener("selectionchange", () => {
    if (selectionTimer) clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        bridge.emit("selection", JSON.stringify({ collapsed: true }));
        return;
      }
      const range = sel.getRangeAt(0);
      const text = range.toString().trim();
      if (!text) {
        bridge.emit("selection", JSON.stringify({ collapsed: true }));
        return;
      }
      const anchor = buildAnchor(range);
      if (!anchor) return;
      const rect = range.getBoundingClientRect();
      bridge.emit("selection", JSON.stringify({
        collapsed: false,
        textContent: text,
        anchor,
        rectJson: { x: rect.left, y: rect.top, w: rect.width, h: rect.height }
      }));
    }, 250);
  });

  // Signal ready after DOMContentLoaded (idempotent if already past).
  function fireReady() {
    bridge.emit("ready", JSON.stringify({ resourceId: "" }));
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", fireReady);
  } else {
    fireReady();
  }
})();
