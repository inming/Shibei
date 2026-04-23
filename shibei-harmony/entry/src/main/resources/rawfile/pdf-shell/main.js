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

  var ZOOM_MIN = 0.5;
  var ZOOM_MAX = 4.0;
  var ZOOM_DEFAULT = 1.0;

  function clampZoom(z) {
    if (typeof z !== 'number' || !isFinite(z)) return ZOOM_DEFAULT;
    if (z < ZOOM_MIN) return ZOOM_MIN;
    if (z > ZOOM_MAX) return ZOOM_MAX;
    // Round to 2 decimals to avoid FP drift accumulating across +/- steps.
    return Math.round(z * 100) / 100;
  }

  var params = new URL(location.href).searchParams;
  var id = params.get('id') || '';
  if (!id) { setStatus('no resource id'); return; }
  var initialZoom = clampZoom(parseFloat(params.get('zoom') || '1'));

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
    // baseFitScale = containerWidth / unscaled-page-1-width. Mirrors
    // "fit-to-width" zoom and updates only on container resize (fold /
    // rotate). The effective render scale is baseFitScale * zoomFactor.
    baseFitScale: 1.0,
    zoomFactor: ZOOM_DEFAULT,
    scale: 1.0,
    // Bumped every time relayoutForNewWidth fires. renderPage captures
    // the current gen at start and bails at every await boundary if the
    // gen has advanced — this prevents an in-flight old-scale render
    // from publishing a stale text-layer after relayout has swapped
    // in new-scale containers.
    renderGen: 0,
  };
  state.zoomFactor = initialZoom;

  (async function() {
    try {
      state.pdf = await pdfjs.getDocument({ url: 'shibei-pdf://resource/' + id }).promise;
      setStatus('rendering — ' + state.pdf.numPages + ' pages');

      // ArkWeb sometimes reports a stale / default clientWidth before the
      // Web component has finished its first layout pass — wait a frame
      // so the real width lands before we compute scale.
      // Wait a frame so ArkWeb's Web component finishes its initial
      // layout pass before we read clientWidth — pre-layout it sometimes
      // reports a stale default that drifts from the final host size.
      await new Promise(function(r) { requestAnimationFrame(function() { r(null); }); });
      var containerWidth = pagesEl.clientWidth - 16;
      var first = await state.pdf.getPage(1);
      var unscaled = first.getViewport({ scale: 1.0 });
      state.baseFitScale = containerWidth / unscaled.width;
      state.scale = state.baseFitScale * state.zoomFactor;

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
      // window.resize doesn't reliably fire inside ArkWeb when its
      // host container reshapes, so use ResizeObserver directly on
      // #pages — guaranteed to fire on any layout change.
      var resizeTimer = null;
      var lastWidth = pagesEl.clientWidth;
      if (typeof ResizeObserver !== 'undefined') {
        var ro = new ResizeObserver(function() {
          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(function() {
            resizeTimer = null;
            var newWidth = pagesEl.clientWidth;
            if (!newWidth || Math.abs(newWidth - lastWidth) < 2) return;
            lastWidth = newWidth;
            relayoutForNewWidth().catch(console.error);
          }, 200);
        });
        ro.observe(pagesEl);
      }
    } catch (err) {
      setStatus('error: ' + (err && err.message ? err.message : String(err)));
      console.error('pdf load fail', err);
    }
  })();

  async function renderPage(n) {
    if (state.rendered.has(n)) return;
    state.rendered.add(n);   // reserve early so concurrent IO callbacks don't double-render
    var myGen = state.renderGen;
    try {
      var page = await state.pdf.getPage(n);
      if (myGen !== state.renderGen) return;   // stale after relayout
      var viewport = page.getViewport({ scale: state.scale });
      var div = state.pageDivs[n];
      div.style.setProperty('--w', viewport.width + 'px');
      div.style.setProperty('--h', viewport.height + 'px');
      // pdfjs TextLayer positions spans via `transform: scale(var(--scale-factor))`.
      // Without these vars set, the scale collapses to 1 and every span
      // renders at its PDF-point-native width — wildly wider than the
      // viewport. Must be set before TextLayer.render() in onPageRendered.
      div.style.setProperty('--scale-factor', String(state.scale));
      div.style.setProperty('--total-scale-factor', String(state.scale));
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
      if (myGen !== state.renderGen) {
        // Relayout superseded this render. The canvas we just appended
        // is already removed by relayout's DOM sweep, but bail before
        // populating a stale text-layer / firing onPageRendered.
        return;
      }

      // Text-layer container; populated by pdf-annotator-mobile.js.
      // Class must be "textLayer" (camelCase) — pdfjs-dist's bundled CSS
      // rules key off that exact class name for per-span font-size +
      // scale transform composition.
      var tl = document.createElement('div');
      tl.className = 'textLayer';
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

  // Capture scroll position as scrollTop/scrollHeight fraction before we
  // tear down pages. Better than tracking topPage for zoom (preserves the
  // sub-page offset), equally good for resize (pages keep same aspect).
  function captureScrollState() {
    var scrollEl = document.scrollingElement || document.documentElement;
    var sh = scrollEl.scrollHeight;
    // Fallback: top-visible page idx when height is zero (can happen mid-layout).
    var topPage = 1;
    if (state.pdf) {
      for (var i = 1; i <= state.pdf.numPages; i++) {
        var d = state.pageDivs[i];
        if (!d) continue;
        var r = d.getBoundingClientRect();
        if (r.bottom > 0) { topPage = i; break; }
      }
    }
    return {
      fraction: sh > 0 ? scrollEl.scrollTop / sh : 0,
      topPage: topPage,
    };
  }

  function restoreScrollState(prior) {
    // Two rAFs: first for the DOM size updates to settle, second for the
    // browser to recompute scrollHeight. One rAF is sometimes too early
    // on ArkWeb and leaves us clamped to 0.
    requestAnimationFrame(function() {
      requestAnimationFrame(function() {
        var scrollEl = document.scrollingElement || document.documentElement;
        var sh = scrollEl.scrollHeight;
        if (sh > 0 && prior.fraction > 0) {
          scrollEl.scrollTop = prior.fraction * sh;
        } else if (state.pageDivs[prior.topPage]) {
          state.pageDivs[prior.topPage].scrollIntoView({ block: 'start' });
        }
      });
    });
  }

  // Tear down + reflow all pages at the current state.scale. Callers set
  // state.scale (and optionally state.baseFitScale) beforehand; this
  // function owns the generation bump, DOM sweep, and IO re-observe.
  async function rebuildAllPages() {
    if (!state.pdf) return;
    // Bump generation so any in-flight renderPage from the prior scale
    // aborts at its next await boundary instead of publishing a stale
    // text-layer whose span positions are from the old viewport.
    state.renderGen++;

    // Flush all cached render state and DOM children (canvas / text-layer /
    // highlight-layer) so IntersectionObserver repaints from scratch.
    state.rendered = new Set();
    if (window.__shibei && window.__shibei.resetPageCache) {
      window.__shibei.resetPageCache();
    }
    var first = await state.pdf.getPage(1);
    for (var j = 1; j <= state.pdf.numPages; j++) {
      var pd = state.pageDivs[j];
      if (!pd) continue;
      // Update placeholder size so layout re-flows at the new scale.
      var vp = first.getViewport({ scale: state.scale });
      pd.style.setProperty('--w', vp.width + 'px');
      pd.style.setProperty('--h', vp.height + 'px');
      // Remove rendered artifacts — leave the empty .page div for IO to re-observe.
      while (pd.firstChild) pd.removeChild(pd.firstChild);
    }

    // IntersectionObserver only fires on change — pages that were already
    // visible won't re-emit isIntersecting after we emptied them, so we
    // unobserve + reobserve to force a fresh visibility check. Without
    // this, fold/rotate leaves visible pages blank until the user scrolls.
    if (state.io) {
      state.pageDivs.forEach(function(div) { if (div) state.io.unobserve(div); });
      state.pageDivs.forEach(function(div) { if (div) state.io.observe(div); });
    }
  }

  // Recompute fit-to-width scale and re-render all previously-rendered
  // pages at the new dimensions. Triggered by ResizeObserver on fold /
  // rotate; preserves the user's scroll position by fraction.
  async function relayoutForNewWidth() {
    if (!state.pdf) return;
    var prior = captureScrollState();

    var containerWidth = pagesEl.clientWidth - 16;
    var first = await state.pdf.getPage(1);
    var unscaled = first.getViewport({ scale: 1.0 });
    state.baseFitScale = containerWidth / unscaled.width;
    state.scale = state.baseFitScale * state.zoomFactor;

    await rebuildAllPages();
    restoreScrollState(prior);
  }

  // Zoom change path: keep baseFitScale (container hasn't resized),
  // update zoomFactor, and rebuild at the new composed scale.
  async function applyZoom(newZoom) {
    if (!state.pdf) return;
    var z = clampZoom(newZoom);
    if (Math.abs(z - state.zoomFactor) < 0.001) return;
    var prior = captureScrollState();
    state.zoomFactor = z;
    state.scale = state.baseFitScale * state.zoomFactor;
    await rebuildAllPages();
    restoreScrollState(prior);
    if (window.shibeiBridge) {
      try { window.shibeiBridge.emit('zoom', JSON.stringify({ zoom: z })); } catch (_) {}
    }
  }

  // ── Pinch-to-zoom ─────────────────────────────────────────────────────
  //
  // Two-phase zoom so the user gets live feedback without paying for a full
  // pdfjs re-render every frame:
  //
  //   1. touchmove (2 fingers): apply a cheap CSS `transform: scale(k)` on
  //      #pages. This blurs the canvas proportionally to k but holds the
  //      user's fingers "stuck" to the content in real time.
  //   2. touchend: strip the transform, call applyZoom(finalZoom) which
  //      does the real pdfjs re-render at the new scale. Canvas snaps back
  //      to crisp. The momentary blur-then-sharpen is the standard pattern
  //      for WebView pinch; same trick Safari iOS uses for its own zoom.
  //
  // We attach to document (not #pages) because touch events bubble from any
  // descendant, and using passive:false lets us preventDefault to keep
  // ArkWeb's default gesture handling (scroll, native zoom) from fighting.

  var pinch = {
    active: false,
    initialDistance: 0,
    initialZoom: 1.0,
    liveZoom: 1.0,
    // Midpoint between the two fingers in viewport coordinates at
    // pinch-start. Used as the CSS transform-origin so the pinch feels
    // anchored where the fingers are, not at the top-left of #pages.
    originX: 0,
    originY: 0,
  };

  function pinchDistance(t1, t2) {
    var dx = t1.clientX - t2.clientX;
    var dy = t1.clientY - t2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  document.addEventListener('touchstart', function(ev) {
    if (ev.touches.length !== 2) return;
    pinch.active = true;
    pinch.initialDistance = pinchDistance(ev.touches[0], ev.touches[1]);
    pinch.initialZoom = state.zoomFactor;
    pinch.liveZoom = state.zoomFactor;
    var midX = (ev.touches[0].clientX + ev.touches[1].clientX) / 2;
    var midY = (ev.touches[0].clientY + ev.touches[1].clientY) / 2;
    // transform-origin is relative to the element's own box, not the
    // viewport — convert by subtracting the element's offset.
    var rect = pagesEl.getBoundingClientRect();
    pinch.originX = midX - rect.left;
    pinch.originY = midY - rect.top;
    pagesEl.style.transformOrigin = pinch.originX + 'px ' + pinch.originY + 'px';
    // Kill the transition briefly so scale changes track fingers without lag.
    pagesEl.style.transition = 'none';
  }, { passive: true });

  document.addEventListener('touchmove', function(ev) {
    if (!pinch.active || ev.touches.length !== 2) return;
    // preventDefault cancels native ArkWeb pinch-zoom on the page (we
    // still need zoomAccess(false) from ArkTS too, this is belt-and-suspenders).
    if (ev.cancelable) ev.preventDefault();
    var d = pinchDistance(ev.touches[0], ev.touches[1]);
    if (pinch.initialDistance <= 0) return;
    var raw = pinch.initialZoom * (d / pinch.initialDistance);
    pinch.liveZoom = clampZoom(raw);
    // Live preview via CSS transform — cheap, but the canvas goes blurry
    // until touchend triggers the real re-render.
    var k = pinch.liveZoom / pinch.initialZoom;
    pagesEl.style.transform = 'scale(' + k + ')';
  }, { passive: false });

  function endPinch() {
    if (!pinch.active) return;
    pinch.active = false;
    var finalZoom = pinch.liveZoom;
    pagesEl.style.transition = '';
    pagesEl.style.transform = '';
    pagesEl.style.transformOrigin = '';
    // Only re-render if the zoom actually changed — prevents a pinch that
    // ended back at the starting scale (user cancelled) from rebuilding.
    if (Math.abs(finalZoom - pinch.initialZoom) > 0.005) {
      applyZoom(finalZoom).catch(console.error);
    }
  }
  document.addEventListener('touchend', endPinch, { passive: true });
  document.addEventListener('touchcancel', endPinch, { passive: true });

  // Small API for ArkTS to drive.
  window.__shibeiReader = {
    scrollToPage: function(n) {
      var div = state.pageDivs[n];
      if (div) div.scrollIntoView({ block: 'start' });
    },
    // Forceable entry point: ArkTS can call this on fold-state change
    // when ResizeObserver didn't fire (e.g., ArkWeb swapped containers).
    relayout: function() {
      relayoutForNewWidth().catch(console.error);
    },
    setZoom: function(z) {
      applyZoom(z).catch(console.error);
    },
    getZoom: function() {
      return state.zoomFactor;
    },
  };
})();
