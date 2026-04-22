// pdf-annotator-mobile.js — PDF text-layer + selection + anchor construction.
// Separate from HTML annotator; shares only the window.__shibei.* API
// contract so ArkTS's AnnotationBridge stays doc-type agnostic.
//
// Runs in classic-script mode inside shell.html. Depends on pdfjs globals
// (pdfjsLib) and the page div+text-layer structure created by main.js.

(function() {
  'use strict';

  var bridge = window.shibeiBridge;
  function emit(type, payload) {
    if (bridge && typeof bridge.emit === 'function') {
      try { bridge.emit(type, typeof payload === 'string' ? payload : JSON.stringify(payload)); }
      catch (_) {}
    }
  }

  // Per-page char-stream cache: pageNum → { text: string, spans: [{el, start, end}] }.
  // `start`/`end` are char offsets into the full page text — matches the
  // desktop anchor's { charIndex, length } referencing `streamTextContent` output.
  var pageTextCache = {};

  async function populateTextLayer(pageNum, page, viewport, textLayerEl) {
    var stream = page.streamTextContent({ includeMarkedContent: false });
    var reader = stream.getReader();
    var charOffset = 0;
    var spans = [];
    var fullText = '';

    while (true) {
      var r = await reader.read();
      if (r.done) break;
      var items = r.value && r.value.items ? r.value.items : [];
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (typeof it.str !== 'string') continue;
        var tx = pdfjsLib.Util.transform(viewport.transform, it.transform);
        var angle = Math.atan2(tx[1], tx[0]);
        var fontHeight = Math.hypot(tx[2], tx[3]);
        var left = tx[4];
        var top  = tx[5] - fontHeight;
        var span = document.createElement('span');
        span.textContent = it.str;
        span.style.left = left + 'px';
        span.style.top = top + 'px';
        span.style.fontSize = fontHeight + 'px';
        span.style.fontFamily = it.fontName || 'serif';
        if (angle !== 0) {
          span.style.transform = 'rotate(' + angle + 'rad)';
        }
        textLayerEl.appendChild(span);

        var start = charOffset;
        var end = charOffset + it.str.length;
        spans.push({ el: span, start: start, end: end });
        charOffset = end;
        fullText += it.str;
        // Desktop uses createTreeWalker over text nodes in collectTextContent —
        // no synthetic newline on item.hasEOL. Match that exactly so
        // charIndex/length anchors are byte-for-byte interoperable.
      }
    }

    pageTextCache[pageNum] = { text: fullText, spans: spans };
  }

  // Called by main.js when a page finishes rendering.
  window.__shibei = window.__shibei || {};
  window.__shibei.onPageRendered = function(pageNum, page, viewport, textLayerEl) {
    populateTextLayer(pageNum, page, viewport, textLayerEl).catch(function(err) {
      console.error('populateTextLayer fail page', pageNum, err);
    });
  };

  // ── Selection → anchor construction ──

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

    var startPageDiv = closestPageDiv(range.startContainer);
    var endPageDiv = closestPageDiv(range.endContainer);
    if (!startPageDiv || !endPageDiv || startPageDiv !== endPageDiv) {
      emit('selection', { collapsed: true });
      return;
    }
    var pageNum = parseInt(startPageDiv.dataset.pageNumber, 10);
    var cache = pageTextCache[pageNum];
    if (!cache) return;

    var startCharIndex = charOffsetFromRangeEnd(range.startContainer, range.startOffset, cache.spans);
    var endCharIndex = charOffsetFromRangeEnd(range.endContainer, range.endOffset, cache.spans);
    if (startCharIndex < 0 || endCharIndex < 0 || endCharIndex <= startCharIndex) return;

    var exact = cache.text.substring(startCharIndex, endCharIndex);
    if (!exact.trim()) { emit('selection', { collapsed: true }); return; }

    var prefix = cache.text.substring(Math.max(0, startCharIndex - 32), startCharIndex);
    var suffix = cache.text.substring(endCharIndex, Math.min(cache.text.length, endCharIndex + 32));

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

  function closestPageDiv(node) {
    while (node && node !== document.body) {
      if (node.nodeType === 1 && node.classList && node.classList.contains('page')) {
        return node;
      }
      node = node.parentNode;
    }
    return null;
  }

  // Given a DOM node+offset inside a text-layer, find the char offset
  // relative to the page's full streamTextContent text. Linear scan of the
  // span cache — fine at hundreds of spans per page.
  function charOffsetFromRangeEnd(node, offset, spans) {
    var spanEl = (node.nodeType === 3) ? node.parentNode : node;
    for (var i = 0; i < spans.length; i++) {
      if (spans[i].el === spanEl) {
        var within = Math.min(offset, spans[i].end - spans[i].start);
        return spans[i].start + within;
      }
    }
    return -1;
  }

  // ── Highlight overlay rendering ──
  //
  // For each highlighted range, compute bounding client rects of the covered
  // text-layer spans and draw absolutely-positioned <div> rects in a
  // highlight-layer appended to the owning .page div. Layer is per-page so
  // page-specific repaints don't walk the whole DOM.

  var highlights = {};   // id → { anchor, color }

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
    if (!pageDiv) return;  // page not rendered yet; will paint on next render
    var cache = pageTextCache[pageNum];
    if (!cache) return;

    var layer = ensureHighlightLayer(pageDiv);
    var old = layer.querySelectorAll('[data-shibei-id="' + cssEscape(h.id) + '"]');
    old.forEach(function(el) { el.remove(); });

    var start = h.anchor.charIndex;
    var end = start + (h.anchor.length || 0);
    var pageRect = pageDiv.getBoundingClientRect();

    for (var i = 0; i < cache.spans.length; i++) {
      var s = cache.spans[i];
      if (s.end <= start || s.start >= end) continue;

      var fromCh = Math.max(start - s.start, 0);
      var toCh   = Math.min(end - s.start, s.end - s.start);
      var rect = spanRectForRange(s.el, fromCh, toCh);
      if (!rect) continue;

      var hl = document.createElement('div');
      hl.className = 'hl';
      hl.setAttribute('data-shibei-id', h.id);
      hl.style.setProperty('--shibei-hl-color', h.color || '#ffeb3b');
      hl.style.left = (rect.left - pageRect.left) + 'px';
      hl.style.top = (rect.top - pageRect.top) + 'px';
      hl.style.width = rect.width + 'px';
      hl.style.height = rect.height + 'px';
      hl.addEventListener('click', function(ev) {
        ev.preventDefault(); ev.stopPropagation();
        emit('click', { highlightId: this.getAttribute('data-shibei-id') });
      });
      layer.appendChild(hl);
    }
  }

  function spanRectForRange(spanEl, fromCh, toCh) {
    var text = spanEl.firstChild;
    if (!text || text.nodeType !== 3) return spanEl.getBoundingClientRect();
    var r = document.createRange();
    try {
      r.setStart(text, Math.max(0, Math.min(fromCh, text.data.length)));
      r.setEnd(text, Math.max(0, Math.min(toCh, text.data.length)));
      return r.getBoundingClientRect();
    } catch (_) {
      return spanEl.getBoundingClientRect();
    } finally { r.detach && r.detach(); }
  }

  function cssEscape(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9-_]/g, '\\$&');
  }

  // Extend window.__shibei.onPageRendered: run Task 6's populateTextLayer
  // first, then paint any highlights whose page just became available.
  var prevOnPageRendered = window.__shibei.onPageRendered;
  window.__shibei.onPageRendered = function(pageNum, page, viewport, textLayerEl) {
    prevOnPageRendered.call(this, pageNum, page, viewport, textLayerEl);
    // populateTextLayer is async; poll for its cache slot then paint.
    var waitForCache = setInterval(function() {
      if (pageTextCache[pageNum]) {
        clearInterval(waitForCache);
        Object.keys(highlights).forEach(function(id) {
          var h = highlights[id];
          if (h.anchor && h.anchor.page === pageNum) drawHighlight(h);
        });
      }
    }, 50);
    // Bail out after 5s to avoid leaks on very broken pages.
    setTimeout(function() { clearInterval(waitForCache); }, 5000);
  };

  // ── Public API matching annotator-mobile.js (HTML) contract ──

  window.__shibei.paintHighlights = function(listJson) {
    var list;
    try { list = JSON.parse(listJson); } catch (_) { return; }
    if (!Array.isArray(list)) return;
    list.forEach(function(h) {
      if (!h || !h.id || !h.anchor) return;
      var prev = highlights[h.id];
      highlights[h.id] = h;
      if (prev && prev.color === h.color) {
        return;  // same color, no repaint needed
      }
      drawHighlight(h);
    });
    // Any local highlights not in the incoming list have been deleted.
    var incomingIds = {};
    for (var i = 0; i < list.length; i++) incomingIds[list[i].id] = 1;
    Object.keys(highlights).forEach(function(id) {
      if (!incomingIds[id]) removeHighlightLocal(id);
    });
  };

  function removeHighlightLocal(id) {
    delete highlights[id];
    var els = document.querySelectorAll('[data-shibei-id="' + cssEscape(id) + '"]');
    els.forEach(function(el) { el.remove(); });
  }

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
