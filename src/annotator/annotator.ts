(function () {
  // Only activate in shibei protocol frames (macOS: shibei://, Windows: http://shibei.localhost)
  const href = window.location.href;
  if (!href.startsWith("shibei://") && !href.startsWith("http://shibei.localhost")) return;

  // ── Local type definitions (mirrors src/types/index.ts — no imports allowed) ──

  interface TextPosition {
    start: number;
    end: number;
  }

  interface TextQuote {
    exact: string;
    prefix: string;
    suffix: string;
  }

  interface Anchor {
    text_position: TextPosition;
    text_quote: TextQuote;
  }

  interface HighlightData {
    id: string;
    anchor: Anchor;
    color: string;
  }

  // ── Inbound message types (React parent → annotator) ──

  interface RenderHighlightsMsg {
    type: "shibei:render-highlights";
    highlights: HighlightData[];
  }

  interface AddHighlightMsg {
    type: "shibei:add-highlight";
    highlight: HighlightData;
  }

  interface RemoveHighlightMsg {
    type: "shibei:remove-highlight";
    id: string;
  }

  interface ScrollToHighlightMsg {
    type: "shibei:scroll-to-highlight";
    id: string;
  }

  type InboundMessage =
    | RenderHighlightsMsg
    | AddHighlightMsg
    | RemoveHighlightMsg
    | ScrollToHighlightMsg;

  // ── Outbound message types (annotator → React parent) ──

  interface SelectionRect {
    top: number;
    left: number;
    width: number;
    height: number;
  }

  interface SelectionMsg {
    type: "shibei:selection";
    text: string;
    anchor: Anchor;
    rect: SelectionRect;
  }

  interface SelectionClearedMsg {
    type: "shibei:selection-cleared";
  }

  interface HighlightClickedMsg {
    type: "shibei:highlight-clicked";
    id: string;
  }

  interface LinkClickedMsg {
    type: "shibei:link-clicked";
    url: string;
  }

  interface AnnotatorReadyMsg {
    type: "shibei:annotator-ready";
  }

  interface RenderResultMsg {
    type: "shibei:render-result";
    failedIds: string[];
  }

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

  const EXCLUDED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);

  const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\uFEFF]/g;

  function normalizedLength(text: string): number {
    return text.replace(ZERO_WIDTH_RE, "").length;
  }

  function normalizedText(text: string): string {
    return text.replace(ZERO_WIDTH_RE, "");
  }

  /**
   * Given a raw string and a target offset in the normalized (zero-width-free) version,
   * return the corresponding offset in the raw string.
   */
  function rawOffset(raw: string, normalizedOff: number): number {
    let norm = 0;
    for (let i = 0; i < raw.length; i++) {
      if (norm >= normalizedOff) return i;
      if (!ZERO_WIDTH_RE.test(raw[i])) {
        norm++;
      }
      // Reset lastIndex since we use global regex for single char test
      ZERO_WIDTH_RE.lastIndex = 0;
    }
    return raw.length;
  }

  /**
   * Walk all text nodes under root in document order, skipping invisible nodes.
   */
  function getTextNodes(root: Node): Text[] {
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node: Node): number {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_ACCEPT;
        // Skip text inside script/style/noscript/template
        if (EXCLUDED_TAGS.has(parent.tagName)) {
          return NodeFilter.FILTER_REJECT;
        }
        // Skip text inside hidden elements
        const style = getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden") {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node: Node | null;
    while ((node = walker.nextNode())) {
      nodes.push(node as Text);
    }
    return nodes;
  }

  /**
   * Compute the character offset of a (node, offset) pair relative to body's full text.
   */
  function computeTextOffset(container: Node, offset: number): number {
    const textNodes = getTextNodes(document.body);
    let total = 0;
    for (const tn of textNodes) {
      if (tn === container) {
        return total + normalizedLength((tn.textContent ?? "").slice(0, offset));
      }
      total += normalizedLength(tn.textContent ?? "");
    }
    // If container is an element, find the offset-th child's text position
    if (container.nodeType === Node.ELEMENT_NODE) {
      let childIndex = 0;
      total = 0;
      for (const tn of textNodes) {
        if ((container as Element).contains(tn)) {
          if (childIndex >= offset) return total;
          childIndex++;
        }
        total += normalizedLength(tn.textContent ?? "");
      }
    }
    return total;
  }

  /**
   * Get the full text content of body (same ordering as getTextNodes).
   */
  function getBodyText(): string {
    return getTextNodes(document.body)
      .map((n) => normalizedText(n.textContent ?? ""))
      .join("");
  }

  /**
   * Build anchor from current selection.
   */
  function computeAnchor(selection: Selection): Anchor {
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
  function resolveByPosition(anchor: Anchor): Range | null {
    const textNodes = getTextNodes(document.body);
    const { start, end } = anchor.text_position;
    let offset = 0;
    let startNode: Text | null = null;
    let startOff = 0;
    let endNode: Text | null = null;
    let endOff = 0;

    for (const tn of textNodes) {
      const raw = tn.textContent ?? "";
      const len = normalizedLength(raw);
      if (!startNode && offset + len > start) {
        startNode = tn;
        startOff = rawOffset(raw, start - offset);
      }
      if (!endNode && offset + len >= end) {
        endNode = tn;
        endOff = rawOffset(raw, end - offset);
        break;
      }
      offset += len;
    }

    if (!startNode || !endNode) return null;

    try {
      const range = document.createRange();
      range.setStart(startNode, startOff);
      range.setEnd(endNode, endOff);
      // Verify the text matches (compare normalized)
      if (normalizedText(range.toString()) === normalizedText(anchor.text_quote.exact)) {
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
  function resolveByQuote(anchor: Anchor): Range | null {
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
  function resolveAnchor(anchor: Anchor): Range | null {
    return resolveByPosition(anchor) ?? resolveByQuote(anchor);
  }

  // ── Highlight rendering ──

  interface NodeWrapSpec {
    node: Text;
    start: number;
    end: number;
  }

  /**
   * Wrap a Range with <shibei-hl> elements. Handles ranges spanning multiple text nodes.
   */
  function wrapRange(range: Range, highlightId: string, color: string): void {
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
    const nodesToWrap: NodeWrapSpec[] = [];

    for (const tn of textNodes) {
      const raw = tn.textContent ?? "";
      const len = normalizedLength(raw);
      const nodeStart = offset;
      const nodeEnd = offset + len;

      if (nodeEnd > startOff && nodeStart < endOff) {
        const wrapStartNorm = Math.max(0, startOff - nodeStart);
        const wrapEndNorm = Math.min(len, endOff - nodeStart);
        nodesToWrap.push({
          node: tn,
          start: rawOffset(raw, wrapStartNorm),
          end: rawOffset(raw, wrapEndNorm),
        });
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

  function createHlElement(highlightId: string, color: string): HTMLElement {
    const hl = document.createElement("shibei-hl");
    hl.setAttribute("data-hl-id", highlightId);
    hl.style.setProperty("--shibei-hl-color", color);
    hl.addEventListener("click", () => {
      const msg: HighlightClickedMsg = {
        type: "shibei:highlight-clicked",
        id: highlightId,
      };
      window.parent.postMessage(msg, "*");
    });
    return hl;
  }

  /**
   * Remove all <shibei-hl> elements for a given highlight ID.
   */
  function removeHighlight(highlightId: string): void {
    const elements = document.querySelectorAll(
      `shibei-hl[data-hl-id="${highlightId}"]`
    );
    elements.forEach((el) => {
      const parent = el.parentNode;
      if (!parent) return;
      while (el.firstChild) {
        parent.insertBefore(el.firstChild, el);
      }
      parent.removeChild(el);
      (parent as Element).normalize(); // merge adjacent text nodes
    });
  }

  /**
   * Scroll to a highlight and flash it.
   */
  function scrollToHighlight(highlightId: string): void {
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
      const msg: SelectionClearedMsg = { type: "shibei:selection-cleared" };
      window.parent.postMessage(msg, "*");
      return;
    }

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const anchor = computeAnchor(selection);

    const msg: SelectionMsg = {
      type: "shibei:selection",
      text: selection.toString(),
      anchor,
      rect: {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      },
    };
    window.parent.postMessage(msg, "*");
  });

  // ── Message handler (from parent React app) ──

  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    const msg = event.data as InboundMessage;
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case "shibei:render-highlights":
        // Batch render highlights on page load
        if (Array.isArray(msg.highlights)) {
          const failedIds: string[] = [];
          for (const hl of msg.highlights) {
            try {
              const range = resolveAnchor(hl.anchor);
              if (range) {
                wrapRange(range, hl.id, hl.color);
              } else {
                console.warn("[shibei] Could not resolve anchor for:", hl.id);
                failedIds.push(hl.id);
              }
            } catch (e) {
              console.warn("[shibei] Failed to render highlight:", hl.id, e);
              failedIds.push(hl.id);
            }
          }
          // Report resolution results back to parent
          const renderResult: RenderResultMsg = {
            type: "shibei:render-result",
            failedIds,
          };
          window.parent.postMessage(renderResult, "*");
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
  document.addEventListener(
    "click",
    (e: MouseEvent) => {
      const link = (e.target as Element).closest("a[href]");
      if (!link) return;

      const href = link.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("javascript:"))
        return;

      e.preventDefault();
      e.stopPropagation();

      // Tell parent about the link click (parent can open in external browser)
      const msg: LinkClickedMsg = {
        type: "shibei:link-clicked",
        url: (link as HTMLAnchorElement).href,
      };
      window.parent.postMessage(msg, "*");
    },
    true
  );

  // Signal that annotator is ready
  const readyMsg: AnnotatorReadyMsg = { type: "shibei:annotator-ready" };
  window.parent.postMessage(readyMsg, "*");

})();
