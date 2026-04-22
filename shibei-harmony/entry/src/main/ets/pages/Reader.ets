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
} from '../components/AnnotationBridge';
import { AnnotationPanel } from '../components/AnnotationPanel';
import { AnnotationsBundle } from '../services/ShibeiService';
import { getReaderScroll, saveReaderScroll } from '../app/ReaderScrollState';

// Route param shape.
interface ReaderParams { resourceId?: string; }

// Palette shown in the selection action bar. Order left→right matches
// the desktop picker. Yellow is the first tap position since it's the
// historical default.
interface HlColor { value: string; label: string; }
const HL_COLORS: HlColor[] = [
  { value: '#ffeb3b', label: '黄' },
  { value: '#81c784', label: '绿' },
  { value: '#64b5f6', label: '蓝' },
  { value: '#f48fb1', label: '粉' },
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

  private webController: webview.WebviewController = new webview.WebviewController();
  private bridge: AnnotationBridge = new AnnotationBridge({
    onSelection: (p: SelectionPayload) => this.handleSelection(p),
    onClick: (p: ClickPayload) => this.handleClick(p),
    onReady: (p: ReadyPayload) => this.handleReady(p),
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
      if (this.resource.resource_type === 'pdf') {
        this.loading = false;
        this.ensurePdfReady(id);
      } else {
        this.html = ShibeiService.instance.getResourceHtml(id);
        this.loading = false;
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

  // Ensure the PDF is on local disk. Fast path (file exists) resolves
  // immediately; slow path pulls via shibei-sync's download_snapshot and
  // the UI sits on the "正在下载 PDF…" panel during the RPC. On any error
  // we surface the message into `pdfError` so the retry button appears.
  private async ensurePdfReady(id: string): Promise<void> {
    this.pdfError = '';
    this.pdfDownloading = true;
    try {
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
    this.panelOpen = true;
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
      promptAction.showToast({ message: `创建失败: ${(err as Error).message}` });
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
      promptAction.showToast({ message: '链接已复制' });
    }).catch((err: Error) => {
      hilog.warn(0x0000, 'shibei', 'pasteboard setData fail: %{public}s', err.message);
      promptAction.showToast({ message: '复制失败' });
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
          Text('加载中…').fontColor($r('sys.color.ohos_id_color_text_tertiary'));
        }.width('100%').height('100%').justifyContent(FlexAlign.Center);
      } else if (this.loadError) {
        Column() {
          Text(`加载失败: ${this.loadError}`).fontColor($r('sys.color.ohos_id_color_warning'));
        }.width('100%').height('100%').justifyContent(FlexAlign.Center);
      } else {
        SideBarContainer(SideBarContainerType.Overlay) {
          // SideBarContainer convention: FIRST child = side bar, SECOND = content.
          // We put AnnotationPanel first (drawer) and the top-bar+Web column second.
          AnnotationPanel({
            bundle: this.bundle,
            onTapHighlight: (id: string) => this.flashHighlight(id),
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
      title: { title: this.commentDialogId ? '编辑笔记' : '新建笔记' },
    });
  }

  // Top bar: back button + title + annotations drawer toggle. Shared by
  // both HTML and PDF branches; keep it thin and depend only on @State
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
      Text(`☰ ${this.bundle.highlights.length}`)
        .fontSize(14)
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
        .padding({ left: 8, right: 8 }).height(44)
        .onClick(() => { this.panelOpen = !this.panelOpen; });
    }
    .width('100%')
    .backgroundColor($r('sys.color.ohos_id_color_background'))
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
    .shadow({ radius: 12, color: '#40000000', offsetY: 2 })
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
            .backgroundColor('#01000000')
            .onClick(() => { this.panelOpen = false; });
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
            Text('正在下载 PDF…')
              .fontColor($r('sys.color.ohos_id_color_text_tertiary'));
          }.width('100%').height('100%').justifyContent(FlexAlign.Center);
        } else if (this.pdfError) {
          Column() {
            Text(`下载失败: ${this.pdfError}`)
              .fontColor($r('sys.color.ohos_id_color_warning'));
            Button('重试').margin({ top: 12 })
              .onClick(() => {
                if (this.resource) this.ensurePdfReady(this.resource.id);
              });
          }.width('100%').height('100%').justifyContent(FlexAlign.Center);
        } else if (this.pdfReady && this.resource) {
          Web({
            src: $rawfile(`pdf-shell/shell.html?id=${this.resource.id}`),
            controller: this.webController,
          })
            .domStorageAccess(true)
            .javaScriptAccess(true)
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
            .backgroundColor('#01000000')
            .onClick(() => { this.panelOpen = false; });
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
      TextArea({ text: this.commentDialogDraft, placeholder: '写下你的想法…' })
        .fontSize(15)
        .width('100%')
        .height(160)
        .onChange((v: string) => { this.commentDialogDraft = v; });
      Row() {
        Text('取消')
          .fontSize(15)
          .padding({ left: 20, right: 20, top: 10, bottom: 10 })
          .onClick(() => {
            this.commentDialogOpen = false;
            this.commentDialogDraft = '';
            this.commentDialogId = null;
            this.commentDialogHighlightId = null;
          });
        Text('保存')
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
