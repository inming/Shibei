import { webview } from '@kit.ArkWeb';
import { router } from '@kit.ArkUI';
import { promptAction } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { pasteboard } from '@kit.BasicServicesKit';
import { ShibeiService, Resource, Comment } from '../services/ShibeiService';
import { AnnotationsService } from '../services/AnnotationsService';
import {
  AnnotationBridge,
  SelectionPayload,
  ClickPayload,
  ReadyPayload,
  ZoomPayload,
} from '../components/AnnotationBridge';
import { AnnotationPanel } from '../components/AnnotationPanel';
import { AnnotationsBundle } from '../services/ShibeiService';
import { I18n } from '../services/I18n';
import { getReaderScroll, saveReaderScroll } from '../app/ReaderScrollState';
import {
  getReaderZoom,
  saveReaderZoom,
  clampZoom,
  PDF_ZOOM_MIN,
  PDF_ZOOM_MAX,
  PDF_ZOOM_DEFAULT,
  PDF_ZOOM_STEP,
} from '../app/ReaderZoomState';

// Route param shape.
interface ReaderParams { resourceId?: string; }

// Palette shown in the selection action bar. Order left→right matches
// the desktop picker. Yellow is the first tap position since it's the
// historical default.
//
// `value` is the CSS color used both as paint and as data key for
// createHighlight — it MUST NOT change without coordinating with desktop
// annotation storage. The palette only renders colored circles, so no
// label field is needed; if a future tooltip/a11y pass needs one,
// look up reader_hl_color_{yellow,green,blue,pink} via I18n.t.
interface HlColor { value: string; }
const HL_COLORS: HlColor[] = [
  { value: '#ffeb3b' },
  { value: '#81c784' },
  { value: '#64b5f6' },
  { value: '#f48fb1' },
];

// Header row shape for WebResourceResponse.setResponseHeader. ArkTS strict
// mode rejects inline object-literal types, so we pin the shape here.
interface WebHeader { headerKey: string; headerValue: string; }

@Entry
@Component
struct Reader {
  @State resource: Resource | null = null;
  @State html: string = '';
  @State loading: boolean = true;
  @State loadError: string = '';
  @State bundle: AnnotationsBundle = { highlights: [], comments: [] };
  @State panelOpen: boolean = false;
  @State pendingSelection: SelectionPayload | null = null;
  @State commentDialogOpen: boolean = false;
  @State commentDialogId: string | null = null;  // null = new resource-level note
  // Set when "+ 评论" is tapped on a highlight card — attaches the new
  // comment to that highlight. null means a free-standing resource note.
  @State commentDialogHighlightId: string | null = null;
  @State commentDialogDraft: string = '';
  // PDF branch state (Phase 3b). pdfDownloading covers the
  // ensurePdfDownloaded RPC to S3; pdfReady flips true once the bytes are
  // confirmed on disk and the shell can load. pdfError holds an i18n-style
  // code for the retry panel.
  @State pdfReady: boolean = false;
  @State pdfDownloading: boolean = false;
  @State pdfError: string = '';
  // PDF zoom is the shell's zoomFactor, initialized from prefs inside
  // ensurePdfReady so the Web src (built in PdfContent) already carries
  // ?zoom=X on first render — avoids an initial 1.0 rebuild.
  @State pdfZoom: number = PDF_ZOOM_DEFAULT;
  // Debounce persistence of zoom changes — a rapid tap on +/- shouldn't
  // flush preferences N times. Same 500ms cadence as scroll save.
  private zoomSaveTimer: number = -1;

  private webController: webview.WebviewController = new webview.WebviewController();
  private bridge: AnnotationBridge = new AnnotationBridge({
    onSelection: (p: SelectionPayload) => this.handleSelection(p),
    onClick: (p: ClickPayload) => this.handleClick(p),
    onReady: (p: ReadyPayload) => this.handleReady(p),
    onZoom: (p: ZoomPayload) => this.handleZoom(p),
  });
  private unsubscribe: (() => void) | null = null;
  // Debounce scroll persistence — onScroll fires continuously during a
  // flick and we don't want to hammer preferences.
  private scrollSaveTimer: number = -1;
  private lastScrollY: number = 0;
  private restoredScroll: boolean = false;

  aboutToAppear(): void {
    const raw = router.getParams();
    const params: ReaderParams = raw ? (raw as ReaderParams) : {};
    const id = params.resourceId ?? '';
    if (!id) {
      this.loadError = 'error.missingResourceId';
      this.loading = false;
      return;
    }
    try {
      this.resource = ShibeiService.instance.getResource(id);
      if (!this.resource) {
        this.loadError = 'error.resourceNotFound';
        this.loading = false;
        return;
      }
      // Branch HTML vs PDF. PDFs skip the synchronous getResourceHtml
      // (no HTML snapshot on disk) and instead kick off ensurePdfReady
      // which may download snapshot.pdf via S3 sync. The Reader shell is
      // shown immediately; the inner Stack drives the download/error/ready
      // state.
      //
      // HTML gets the same treatment (§7.2): Phase 5.1's sync engine no
      // longer pulls snapshots eagerly, so first read may need to fetch
      // from S3. Keep the `loading` flag up during download — annotator
      // load + paint waits on it.
      if (this.resource.resource_type === 'pdf') {
        this.loading = false;
        this.ensurePdfReady(id);
      } else {
        this.ensureHtmlReady(id);
      }
    } catch (err) {
      this.loadError = (err as Error).message;
      this.loading = false;
      hilog.error(0x0000, 'shibei', 'Reader init fail: %{public}s', this.loadError);
      return;
    }
    // Load cached annotations; fire-and-forget refresh.
    AnnotationsService.instance.load(id).then((b: AnnotationsBundle) => {
      this.bundle = b;
      this.paintHighlights();
    }).catch((err: Error) => {
      hilog.warn(0x0000, 'shibei', 'annotations load fail: %{public}s', err.message);
    });
    this.unsubscribe = AnnotationsService.instance.subscribe(id, (b: AnnotationsBundle) => {
      this.bundle = b;
      this.paintHighlights();
    });
  }

  aboutToDisappear(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
    }
    this.unsubscribe = null;
    // Flush any pending scroll save so we don't lose the last 500ms.
    if (this.scrollSaveTimer !== -1) {
      clearTimeout(this.scrollSaveTimer);
      this.scrollSaveTimer = -1;
      this.flushScroll();
    }
    if (this.zoomSaveTimer !== -1) {
      clearTimeout(this.zoomSaveTimer);
      this.zoomSaveTimer = -1;
      this.flushZoom();
    }
  }

  private flushScroll(): void {
    if (!this.resource) return;
    const ctx = getContext(this) as common.UIAbilityContext;
    saveReaderScroll(ctx, this.resource.id, this.lastScrollY).catch(() => {});
  }

  private scheduleScrollSave(): void {
    if (this.scrollSaveTimer !== -1) clearTimeout(this.scrollSaveTimer);
    this.scrollSaveTimer = setTimeout(() => {
      this.scrollSaveTimer = -1;
      this.flushScroll();
    }, 500);
  }

  private flushZoom(): void {
    if (!this.resource) return;
    const ctx = getContext(this) as common.UIAbilityContext;
    saveReaderZoom(ctx, this.resource.id, this.pdfZoom).catch(() => {});
  }

  private scheduleZoomSave(): void {
    if (this.zoomSaveTimer !== -1) clearTimeout(this.zoomSaveTimer);
    this.zoomSaveTimer = setTimeout(() => {
      this.zoomSaveTimer = -1;
      this.flushZoom();
    }, 500);
  }

  // Drive the shell's zoomFactor from ArkTS. Clamp here so the Web side
  // never sees an out-of-range value; the shell also clamps defensively.
  private applyPdfZoom(next: number): void {
    const z = clampZoom(next);
    if (Math.abs(z - this.pdfZoom) < 0.001) return;
    this.pdfZoom = z;
    this.webController.runJavaScript(
      `window.__shibeiReader && window.__shibeiReader.setZoom(${z});`
    ).catch((err: Error) => {
      hilog.warn(0x0000, 'shibei', 'setZoom fail: %{public}s', err.message);
    });
    this.scheduleZoomSave();
  }

  private async restoreScrollIfNeeded(): Promise<void> {
    if (this.restoredScroll || !this.resource) return;
    this.restoredScroll = true;
    try {
      const ctx = getContext(this) as common.UIAbilityContext;
      const y = await getReaderScroll(ctx, this.resource.id);
      if (y > 0) {
        // scrollTo in pixels; Web's own scroll offset accepts 0-based y.
        this.webController.scrollTo(0, y);
      }
    } catch (err) {
      hilog.warn(0x0000, 'shibei', 'restoreScroll fail: %{public}s',
        (err as Error).message);
    }
  }

  /// Ensure snapshot.html is on disk, pulling via sync if missing (§7.2),
  /// then pull the annotator-injected HTML string. Fast path when the file
  /// already exists. On failure we fall through to loadError so Reader
  /// shows the error card instead of a blank page.
  private async ensureHtmlReady(id: string): Promise<void> {
    try {
      await ShibeiService.instance.ensureHtmlDownloaded(id);
      this.html = ShibeiService.instance.getResourceHtml(id);
      this.loading = false;
    } catch (err) {
      this.loadError = (err as Error).message;
      this.loading = false;
      hilog.warn(0x0000, 'shibei', 'ensureHtmlReady fail %{public}s: %{public}s',
        id, this.loadError);
    }
  }

  /// Retry handler for the HTML error card. Clears error + resets
  /// loading flag so the Stack returns to the spinner branch, then
  /// re-runs ensureHtmlReady. No-op if resource failed to load at all
  /// (e.g. bad route params) — the retry button still shows but the
  /// subsequent attempt will re-raise the same error.
  private retryHtmlLoad(): void {
    if (!this.resource) return;
    this.loadError = '';
    this.loading = true;
    this.ensureHtmlReady(this.resource.id);
  }

  // Ensure the PDF is on local disk. Fast path (file exists) resolves
  // immediately; slow path pulls via shibei-sync's download_snapshot and
  // the UI sits on the "正在下载 PDF…" panel during the RPC. On any error
  // we surface the message into `pdfError` so the retry button appears.
  private async ensurePdfReady(id: string): Promise<void> {
    this.pdfError = '';
    this.pdfDownloading = true;
    try {
      // Load the saved zoom BEFORE flipping pdfReady — the Web src in
      // PdfContent embeds `?zoom=X` and is evaluated exactly once, so
      // the shell sees the final zoom on first pdfjs init and we skip
      // the would-be 1.0 → saved rebuild.
      const ctx = getContext(this) as common.UIAbilityContext;
      const savedZoom = await getReaderZoom(ctx, id);
      this.pdfZoom = clampZoom(savedZoom);
      await ShibeiService.instance.ensurePdfDownloaded(id);
      this.pdfReady = true;
      this.pdfDownloading = false;
    } catch (err) {
      this.pdfError = (err as Error).message;
      this.pdfDownloading = false;
      hilog.warn(0x0000, 'shibei', 'ensurePdfReady fail %{public}s: %{public}s',
        id, this.pdfError);
    }
  }

  private paintHighlights(): void {
    if (!this.resource) {
      return;
    }
    const json = JSON.stringify(this.bundle.highlights);
    // Escape single quotes and backslashes for safe interpolation into the JS string.
    const safe = json.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    this.webController.runJavaScript(`window.__shibei && window.__shibei.paintHighlights('${safe}');`)
      .catch((err: Error) => {
        hilog.warn(0x0000, 'shibei', 'paintHighlights fail: %{public}s', err.message);
      });
  }

  private handleSelection(p: SelectionPayload): void {
    if (p.collapsed || !p.textContent || !p.anchor) {
      this.pendingSelection = null;
      return;
    }
    this.pendingSelection = p;
  }

  private handleClick(p: ClickPayload): void {
    if (!p.highlightId) {
      return;
    }
    this.setPanelOpen(true);
  }

  /// Toggle AnnotationPanel inside animateTo so the SideBarContainer width
  /// and the scrim interpolate. 260ms / FastOutSlowIn matches the folder
  /// drawer on Library for visual parity.
  private setPanelOpen(open: boolean): void {
    animateTo({ duration: 260, curve: Curve.FastOutSlowIn }, () => {
      this.panelOpen = open;
    });
  }

  // Shell-driven zoom settle — fired after pinch gestures resolve OR after
  // our own applyPdfZoom → setZoom round-trip. In both cases we mirror the
  // value into @State so the toolbar percentage stays truthful, and debounce
  // a prefs save. The runJavaScript path is NOT invoked here (shell already
  // has the state); would cause a redundant rebuild.
  private handleZoom(p: ZoomPayload): void {
    if (typeof p.zoom !== 'number') return;
    const z = clampZoom(p.zoom);
    if (Math.abs(z - this.pdfZoom) < 0.001) return;
    this.pdfZoom = z;
    this.scheduleZoomSave();
  }

  private handleReady(_: ReadyPayload): void {
    this.paintHighlights();
    // Web reports DOMContentLoaded inside the iframe; safe to restore scroll now.
    // PDF shell also emits 'ready' via window.shibeiBridge once pdfjs has
    // finished the initial document parse, so this path covers both branches.
    this.restoreScrollIfNeeded();
  }

  private createHighlightWithColor(color: string): void {
    const sel = this.pendingSelection;
    if (!sel || !this.resource || !sel.textContent || !sel.anchor) {
      return;
    }
    try {
      AnnotationsService.instance.createHighlight(
        this.resource.id,
        sel.textContent,
        sel.anchor,
        color,
      );
      this.pendingSelection = null;
      this.webController.runJavaScript(`window.__shibei && window.__shibei.clearSelection();`)
        .catch(() => {});
    } catch (err) {
      promptAction.showToast({
        message: I18n.t($r('app.string.reader_create_failed'), (err as Error).message),
      });
    }
  }

  private flashHighlight(id: string): void {
    this.webController.runJavaScript(`window.__shibei && window.__shibei.flashHighlight('${id}');`)
      .catch(() => {});
  }

  private deleteHighlight(id: string): void {
    if (!this.resource) {
      return;
    }
    try {
      AnnotationsService.instance.deleteHighlight(this.resource.id, id);
      this.webController.runJavaScript(`window.__shibei && window.__shibei.removeHighlight('${id}');`)
        .catch(() => {});
    } catch (err) {
      promptAction.showToast({ message: (err as Error).message });
    }
  }

  private changeHighlightColor(id: string, color: string): void {
    if (!this.resource) return;
    try {
      AnnotationsService.instance.updateHighlightColor(this.resource.id, id, color);
      // Service notify → subscribe fires → paintHighlights runs. No extra
      // runJavaScript needed; the repaint redraws the span background.
    } catch (err) {
      promptAction.showToast({ message: (err as Error).message });
    }
  }

  private copyHighlightLink(id: string): void {
    if (!this.resource) return;
    const url = `shibei://open/resource/${this.resource.id}?highlight=${id}`;
    const data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, url);
    pasteboard.getSystemPasteboard().setData(data).then(() => {
      promptAction.showToast({
        message: I18n.t($r('app.string.common_copy_success')),
      });
    }).catch((err: Error) => {
      hilog.warn(0x0000, 'shibei', 'pasteboard setData fail: %{public}s', err.message);
      promptAction.showToast({
        message: I18n.t($r('app.string.common_copy_failed')),
      });
    });
  }

  // ArkWeb intercept for `shibei-pdf://resource/{id}`. pdfjs (inside the
  // shell) issues an XHR to that URL after shell.html loads; we answer
  // with the PDF bytes from NAPI. Returning null for any other URL lets
  // ArkWeb's default handler take the $rawfile loads of shell.html /
  // main.js / pdf-bundle.js / etc. through.
  //
  // The response MUST be HTTP-shaped (explicit status 200 + reason "OK" +
  // Content-Type / Content-Length / CORS headers) or pdfjs sees status 0
  // and reports "Unexpected server response (0)". The spike at 563368a
  // nailed this down — see its commit message for the full story.
  private handlePdfIntercept(event: OnInterceptRequestEvent): WebResourceResponse | null {
    const url = event.request.getRequestUrl();
    if (!url.startsWith('shibei-pdf://resource/')) {
      return null;
    }
    const id = url.slice('shibei-pdf://resource/'.length);
    try {
      const bytes = ShibeiService.instance.getPdfBytes(id);
      if (bytes.byteLength === 0) {
        hilog.warn(0x0000, 'shibei', 'intercept empty bytes for %{public}s', id);
        return null;
      }
      const resp = new WebResourceResponse();
      resp.setResponseMimeType('application/pdf');
      resp.setResponseEncoding('');
      resp.setResponseCode(200);
      resp.setReasonMessage('OK');
      const headers: WebHeader[] = [
        { headerKey: 'Content-Type', headerValue: 'application/pdf' },
        { headerKey: 'Content-Length', headerValue: String(bytes.byteLength) },
        { headerKey: 'Access-Control-Allow-Origin', headerValue: '*' },
        { headerKey: 'Cache-Control', headerValue: 'no-store' },
      ];
      resp.setResponseHeader(headers);
      resp.setResponseData(bytes.buffer);
      resp.setResponseIsReady(true);
      return resp;
    } catch (err) {
      hilog.error(0x0000, 'shibei', 'intercept fail %{public}s: %{public}s',
        id, (err as Error).message);
      return null;
    }
  }

  build() {
    Stack() {
      if (this.loading) {
        Column() {
          Text(I18n.t($r('app.string.common_loading')))
            .fontColor($r('sys.color.ohos_id_color_text_tertiary'));
        }.width('100%').height('100%').justifyContent(FlexAlign.Center);
      } else if (this.loadError) {
        Column() {
          Text(I18n.t($r('app.string.common_load_failed'), I18n.translateError(this.loadError)))
            .fontColor($r('sys.color.ohos_id_color_warning'));
          // Retry only makes sense for transient failures (network /
          // snapshot missing). Terminal ones like resourceNotFound still
          // show the button — a second try is cheap and harmless.
          Button(I18n.t($r('app.string.common_retry'))).margin({ top: 12 })
            .onClick(() => this.retryHtmlLoad());
        }.width('100%').height('100%').justifyContent(FlexAlign.Center);
      } else {
        SideBarContainer(SideBarContainerType.Overlay) {
          // SideBarContainer convention: FIRST child = side bar, SECOND = content.
          // We put AnnotationPanel first (drawer) and the top-bar+Web column second.
          AnnotationPanel({
            bundle: this.bundle,
            onTapHighlight: (id: string) => {
              // Auto-close the drawer on folded / overlay layouts — user
              // expects the tap to "jump" them to the passage, and keeping
              // the drawer open covers the page they just navigated to.
              this.setPanelOpen(false);
              this.flashHighlight(id);
            },
            onDeleteHighlight: (id: string) => this.deleteHighlight(id),
            onChangeHighlightColor: (id: string, color: string) =>
              this.changeHighlightColor(id, color),
            onCopyHighlightLink: (id: string) => this.copyHighlightLink(id),
            onAddHighlightComment: (hlId: string) => {
              this.commentDialogId = null;
              this.commentDialogHighlightId = hlId;
              this.commentDialogDraft = '';
              this.commentDialogOpen = true;
            },
            onAddResourceComment: () => {
              this.commentDialogId = null;
              this.commentDialogHighlightId = null;
              this.commentDialogDraft = '';
              this.commentDialogOpen = true;
            },
            onEditComment: (id: string) => {
              const c = this.bundle.comments.find((x: Comment) => x.id === id);
              if (!c) return;
              this.commentDialogId = id;
              this.commentDialogHighlightId = c.highlight_id;
              this.commentDialogDraft = c.content;
              this.commentDialogOpen = true;
            },
            onDeleteComment: (id: string) => {
              if (!this.resource) {
                return;
              }
              try {
                AnnotationsService.instance.deleteComment(this.resource.id, id);
              } catch (err) {
                promptAction.showToast({ message: (err as Error).message });
              }
            },
          });

          // Main content: branch between HTML and PDF. Both branches share
          // the TopBar + SelectionPalette builders; only the inner Web (or
          // download/error panel) differs.
          if (this.resource && this.resource.resource_type === 'pdf') {
            this.PdfContent();
          } else {
            this.HtmlContent();
          }
        }
        .showSideBar(this.panelOpen)
        .autoHide(true)
        .onChange((value: boolean) => {
          // Fired when SideBarContainer toggles visibility (including
          // tap-outside auto-dismiss on Overlay type). Keep panelOpen in sync
          // so the ☰ toggle state matches what's actually drawn.
          this.panelOpen = value;
        })
        .sideBarWidth(280)
        .minSideBarWidth(240)
        .maxSideBarWidth(360)
        .sideBarPosition(SideBarPosition.End)
        .showControlButton(false)
        .width('100%').height('100%');
      }
    }
    .width('100%').height('100%')
    .bindSheet($$this.commentDialogOpen, this.CommentSheet(), {
      // SheetType.BOTTOM forces the drawer-style sheet on wide layouts
      // (unfolded Mate X5 defaults to CENTER, looking like a modal window).
      // Detents let the user drag between medium (~half screen) and large.
      preferType: SheetType.BOTTOM,
      detents: [SheetSize.MEDIUM, SheetSize.LARGE],
      showClose: true,
      dragBar: true,
      title: {
        title: this.commentDialogId
          ? I18n.t($r('app.string.reader_note_edit'))
          : I18n.t($r('app.string.reader_note_new')),
      },
    });
  }

  // Top bar: back button + title + (PDF only) zoom toolbar + annotations drawer toggle.
  // Shared by both HTML and PDF branches; keep it thin and depend only on @State
  // fields already reactive to the bundle/resource.
  @Builder TopBar() {
    Row() {
      Text('←').fontSize(22)
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
        .width(44).height(44).textAlign(TextAlign.Center)
        .onClick(() => router.back());
      Text(this.resource ? this.resource.title : '')
        .fontSize(15).fontWeight(FontWeight.Medium).layoutWeight(1)
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
        .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis });
      // Zoom toolbar: only shown once the PDF shell is actually loaded.
      // Pre-ready (downloading / error) the buttons would be no-ops since
      // the webview hasn't registered __shibeiReader yet, and the visual
      // clutter would distract from the download status panel.
      if (this.resource && this.resource.resource_type === 'pdf' && this.pdfReady) {
        this.ZoomToolbar();
      }
      Text(`☰ ${this.bundle.highlights.length}`)
        .fontSize(14)
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
        .padding({ left: 8, right: 8 }).height(44)
        .onClick(() => { this.setPanelOpen(!this.panelOpen); });
    }
    .width('100%')
    .backgroundColor($r('sys.color.ohos_id_color_background'))
    .padding({ left: 4, right: 4 });
  }

  // PDF zoom controls: [−] [N%] [+]. Percentage tap resets to 1.0.
  // Buttons are 36x44 for comfortable thumb hit targets; the row itself
  // stays compact so it doesn't crowd the title at narrow widths.
  @Builder ZoomToolbar() {
    Row() {
      Text('−')
        .fontSize(20)
        .fontColor(this.pdfZoom <= PDF_ZOOM_MIN + 0.001
          ? $r('sys.color.ohos_id_color_text_tertiary')
          : $r('sys.color.ohos_id_color_text_primary'))
        .width(36).height(44).textAlign(TextAlign.Center)
        .onClick(() => {
          if (this.pdfZoom <= PDF_ZOOM_MIN + 0.001) return;
          this.applyPdfZoom(this.pdfZoom - PDF_ZOOM_STEP);
        });
      Text(`${Math.round(this.pdfZoom * 100)}%`)
        .fontSize(13)
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
        .width(44).height(44).textAlign(TextAlign.Center)
        .onClick(() => this.applyPdfZoom(PDF_ZOOM_DEFAULT));
      Text('+')
        .fontSize(20)
        .fontColor(this.pdfZoom >= PDF_ZOOM_MAX - 0.001
          ? $r('sys.color.ohos_id_color_text_tertiary')
          : $r('sys.color.ohos_id_color_text_primary'))
        .width(36).height(44).textAlign(TextAlign.Center)
        .onClick(() => {
          if (this.pdfZoom >= PDF_ZOOM_MAX - 0.001) return;
          this.applyPdfZoom(this.pdfZoom + PDF_ZOOM_STEP);
        });
    }
    .padding({ left: 4, right: 4 });
  }

  // Floating highlight-color palette. Shown only when the inner Web has
  // reported a non-collapsed selection. Identical in both HTML and PDF
  // branches — the color → createHighlight path is anchor-agnostic.
  @Builder SelectionPalette() {
    Row() {
      ForEach(HL_COLORS, (c: HlColor) => {
        Stack() {
          Text('')
            .width(32).height(32)
            .backgroundColor(c.value)
            .borderRadius(16)
            .border({ width: 2, color: $r('sys.color.ohos_id_color_background') });
        }
        .width(44).height(44)
        .margin({ left: 6, right: 6 })
        .onClick(() => this.createHighlightWithColor(c.value));
      }, (c: HlColor) => c.value);
    }
    .padding({ left: 12, right: 12, top: 8, bottom: 8 })
    .borderRadius(28)
    .backgroundColor($r('sys.color.ohos_id_color_background'))
    .shadow({ radius: 12, color: $r('app.color.shadow_default'), offsetY: 2 })
    .position({ x: 0, y: '85%' })
    .margin({ left: 16, right: 16 })
    .justifyContent(FlexAlign.Center);
  }

  // HTML branch: loadData() with the pre-injected annotator script.
  @Builder HtmlContent() {
    Column() {
      this.TopBar();

      // Web area
      Stack() {
        Web({ src: '', controller: this.webController })
          .domStorageAccess(true)
          .javaScriptAccess(true)
          // Let Chromium follow the system ColorMode for ArkUI media queries
          // (snapshot author's own styles still win). We leave
          // forceDarkAccess at its default (false) so Chromium's forced
          // dark-mode filter does NOT invert the saved page content —
          // mirrors desktop behavior where the iframe stays authentic and
          // only an optional invert filter is offered.
          .darkMode(WebDarkMode.Auto)
          .onControllerAttached(() => {
            // Expose bridge before page loads so annotator-mobile.js
            // sees window.shibeiBridge on first evaluation.
            this.webController.registerJavaScriptProxy(
              this.bridge, 'shibeiBridge', ['emit'],
            );
            // loadData's historyUrl param must be a string — passing null
            // throws BusinessError 401 on HarmonyOS NEXT. Empty string
            // means "no history entry", which is what we want.
            const baseUrl = `shibei://resource/${this.resource ? this.resource.id : ''}`;
            this.webController.loadData(this.html, 'text/html', 'UTF-8', baseUrl, '');
          })
          .onScroll((ev: OnScrollEvent) => {
            this.lastScrollY = ev.yOffset;
            this.scheduleScrollSave();
          })
          .width('100%').height('100%')
          .backgroundColor($r('sys.color.ohos_id_color_sub_background'));

        // Tap-catcher scrim. Only renders when the annotation drawer is
        // open. ArkWeb's Web captures all touches, so SideBarContainer's
        // autoHide never fires when the user taps the page area. This
        // transparent layer sits on top of the Web only while the drawer
        // is visible, catches the tap, and closes the drawer. Uses a
        // near-transparent fill (not pure Color.Transparent) so the hit
        // test actually registers.
        if (this.panelOpen) {
          Column()
            .width('100%').height('100%')
            .backgroundColor($r('app.color.surface_tap_invisible'))
            .onClick(() => { this.setPanelOpen(false); });
        }

        // Floating selection action bar — shown when user has an active
        // selection. Tap a color circle to create a highlight with that color.
        if (this.pendingSelection !== null && !this.pendingSelection.collapsed) {
          this.SelectionPalette();
        }
      }
      .layoutWeight(1).width('100%');
    }
    .width('100%').height('100%');
  }

  // PDF branch: loads `pdf-shell/shell.html?id=<resourceId>` from rawfile;
  // pdfjs inside the shell XHRs `shibei-pdf://resource/{id}` which our
  // handlePdfIntercept answers with bytes from NAPI. The download/error
  // panels cover the pre-ready states — on first open of a resource that
  // hasn't been synced to this device yet we sit on "正在下载 PDF…" until
  // ensurePdfDownloaded resolves.
  @Builder PdfContent() {
    Column() {
      this.TopBar();

      Stack() {
        if (this.pdfDownloading) {
          Column() {
            Text(I18n.t($r('app.string.reader_pdf_downloading')))
              .fontColor($r('sys.color.ohos_id_color_text_tertiary'));
          }.width('100%').height('100%').justifyContent(FlexAlign.Center);
        } else if (this.pdfError) {
          Column() {
            Text(I18n.t($r('app.string.reader_pdf_download_failed'), I18n.translateError(this.pdfError)))
              .fontColor($r('sys.color.ohos_id_color_warning'));
            Button(I18n.t($r('app.string.common_retry'))).margin({ top: 12 })
              .onClick(() => {
                if (this.resource) this.ensurePdfReady(this.resource.id);
              });
          }.width('100%').height('100%').justifyContent(FlexAlign.Center);
        } else if (this.pdfReady && this.resource) {
          Web({
            // zoom is appended so the shell reads its initial zoomFactor
            // from the URL query and computes the first scale with that
            // value, avoiding a flash-of-1.0 → saved rebuild. pdfZoom has
            // already been loaded from prefs in ensurePdfReady before
            // pdfReady flips true.
            //
            // loadingText is the localized "Loading…" string, injected so
            // the shell's status div stays in sync with the app's current
            // locale (ArkTS resolves the resource; main.js applies it
            // before pdfjs gets a chance to overwrite with progress).
            src: $rawfile(`pdf-shell/shell.html?id=${this.resource.id}`
              + `&zoom=${this.pdfZoom}`
              + `&loadingText=${encodeURIComponent(I18n.t($r('app.string.common_loading')))}`),
            controller: this.webController,
          })
            .domStorageAccess(true)
            .javaScriptAccess(true)
            // Disable ArkWeb's native pinch-to-zoom so our own touchmove
            // handler in main.js gets the gesture cleanly and can drive
            // pdfjs to re-render at the new scale. ArkWeb's native zoom
            // does a CSS transform scale — fine for HTML but blurs the
            // PDF canvas since pdfjs would still be rendering at the old
            // scale underneath.
            .zoomAccess(false)
            // Follow system ColorMode for pdf-shell's own chrome (background
            // behind pages, status text) — style.css has prefers-color-scheme
            // rules. PDF canvas content itself stays authentic (white page).
            .darkMode(WebDarkMode.Auto)
            .onControllerAttached(() => {
              // Same bridge contract as HTML — pdf-annotator-mobile.js
              // speaks the identical SelectionPayload / ClickPayload /
              // ReadyPayload protocol via window.shibeiBridge.emit.
              this.webController.registerJavaScriptProxy(
                this.bridge, 'shibeiBridge', ['emit'],
              );
            })
            .onInterceptRequest((ev: OnInterceptRequestEvent) => this.handlePdfIntercept(ev))
            .onScroll((ev: OnScrollEvent) => {
              this.lastScrollY = ev.yOffset;
              this.scheduleScrollSave();
            })
            .onConsole((ev: OnConsoleEvent) => {
              // Surface the shell's console.log into hilog so we can
              // diagnose width / scale issues from ssh+hdc.
              hilog.info(0x0000, 'shibei', 'pdf-shell: %{public}s',
                ev.message.getMessage());
              return false;  // still propagate to the default handler
            })
            .width('100%').height('100%')
            .backgroundColor($r('sys.color.ohos_id_color_sub_background'));
        }

        // Tap-catcher scrim (mirrors HtmlContent). The PDF shell's
        // scrollable `<div id="pages">` captures touches the same way the
        // HTML iframe does, so we need the same workaround to close the
        // drawer by tapping the page area.
        if (this.panelOpen) {
          Column()
            .width('100%').height('100%')
            .backgroundColor($r('app.color.surface_tap_invisible'))
            .onClick(() => { this.setPanelOpen(false); });
        }

        if (this.pendingSelection !== null && !this.pendingSelection.collapsed) {
          this.SelectionPalette();
        }
      }
      .layoutWeight(1).width('100%');
    }
    .width('100%').height('100%');
  }

  @Builder CommentSheet() {
    Column() {
      TextArea({
        text: this.commentDialogDraft,
        placeholder: I18n.t($r('app.string.reader_note_placeholder')),
      })
        .fontSize(15)
        .width('100%')
        .height(160)
        .onChange((v: string) => { this.commentDialogDraft = v; });
      Row() {
        Text(I18n.t($r('app.string.common_cancel')))
          .fontSize(15)
          .padding({ left: 20, right: 20, top: 10, bottom: 10 })
          .onClick(() => {
            this.commentDialogOpen = false;
            this.commentDialogDraft = '';
            this.commentDialogId = null;
            this.commentDialogHighlightId = null;
          });
        Text(I18n.t($r('app.string.common_save')))
          .fontSize(15).fontColor($r('sys.color.ohos_id_color_emphasize'))
          .padding({ left: 20, right: 20, top: 10, bottom: 10 })
          .onClick(() => this.saveComment());
      }
      .width('100%').justifyContent(FlexAlign.End);
    }
    .width('100%').padding(16);
  }

  private saveComment(): void {
    if (!this.resource) return;
    const content = this.commentDialogDraft.trim();
    if (!content) {
      this.commentDialogOpen = false;
      return;
    }
    try {
      if (this.commentDialogId) {
        AnnotationsService.instance.updateComment(this.resource.id, this.commentDialogId, content);
      } else {
        // commentDialogHighlightId is set when "+ 评论" is tapped on a
        // highlight card; null path saves as a resource-level note.
        AnnotationsService.instance.createComment(
          this.resource.id,
          this.commentDialogHighlightId,
          content,
        );
      }
      this.commentDialogOpen = false;
      this.commentDialogDraft = '';
      this.commentDialogId = null;
      this.commentDialogHighlightId = null;
    } catch (err) {
      promptAction.showToast({ message: (err as Error).message });
    }
  }
}
