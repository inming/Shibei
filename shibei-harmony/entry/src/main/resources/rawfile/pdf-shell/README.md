# pdf-shell — pdfjs-dist runtime assets

These are **pre-bundled** classic-script builds of pdfjs-dist v4 (not ES
modules). They live in-repo rather than `node_modules/` because ArkWeb's
Chromium needs a specific combination that standard npm output doesn't
provide:

- ArkWeb rejects `import(workerSrc)` from file://, so we use pdfjs's
  fake-worker pattern: the worker bundle exposes `WorkerMessageHandler`
  as a global (`window.pdfjsWorker`), pdfjs picks that up and runs the
  handler on the main thread instead of spawning a worker. The main
  bundle exposes `pdfjsLib` similarly.
- Classic scripts + globals are the only combination that works;
  ES modules trip both the `import()` worker path and cross-file fetch
  restrictions under `$rawfile`.

Regenerate with esbuild against pdfjs-dist if ever upgrading:
```
esbuild pdfjs-dist/build/pdf.mjs --bundle --format=iife --global-name=pdfjsLib -o=pdf-bundle.js
esbuild pdfjs-dist/build/pdf.worker.mjs --bundle --format=iife --global-name=pdfjsWorker -o=pdf-worker-bundle.js
```

Other files (`shell.html`, `main.js`, `pdf-annotator-mobile.js`,
`style.css`) are added by later tasks of the Phase 3b plan at
`docs/superpowers/plans/2026-04-22-phase3b-pdf-support.md`.
