// Visual web-capture page. Opened from share intent or AddByUrlDialog.
//
// Design: 2026-04-28-harmony-web-capture-design.md §4.
//
// Why "visible WebView, not headless":
//   1. Lazy-loaded images only render after the user (or our auto-scroll
//      helper) has scrolled past them. SingleFile's getPageData captures
//      DOM in its CURRENT state — invisible-to-the-eye lazy slots stay
//      blank if we don't render them first.
//   2. Login walls: the user can sign in directly inside this WebView,
//      ArkWeb persists cookies for the app, and subsequent captures of
//      the same domain skip the login page automatically.
//   3. SPAs need user navigation to reach the canonical URL/state worth
//      saving — desktop's Chrome extension flow assumes the user is
//      already on the right page; we mirror that here.
//
// Key steady-state behavior: Web fully loaded → ArkTS pre-injects the
// SingleFile bundle (one-time per page) → "保存" tap calls SingleFile's
// getPageData → snapshot bytes flow back through the registered JS
// proxy → NAPI saveHtmlSnapshot writes file + DB row + sync_log. PDF
// branch is symmetric but bypasses SingleFile (downloads bytes via
// http.createHttp, carrying WebView cookies for login-walled PDFs).

import { webview } from '@kit.ArkWeb';
import { router, promptAction } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { util } from '@kit.ArkTS';
import { http } from '@kit.NetworkKit';
import { ShibeiService, ShibeiError, Folder } from '../services/ShibeiService';
import { I18n } from '../services/I18n';
import { INBOX_FOLDER_ID } from '../components/FolderDrawer';

interface CaptureParams { url?: string; folderId?: string; }

type CaptureState =
  | 'loading'        // Web loading or before onPageEnd
  | 'ready'          // Page rendered, save enabled
  | 'scrolling'      // Auto-scroll-to-bottom helper running
  | 'saving'         // SingleFile or PDF download in flight
  | 'saved'          // Brief end state showing toast + Back-after-anim
  | 'error_load'     // onErrorReceive fired
  | 'error_save';    // SingleFile threw or NAPI returned error

// Bridge proxy injected as `window.shibeiBridge`. Receives one of:
//   - 'snapshot-meta'  JSON{title,url,total} — start of a chunked snapshot
//   - 'snapshot-chunk' base64 fragment of UTF-8 HTML
//   - 'snapshot-done'  '' — all chunks delivered, assemble + fire onSnapshot
//   - 'snapshot-error' string — SingleFile failure ("singlefile_not_ready"
//     or the original error message)
//   - 'autoscroll-done' '' — auto-scroll loop completed
//
// Why chunked? ArkWeb's `registerJavaScriptProxy` truncates each method
// argument at ~4 KB on the JS→ArkTS hop (verified empirically: WeChat
// articles serialised as a single `emit` arrive at exactly 4095 bytes,
// cutting off mid-script). We base64-encode the HTML on the page side
// and stream it across in 3 KB chunks; ArkTS reassembles + decodes.
//
// `emit` MUST be sync (registerJavaScriptProxy invariant). State updates
// happen via the handlers wired in CapturePage.aboutToAppear.
interface SnapshotPayload { html?: string; title?: string; url?: string; }
interface SnapshotMeta { title?: string; url?: string; total?: number; }
interface CaptureBridgeHandlers {
  onSnapshot: (payload: SnapshotPayload) => void;
  onSnapshotError: (msg: string) => void;
  onAutoScrollDone: () => void;
}
// Refuse pathologically chunked uploads. 80 MB / 3 KB ≈ 27_000 chunks, so
// 50 000 leaves headroom while bounding the memory cost of a malformed page.
const SNAPSHOT_CHUNK_LIMIT: number = 50000;

// JS body injected into the WebView to stream a snapshot back to ArkTS in
// 3 KB base64 chunks. Defines `__shibeiStreamSnapshot(html, title, url)`.
// `btoa(unescape(encodeURIComponent(s)))` is the canonical UTF-8 → base64
// recipe; ArkTS decodes back via util.Base64Helper + TextDecoder('utf-8').
//
// 3000 base64 chars ≈ 2.25 KB binary — comfortably under the ~4 KB ArkWeb
// proxy-arg cap (the cap appears to apply to the JS string length / UTF-8
// byte count after marshalling). Each chunk is plain ASCII so chunk.length
// === byte count post-marshal.
const SNAPSHOT_STREAM_JS: string = `
function __shibeiStreamSnapshot(html, title, url) {
  var b64 = btoa(unescape(encodeURIComponent(html)));
  var CHUNK = 3000;
  var total = Math.ceil(b64.length / CHUNK);
  if (total === 0) total = 1;  // empty page still emits a sentinel chunk
  window.shibeiBridge.emit('snapshot-meta', JSON.stringify({
    title: title || '',
    url: url || '',
    total: total,
  }));
  for (var i = 0; i < total; i++) {
    window.shibeiBridge.emit('snapshot-chunk', b64.substr(i * CHUNK, CHUNK));
  }
  window.shibeiBridge.emit('snapshot-done', '');
}
`;
class CaptureBridge {
  private handlers: CaptureBridgeHandlers;
  private metaTitle: string = '';
  private metaUrl: string = '';
  // Pre-sized to `expected` once the meta event arrives. Slots are
  // initialised to '' so the running-fill index check (truthy != '') stays
  // simple and ArkTS strict mode accepts the `string[]` type.
  private chunks: string[] = [];
  private expected: number = 0;
  private filled: number = 0;
  constructor(handlers: CaptureBridgeHandlers) { this.handlers = handlers; }
  emit(type: string, json: string): void {
    try {
      if (type === 'snapshot-meta') {
        const m = JSON.parse(json) as SnapshotMeta;
        const total = m.total ?? 0;
        if (total <= 0 || total > SNAPSHOT_CHUNK_LIMIT) {
          this.resetChunkState();
          this.handlers.onSnapshotError('snapshot_chunk_count_invalid');
          return;
        }
        this.metaTitle = m.title ?? '';
        this.metaUrl = m.url ?? '';
        this.expected = total;
        this.filled = 0;
        const buf: string[] = [];
        for (let i = 0; i < total; i++) buf.push('');
        this.chunks = buf;
      } else if (type === 'snapshot-chunk') {
        // Order-preserving: emit() is sync from the JS side, so chunks
        // arrive in the same order they were produced. We just append in
        // arrival order — no per-chunk index needed in the payload.
        if (this.expected === 0) return;  // chunk before meta — drop silently
        if (this.filled < this.chunks.length) {
          this.chunks[this.filled] = json;
          this.filled++;
        }
      } else if (type === 'snapshot-done') {
        if (this.expected === 0) {
          this.handlers.onSnapshotError('snapshot_no_chunks');
          return;
        }
        try {
          const b64 = this.chunks.join('');
          const bytes = new util.Base64Helper().decodeSync(b64);
          const html = new util.TextDecoder('utf-8', { ignoreBOM: true })
            .decodeWithStream(bytes);
          this.handlers.onSnapshot({
            html,
            title: this.metaTitle,
            url: this.metaUrl,
          });
        } catch (err) {
          this.handlers.onSnapshotError(`snapshot_decode_failed: ${(err as Error).message}`);
        }
        this.resetChunkState();
      } else if (type === 'snapshot-error') {
        this.resetChunkState();
        this.handlers.onSnapshotError(json);
      } else if (type === 'autoscroll-done') {
        this.handlers.onAutoScrollDone();
      } else {
        hilog.warn(0x0000, 'shibei', 'capture bridge unknown=%{public}s', type);
      }
    } catch (err) {
      hilog.warn(0x0000, 'shibei', 'capture bridge parse fail: %{public}s',
        (err as Error).message);
    }
  }
  private resetChunkState(): void {
    this.metaTitle = '';
    this.metaUrl = '';
    this.chunks = [];
    this.expected = 0;
    this.filled = 0;
  }
}

@Entry
@Component
struct CapturePage {
  @State url: string = '';
  @State title: string = '';
  @State host: string = '';
  @State progress: number = 0;
  @State state: CaptureState = 'loading';
  @State isPdf: boolean = false;
  @State error: string = '';
  @State folders: Folder[] = [];
  @State targetFolderId: string = INBOX_FOLDER_ID;
  // Whether SingleFile's bundle is already evaluated in the page context.
  // We pre-inject in onPageEnd so the save click doesn't pay the ~1.3 MB
  // load cost during the user-facing "正在保存..." overlay.
  private singleFileReady: boolean = false;
  // Cached SingleFile bundle text — read from rawfile once per page mount
  // and reused across reloads (refresh button) without hitting the FS again.
  private singleFileSrc: string = '';
  private webController: webview.WebviewController = new webview.WebviewController();
  private bridge: CaptureBridge = new CaptureBridge({
    onSnapshot: (p: SnapshotPayload) => this.handleSnapshot(p),
    onSnapshotError: (m: string) => this.handleSnapshotError(m),
    onAutoScrollDone: () => this.handleAutoScrollDone(),
  });

  aboutToAppear(): void {
    const raw = router.getParams();
    const params: CaptureParams = raw ? (raw as CaptureParams) : {};
    const u = (params.url ?? '').trim();
    if (!u) {
      this.error = 'error.missingUrl';
      this.state = 'error_load';
      return;
    }
    this.url = u;
    this.host = this.deriveHost(u);
    if (params.folderId) this.targetFolderId = params.folderId;
    try {
      this.folders = ShibeiService.instance.listFolders();
    } catch (err) {
      hilog.warn(0x0000, 'shibei', 'CapturePage listFolders fail: %{public}s',
        (err as Error).message);
      this.folders = [];
    }
    // Begin loading the SingleFile bundle in parallel with the WebView's
    // first paint. By the time the user has waited ~2s for the page to
    // render, the bundle string is in memory and pre-injection is cheap.
    this.loadSingleFileBundle();
  }

  private deriveHost(url: string): string {
    const m = url.match(/^[a-z]+:\/\/([^/?#]+)/i);
    return m ? m[1] : url;
  }

  private async loadSingleFileBundle(): Promise<void> {
    if (this.singleFileSrc.length > 0) return;
    try {
      const ctx = getContext(this) as common.UIAbilityContext;
      const bytes = await ctx.resourceManager.getRawFileContent('single-file-bundle.js');
      this.singleFileSrc = new util.TextDecoder('utf-8').decodeWithStream(bytes);
    } catch (err) {
      hilog.warn(0x0000, 'shibei', 'loadSingleFileBundle fail: %{public}s',
        (err as Error).message);
      // Save will fall through to a degraded outerHTML path; SingleFile
      // injection will simply no-op because singleFileReady stays false.
    }
  }

  // ── Web event handlers ──

  private onPageBegin(): void {
    this.state = 'loading';
    this.singleFileReady = false;
  }

  private async onPageEnd(): Promise<void> {
    this.state = 'ready';
    if (this.singleFileSrc.length === 0) {
      // Bundle not yet loaded from rawfile — try once more before giving
      // up. The async race is rare (slow FS on cold start).
      await this.loadSingleFileBundle();
    }
    if (this.singleFileSrc.length > 0) {
      try {
        await this.webController.runJavaScriptExt(this.singleFileSrc);
        await this.webController.runJavaScript(`window.__shibeiSFReady=true;`);
        this.singleFileReady = true;
      } catch (err) {
        hilog.warn(0x0000, 'shibei', 'singlefile inject fail: %{public}s',
          (err as Error).message);
        this.singleFileReady = false;
      }
    }
  }

  private onProgressChange(p: number): void {
    this.progress = p;
  }

  // ── Top bar ──

  @Builder TopBar() {
    Column() {
      Row() {
        Text('‹')
          .fontSize(28)
          .fontColor($r('app.color.text_primary'))
          .width(44)
          .height(44)
          .textAlign(TextAlign.Center)
          .onClick(() => this.handleBack());

        Column() {
          Text(this.host || this.url)
            .fontSize(14)
            .fontColor($r('app.color.text_primary'))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis });
          if (this.title) {
            Text(this.title)
              .fontSize(11)
              .fontColor($r('app.color.text_secondary'))
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis });
          }
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
        .padding({ left: 4, right: 4 });

        Text('↻')
          .fontSize(20)
          .fontColor($r('app.color.text_primary'))
          .width(44)
          .height(44)
          .textAlign(TextAlign.Center)
          .onClick(() => this.refreshPage());
      }
      .width('100%')
      .height(44)
      .backgroundColor($r('app.color.bg_primary'));

      // Progress bar — shrinks to height 0 when idle so the chrome stays
      // tight, but keeps the layout stable to avoid jumping content.
      if (this.state === 'loading' && this.progress < 100) {
        Progress({ value: this.progress, total: 100, type: ProgressType.Linear })
          .width('100%')
          .height(2)
          .color($r('app.color.accent_primary'));
      } else {
        Divider().strokeWidth(0.5).color($r('app.color.border_divider'));
      }
    }
    .width('100%');
  }

  // ── Bottom bar ──

  @Builder BottomBar() {
    Column() {
      Divider().strokeWidth(0.5).color($r('app.color.border_divider'));
      Row() {
        // Folder picker (compact). Tapping opens a list dialog. Default
        // is 收件箱; we look up the display name from the loaded folder
        // list each render to stay in sync with rename events.
        Row() {
          Text('📁').fontSize(14).margin({ right: 4 });
          Text(this.folderLabel())
            .fontSize(13)
            .fontColor($r('app.color.text_primary'))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis });
          Text(' ▾').fontSize(11).fontColor($r('app.color.text_secondary'));
        }
        .padding({ top: 8, bottom: 8, left: 10, right: 10 })
        .backgroundColor($r('app.color.bg_secondary'))
        .borderRadius(8)
        .onClick(() => this.pickFolder());

        // Auto-scroll helper — disabled in PDF mode because PDFs aren't
        // DOM-scrolled the same way. SingleFile's only useful on HTML.
        if (!this.isPdf) {
          Text(this.state === 'scrolling'
            ? I18n.t($r('app.string.capture_scrolling'))
            : I18n.t($r('app.string.capture_scroll_to_bottom')))
            .fontSize(13)
            .fontColor(this.state === 'scrolling'
              ? $r('app.color.text_disabled')
              : $r('app.color.accent_primary_alt'))
            .padding({ left: 10, right: 10 })
            .margin({ left: 10 })
            .onClick(() => {
              if (this.state === 'ready') this.runAutoScroll();
            });
        }

        Blank().layoutWeight(1);

        Button(this.saveButtonLabel())
          .fontSize(14)
          .backgroundColor(this.canSave()
            ? $r('app.color.accent_primary')
            : $r('app.color.text_disabled'))
          .fontColor(Color.White)
          .height(36)
          .padding({ left: 16, right: 16 })
          .enabled(this.canSave())
          .onClick(() => this.handleSave());
      }
      .width('100%')
      .padding({ top: 8, bottom: 8, left: 12, right: 12 })
      .backgroundColor($r('app.color.bg_primary'))
      .alignItems(VerticalAlign.Center);
    }
    .width('100%');
  }

  private folderLabel(): string {
    if (this.targetFolderId === INBOX_FOLDER_ID) {
      return I18n.t($r('app.string.sidebar_inbox'));
    }
    const f = this.folders.find((x: Folder) => x.id === this.targetFolderId);
    return f ? f.name : I18n.t($r('app.string.sidebar_inbox'));
  }

  private saveButtonLabel(): string {
    if (this.state === 'saving') return I18n.t($r('app.string.capture_saving'));
    if (this.isPdf) return I18n.t($r('app.string.capture_save_pdf'));
    return I18n.t($r('app.string.capture_save'));
  }

  private canSave(): boolean {
    return this.state === 'ready' || this.state === 'error_save';
  }

  private pickFolder(): void {
    interface PickButton { text: string; color: ResourceStr; }
    interface PickRow { id: string; name: string; }
    const rows: PickRow[] = [{ id: INBOX_FOLDER_ID, name: I18n.t($r('app.string.sidebar_inbox')) }];
    for (const f of this.folders) {
      if (f.id === INBOX_FOLDER_ID) continue;
      rows.push({ id: f.id, name: f.name });
    }
    const buttons: PickButton[] = rows.map((r): PickButton => ({
      text: r.name,
      color: $r('app.color.accent_primary'),
    }));
    buttons.push({
      text: I18n.t($r('app.string.common_cancel')),
      color: $r('app.color.text_secondary'),
    });
    promptAction.showDialog({
      title: I18n.t($r('app.string.capture_target_folder')),
      buttons,
    }).then((res) => {
      if (res.index >= 0 && res.index < rows.length) {
        this.targetFolderId = rows[res.index].id;
      }
    }).catch((err: Error) => {
      hilog.warn(0x0000, 'shibei', 'folder picker dismissed: %{public}s', err.message);
    });
  }

  // ── Auto-scroll ──

  private runAutoScroll(): void {
    this.state = 'scrolling';
    const js = `(function () {
  var step = Math.floor(window.innerHeight * 0.8);
  var lastY = -1, stable = 0;
  var tick = setInterval(function () {
    if (window.scrollY === lastY) {
      stable++;
      if (stable >= 3) {
        clearInterval(tick);
        if (window.shibeiBridge) {
          window.shibeiBridge.emit('autoscroll-done', '');
        }
      }
    } else {
      stable = 0;
      lastY = window.scrollY;
    }
    window.scrollBy(0, step);
  }, 300);
})();`;
    this.webController.runJavaScript(js).catch((err: Error) => {
      hilog.warn(0x0000, 'shibei', 'autoscroll inject fail: %{public}s', err.message);
      this.state = 'ready';
    });
  }

  private handleAutoScrollDone(): void {
    if (this.state === 'scrolling') this.state = 'ready';
  }

  private refreshPage(): void {
    try {
      this.webController.refresh();
      this.singleFileReady = false;
    } catch (err) {
      hilog.warn(0x0000, 'shibei', 'refresh fail: %{public}s', (err as Error).message);
    }
  }

  // ── Save flow (HTML branch) ──

  private handleSave(): void {
    if (!this.canSave()) return;
    if (this.isPdf) {
      this.savePdf();
    } else {
      this.saveHtml();
    }
  }

  private async saveHtml(): Promise<void> {
    this.state = 'saving';
    this.error = '';
    if (!this.singleFileReady) {
      // Bundle never loaded — degrade to outerHTML. Stream via the same
      // chunked protocol so a heavy WeChat page doesn't get clipped at
      // the 4 KB proxy-arg limit.
      const fallback = `(function(){
        try {
          ${SNAPSHOT_STREAM_JS}
          __shibeiStreamSnapshot(
            document.documentElement.outerHTML,
            document.title || '',
            location.href
          );
        } catch (e) {
          window.shibeiBridge.emit('snapshot-error', String(e && e.message || e));
        }
      })();`;
      this.webController.runJavaScript(fallback).catch((err: Error) => {
        this.handleSnapshotError(err.message);
      });
      return;
    }
    const js = `(async function(){
  if (!window.__shibeiSFReady || typeof SingleFile === 'undefined') {
    window.shibeiBridge.emit('snapshot-error', 'singlefile_not_ready');
    return;
  }
  try {
    var d = await SingleFile.getPageData({
      removeScripts: true,
      compressHTML: true,
      removeHiddenElements: false,
    });
    ${SNAPSHOT_STREAM_JS}
    __shibeiStreamSnapshot(d.content, d.title || document.title || '', location.href);
  } catch (err) {
    window.shibeiBridge.emit('snapshot-error', String(err && err.message || err));
  }
})();`;
    this.webController.runJavaScript(js).catch((err: Error) => {
      this.handleSnapshotError(err.message);
    });
  }

  private handleSnapshot(payload: SnapshotPayload): void {
    if (this.state !== 'saving') return;  // ignore late events
    const html = payload.html ?? '';
    if (!html) {
      this.handleSnapshotError('empty_snapshot');
      return;
    }
    const title = payload.title ?? this.title;
    const url = payload.url ?? this.url;
    try {
      ShibeiService.instance.saveHtmlSnapshot(url, title, html, this.targetFolderId);
      this.afterSaveSuccess();
    } catch (err) {
      const code = err instanceof ShibeiError ? err.code : (err as Error).message;
      this.error = code;
      this.state = 'error_save';
      promptAction.showToast({
        message: I18n.t($r('app.string.capture_save_failed'), I18n.translateError(code)),
      });
    }
  }

  private handleSnapshotError(msg: string): void {
    this.error = msg;
    this.state = 'error_save';
    promptAction.showToast({
      message: I18n.t($r('app.string.capture_singlefile_failed')),
    });
  }

  // ── Save flow (PDF branch) ──
  //
  // ArkTS-side download because pdfjs is overkill here and we already need
  // raw bytes for `save_pdf_snapshot`. Cookie passthrough lets us pull
  // login-walled PDFs (e.g. paywalled journal article URLs the user has
  // already authenticated against in this WebView session).

  private async savePdf(): Promise<void> {
    this.state = 'saving';
    this.error = '';
    let cookie = '';
    try {
      cookie = webview.WebCookieManager.getCookie(this.url) || '';
    } catch (err) {
      hilog.debug(0x0000, 'shibei', 'cookie fetch fail: %{public}s', (err as Error).message);
    }
    interface PdfHeader { Cookie?: string; }
    const httpReq = http.createHttp();
    try {
      const resp = await httpReq.request(this.url, {
        method: http.RequestMethod.GET,
        header: cookie ? ({ 'Cookie': cookie } as PdfHeader) : ({} as PdfHeader),
        expectDataType: http.HttpDataType.ARRAY_BUFFER,
        connectTimeout: 30000,
        readTimeout: 60000,
      });
      if (resp.responseCode < 200 || resp.responseCode >= 300) {
        throw new Error(`http_${resp.responseCode}`);
      }
      const buf = resp.result as ArrayBuffer;
      const bytes = new Uint8Array(buf);
      const b64 = new util.Base64Helper().encodeToStringSync(bytes);
      ShibeiService.instance.savePdfSnapshot(this.url, this.title || this.host, b64,
        this.targetFolderId);
      this.afterSaveSuccess();
    } catch (err) {
      const code = err instanceof ShibeiError ? err.code : (err as Error).message;
      this.error = code;
      this.state = 'error_save';
      promptAction.showToast({
        message: I18n.t($r('app.string.capture_save_failed'), I18n.translateError(code)),
      });
    } finally {
      httpReq.destroy();
    }
  }

  private afterSaveSuccess(): void {
    this.state = 'saved';
    promptAction.showToast({
      message: I18n.t($r('app.string.capture_saved'), this.folderLabel()),
    });
    // Brief delay so the toast animates in before navigation tears the
    // page down. Without this, on fast devices the user only sees a
    // flicker.
    setTimeout(() => {
      router.back();
    }, 300);
  }

  // ── Back / cancel ──

  private handleBack(): void {
    if (this.state === 'saving' || this.state === 'scrolling') {
      promptAction.showDialog({
        title: I18n.t($r('app.string.capture_abandon_confirm')),
        buttons: [
          { text: I18n.t($r('app.string.common_cancel')), color: $r('app.color.text_secondary') },
          { text: I18n.t($r('app.string.common_confirm')), color: $r('app.color.accent_danger') },
        ],
      }).then((res) => {
        if (res.index === 1) router.back();
      }).catch((err: Error) => {
        hilog.warn(0x0000, 'shibei', 'abandon dialog dismissed: %{public}s', err.message);
      });
      return;
    }
    router.back();
  }

  // ── Build ──

  build() {
    Column() {
      this.TopBar();
      Stack() {
        Web({ src: this.url, controller: this.webController })
          .domStorageAccess(true)
          .databaseAccess(true)
          .javaScriptAccess(true)
          .geolocationAccess(false)
          .darkMode(WebDarkMode.Auto)
          .zoomAccess(true)
          .onControllerAttached(() => {
            this.webController.registerJavaScriptProxy(
              this.bridge, 'shibeiBridge', ['emit'],
            );
          })
          .onPageBegin(() => this.onPageBegin())
          .onPageEnd(() => { this.onPageEnd(); })
          .onTitleReceive((event) => {
            this.title = event.title || '';
          })
          .onProgressChange((event) => this.onProgressChange(event.newProgress))
          .onErrorReceive((event) => {
            const err = event.error;
            hilog.warn(0x0000, 'shibei', 'CapturePage onError: %{public}s',
              err.getErrorInfo ? err.getErrorInfo() : '');
            this.state = 'error_load';
            this.error = 'error.loadFailed';
          })
          .onResourceLoad((event) => {
            // We use the URL extension as a coarse PDF heuristic since
            // ArkWeb's onHttpAuthRequest/onResourceLoad don't expose
            // response headers in the public API. The CapturePage user
            // confirms via the changed button label before saving.
            const u = event.url || '';
            if (!this.isPdf && /\.pdf(\?|#|$)/i.test(u) && u === this.url) {
              this.isPdf = true;
              promptAction.showToast({
                message: I18n.t($r('app.string.capture_pdf_detected')),
              });
            }
          })
          .width('100%').height('100%');

        if (this.state === 'saving') {
          Column() {
            Text(I18n.t($r('app.string.capture_saving')))
              .fontColor(Color.White)
              .fontSize(15);
          }
          .width('100%').height('100%')
          .justifyContent(FlexAlign.Center)
          .backgroundColor('rgba(0,0,0,0.45)');
        }

        if (this.state === 'error_load') {
          Column() {
            Text(I18n.t($r('app.string.capture_load_failed')))
              .fontColor($r('app.color.text_primary'))
              .fontSize(15);
            Button(I18n.t($r('app.string.capture_retry')))
              .margin({ top: 12 })
              .onClick(() => this.refreshPage());
          }
          .width('100%').height('100%')
          .justifyContent(FlexAlign.Center)
          .backgroundColor($r('app.color.bg_primary'));
        }
      }
      .layoutWeight(1).width('100%');

      this.BottomBar();
    }
    .width('100%').height('100%')
    .backgroundColor($r('app.color.bg_primary'));
  }
}
