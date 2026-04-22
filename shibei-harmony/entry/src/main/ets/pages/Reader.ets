import { webview } from '@kit.ArkWeb';
import { router } from '@kit.ArkUI';
import { promptAction } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { ShibeiService, Resource } from '../services/ShibeiService';
import { AnnotationsService } from '../services/AnnotationsService';
import {
  AnnotationBridge,
  SelectionPayload,
  ClickPayload,
  ReadyPayload,
} from '../components/AnnotationBridge';
import { AnnotationPanel } from '../components/AnnotationPanel';
import { AnnotationsBundle } from '../services/ShibeiService';

// Route param shape.
interface ReaderParams { resourceId?: string; }

const DEFAULT_HL_COLOR = '#ffeb3b';

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

  private webController: webview.WebviewController = new webview.WebviewController();
  private bridge: AnnotationBridge = new AnnotationBridge({
    onSelection: (p: SelectionPayload) => this.handleSelection(p),
    onClick: (p: ClickPayload) => this.handleClick(p),
    onReady: (p: ReadyPayload) => this.handleReady(p),
  });
  private unsubscribe: (() => void) | null = null;

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
  }

  private createHighlightFromPending(): void {
    const sel = this.pendingSelection;
    if (!sel || !this.resource || !sel.textContent || !sel.anchor) {
      return;
    }
    try {
      AnnotationsService.instance.createHighlight(
        this.resource.id,
        sel.textContent,
        sel.anchor,
        DEFAULT_HL_COLOR,
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
                  this.webController.refresh();
                  // Load the HTML string. baseUrl uses shibei scheme so the
                  // annotator's href check doesn't reject it.
                  const baseUrl = `shibei://resource/${this.resource ? this.resource.id : ''}`;
                  this.webController.loadData(this.html, 'text/html', 'UTF-8', baseUrl, null);
                })
                .width('100%').height('100%')
                .backgroundColor($r('sys.color.ohos_id_color_sub_background'));

              // Floating selection action bar — shown when user has an active selection.
              if (this.pendingSelection !== null && !this.pendingSelection.collapsed) {
                Row() {
                  Text('高亮').fontSize(14)
                    .fontColor(Color.White)
                    .backgroundColor($r('sys.color.ohos_id_color_emphasize'))
                    .padding({ left: 16, right: 16, top: 8, bottom: 8 })
                    .borderRadius(18)
                    .onClick(() => this.createHighlightFromPending());
                }
                .width('100%').justifyContent(FlexAlign.Center)
                .position({ x: 0, y: '90%' });
              }
            }
            .layoutWeight(1).width('100%');
          }
          .width('100%').height('100%');

          // Side panel
          AnnotationPanel({
            bundle: this.bundle,
            onTapHighlight: (id: string) => this.flashHighlight(id),
            onDeleteHighlight: (id: string) => this.deleteHighlight(id),
            onAddResourceComment: () => { /* Phase 3a: Task 10 */ },
            onEditComment: (_id: string) => { /* Task 10 */ },
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
        }
        .showSideBar(this.panelOpen)
        .sideBarWidth(280)
        .minSideBarWidth(240)
        .maxSideBarWidth(360)
        .sideBarPosition(SideBarPosition.End)
        .showControlButton(false)
        .width('100%').height('100%');
      }
    }
    .width('100%').height('100%');
  }
}
