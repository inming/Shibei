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

        if (it.hasEOL) { fullText += '\n'; charOffset += 1; }
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

    var prefix = cache.text.substring(Math.max(0, startCharIndex - 10), startCharIndex);
    var suffix = cache.text.substring(endCharIndex, Math.min(cache.text.length, endCharIndex + 10));

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
})();
