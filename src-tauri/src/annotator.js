"use strict";
(function () {
    // Only activate in shibei protocol frames (macOS: shibei://, Windows: http://shibei.localhost)
    const href = window.location.href;
    if (!href.startsWith("shibei://") && !href.startsWith("http://shibei.localhost"))
        return;
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
    function normalizedLength(text) {
        return text.replace(ZERO_WIDTH_RE, "").length;
    }
    function normalizedText(text) {
        return text.replace(ZERO_WIDTH_RE, "");
    }
    /**
     * Given a raw string and a target offset in the normalized (zero-width-free) version,
     * return the corresponding offset in the raw string.
     */
    function rawOffset(raw, normalizedOff) {
        let norm = 0;
        for (let i = 0; i < raw.length; i++) {
            if (norm >= normalizedOff)
                return i;
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
    function getTextNodes(root) {
        const nodes = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                const parent = node.parentElement;
                if (!parent)
                    return NodeFilter.FILTER_ACCEPT;
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
                return total + normalizedLength((tn.textContent ?? "").slice(0, offset));
            }
            total += normalizedLength(tn.textContent ?? "");
        }
        // If container is an element, find the offset-th child's text position
        if (container.nodeType === Node.ELEMENT_NODE) {
            let childIndex = 0;
            total = 0;
            for (const tn of textNodes) {
                if (container.contains(tn)) {
                    if (childIndex >= offset)
                        return total;
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
    function getBodyText() {
        return getTextNodes(document.body)
            .map((n) => normalizedText(n.textContent ?? ""))
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
        let startNode = null;
        let startOff = 0;
        let endNode = null;
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
        if (!startNode || !endNode)
            return null;
        try {
            const range = document.createRange();
            range.setStart(startNode, startOff);
            range.setEnd(endNode, endOff);
            // Verify the text matches (compare normalized)
            if (normalizedText(range.toString()) === normalizedText(anchor.text_quote.exact)) {
                return range;
            }
        }
        catch (_e) {
            // Fall through to null
        }
        return null;
    }
    /**
     * Bitap approximate string search.
     * Finds the best match of `pattern` in `text` within `maxErrors` edit distance.
     * Uses position hint for tie-breaking when multiple matches have the same error count.
     *
     * Pattern length is limited to 32 characters (JavaScript bitwise limit).
     * For longer patterns, the first 32 chars are used to locate candidates,
     * then full text comparison validates.
     */
    function fuzzySearch(text, pattern, maxErrors, positionHint) {
        if (pattern.length === 0)
            return null;
        // For patterns > 32 chars, use prefix to locate, then validate full match
        const searchPattern = pattern.length > 32 ? pattern.slice(0, 32) : pattern;
        const m = searchPattern.length;
        const k = Math.min(maxErrors, m - 1);
        // Build character masks
        const charMask = {};
        for (let i = 0; i < m; i++) {
            const c = searchPattern[i];
            charMask[c] = (charMask[c] ?? ~0) & ~(1 << i);
        }
        // State arrays for each error level
        const state = new Array(k + 1).fill(~0);
        let bestMatch = null;
        for (let i = 0; i < text.length; i++) {
            const charBit = charMask[text[i]] ?? ~0;
            // Update states from highest error count down
            let oldState = state[0];
            state[0] = (state[0] << 1) | charBit;
            for (let d = 1; d <= k; d++) {
                const prevState = oldState;
                oldState = state[d];
                // Shift + char match OR insertion OR deletion OR substitution
                state[d] = ((state[d] << 1) | charBit) & (prevState << 1) & ((oldState | prevState) << 1) & prevState;
            }
            // Check for matches at each error level (prefer fewer errors)
            for (let d = 0; d <= k; d++) {
                if ((state[d] & (1 << (m - 1))) === 0) {
                    const matchEnd = i + 1;
                    let matchStart;
                    let errors;
                    if (pattern.length > 32) {
                        // Validate full pattern at this position
                        matchStart = matchEnd - m;
                        if (matchStart < 0)
                            continue;
                        // Extend to full pattern length
                        const candidateEnd = matchStart + pattern.length;
                        if (candidateEnd > text.length)
                            continue;
                        const candidate = text.slice(matchStart, candidateEnd);
                        errors = levenshteinDistance(candidate, pattern);
                        if (errors > maxErrors)
                            continue;
                    }
                    else {
                        matchStart = matchEnd - m;
                        errors = d;
                    }
                    // Score: fewer errors better, closer to position hint better
                    if (!bestMatch ||
                        errors < bestMatch.errors ||
                        (errors === bestMatch.errors &&
                            Math.abs(matchStart - positionHint) < Math.abs(bestMatch.start - positionHint))) {
                        bestMatch = {
                            start: matchStart,
                            end: pattern.length > 32 ? matchStart + pattern.length : matchEnd,
                            errors,
                        };
                    }
                    break; // Found match at this error level, don't check higher
                }
            }
        }
        return bestMatch;
    }
    /**
     * Simple Levenshtein distance for validating long pattern matches.
     * Only used for patterns > 32 chars where Bitap searched by prefix.
     */
    function levenshteinDistance(a, b) {
        const m = a.length;
        const n = b.length;
        const dp = Array.from({ length: n + 1 }, (_, i) => i);
        for (let i = 1; i <= m; i++) {
            let prev = dp[0];
            dp[0] = i;
            for (let j = 1; j <= n; j++) {
                const temp = dp[j];
                dp[j] = a[i - 1] === b[j - 1]
                    ? prev
                    : 1 + Math.min(prev, dp[j], dp[j - 1]);
                prev = temp;
            }
        }
        return dp[n];
    }
    /**
     * Normalized string similarity (0.0 = completely different, 1.0 = identical).
     */
    function similarity(a, b) {
        if (a.length === 0 && b.length === 0)
            return 1;
        const maxLen = Math.max(a.length, b.length);
        if (maxLen === 0)
            return 1;
        return 1 - levenshteinDistance(a, b) / maxLen;
    }
    /**
     * Resolve anchor using textQuote (fuzzy fallback).
     */
    function resolveByQuote(anchor) {
        const bodyText = getBodyText();
        const { exact, prefix, suffix } = anchor.text_quote;
        // Step 1: Exact match with full context (prefix + exact + suffix)
        const contextStr = prefix + exact + suffix;
        const idx = bodyText.indexOf(contextStr);
        if (idx !== -1) {
            const start = idx + prefix.length;
            const end = start + exact.length;
            return resolveByPosition({
                text_position: { start, end },
                text_quote: anchor.text_quote,
            });
        }
        // Step 2: Exact match on just the quote text
        const simpleIdx = bodyText.indexOf(exact);
        if (simpleIdx !== -1) {
            return resolveByPosition({
                text_position: { start: simpleIdx, end: simpleIdx + exact.length },
                text_quote: anchor.text_quote,
            });
        }
        // Step 3: Fuzzy match on exact text (tolerant of minor differences)
        const maxErrors = Math.min(32, Math.floor(exact.length / 5));
        if (maxErrors < 1)
            return null;
        const match = fuzzySearch(bodyText, exact, maxErrors, anchor.text_position.start);
        if (!match)
            return null;
        // Validate with context: at least one of prefix/suffix should roughly match
        const candidatePrefix = bodyText.slice(Math.max(0, match.start - prefix.length), match.start);
        const candidateSuffix = bodyText.slice(match.end, Math.min(bodyText.length, match.end + suffix.length));
        const prefixSim = prefix.length > 0 ? similarity(candidatePrefix, prefix) : 1;
        const suffixSim = suffix.length > 0 ? similarity(candidateSuffix, suffix) : 1;
        // Require at least one context side to be a reasonable match
        if (prefixSim < 0.5 && suffixSim < 0.5)
            return null;
        // Build a new position-based anchor from the fuzzy match
        return resolveByPosition({
            text_position: { start: match.start, end: match.end },
            text_quote: {
                exact: bodyText.slice(match.start, match.end),
                prefix: anchor.text_quote.prefix,
                suffix: anchor.text_quote.suffix,
            },
        });
    }
    /**
     * Resolve anchor: try position first, then quote fallback.
     */
    function resolveAnchor(anchor) {
        return resolveByPosition(anchor) ?? resolveByQuote(anchor);
    }
    /**
     * Wrap a Range with <shibei-hl> elements. Handles ranges spanning multiple text nodes.
     */
    function wrapRange(range, highlightId, color) {
        // If range spans a single text node
        if (range.startContainer === range.endContainer &&
            range.startContainer.nodeType === Node.TEXT_NODE) {
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
    function createHlElement(highlightId, color) {
        const hl = document.createElement("shibei-hl");
        hl.setAttribute("data-hl-id", highlightId);
        hl.style.setProperty("--shibei-hl-color", color);
        hl.addEventListener("click", () => {
            const msg = {
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
    function removeHighlight(highlightId) {
        const elements = document.querySelectorAll(`shibei-hl[data-hl-id="${highlightId}"]`);
        elements.forEach((el) => {
            const parent = el.parentNode;
            if (!parent)
                return;
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
        const el = document.querySelector(`shibei-hl[data-hl-id="${highlightId}"]`);
        if (!el)
            return;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("shibei-flash");
        setTimeout(() => el.classList.remove("shibei-flash"), 700);
    }
    // ── Selection detection ──
    document.addEventListener("mouseup", () => {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || !selection.toString().trim()) {
            const msg = { type: "shibei:selection-cleared" };
            window.parent.postMessage(msg, "*");
            return;
        }
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        const anchor = computeAnchor(selection);
        const msg = {
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
    window.addEventListener("message", (event) => {
        const msg = event.data;
        if (!msg || !msg.type)
            return;
        switch (msg.type) {
            case "shibei:render-highlights":
                // Batch render highlights on page load
                if (Array.isArray(msg.highlights)) {
                    const failedIds = [];
                    for (const hl of msg.highlights) {
                        try {
                            const range = resolveAnchor(hl.anchor);
                            if (range) {
                                wrapRange(range, hl.id, hl.color);
                            }
                            else {
                                console.warn("[shibei] Could not resolve anchor for:", hl.id);
                                failedIds.push(hl.id);
                            }
                        }
                        catch (e) {
                            console.warn("[shibei] Failed to render highlight:", hl.id, e);
                            failedIds.push(hl.id);
                        }
                    }
                    // Report resolution results back to parent
                    const renderResult = {
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
                    }
                    catch (e) {
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
        if (!link)
            return;
        const href = link.getAttribute("href");
        if (!href || href.startsWith("#") || href.startsWith("javascript:"))
            return;
        e.preventDefault();
        e.stopPropagation();
        // Tell parent about the link click (parent can open in external browser)
        const msg = {
            type: "shibei:link-clicked",
            url: link.href,
        };
        window.parent.postMessage(msg, "*");
    }, true);
    // Signal that annotator is ready
    const readyMsg = { type: "shibei:annotator-ready" };
    window.parent.postMessage(readyMsg, "*");
})();
