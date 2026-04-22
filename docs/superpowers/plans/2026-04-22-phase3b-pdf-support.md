# Phase 3b — 鸿蒙 PDF 支持实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 PDF 阅读 + 标注在鸿蒙移动端做起来，与桌面端跨端互通。设计见
[`docs/superpowers/specs/2026-04-22-phase3b-pdf-support-design.md`](../specs/2026-04-22-phase3b-pdf-support-design.md)。

**Architecture:** 复用现有 `pdfjs-demo/` 里已验证的 pdfjs v4 classic-script
bundles（worker 以 fake-worker 方式跑在主线程）。在现有 `Reader.ets`
里条件分支出 `PdfContent()` 子树。PDF 二进制用自定义 URL scheme
`shibei-pdf://resource/{id}` 经 ArkWeb `onInterceptRequest` 从 NAPI
喂给 pdfjs。标注复用 Phase 3a 的 `AnnotationPanel` / `bindSheet` /
`AnnotationsService`，只新增 `pdf-annotator-mobile.js` 负责文本层选区 →
anchor 构建和高亮 overlay 绘制。

**Tech Stack:**
- HarmonyOS NEXT + ArkWeb + ArkTS 严格模式
- pdfjs-dist v4（已 pre-bundled 在 rawfile，不走 npm）
- Rust NAPI (shibei-core) + shibei-sync 的 `download_snapshot` 复用
- SSH + hdc 远程调试（见 `memory/reference_harmony_remote_debug.md`）

**重要前置知识（从 `pdfjs-demo/index.html` 学到的）：**
1. ArkWeb 的 Chromium 缺 ES2024 `Uint8Array.toHex`/`fromHex`，pdfjs 里用到，必须在 load bundles 之前 polyfill。
2. ArkWeb 拒绝 `import(workerSrc)` from file:// — 必须走 fake-worker 路径：在 `getDocument` 之前把 `window.pdfjsWorker.WorkerMessageHandler` 设好，pdfjs 会主线程跑 worker。`workerSrc` 仍需设一个非空字串占位（否则 pdfjs 抛 "No workerSrc specified"），设 `'about:blank'` 即可。
3. 页面 `src=$rawfile(...)` 时跨 rawfile `fetch` 另一个资源会被 ArkWeb 拦；PDF 字节必须走 bridge 或自定义 scheme。

---

## 前置：分支工作方式

- 直接 commit 到 `main`（项目约定）
- 每个 Task 结束时 commit；PR / 分支不用
- Task 0 是 go/no-go 的 spike — **spike 未通过禁止动 Task 1+**
- 手动验证节点（Task 0, 4, 8, 10）需要远程 Mate X5，用 hdc + sqlite 对 DB；AI 不能操 UI

---

## Task 0: Spike — 验证 onInterceptRequest + pdfjs 渲染真 PDF

**目的**：一次性验证设计第 1 节的关键路径：自定义 scheme 能被 ArkWeb
拦截、返回二进制、pdfjs 能消化。如果通过，后续全部按计划走；如果不通，
回头切换到 base64-via-bridge（已由 `pdfjs-demo` 证明可行）再改 plan。

**Files:**
- Create: `shibei-harmony/entry/src/main/resources/rawfile/pdf-spike/spike.html`
- Create: `shibei-harmony/entry/src/main/resources/rawfile/pdf-spike/sample.pdf` (copy from `pdfjs-demo/sample.pdf`)
- Create: `shibei-harmony/entry/src/main/resources/rawfile/pdf-spike/pdf-bundle.js` (copy from `pdfjs-demo/pdf-bundle.js`)
- Create: `shibei-harmony/entry/src/main/resources/rawfile/pdf-spike/pdf-worker-bundle.js` (copy from `pdfjs-demo/pdf-worker-bundle.js`)
- Create: `shibei-harmony/entry/src/main/ets/pages/PdfSpike.ets` (throwaway Entry page)
- Modify: `shibei-harmony/entry/src/main/resources/base/profile/main_pages.json` (register `pages/PdfSpike`)

- [ ] **Step 1: Copy pdfjs bundles into the spike directory**

```bash
cd /Users/work/workspace/Shibei/shibei-harmony/entry/src/main/resources/rawfile
mkdir -p pdf-spike
cp pdfjs-demo/pdf-bundle.js pdf-spike/pdf-bundle.js
cp pdfjs-demo/pdf-worker-bundle.js pdf-spike/pdf-worker-bundle.js
cp pdfjs-demo/sample.pdf pdf-spike/sample.pdf
ls pdf-spike/
```

Expected: 3 files, ~3.5 MB total.

- [ ] **Step 2: Write `spike.html` — fetches PDF via `shibei-pdf://` scheme**

Create `shibei-harmony/entry/src/main/resources/rawfile/pdf-spike/spike.html`:

```html
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Spike: shibei-pdf:// intercept</title>
<style>
  body { font: 14px -apple-system, sans-serif; padding: 8px; }
  #status { padding: 8px; background: #eef; margin-bottom: 8px; }
  canvas { width: 100%; border: 1px solid #aaa; }
  pre { max-height: 30vh; overflow: auto; background: #f0f0f0; padding: 6px; font-size: 11px; }
</style>
</head>
<body>
<h3>Phase 3b Spike: custom scheme + onInterceptRequest</h3>
<div id="status">loading…</div>
<canvas id="page"></canvas>
<h4>Log:</h4>
<pre id="log"></pre>

<script>
// Polyfill ES2024 Uint8Array.toHex/fromHex missing in ArkWeb's Chromium.
// pdfjs v4 uses these for fingerprinting and throws TypeError without them.
(function() {
  var P = Uint8Array.prototype;
  if (typeof P.toHex !== 'function') {
    P.toHex = function() {
      var out = '';
      for (var i = 0; i < this.length; i++) {
        var h = this[i].toString(16);
        out += h.length < 2 ? '0' + h : h;
      }
      return out;
    };
  }
  if (typeof Uint8Array.fromHex !== 'function') {
    Uint8Array.fromHex = function(hex) {
      var len = hex.length >> 1;
      var arr = new Uint8Array(len);
      for (var i = 0; i < len; i++) arr[i] = parseInt(hex.substr(i*2, 2), 16);
      return arr;
    };
  }
})();
</script>
<script src="./pdf-bundle.js"></script>
<script src="./pdf-worker-bundle.js"></script>
<script>
(async function() {
  var logEl = document.getElementById('log');
  var statusEl = document.getElementById('status');
  function log(m) {
    var line = (typeof m === 'string' ? m : JSON.stringify(m));
    logEl.textContent += line + '\n';
    console.log(line);
  }
  function setStatus(s) { statusEl.textContent = s; log('status: ' + s); }

  try {
    var pdfjs = window.pdfjsLib;
    var wg = window.pdfjsWorker;
    if (!pdfjs || !pdfjs.getDocument) { setStatus('ERR: pdfjsLib missing'); return; }
    if (!wg || !wg.WorkerMessageHandler) { setStatus('ERR: pdfjsWorker global missing'); return; }
    // Fake-worker: handler found on globalThis → pdfjs never fetches workerSrc.
    pdfjs.GlobalWorkerOptions.workerSrc = 'about:blank';
    setStatus('A: pdfjs globals ready');

    // The key spike assertion: pdfjs.getDocument({url: 'shibei-pdf://test'})
    // triggers a network request that ArkWeb's onInterceptRequest catches;
    // ArkTS returns the sample PDF bytes.
    setStatus('B: requesting shibei-pdf://test');
    var task = pdfjs.getDocument({ url: 'shibei-pdf://test' });
    var pdf = await task.promise;
    setStatus('C: loaded, pages=' + pdf.numPages);

    var page = await pdf.getPage(1);
    var viewport = page.getViewport({ scale: 1.0 });
    var canvas = document.getElementById('page');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    setStatus('D: SPIKE PASS — rendered page 1 (' + viewport.width + 'x' + viewport.height + ')');
  } catch (err) {
    var msg = err && err.message ? err.message : String(err);
    var stack = err && err.stack ? err.stack.toString().substring(0, 400) : '';
    setStatus('ERR: ' + msg);
    log({ error: msg, stack: stack });
  }
})();
</script>
</body>
</html>
```

- [ ] **Step 3: Write throwaway `PdfSpike.ets` Entry page**

Create `shibei-harmony/entry/src/main/ets/pages/PdfSpike.ets`:

```typescript
import { webview, WebResourceResponse } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { resourceManager } from '@kit.LocalizationKit';

// Throwaway Phase-3b spike page. Verifies that ArkWeb's onInterceptRequest
// catches requests to a custom scheme (shibei-pdf://) and that pdfjs can
// consume the returned bytes to render a page. Delete this file and its
// main_pages.json registration once the spike passes.

@Entry
@Component
struct PdfSpike {
  private webController: webview.WebviewController = new webview.WebviewController();
  @State loaded: boolean = false;

  build() {
    Stack() {
      Web({
        src: $rawfile('pdf-spike/spike.html'),
        controller: this.webController,
      })
      .javaScriptAccess(true)
      .domStorageAccess(true)
      .onInterceptRequest((event) => this.handleIntercept(event))
      .onPageEnd(() => { this.loaded = true; })
      .width('100%')
      .height('100%');
    }
    .width('100%').height('100%');
  }

  private handleIntercept(event: OnInterceptRequestEvent): WebResourceResponse | null {
    const url = event.request.getRequestUrl();
    if (!url.startsWith('shibei-pdf://')) {
      return null;  // let ArkWeb handle all other requests normally
    }
    try {
      const ctx = getContext(this) as common.UIAbilityContext;
      const bytes: Uint8Array = ctx.resourceManager.getRawFileContentSync('pdf-spike/sample.pdf');
      hilog.info(0x0000, 'shibei', 'spike intercept %{public}s → %{public}d bytes', url, bytes.byteLength);
      const resp = new WebResourceResponse();
      resp.setResponseMimeType('application/pdf');
      resp.setResponseCode(200);
      resp.setResponseData(bytes.buffer);
      return resp;
    } catch (err) {
      hilog.error(0x0000, 'shibei', 'spike intercept fail %{public}s', (err as Error).message);
      return null;
    }
  }
}
```

- [ ] **Step 4: Register the spike page in `main_pages.json`**

Edit `shibei-harmony/entry/src/main/resources/base/profile/main_pages.json`:

```bash
# Inspect current state
cat /Users/work/workspace/Shibei/shibei-harmony/entry/src/main/resources/base/profile/main_pages.json
```

Add `"pages/PdfSpike"` to the `src` array. Example if the current content is:
```json
{ "src": ["pages/Onboard", "pages/Library", "pages/Reader", "pages/Settings", "pages/Search"] }
```
It becomes:
```json
{ "src": ["pages/Onboard", "pages/Library", "pages/Reader", "pages/Settings", "pages/Search", "pages/PdfSpike"] }
```

- [ ] **Step 5: Change the startup route to `pages/PdfSpike`** (spike-only)

For spike testing, temporarily make `EntryAbility` push to `pages/PdfSpike` instead of the normal Library. Find `EntryAbility.ets` `onWindowStageCreate`:

```bash
grep -n "loadContent\|pages/" /Users/work/workspace/Shibei/shibei-harmony/entry/src/main/ets/entryability/EntryAbility.ets
```

Edit that file so `windowStage.loadContent('pages/PdfSpike', ...)` runs for this spike session (you'll revert in Step 8).

- [ ] **Step 6: Build .so + rebuild ArkTS + deploy**

```bash
cd /Users/work/workspace/Shibei
scripts/build-harmony-napi.sh
```

Expected: `libshibei_core.so` built fresh. Then in DevEco on the remote Mac (SSH in via `ssh inming@192.168.64.1`, open the project), Run the app on the Mate X5.

- [ ] **Step 7: Verify pass/fail**

On the phone: status line at the top of PdfSpike page.

- **PASS**: "D: SPIKE PASS — rendered page 1 (612x792)" plus a visible PDF page on canvas.
- **FAIL**: any "ERR:" status. Read `hilog` via:

```bash
ssh inming@192.168.64.1 '/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc shell "hilog | grep shibei | tail -50"'
```

If PASS → proceed to Step 8.
If FAIL → **STOP.** Report to user with hilog output. Decide with user whether to pivot to base64-via-bridge path (Task 2/4/8 would all revise).

- [ ] **Step 8: Clean up the spike**

Once PASS:

```bash
cd /Users/work/workspace/Shibei
rm -rf shibei-harmony/entry/src/main/resources/rawfile/pdf-spike
rm shibei-harmony/entry/src/main/ets/pages/PdfSpike.ets
# revert main_pages.json and EntryAbility.ets edits from Steps 4–5
```

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore(harmony): phase 3b spike — onInterceptRequest + pdfjs validated"
```

The commit records the negative space (spike ran and passed; files deleted). If the spike failed, commit with message naming the blocker and stop the plan here.

---

## Task 1: Promote pdfjs bundles to `pdf-shell/`

**Purpose:** Move from the one-off spike/demo layout to the real runtime
location under `rawfile/pdf-shell/`. This is the directory the main code
references; `pdfjs-demo/` stays as a reference/test artifact.

**Files:**
- Create: `shibei-harmony/entry/src/main/resources/rawfile/pdf-shell/pdf-bundle.js` (copy from `pdfjs-demo/`)
- Create: `shibei-harmony/entry/src/main/resources/rawfile/pdf-shell/pdf-worker-bundle.js` (copy from `pdfjs-demo/`)

- [ ] **Step 1: Copy bundles**

```bash
cd /Users/work/workspace/Shibei/shibei-harmony/entry/src/main/resources/rawfile
mkdir -p pdf-shell
cp pdfjs-demo/pdf-bundle.js pdf-shell/pdf-bundle.js
cp pdfjs-demo/pdf-worker-bundle.js pdf-shell/pdf-worker-bundle.js
ls -la pdf-shell/
```

Expected: ~1 MB + ~2.4 MB bundles.

- [ ] **Step 2: Add a README so future-you doesn't wonder why the `.js` files aren't in `node_modules`**

Create `shibei-harmony/entry/src/main/resources/rawfile/pdf-shell/README.md`:

```markdown
# pdf-shell — pdfjs-dist runtime assets

These are **pre-bundled** classic-script builds of pdfjs-dist v4 (not ES
modules). We keep them in-repo rather than in `node_modules/` because:

- ArkWeb cannot `import(workerSrc)` from file://, so we use pdfjs's
  fake-worker pattern (WorkerMessageHandler exposed as a global).
- Classic scripts + globals is the only combination that works.

Regenerate with esbuild against pdfjs-dist if you ever need to upgrade —
see `docs/superpowers/plans/2026-04-22-phase3b-pdf-support.md` Task 1.

Other files (`shell.html`, `main.mjs`, `pdf-annotator-mobile.js`,
`style.css`) are added by later tasks in the same plan.
```

- [ ] **Step 3: Commit**

```bash
git add shibei-harmony/entry/src/main/resources/rawfile/pdf-shell/
git commit -m "chore(harmony): promote pdfjs bundles to pdf-shell/ runtime path"
```

---

## Task 2: Rust NAPI — `get_pdf_bytes` + `ensure_pdf_downloaded`

**Files:**
- Modify: `src-harmony-napi/src/commands.rs` (add two commands)

- [ ] **Step 1: Find the insertion point**

```bash
grep -n "pub fn get_resource_html\|fn build_sync_engine\|#\[shibei_napi\] pub fn" /Users/work/workspace/Shibei/src-harmony-napi/src/commands.rs | head -10
```

Add the new commands near other resource-scoped commands.

- [ ] **Step 2: Add `get_pdf_bytes`**

Add to `src-harmony-napi/src/commands.rs`:

```rust
#[shibei_napi]
pub fn get_pdf_bytes(id: String) -> Vec<u8> {
    let app = match state::get() {
        Ok(a) => a,
        Err(e) => {
            hilog_warn!("get_pdf_bytes not-initialized: {e}");
            return Vec::new();
        }
    };
    let pdf_path = app.data_dir.join("storage").join(&id).join("snapshot.pdf");
    match std::fs::read(&pdf_path) {
        Ok(bytes) => bytes,
        Err(e) => {
            hilog_warn!("get_pdf_bytes read fail {}: {e}", pdf_path.display());
            Vec::new()
        }
    }
}
```

If `hilog_warn!` isn't defined in that file, use `hilog::warn!` or the pattern already in use — inspect how `get_resource_html` reports errors and copy that style. Returning an empty `Vec<u8>` on error signals "not available" to the caller; ArkTS side translates to "PDF 文件不存在" UI.

- [ ] **Step 3: Add `ensure_pdf_downloaded`**

```rust
#[shibei_napi]
pub async fn ensure_pdf_downloaded(id: String) -> String {
    let app = match state::get() {
        Ok(a) => a,
        Err(e) => return format!("error.notInitialized: {e}"),
    };
    let pdf_path = app.data_dir.join("storage").join(&id).join("snapshot.pdf");
    if pdf_path.exists() {
        return "ok".to_string();
    }
    // Build a sync engine and pull this one snapshot.
    let engine = match build_sync_engine().await {
        Ok(e) => e,
        Err(e) => return format!("error.syncEngine: {e}"),
    };
    match engine.download_snapshot(&id, "pdf").await {
        Ok(()) => "ok".to_string(),
        Err(e) => format!("error.downloadFailed: {e}"),
    }
}
```

If `build_sync_engine` is sync (non-async), drop the `.await` and adjust return type to non-async. Cross-check with the existing `sync_metadata` command which calls `build_sync_engine` — mirror its signature exactly.

- [ ] **Step 4: Verify build**

```bash
cd /Users/work/workspace/Shibei
cargo check -p shibei-core
```

Expected: no errors.

- [ ] **Step 5: Run NAPI codegen**

```bash
cargo run -p shibei-napi-codegen
```

Expected: new entries in `src-harmony-napi/Index.d.ts` for `getPdfBytes` and `ensurePdfDownloaded`.

- [ ] **Step 6: Commit**

```bash
git add src-harmony-napi/src/commands.rs src-harmony-napi/Index.d.ts src-harmony-napi/src/bindings.rs src-harmony-napi/src/shim.c
git commit -m "feat(harmony): NAPI get_pdf_bytes + ensure_pdf_downloaded"
```

---

## Task 3: ShibeiService facade + rebuild .so

**Files:**
- Modify: `shibei-harmony/entry/src/main/ets/services/ShibeiService.ets` (add facade methods)

- [ ] **Step 1: Add imports and facade methods**

Find the block where existing NAPI imports are aliased (near top of file). Add:

```typescript
import {
  // …existing imports…
  getPdfBytes as napiGetPdfBytes,
  ensurePdfDownloaded as napiEnsurePdfDownloaded,
} from '@ohos/shibei_core/Index';
```

Inside the `ShibeiService` class, near `getResourceHtml`, add:

```typescript
/// Read the PDF bytes for a resource from local storage. Returns a
/// zero-length Uint8Array if the file doesn't exist — caller should
/// trigger `ensurePdfDownloaded` first.
getPdfBytes(id: string): Uint8Array {
  const bytes = napiGetPdfBytes(id);
  return bytes;
}

/// Ensure the PDF snapshot for a resource is present on disk; pulls it
/// from S3 via the sync engine if missing. Throws ShibeiError on failure.
async ensurePdfDownloaded(id: string): Promise<void> {
  const result: string = await napiEnsurePdfDownloaded(id);
  if (result !== 'ok') {
    throw new ShibeiError(result);
  }
}
```

- [ ] **Step 2: Rebuild .so**

```bash
cd /Users/work/workspace/Shibei
scripts/build-harmony-napi.sh
```

Expected: `libshibei_core.so` rebuilt.

- [ ] **Step 3: Commit**

```bash
git add shibei-harmony/entry/src/main/ets/services/ShibeiService.ets
git commit -m "feat(harmony): ShibeiService.getPdfBytes + ensurePdfDownloaded"
```

---

## Task 4: Shell HTML + main.mjs — single-page render happy path

**Files:**
- Create: `shibei-harmony/entry/src/main/resources/rawfile/pdf-shell/shell.html`
- Create: `shibei-harmony/entry/src/main/resources/rawfile/pdf-shell/main.js`
- Create: `shibei-harmony/entry/src/main/resources/rawfile/pdf-shell/style.css`

(Using classic `.js` file, not `.mjs`, because the existing pdfjs bundles are classic-script; ES modules don't play well with the fake-worker pattern.)

- [ ] **Step 1: Write `shell.html`**

```html
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>PDF Reader</title>
<link rel="stylesheet" href="./style.css">
</head>
<body>
<div id="status">加载中…</div>
<div id="pages"></div>

<script>
// ES2024 Uint8Array.toHex/fromHex polyfill — ArkWeb's Chromium lacks them
// and pdfjs v4 trips on their absence.
(function() {
  var P = Uint8Array.prototype;
  if (typeof P.toHex !== 'function') {
    P.toHex = function() {
      var out = '';
      for (var i = 0; i < this.length; i++) {
        var h = this[i].toString(16);
        out += h.length < 2 ? '0' + h : h;
      }
      return out;
    };
  }
  if (typeof Uint8Array.fromHex !== 'function') {
    Uint8Array.fromHex = function(hex) {
      var len = hex.length >> 1;
      var arr = new Uint8Array(len);
      for (var i = 0; i < len; i++) arr[i] = parseInt(hex.substr(i*2, 2), 16);
      return arr;
    };
  }
})();
</script>
<script src="./pdf-bundle.js"></script>
<script src="./pdf-worker-bundle.js"></script>
<script src="./main.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `style.css`**

```css
body {
  margin: 0;
  padding: 0;
  background: #f4f4f4;
  font: 14px -apple-system, "PingFang SC", sans-serif;
  -webkit-user-select: text;  /* allow selection in text layer */
}

#status {
  position: fixed; top: 0; left: 0; right: 0;
  background: #fff; padding: 6px 12px;
  box-shadow: 0 1px 2px rgba(0,0,0,.08);
  z-index: 100;
  font-size: 12px;
  color: #666;
}
#status.hidden { display: none; }

#pages {
  padding-top: 32px;     /* clear the status bar */
  padding-bottom: 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.page {
  position: relative;
  background: #fff;
  box-shadow: 0 1px 4px rgba(0,0,0,.12);
  /* width/height set by JS per page via --w/--h CSS vars */
  width: var(--w);
  height: var(--h);
  overflow: hidden;
}
.page canvas { width: 100%; height: 100%; display: block; }
.page .text-layer {
  position: absolute; left: 0; top: 0; right: 0; bottom: 0;
  overflow: hidden;
  opacity: .2;        /* visible while debugging; switch to 0 for prod */
  line-height: 1;
  -webkit-user-select: text;
}
.page .text-layer span {
  position: absolute;
  white-space: pre;
  color: transparent;
  cursor: text;
  transform-origin: 0 0;
}

.highlight-layer {
  position: absolute; left: 0; top: 0; right: 0; bottom: 0;
  pointer-events: none;
}
.highlight-layer .hl {
  position: absolute;
  background: var(--shibei-hl-color, #ffeb3b);
  opacity: .35;
  pointer-events: auto;
  cursor: pointer;
  border-radius: 2px;
}
.highlight-layer .hl.flash {
  animation: shibei-flash .8s ease-out;
}
@keyframes shibei-flash {
  0%, 100% { opacity: .35; }
  50% { opacity: .75; box-shadow: 0 0 0 2px rgba(255,235,59,.6); }
}
```

- [ ] **Step 3: Write `main.js` — single-page render happy path**

```javascript
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

  // Expose a stub window.__shibei so ArkTS runJavaScript calls never throw
  // during the brief window before annotator.js loads (added in Task 7).
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

      // Render page 1 at fit-to-width scale against the pages container.
      var containerWidth = pagesEl.clientWidth - 16;  /* small margin */
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

      // Notify ArkTS we're ready for annotation paint. Bridge expects JSON.
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
```

- [ ] **Step 4: Manual test via a throwaway ArkTS page** (this step will be deleted in Task 8)

For now you can't render without wiring from ArkTS — but you CAN verify shell syntax by opening `shell.html?id=fake` in a desktop browser; the status should show "pdfjsLib missing" (because the classic bundles need the dom) or "pdfjsWorker missing". Syntax-OK means load order works.

- [ ] **Step 5: Commit**

```bash
git add shibei-harmony/entry/src/main/resources/rawfile/pdf-shell/
git commit -m "feat(harmony): pdf-shell HTML + main.js + style (single-page happy path)"
```

---

## Task 5: Virtual scrolling for multi-page PDFs

**Files:**
- Modify: `shibei-harmony/entry/src/main/resources/rawfile/pdf-shell/main.js`

- [ ] **Step 1: Extend main.js to render all pages with lazy render**

Replace the contents of `main.js` with:

```javascript
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
    rendered: new Set(),   // page idx where canvas is drawn
    scale: 1.0,
  };

  (async function() {
    try {
      state.pdf = await pdfjs.getDocument({ url: 'shibei-pdf://resource/' + id }).promise;
      setStatus('rendering — ' + state.pdf.numPages + ' pages');

      var containerWidth = pagesEl.clientWidth - 16;
      // Use page 1's width as the "typical" page; pages of different sizes
      // still render correctly — each gets its own viewport below.
      var first = await state.pdf.getPage(1);
      var unscaled = first.getViewport({ scale: 1.0 });
      state.scale = containerWidth / unscaled.width;

      // Create placeholder divs for every page so IntersectionObserver can
      // track scroll-into-view without loading every page at start.
      for (var i = 1; i <= state.pdf.numPages; i++) {
        var viewport = first.getViewport({ scale: state.scale });  // reasonable default
        // If a page is a different size we re-measure on demand when rendering.
        var div = document.createElement('div');
        div.className = 'page';
        div.dataset.pageNumber = String(i);
        div.style.setProperty('--w', viewport.width + 'px');
        div.style.setProperty('--h', viewport.height + 'px');
        pagesEl.appendChild(div);
        state.pageDivs[i] = div;
      }

      // IntersectionObserver with a large rootMargin so we pre-render ±1 page.
      var io = new IntersectionObserver(function(entries) {
        entries.forEach(function(ent) {
          if (ent.isIntersecting) {
            var n = parseInt(ent.target.dataset.pageNumber, 10);
            renderPage(n).catch(console.error);
          }
        });
      }, { root: null, rootMargin: '400px 0px', threshold: 0.01 });
      state.pageDivs.forEach(function(div) { if (div) io.observe(div); });

      hideStatus();
      if (window.shibeiBridge) {
        window.shibeiBridge.emit('ready', JSON.stringify({ resourceId: id, numPages: state.pdf.numPages }));
      }
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
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      div.appendChild(canvas);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise;

      // Text layer for selection (filled in Task 6 by pdf-annotator-mobile.js;
      // here we just create the container div so the annotator can populate).
      var tl = document.createElement('div');
      tl.className = 'text-layer';
      div.appendChild(tl);

      // Signal annotator to populate text-layer + highlight overlay for this page.
      if (window.__shibei && window.__shibei.onPageRendered) {
        window.__shibei.onPageRendered(n, page, viewport, tl);
      }
    } catch (err) {
      state.rendered.delete(n);  // allow retry
      console.error('renderPage fail', n, err);
    }
  }

  // Expose small API for ArkTS driver (to scroll to a page by number).
  window.__shibeiReader = {
    scrollToPage: function(n) {
      var div = state.pageDivs[n];
      if (div) div.scrollIntoView({ block: 'start' });
    },
  };
})();
```

- [ ] **Step 2: Commit**

```bash
git add shibei-harmony/entry/src/main/resources/rawfile/pdf-shell/main.js
git commit -m "feat(harmony): pdf-shell virtual scrolling with ±1 page lazy render"
```

---

## Task 6: `pdf-annotator-mobile.js` — selection → anchor → bridge emit

**Files:**
- Create: `shibei-harmony/entry/src/main/resources/rawfile/pdf-shell/pdf-annotator-mobile.js`
- Modify: `shibei-harmony/entry/src/main/resources/rawfile/pdf-shell/shell.html` (add script tag)

- [ ] **Step 1: Create the annotator skeleton with text-layer population + selection**

```javascript
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
  // `start`/`end` are char offsets into the full page text — this is what
  // anchor.charIndex + length reference, matching the desktop format.
  var pageTextCache = {};

  async function populateTextLayer(pageNum, page, viewport, textLayerEl) {
    // pdfjs streams text items; each item is a visible string fragment with
    // transform (a,b,c,d,e,f) for position. We render each item as an
    // absolutely-positioned <span> inside the text-layer div.
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

        // Append synthetic space after items that have a trailing space,
        // mirroring pdfjs's visible-text convention. Real pdfjs does more
        // sophisticated word-join detection; our char offsets will drift
        // slightly from streamTextContent() on the desktop — that's what
        // textQuote fallback is for.
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

  // When the user releases the selection on the page text layer,
  // construct an anchor describing where it is in PDF char-stream space.
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

    // Find the owning .page div (may span multiple — we require single page).
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
  // relative to the page's full streamTextContent text. Linear scan of
  // span cache — fine at ~hundreds of spans per page.
  function charOffsetFromRangeEnd(node, offset, spans) {
    // If node is a text node, its parent is the <span>.
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
```

- [ ] **Step 2: Load the annotator from shell.html**

Append one more `<script src="./pdf-annotator-mobile.js">` tag to `shell.html`, **after** `main.js`:

```html
<!-- existing main.js line -->
<script src="./main.js"></script>
<!-- new line -->
<script src="./pdf-annotator-mobile.js"></script>
```

- [ ] **Step 3: Commit**

```bash
git add shibei-harmony/entry/src/main/resources/rawfile/pdf-shell/pdf-annotator-mobile.js \
        shibei-harmony/entry/src/main/resources/rawfile/pdf-shell/shell.html
git commit -m "feat(harmony): pdf-annotator-mobile — text layer + selection → anchor"
```

---

## Task 7: `pdf-annotator-mobile.js` — paintHighlights + click + color change

**Files:**
- Modify: `shibei-harmony/entry/src/main/resources/rawfile/pdf-shell/pdf-annotator-mobile.js`

- [ ] **Step 1: Add highlight layer + paint/remove/click/color APIs**

Append to the IIFE in `pdf-annotator-mobile.js`, inside the same `(function(){ ... })()`:

```javascript
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
    // Remove any prior rects for this id (idempotent repaint).
    var old = layer.querySelectorAll('[data-shibei-id="' + cssEscape(h.id) + '"]');
    old.forEach(function(el) { el.remove(); });

    var start = h.anchor.charIndex;
    var end = start + (h.anchor.length || 0);
    var pageRect = pageDiv.getBoundingClientRect();

    for (var i = 0; i < cache.spans.length; i++) {
      var s = cache.spans[i];
      if (s.end <= start || s.start >= end) continue;   // no overlap

      // Partial-span overlap: compute client rect of the covered text.
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
    // Use a Range over the span's text node to compute a client rect for
    // [fromCh, toCh). Falls back to the whole span if the text node shape
    // is unexpected.
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

  // Public API matching annotator-mobile.js (HTML version) contract.
  var prevOnPageRendered = window.__shibei.onPageRendered;
  window.__shibei.onPageRendered = function(pageNum, page, viewport, textLayerEl) {
    // Let the original text-layer population run first (from Task 6), then
    // paint any highlights whose page just became available.
    prevOnPageRendered.call(this, pageNum, page, viewport, textLayerEl);
    // populateTextLayer is async; we don't await it here, so highlights may
    // briefly draw against an empty cache. Hook into the cache-ready event:
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

  window.__shibei.paintHighlights = function(listJson) {
    var list;
    try { list = JSON.parse(listJson); } catch (_) { return; }
    if (!Array.isArray(list)) return;
    list.forEach(function(h) {
      if (!h || !h.id || !h.anchor) return;
      var prev = highlights[h.id];
      highlights[h.id] = h;
      // Skip re-draw if nothing material changed (matches HTML annotator behavior).
      if (prev && prev.color === h.color) {
        // If a color-change via swatch repaint is needed, the color equality
        // will be false; otherwise nothing to do.
        return;
      }
      drawHighlight(h);
    });
    // Any highlights in our local map that aren't in `list` have been deleted.
    var incomingIds = new Set(list.map(function(h) { return h.id; }));
    Object.keys(highlights).forEach(function(id) {
      if (!incomingIds.has(id)) {
        removeHighlightLocal(id);
      }
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
```

- [ ] **Step 2: Commit**

```bash
git add shibei-harmony/entry/src/main/resources/rawfile/pdf-shell/pdf-annotator-mobile.js
git commit -m "feat(harmony): pdf-annotator — paintHighlights/click/color/flash/remove APIs"
```

---

## Task 8: Reader.ets — PdfContent branch + download/error UI

**Files:**
- Modify: `shibei-harmony/entry/src/main/ets/pages/Reader.ets`

- [ ] **Step 1: Add PDF-specific state and imports**

Near the top of `Reader.ets`, add import for `WebResourceResponse` and `OnInterceptRequestEvent`:

```typescript
import { webview, WebResourceResponse, OnInterceptRequestEvent } from '@kit.ArkWeb';
```

(If the existing imports already pull everything from `@kit.ArkWeb`, merge; avoid duplicates.)

Add state fields next to the existing ones:

```typescript
@State pdfReady: boolean = false;
@State pdfDownloading: boolean = false;
@State pdfError: string = '';
```

- [ ] **Step 2: Extend `aboutToAppear()` — branch on resource_type**

Inside `aboutToAppear()`, after `this.resource = ShibeiService.instance.getResource(id);` but BEFORE `this.html = ShibeiService.instance.getResourceHtml(id);`, guard the HTML load:

```typescript
if (this.resource && this.resource.resource_type === 'pdf') {
  this.loading = false;  // show Reader shell immediately; inner state drives the rest
  this.ensurePdfReady(id);
} else {
  try {
    this.html = ShibeiService.instance.getResourceHtml(id);
  } catch (err) {
    // ...existing HTML error handling...
  }
}
```

Add the helper:

```typescript
private async ensurePdfReady(id: string): Promise<void> {
  this.pdfDownloading = true;
  this.pdfError = '';
  try {
    await ShibeiService.instance.ensurePdfDownloaded(id);
    this.pdfReady = true;
  } catch (err) {
    const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
    this.pdfError = code;
    hilog.error(0x0000, 'shibei', 'pdf download fail %{public}s: %{public}s', id, code);
  } finally {
    this.pdfDownloading = false;
  }
}
```

- [ ] **Step 3: Split `build()` into HTML/PDF branches via @Builder**

Inside the `else` branch that currently renders `SideBarContainer(...)`, swap the Web-hosting body for a call to one of two @Builders chosen by resource_type:

```typescript
// inside SideBarContainer { ... } after AnnotationPanel(...) 
if (this.resource && this.resource.resource_type === 'pdf') {
  this.PdfContent();
} else {
  this.HtmlContent();
}
```

Extract the existing HTML Web block into a new @Builder `HtmlContent()` — pull the `Column() { ... Row() topbar ... Stack() { Web(...), scrim, floating palette } ... }` from the current build verbatim.

- [ ] **Step 4: Write `PdfContent()` @Builder**

```typescript
@Builder PdfContent() {
  Column() {
    // Reuse the topbar Row from HtmlContent (back button / title / annotations toggle).
    // Factor that Row into another @Builder TopBar() and call it from both branches.
    this.TopBar();

    Stack() {
      if (this.pdfDownloading) {
        Column() {
          Text('正在下载 PDF…')
            .fontColor($r('sys.color.ohos_id_color_text_tertiary'));
        }.width('100%').height('100%').justifyContent(FlexAlign.Center);
      } else if (this.pdfError) {
        Column() {
          Text('下载失败: ' + this.pdfError)
            .fontColor($r('sys.color.ohos_id_color_warning'));
          Button('重试').margin({ top: 12 })
            .onClick(() => {
              if (this.resource) this.ensurePdfReady(this.resource.id);
            });
        }.width('100%').height('100%').justifyContent(FlexAlign.Center);
      } else if (this.pdfReady && this.resource) {
        Web({
          src: $rawfile('pdf-shell/shell.html?id=' + this.resource.id),
          controller: this.webController,
        })
          .domStorageAccess(true)
          .javaScriptAccess(true)
          .onInterceptRequest((ev: OnInterceptRequestEvent) => this.handlePdfIntercept(ev))
          .onControllerAttached(() => {
            this.webController.registerJavaScriptProxy(
              this.bridge, 'shibeiBridge', ['emit'],
            );
          })
          .onScroll((ev: OnScrollEvent) => {
            this.lastScrollY = ev.yOffset;
            this.scheduleScrollSave();
          })
          .width('100%').height('100%')
          .backgroundColor($r('sys.color.ohos_id_color_sub_background'));
      }

      // Scrim for tap-to-close drawer (mirrors HtmlContent).
      if (this.panelOpen) {
        Column()
          .width('100%').height('100%')
          .backgroundColor('#01000000')
          .onClick(() => { this.panelOpen = false; });
      }

      // Floating palette when the user has a pending selection in the PDF.
      if (this.pendingSelection !== null && !this.pendingSelection.collapsed) {
        // Reuse the same Row(...) palette markup as HtmlContent — factor into
        // @Builder SelectionPalette() and call from both branches.
        this.SelectionPalette();
      }
    }
    .layoutWeight(1).width('100%');
  }
  .width('100%').height('100%');
}
```

- [ ] **Step 5: Add `handlePdfIntercept`**

```typescript
private handlePdfIntercept(event: OnInterceptRequestEvent): WebResourceResponse | null {
  const url = event.request.getRequestUrl();
  if (!url.startsWith('shibei-pdf://resource/')) return null;
  const id = url.slice('shibei-pdf://resource/'.length);
  try {
    const bytes = ShibeiService.instance.getPdfBytes(id);
    if (bytes.byteLength === 0) {
      hilog.warn(0x0000, 'shibei', 'intercept empty bytes for %{public}s', id);
      return null;
    }
    const resp = new WebResourceResponse();
    resp.setResponseMimeType('application/pdf');
    resp.setResponseCode(200);
    resp.setResponseData(bytes.buffer);
    return resp;
  } catch (err) {
    hilog.error(0x0000, 'shibei', 'intercept fail %{public}s: %{public}s',
      id, (err as Error).message);
    return null;
  }
}
```

- [ ] **Step 6: Factor out `TopBar()` and `SelectionPalette()` builders**

The existing HtmlContent has these inline. Extract so PdfContent doesn't duplicate. Purely mechanical refactor.

- [ ] **Step 7: Sanity check**

```bash
cd /Users/work/workspace/Shibei
# ArkTS compiles in DevEco; no local CLI check. Run Step 8 on the device.
```

- [ ] **Step 8: Commit**

```bash
git add shibei-harmony/entry/src/main/ets/pages/Reader.ets
git commit -m "feat(harmony): Reader PdfContent branch + onInterceptRequest wiring + download/error UI"
```

---

## Task 9: Long-press menu + AnnotationPanel integration sanity check

**Files:**
- No code changes expected. Verify that existing `AnnotationPanel` callbacks (from Phase 3a) still work when the resource is a PDF.

- [ ] **Step 1: Manually trace the paths**

Read `Reader.ets` and confirm:

- `onTapHighlight: (id) => this.flashHighlight(id)` — calls `window.__shibei.flashHighlight(id)` via `runJavaScript`. In PDF shell this exists and does `scrollIntoView + .flash` class. ✓
- `onChangeHighlightColor: (id, color) => this.changeHighlightColor(id, color)` — calls `updateHighlightColor` NAPI, service notifies, `paintHighlights(bundle.highlights)` runs. In PDF shell `paintHighlights` re-draws the rects with updated CSS var. ✓
- `onDeleteHighlight: (id) => this.deleteHighlight(id)` — calls `deleteHighlight` NAPI + `window.__shibei.removeHighlight(id)`. In PDF shell `removeHighlight` finds `[data-shibei-id=id]` and removes. ✓
- `onAddHighlightComment: (hlId) => { ... commentDialogHighlightId = hlId; open sheet }` — no doc-type branching; just opens the existing sheet. ✓
- `onCopyHighlightLink: (id) => this.copyHighlightLink(id)` — writes `shibei://open/resource/{rId}?highlight={hId}` to pasteboard. Doc-type agnostic. ✓

- [ ] **Step 2: Commit (no code; skip if nothing to commit)**

If the trace uncovered a miss, add a targeted patch + commit. Otherwise skip.

---

## Task 10: Cross-device smoke — P1–P11 from the design doc

**Files:**
- Modify: `scripts/smoke-sync-diff.sh` (optional — add `resource_type` column)

- [ ] **Step 1: Confirm build + deploy**

```bash
cd /Users/work/workspace/Shibei
scripts/build-harmony-napi.sh
```

Then remote-deploy in DevEco on `inming@192.168.64.1`.

- [ ] **Step 2: Save a smoke baseline**

```bash
scripts/smoke-sync-diff.sh --save-baseline
```

- [ ] **Step 3: Run the P1–P11 script**

Drive each scenario from the design doc §4.2. After each scenario, run:

```bash
scripts/smoke-sync-diff.sh --delta "Pn post"
```

Record pass/fail in a running log. For P3/P5/P6, dump the affected highlight row after the scenario:

```bash
ssh inming@192.168.64.1 '/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc file recv /data/app/el2/100/base/com.shibei.harmony.phase0/haps/entry/files/shibei.db /tmp/shibei-mobile.db'
ssh inming@192.168.64.1 'sqlite3 /tmp/shibei-mobile.db "SELECT id, substr(hlc,1,13), json_extract(anchor,\"$.type\") AS ak, color FROM highlights WHERE deleted_at IS NULL ORDER BY hlc DESC LIMIT 5"'
```

- [ ] **Step 4: Optionally extend smoke-sync-diff.sh**

If you want to see `resource_type` in the main snapshot table, add a column joining off `resources.resource_type`. Keep the edit small — only where it aids triage.

- [ ] **Step 5: If everything passes, commit smoke-script tweaks (if any)**

```bash
git add scripts/smoke-sync-diff.sh   # only if modified
git commit -m "chore(harmony): smoke-sync-diff shows resource_type for PDF triage"
```

If any scenario fails, STOP the plan and report to user with delta output + hilog excerpt. Fix root cause as a separate task, then re-run smoke.

---

## Task 11: Docs + memory updates

**Files:**
- Modify: `CLAUDE.md` (add Phase 3b bullet under 架构约束)
- Modify: `/Users/work/.claude/projects/-Users-work-workspace-Shibei/memory/feedback_arkweb_reader.md` (append PDF notes)
- Modify: `/Users/work/.claude/projects/-Users-work-workspace-Shibei/memory/MEMORY.md` (index entry already covers ArkWeb reader; extend hook if helpful)

- [ ] **Step 1: Add a CLAUDE.md entry for the PDF reader**

Under the `鸿蒙 Reader (Phase 3a)` bullet, add:

> **鸿蒙 PDF Reader (Phase 3b)**：`Reader.ets` 按 `resource_type='pdf'` 分支到 `PdfContent()`；ArkWeb 加载 `$rawfile('pdf-shell/shell.html?id=<id>')`，pdfjs-dist v4 classic bundles + fake-worker（`pdfjsWorker.WorkerMessageHandler` 挂全局、`workerSrc = 'about:blank'`）。PDF 字节走自定义 scheme `shibei-pdf://resource/{id}` + `onInterceptRequest` 从 NAPI `get_pdf_bytes` 喂入；本地缺失时 `ensure_pdf_downloaded` 调 `shibei-sync` 的 `download_snapshot`。文本层由 `pdf-annotator-mobile.js` 用 `streamTextContent()` 绘制，anchor 格式复用桌面 `{type:"pdf", page, charIndex, length, textQuote}`。固定 fit-to-width，无缩放；扫描版 PDF 无文字层时只能资料级笔记。**已知兼容**：ArkWeb Chromium 缺 ES2024 `Uint8Array.toHex`，必须在 pdfjs 加载前 polyfill。

- [ ] **Step 2: Update the ArkWeb-reader memory**

Append to `memory/feedback_arkweb_reader.md`:

```markdown
## PDF extension (Phase 3b)

- PDF bytes via custom scheme `shibei-pdf://resource/{id}` + `onInterceptRequest`; NAPI `get_pdf_bytes` returns raw Vec<u8>. ensure_pdf_downloaded uses the existing shibei-sync download_snapshot path.
- pdfjs v4 classic bundles live at `entry/src/main/resources/rawfile/pdf-shell/pdf-bundle.js` + `pdf-worker-bundle.js`; no npm runtime dependency.
- ArkWeb Chromium lacks ES2024 `Uint8Array.toHex`/`fromHex` — MUST polyfill before loading pdfjs (see `shell.html` top script block).
- Worker path: set `window.pdfjsWorker.WorkerMessageHandler` globally (done by `pdf-worker-bundle.js`) then `pdfjs.GlobalWorkerOptions.workerSrc = 'about:blank'`. DO NOT try to load worker as a separate file — ArkWeb blocks `import(workerSrc)` from file://.
- Anchor format frozen at `{type:"pdf", page, charIndex, length, textQuote:{exact, prefix, suffix}}` — matches desktop byte-for-byte for LWW interop.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md /Users/work/.claude/projects/-Users-work-workspace-Shibei/memory/feedback_arkweb_reader.md
git commit -m "docs(harmony): phase 3b PDF reader notes in CLAUDE.md and memory"
```

---

## Final acceptance

- `cargo check -p shibei-core` + `cargo clippy -- -D warnings` clean
- P1–P11 all pass (see Task 10)
- `smoke-sync-diff.sh --delta` after any PDF write shows identical HLC on both sides
- A color-swatch tap on a PDF highlight repaints in-page AND the right-drawer card instantly (same fix pattern as 3a polish — ForEach key + annotator repaint)
- Branch `main` clean, all commits pushed as a cohesive set

If any acceptance item fails, fix as a follow-up commit under the same
plan; do NOT open Phase 3c until all of 3b is green.
