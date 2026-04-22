(function() {
  'use strict';

  // Suppress ArkWeb's default contextmenu popup so our selection palette
  // is the only UI showing on long-press.
  document.addEventListener('contextmenu', function(ev) { ev.preventDefault(); });

  var pdfjs = window.pdfjsLib;
  var statusEl = document.getElementById('status');
  var pagesEl = document.getElementById('pages');
  function setStatus(s) { statusEl.textContent = s; }
  function hideStatus() { statusEl.classList.add('hidden'); }

  if (!pdfjs || !pdfjs.getDocument) { setStatus('pdfjsLib missing'); return; }
  var wg = window.pdfjsWorker;
  if (!wg || !wg.WorkerMessageHandler) { setStatus('pdfjsWorker missing'); return; }
  pdfjs.GlobalWorkerOptions.workerSrc = 'about:blank';

  var id = new URL(location.href).searchParams.get('id') || '';
  if (!id) { setStatus('no resource id'); return; }

  window.__shibei = window.__shibei || {
    paintHighlights: function() {},
    removeHighlight: function() {},
    flashHighlight: function() {},
    clearSelection: function() {},
  };

  var state = {
    pdf: null,
    pageDivs: [],          // [idx] → div.page
    pageViewports: [],     // [idx] → viewport @ fit-to-width scale
    rendered: new Set(),   // page idx where canvas has been drawn
    scale: 1.0,
  };

  (async function() {
    try {
      state.pdf = await pdfjs.getDocument({ url: 'shibei-pdf://resource/' + id }).promise;
      setStatus('rendering — ' + state.pdf.numPages + ' pages');

      var containerWidth = pagesEl.clientWidth - 16;
      // Page 1 sets the scale. Pages of different sizes still render
      // correctly — each gets its own per-page viewport in renderPage().
      var first = await state.pdf.getPage(1);
      var unscaled = first.getViewport({ scale: 1.0 });
      state.scale = containerWidth / unscaled.width;

      // Create placeholder divs for every page so IntersectionObserver can
      // observe scroll-into-view without loading every page up front.
      for (var i = 1; i <= state.pdf.numPages; i++) {
        var viewport = first.getViewport({ scale: state.scale });
        var div = document.createElement('div');
        div.className = 'page';
        div.dataset.pageNumber = String(i);
        div.style.setProperty('--w', viewport.width + 'px');
        div.style.setProperty('--h', viewport.height + 'px');
        pagesEl.appendChild(div);
        state.pageDivs[i] = div;
      }

      // rootMargin pre-renders ±1 viewport's worth of pages so scrolling
      // doesn't flash blank placeholders.
      state.io = new IntersectionObserver(function(entries) {
        entries.forEach(function(ent) {
          if (ent.isIntersecting) {
            var n = parseInt(ent.target.dataset.pageNumber, 10);
            renderPage(n).catch(console.error);
          }
        });
      }, { root: null, rootMargin: '400px 0px', threshold: 0.01 });
      state.pageDivs.forEach(function(div) { if (div) state.io.observe(div); });

      hideStatus();
      if (window.shibeiBridge) {
        window.shibeiBridge.emit('ready', JSON.stringify({ resourceId: id, numPages: state.pdf.numPages }));
      }

      // Fold/unfold (Mate X5) and rotation change the container width.
      // Re-render visible pages at the new fit-to-width scale so the PDF
      // adapts instead of staying at the old device size.
      var resizeTimer = null;
      var lastWidth = pagesEl.clientWidth;
      window.addEventListener('resize', function() {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function() {
          resizeTimer = null;
          var newWidth = pagesEl.clientWidth;
          if (Math.abs(newWidth - lastWidth) < 2) return;   // ignore sub-pixel noise
          lastWidth = newWidth;
          relayoutForNewWidth().catch(console.error);
        }, 200);
      });
    } catch (err) {
      setStatus('error: ' + (err && err.message ? err.message : String(err)));
      console.error('pdf load fail', err);
    }
  })();

  async function renderPage(n) {
    if (state.rendered.has(n)) return;
    state.rendered.add(n);   // reserve early so concurrent IO callbacks don't double-render
    try {
      var page = await state.pdf.getPage(n);
      var viewport = page.getViewport({ scale: state.scale });
      var div = state.pageDivs[n];
      div.style.setProperty('--w', viewport.width + 'px');
      div.style.setProperty('--h', viewport.height + 'px');
      state.pageViewports[n] = viewport;

      var canvas = document.createElement('canvas');
      var dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      div.appendChild(canvas);
      var ctx = canvas.getContext('2d');
      var renderParams = { canvasContext: ctx, viewport: viewport };
      if (dpr !== 1) {
        renderParams.transform = [dpr, 0, 0, dpr, 0, 0];
      }
      await page.render(renderParams).promise;

      // Text-layer container; populated by pdf-annotator-mobile.js (Task 6).
      var tl = document.createElement('div');
      tl.className = 'text-layer';
      div.appendChild(tl);

      // Signal annotator so it can fill text-layer + paint highlights for
      // this page. Optional hook — absent in Task 4/5, present from Task 6.
      if (window.__shibei && window.__shibei.onPageRendered) {
        window.__shibei.onPageRendered(n, page, viewport, tl);
      }
    } catch (err) {
      state.rendered.delete(n);   // allow retry
      console.error('renderPage fail', n, err);
    }
  }

  // Recompute fit-to-width scale and re-render all previously-rendered
  // pages at the new dimensions. Preserves the user's approximate scroll
  // position by tracking the top-visible page before teardown and
  // scrolling back to it after.
  async function relayoutForNewWidth() {
    if (!state.pdf) return;

    // Capture current top-visible page for restore.
    var topPage = 1;
    for (var i = 1; i <= state.pdf.numPages; i++) {
      var d = state.pageDivs[i];
      if (!d) continue;
      var r = d.getBoundingClientRect();
      if (r.bottom > 0) { topPage = i; break; }
    }

    // New scale based on page 1 (same heuristic as first load).
    var containerWidth = pagesEl.clientWidth - 16;
    var first = await state.pdf.getPage(1);
    var unscaled = first.getViewport({ scale: 1.0 });
    state.scale = containerWidth / unscaled.width;

    // Flush all cached render state and DOM children (canvas / text-layer /
    // highlight-layer) so IntersectionObserver repaints from scratch.
    state.rendered = new Set();
    if (window.__shibei && window.__shibei.resetPageCache) {
      window.__shibei.resetPageCache();
    }
    for (var j = 1; j <= state.pdf.numPages; j++) {
      var pd = state.pageDivs[j];
      if (!pd) continue;
      // Update placeholder size so layout re-flows at the new width.
      var vp = first.getViewport({ scale: state.scale });
      pd.style.setProperty('--w', vp.width + 'px');
      pd.style.setProperty('--h', vp.height + 'px');
      // Remove rendered artifacts — leave the empty .page div for IO to re-observe.
      while (pd.firstChild) pd.removeChild(pd.firstChild);
    }

    // Re-observe (the IO already has these divs, but kick a scroll to
    // force re-evaluation of visibility).
    if (state.pageDivs[topPage]) {
      state.pageDivs[topPage].scrollIntoView({ block: 'start' });
    }
  }

  // Small API for ArkTS to drive (scroll to a specific page by number).
  window.__shibeiReader = {
    scrollToPage: function(n) {
      var div = state.pageDivs[n];
      if (div) div.scrollIntoView({ block: 'start' });
    },
  };
})();
