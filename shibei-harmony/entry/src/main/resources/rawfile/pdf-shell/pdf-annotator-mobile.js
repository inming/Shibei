// pdf-annotator-mobile.js — PDF text-layer + selection + highlight overlay.
//
// Uses pdfjs's own TextLayer primitive so the DOM structure is byte-for-byte
// identical to the desktop reader. All char-offset math is a plain
// createTreeWalker(SHOW_TEXT) over the text-layer container — same algorithm
// as src/components/PDFReader.tsx `collectTextContent` / `computeCharIndex`
// / `getHighlightRects`. This is what makes anchors round-trip cross-device.

(function() {
  'use strict';

  var bridge = window.shibeiBridge;
  function emit(type, payload) {
    if (bridge && typeof bridge.emit === 'function') {
      try { bridge.emit(type, typeof payload === 'string' ? payload : JSON.stringify(payload)); }
      catch (_) {}
    }
  }

  // Per-page cache: pageNum → { textLayerEl, fullText }.
  // fullText is cached on render and used for textQuote prefix/suffix
  // construction at selection time; the live DOM is the source of truth
  // for computing numerical offsets.
  var pageCache = {};

  var highlights = {};  // id → { anchor, color }

  // Called by main.js when a page's canvas has finished rendering.
  window.__shibei = window.__shibei || {};
  var prevOnPageRendered = window.__shibei.onPageRendered;
  window.__shibei.onPageRendered = async function(pageNum, page, viewport, textLayerEl) {
    if (prevOnPageRendered) {
      try { prevOnPageRendered(pageNum, page, viewport, textLayerEl); } catch (_) {}
    }
    try {
      var textContentSource = page.streamTextContent({ includeMarkedContent: false });
      var tl = new pdfjsLib.TextLayer({
        textContentSource: textContentSource,
        container: textLayerEl,
        viewport: viewport,
      });
      await tl.render();
      pageCache[pageNum] = {
        textLayerEl: textLayerEl,
        fullText: collectTextContent(textLayerEl),
      };
      // Paint any already-known highlights that belong to this page.
      Object.keys(highlights).forEach(function(id) {
        var h = highlights[id];
        if (h.anchor && h.anchor.page === pageNum) drawHighlight(h);
      });
    } catch (err) {
      console.error('TextLayer render fail page', pageNum, err);
    }
  };

  // ── Char-offset utilities (mirrors desktop PDFReader.tsx) ──────────────

  function collectTextContent(container) {
    var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    var result = '';
    var node = walker.nextNode();
    while (node) {
      result += node.textContent || '';
      node = walker.nextNode();
    }
    return result;
  }

  function computeCharIndex(container, targetNode, targetOffset) {
    var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    var charCount = 0;
    var node = walker.nextNode();
    while (node) {
      if (node === targetNode) return charCount + targetOffset;
      charCount += (node.textContent || '').length;
      node = walker.nextNode();
    }
    return -1;
  }

  // Walks text nodes to find the (startNode, startOffset) and
  // (endNode, endOffset) corresponding to [charIndex, charIndex+length).
  // Returns a Range positioned over those nodes, or null if the range
  // falls outside the container.
  function rangeFromCharIndex(container, charIndex, length) {
    var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    var charCount = 0;
    var startNode = null, startOffset = 0, endNode = null, endOffset = 0;
    var node = walker.nextNode();
    while (node) {
      var nodeLen = (node.textContent || '').length;
      if (!startNode && charCount + nodeLen > charIndex) {
        startNode = node;
        startOffset = charIndex - charCount;
      }
      if (startNode && charCount + nodeLen >= charIndex + length) {
        endNode = node;
        endOffset = charIndex + length - charCount;
        break;
      }
      charCount += nodeLen;
      node = walker.nextNode();
    }
    if (!startNode || !endNode) return null;
    var r = document.createRange();
    try {
      r.setStart(startNode, Math.max(0, startOffset));
      r.setEnd(endNode, Math.max(0, endOffset));
    } catch (_) { return null; }
    return r;
  }

  function closestPageDiv(node) {
    while (node && node !== document.body) {
      if (node.nodeType === 1 && node.classList && node.classList.contains('page')) {
        return node;
      }
      node = node.parentNode;
    }
    return null;
  }

  function cssEscape(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9-_]/g, '\\$&');
  }

  // ── Selection → anchor ────────────────────────────────────────────────

  var selectionTimer = null;
  document.addEventListener('selectionchange', function() {
    if (selectionTimer) clearTimeout(selectionTimer);
    selectionTimer = setTimeout(handleSelectionSettled, 250);
  });

  function handleSelectionSettled() {
    var sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      emit('selection', { collapsed: true });
      return;
    }
    var range = sel.getRangeAt(0);
    var pageDiv = closestPageDiv(range.startContainer);
    if (!pageDiv || pageDiv !== closestPageDiv(range.endContainer)) {
      emit('selection', { collapsed: true });
      return;
    }
    var pageNum = parseInt(pageDiv.dataset.pageNumber, 10);
    var cache = pageCache[pageNum];
    if (!cache) return;

    var textLayerEl = cache.textLayerEl;
    var startCharIndex = computeCharIndex(textLayerEl, range.startContainer, range.startOffset);
    var endCharIndex = computeCharIndex(textLayerEl, range.endContainer, range.endOffset);
    if (startCharIndex < 0 || endCharIndex < 0 || endCharIndex <= startCharIndex) return;

    var exact = cache.fullText.substring(startCharIndex, endCharIndex);
    if (!exact.trim()) { emit('selection', { collapsed: true }); return; }

    var prefix = cache.fullText.substring(Math.max(0, startCharIndex - 32), startCharIndex);
    var suffix = cache.fullText.substring(endCharIndex, Math.min(cache.fullText.length, endCharIndex + 32));

    var rect = range.getBoundingClientRect();
    emit('selection', {
      collapsed: false,
      textContent: exact,
      anchor: {
        type: 'pdf',
        page: pageNum,
        charIndex: startCharIndex,
        length: endCharIndex - startCharIndex,
        textQuote: { exact: exact, prefix: prefix, suffix: suffix },
      },
      rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
    });
  }

  // ── Highlight overlay rendering ───────────────────────────────────────

  function ensureHighlightLayer(pageDiv) {
    var layer = pageDiv.querySelector(':scope > .highlight-layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'highlight-layer';
      pageDiv.appendChild(layer);
    }
    return layer;
  }

  function drawHighlight(h) {
    var pageNum = h.anchor && h.anchor.page;
    if (!pageNum) return;
    var pageDiv = document.querySelector('.page[data-page-number="' + pageNum + '"]');
    if (!pageDiv) return;  // page not yet rendered; onPageRendered will repaint when it is
    var cache = pageCache[pageNum];
    if (!cache) return;

    var layer = ensureHighlightLayer(pageDiv);
    var old = layer.querySelectorAll('[data-shibei-id="' + cssEscape(h.id) + '"]');
    old.forEach(function(el) { el.remove(); });

    var range = rangeFromCharIndex(cache.textLayerEl, h.anchor.charIndex, h.anchor.length || 0);
    if (!range) return;

    var pageRect = pageDiv.getBoundingClientRect();
    var clientRects = range.getClientRects();
    for (var i = 0; i < clientRects.length; i++) {
      var r = clientRects[i];
      if (r.width < 0.5 || r.height < 0.5) continue;
      var hl = document.createElement('div');
      hl.className = 'hl';
      hl.setAttribute('data-shibei-id', h.id);
      hl.style.setProperty('--shibei-hl-color', h.color || '#ffeb3b');
      hl.style.left = (r.left - pageRect.left) + 'px';
      hl.style.top = (r.top - pageRect.top) + 'px';
      hl.style.width = r.width + 'px';
      hl.style.height = r.height + 'px';
      hl.addEventListener('click', function(ev) {
        ev.preventDefault(); ev.stopPropagation();
        emit('click', { highlightId: this.getAttribute('data-shibei-id') });
      });
      layer.appendChild(hl);
    }
    range.detach && range.detach();
  }

  function removeHighlightLocal(id) {
    delete highlights[id];
    var els = document.querySelectorAll('[data-shibei-id="' + cssEscape(id) + '"]');
    els.forEach(function(el) { el.remove(); });
  }

  // ── Public API (ArkTS drives via runJavaScript) ──────────────────────

  window.__shibei.paintHighlights = function(listJson) {
    var list;
    try { list = JSON.parse(listJson); } catch (_) { return; }
    if (!Array.isArray(list)) return;
    list.forEach(function(h) {
      if (!h || !h.id || !h.anchor) return;
      var prev = highlights[h.id];
      highlights[h.id] = h;
      if (prev && prev.color === h.color && prev.anchor.charIndex === h.anchor.charIndex
          && prev.anchor.length === h.anchor.length) {
        return;  // nothing material changed
      }
      drawHighlight(h);
    });
    // Any local highlights missing from the incoming list were deleted elsewhere.
    var incomingIds = {};
    for (var i = 0; i < list.length; i++) incomingIds[list[i].id] = 1;
    Object.keys(highlights).forEach(function(id) {
      if (!incomingIds[id]) removeHighlightLocal(id);
    });
  };

  window.__shibei.removeHighlight = function(id) { removeHighlightLocal(id); };

  window.__shibei.flashHighlight = function(id) {
    var els = document.querySelectorAll('[data-shibei-id="' + cssEscape(id) + '"]');
    if (els.length === 0) return;
    els[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
    els.forEach(function(el) {
      el.classList.add('flash');
      setTimeout(function() { el.classList.remove('flash'); }, 800);
    });
  };

  window.__shibei.clearSelection = function() {
    var s = window.getSelection();
    if (s) s.removeAllRanges();
  };
})();
