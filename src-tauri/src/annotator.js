(function () {
  "use strict";

  // Only activate in shibei:// protocol frames
  if (!window.location.href.startsWith("shibei://")) return;

  // ── Styles ──

  const style = document.createElement("style");
  style.textContent = `
    shibei-hl {
      background: var(--shibei-hl-color, #ffeb3b) !important;
      cursor: pointer !important;
      border-radius: 2px !important;
    }
    shibei-hl.shibei-flash {
      animation: shibei-flash-anim 0.6s ease-in-out !important;
    }
    @keyframes shibei-flash-anim {
      0%, 100% { filter: brightness(1); }
      50% { filter: brightness(0.7); }
    }
  `;
  document.documentElement.appendChild(style);

  // ── Text offset utilities ──

  /**
   * Walk all text nodes under root in document order.
   */
  function getTextNodes(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      nodes.push(node);
    }
    return nodes;
  }

  /**
   * Compute the character offset of a (node, offset) pair relative to body's full text.
   */
  function computeTextOffset(container, offset) {
    const textNodes = getTextNodes(document.body);
    let total = 0;
    for (const tn of textNodes) {
      if (tn === container) {
        return total + offset;
      }
      total += tn.textContent.length;
    }
    // If container is an element, find the offset-th child's text position
    if (container.nodeType === Node.ELEMENT_NODE) {
      let childIndex = 0;
      total = 0;
      for (const tn of textNodes) {
        if (container.contains(tn)) {
          if (childIndex >= offset) return total;
          childIndex++;
        }
        total += tn.textContent.length;
      }
    }
    return total;
  }

  /**
   * Get the full text content of body (same ordering as getTextNodes).
   */
  function getBodyText() {
    return getTextNodes(document.body)
      .map((n) => n.textContent)
      .join("");
  }

  /**
   * Build anchor from current selection.
   */
  function computeAnchor(selection) {
    const range = selection.getRangeAt(0);
    const exact = selection.toString();
    const start = computeTextOffset(range.startContainer, range.startOffset);
    const end = start + exact.length;

    const bodyText = getBodyText();
    const prefixStart = Math.max(0, start - 30);
    const suffixEnd = Math.min(bodyText.length, end + 30);

    return {
      text_position: { start, end },
      text_quote: {
        exact,
        prefix: bodyText.slice(prefixStart, start),
        suffix: bodyText.slice(end, suffixEnd),
      },
    };
  }

  // ── Anchor resolution (find DOM range from anchor) ──

  /**
   * Resolve anchor to a DOM Range using textPosition (precise).
   */
  function resolveByPosition(anchor) {
    const textNodes = getTextNodes(document.body);
    const { start, end } = anchor.text_position;
    let offset = 0;
    let startNode = null,
      startOff = 0,
      endNode = null,
      endOff = 0;

    for (const tn of textNodes) {
      const len = tn.textContent.length;
      if (!startNode && offset + len > start) {
        startNode = tn;
        startOff = start - offset;
      }
      if (!endNode && offset + len >= end) {
        endNode = tn;
        endOff = end - offset;
        break;
      }
      offset += len;
    }

    if (!startNode || !endNode) return null;

    try {
      const range = document.createRange();
      range.setStart(startNode, startOff);
      range.setEnd(endNode, endOff);
      // Verify the text matches
      if (range.toString() === anchor.text_quote.exact) {
        return range;
      }
    } catch (_e) {
      // Fall through to null
    }
    return null;
  }

  /**
   * Resolve anchor using textQuote (fuzzy fallback).
   */
  function resolveByQuote(anchor) {
    const bodyText = getBodyText();
    const { exact, prefix, suffix } = anchor.text_quote;

    // Try to find exact match with context
    const searchStr = prefix + exact + suffix;
    const idx = bodyText.indexOf(searchStr);
    if (idx === -1) {
      // Try just the exact text
      const simpleIdx = bodyText.indexOf(exact);
      if (simpleIdx === -1) return null;
      return resolveByPosition({
        text_position: { start: simpleIdx, end: simpleIdx + exact.length },
        text_quote: anchor.text_quote,
      });
    }

    const start = idx + prefix.length;
    const end = start + exact.length;
    return resolveByPosition({
      text_position: { start, end },
      text_quote: anchor.text_quote,
    });
  }

  /**
   * Resolve anchor: try position first, then quote fallback.
   */
  function resolveAnchor(anchor) {
    return resolveByPosition(anchor) || resolveByQuote(anchor);
  }

  // ── Highlight rendering ──

  /**
   * Wrap a Range with <shibei-hl> elements. Handles ranges spanning multiple text nodes.
   */
  function wrapRange(range, highlightId, color) {
    // If range spans a single text node
    if (
      range.startContainer === range.endContainer &&
      range.startContainer.nodeType === Node.TEXT_NODE
    ) {
      const hl = createHlElement(highlightId, color);
      range.surroundContents(hl);
      return;
    }

    // Multi-node range: wrap each text node segment
    const textNodes = getTextNodes(document.body);
    const startOff = computeTextOffset(range.startContainer, range.startOffset);
    const endOff = computeTextOffset(range.endContainer, range.endOffset);
    let offset = 0;
    const nodesToWrap = [];

    for (const tn of textNodes) {
      const len = tn.textContent.length;
      const nodeStart = offset;
      const nodeEnd = offset + len;

      if (nodeEnd > startOff && nodeStart < endOff) {
        const wrapStart = Math.max(0, startOff - nodeStart);
        const wrapEnd = Math.min(len, endOff - nodeStart);
        nodesToWrap.push({ node: tn, start: wrapStart, end: wrapEnd });
      }
      offset += len;
    }

    // Wrap in reverse order to not invalidate offsets
    for (let i = nodesToWrap.length - 1; i >= 0; i--) {
      const { node, start, end } = nodesToWrap[i];
      const r = document.createRange();
      r.setStart(node, start);
      r.setEnd(node, end);
      const hl = createHlElement(highlightId, color);
      r.surroundContents(hl);
    }
  }

  function createHlElement(highlightId, color) {
    const hl = document.createElement("shibei-hl");
    hl.setAttribute("data-hl-id", highlightId);
    hl.style.setProperty("--shibei-hl-color", color);
    hl.addEventListener("click", () => {
      window.parent.postMessage(
        { type: "shibei:highlight-clicked", id: highlightId },
        "*"
      );
    });
    return hl;
  }

  /**
   * Remove all <shibei-hl> elements for a given highlight ID.
   */
  function removeHighlight(highlightId) {
    const elements = document.querySelectorAll(
      `shibei-hl[data-hl-id="${highlightId}"]`
    );
    elements.forEach((el) => {
      const parent = el.parentNode;
      while (el.firstChild) {
        parent.insertBefore(el.firstChild, el);
      }
      parent.removeChild(el);
      parent.normalize(); // merge adjacent text nodes
    });
  }

  /**
   * Scroll to a highlight and flash it.
   */
  function scrollToHighlight(highlightId) {
    const el = document.querySelector(
      `shibei-hl[data-hl-id="${highlightId}"]`
    );
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("shibei-flash");
    setTimeout(() => el.classList.remove("shibei-flash"), 700);
  }

  // ── Selection detection ──

  document.addEventListener("mouseup", () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) {
      window.parent.postMessage({ type: "shibei:selection-cleared" }, "*");
      return;
    }

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const anchor = computeAnchor(selection);

    window.parent.postMessage(
      {
        type: "shibei:selection",
        text: selection.toString(),
        anchor,
        rect: {
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
        },
      },
      "*"
    );
  });

  // ── Message handler (from parent React app) ──

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case "shibei:render-highlights":
        // Batch render highlights on page load
        if (Array.isArray(msg.highlights)) {
          for (const hl of msg.highlights) {
            try {
              const range = resolveAnchor(hl.anchor);
              if (range) {
                wrapRange(range, hl.id, hl.color);
              } else {
                console.warn("[shibei] Could not resolve anchor for:", hl.id);
              }
            } catch (e) {
              console.warn("[shibei] Failed to render highlight:", hl.id, e);
            }
          }
        }
        break;

      case "shibei:add-highlight":
        if (msg.highlight) {
          try {
            const range = resolveAnchor(msg.highlight.anchor);
            if (range) {
              wrapRange(range, msg.highlight.id, msg.highlight.color);
              // Clear selection after highlighting
              window.getSelection()?.removeAllRanges();
            }
          } catch (e) {
            console.warn("[shibei] Failed to add highlight:", e);
          }
        }
        break;

      case "shibei:remove-highlight":
        if (msg.id) {
          removeHighlight(msg.id);
        }
        break;

      case "shibei:scroll-to-highlight":
        if (msg.id) {
          scrollToHighlight(msg.id);
        }
        break;
    }
  });

  // ── Block external navigation ──
  // Intercept all link clicks: prevent navigation inside iframe,
  // notify parent to open in external browser if needed.
  document.addEventListener("click", (e) => {
    const link = e.target.closest("a[href]");
    if (!link) return;

    const href = link.getAttribute("href");
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;

    e.preventDefault();
    e.stopPropagation();

    // Tell parent about the link click (parent can open in external browser)
    window.parent.postMessage(
      { type: "shibei:link-clicked", url: link.href },
      "*"
    );
  }, true);

  // Signal that annotator is ready
  window.parent.postMessage({ type: "shibei:annotator-ready" }, "*");
})();
