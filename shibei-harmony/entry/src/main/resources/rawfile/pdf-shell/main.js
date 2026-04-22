(function() {
  'use strict';

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
  if (!id) { setStatus('no resource id in URL'); return; }

  // Stub window.__shibei so ArkTS runJavaScript calls never throw during
  // the brief window before pdf-annotator-mobile.js loads (Task 7 adds it).
  window.__shibei = window.__shibei || {
    paintHighlights: function() {},
    removeHighlight: function() {},
    flashHighlight: function() {},
    clearSelection: function() {},
  };

  (async function() {
    try {
      var task = pdfjs.getDocument({ url: 'shibei-pdf://resource/' + id });
      var pdf = await task.promise;
      setStatus('loaded — ' + pdf.numPages + ' pages');

      var containerWidth = pagesEl.clientWidth - 16;
      var page = await pdf.getPage(1);
      var unscaled = page.getViewport({ scale: 1.0 });
      var scale = containerWidth / unscaled.width;
      var viewport = page.getViewport({ scale: scale });

      var pageDiv = document.createElement('div');
      pageDiv.className = 'page';
      pageDiv.dataset.pageNumber = '1';
      pageDiv.style.setProperty('--w', viewport.width + 'px');
      pageDiv.style.setProperty('--h', viewport.height + 'px');
      var canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      pageDiv.appendChild(canvas);
      pagesEl.appendChild(pageDiv);

      await page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise;
      hideStatus();

      if (window.shibeiBridge) {
        window.shibeiBridge.emit('ready', JSON.stringify({ resourceId: id, numPages: pdf.numPages }));
      }
    } catch (err) {
      var msg = err && err.message ? err.message : String(err);
      setStatus('error: ' + msg);
      console.error('pdf render fail', err);
    }
  })();
})();
