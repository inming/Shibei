import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { router } from '@kit.ArkUI';
import { ShibeiService, ShibeiError } from '../services/ShibeiService';
import { FolderDrawer, INBOX_FOLDER_ID } from '../components/FolderDrawer';
import { ResourceList } from '../components/ResourceList';

// Track E — Library skeleton (folded-state single column).
// Architecture: SideBarContainer(Overlay) → left is FolderDrawer, right is
// main column containing a TopBar + ResourceList. Picking a folder closes
// the drawer and updates `selectedFolderId`, which `@Watch` in ResourceList
// picks up to reload.

@Entry
@Component
struct Demo11Library {
  @State initReady: boolean = false;
  @State initError: string = '';
  @State drawerOpen: boolean = false;
  @State selectedFolderId: string = INBOX_FOLDER_ID;
  @State selectedFolderLabel: string = '收件箱';

  async aboutToAppear(): Promise<void> {
    // Same init path Demo 9 / Demo 10 use — idempotent, so coming here
    // after those demos still works.
    try {
      const ctx = getContext(this) as common.UIAbilityContext;
      await ShibeiService.instance.init(ctx.filesDir);
      this.initReady = true;
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : err.message;
      this.initError = code;
      hilog.error(0x0000, 'shibei', 'Demo11 init fail: %{public}s', code);
    }
  }

  private onFolderPick(id: string): void {
    this.selectedFolderId = id;
    // Derive a display label; the folder name comes from ShibeiService
    // only for non-virtual folders. Cheap lookup for MVP.
    if (id === '__all__') this.selectedFolderLabel = '所有资料';
    else if (id === INBOX_FOLDER_ID) this.selectedFolderLabel = '收件箱';
    else {
      const folders = ShibeiService.instance.listFolders();
      const found = folders.find(f => f.id === id);
      this.selectedFolderLabel = found ? found.name : id;
    }
    this.drawerOpen = false;
  }

  private onOpenResource(id: string): void {
    // Push to the stub reader; Phase 3 replaces the stub with the real
    // ArkWeb + annotator.js page behind the same route.
    hilog.info(0x0000, 'shibei', 'Demo11 open resource %{public}s', id);
    router.pushUrl({
      url: 'pages/Demo11ReaderStub',
      params: { resourceId: id },
    }).catch((err: Error) => {
      hilog.error(0x0000, 'shibei', 'router.pushUrl fail: %{public}s', err.message);
    });
  }

  // @Entry requires a single root container in build(); guard the init
  // states as sibling branches inside one Stack rather than early-returning.
  build() {
    Stack() {
      if (!this.initReady) {
        Column() {
          if (this.initError) {
            Text(`init failed: ${this.initError}`).fontColor('#c00');
          } else {
            Text('初始化中…').fontColor('#888');
          }
        }
        .width('100%').height('100%')
        .justifyContent(FlexAlign.Center).alignItems(HorizontalAlign.Center);
      } else {
        SideBarContainer(SideBarContainerType.Overlay) {
          FolderDrawer({
            selectedFolderId: $selectedFolderId,
            onPick: (id: string) => this.onFolderPick(id),
          });

          Column() {
            // TopBar — manual ☰ that tracks `drawerOpen`. The built-in
            // SideBarContainer control button is hidden via
            // .showControlButton(false) below so the drawer doesn't end up
            // overlapping a fixed-position toggle when it slides in.
            Row() {
              Text(this.drawerOpen ? '✕' : '☰')
                .fontSize(22).fontColor($r('sys.color.ohos_id_color_text_primary'))
                .width(44).height(44).textAlign(TextAlign.Center)
                .onClick(() => { this.drawerOpen = !this.drawerOpen; });
              Text(this.selectedFolderLabel).fontSize(17).fontWeight(FontWeight.Medium).layoutWeight(1)
                .fontColor($r('sys.color.ohos_id_color_text_primary'))
                .textAlign(TextAlign.Center)
                // Long-press (2s) the title to escape to the dev demo menu.
                // Auto-routing in EntryAbility normally makes pages/Index
                // unreachable; this backdoor is the Phase 2 dev escape.
                .gesture(
                  LongPressGesture({ duration: 2000 }).onAction(() => {
                    router.pushUrl({ url: 'pages/Index' }).catch((err: Error) => {
                      hilog.warn(0x0000, 'shibei', 'dev-menu pushUrl fail: %{public}s', err.message);
                    });
                  })
                );
              // Plain Text + onClick (rather than Button) so the glyph isn't
              // squeezed by Button's default inner padding — ⚙ was clipping
              // inside a 40×40 Button on Mate X5.
              Text('⚙')
                .fontSize(22).fontColor($r('sys.color.ohos_id_color_text_primary'))
                .width(44).height(44).textAlign(TextAlign.Center)
                .onClick(() => {
                  router.pushUrl({ url: 'pages/Settings' }).catch((err: Error) => {
                    hilog.warn(0x0000, 'shibei', 'Settings pushUrl fail: %{public}s', err.message);
                  });
                });
            }
            .width('100%')
            .padding({ left: 4, right: 4, top: 4, bottom: 4 })
            .backgroundColor($r('sys.color.ohos_id_color_background'));

            ResourceList({
              folderId: this.selectedFolderId,
              onOpenResource: (id: string) => this.onOpenResource(id),
            });

          }.width('100%').height('100%')
          .backgroundColor($r('sys.color.ohos_id_color_sub_background'));
        }
        .showSideBar(this.drawerOpen)
        .sideBarWidth(260)
        .minSideBarWidth(200)
        .maxSideBarWidth(320)
        .showControlButton(false)
        .width('100%').height('100%');
      }
    }
    .width('100%').height('100%');
  }
}
