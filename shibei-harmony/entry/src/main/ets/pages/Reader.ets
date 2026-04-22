import { webview } from '@kit.ArkWeb';
import { router } from '@kit.ArkUI';
import { promptAction } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
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
  @State commentDialogDraft: string = '';

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
      this.html = ShibeiService.instance.getResourceHtml(id);
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
    this.loading = false;
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
            onAddResourceComment: () => {
              this.commentDialogId = null;
              this.commentDialogDraft = '';
              this.commentDialogOpen = true;
            },
            onEditComment: (id: string) => {
              const c = this.bundle.comments.find((x: Comment) => x.id === id);
              if (!c) return;
              this.commentDialogId = id;
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

          // Main content: top bar + Web
          Column() {
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

              // Floating selection action bar — shown when user has an active
              // selection. Tap a color circle to create a highlight with that color.
              if (this.pendingSelection !== null && !this.pendingSelection.collapsed) {
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
            }
            .layoutWeight(1).width('100%');
          }
          .width('100%').height('100%');
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
        AnnotationsService.instance.createComment(this.resource.id, null, content);
      }
      this.commentDialogOpen = false;
      this.commentDialogDraft = '';
      this.commentDialogId = null;
    } catch (err) {
      promptAction.showToast({ message: (err as Error).message });
    }
  }
}
