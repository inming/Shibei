import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { router } from '@kit.ArkUI';
import { ShibeiService, ShibeiError } from '../services/ShibeiService';
import { FolderDrawer, INBOX_FOLDER_ID } from '../components/FolderDrawer';
import { ResourceList } from '../components/ResourceList';
import { KEY_FOLD_STATUS } from '../app/AppStorageKeys';
import { FoldStatus } from '../app/FoldObserver';

// Track E — Library with dual-state layout.
//   FOLDED   → SideBarContainer(Overlay); drawer slides out under the ☰
//   EXPANDED → SideBarContainer(Embed); drawer is always visible, ☰ is
//              hidden because there's no reason to collapse the side rail
//              on a wide screen.
// Picking a folder updates `selectedFolderId`, which ResourceList reloads
// off. On FOLDED we also close the drawer after a pick; on EXPANDED the
// drawer stays open.

@Entry
@Component
struct Library {
  @State initReady: boolean = false;
  @State initError: string = '';
  @State drawerOpen: boolean = false;
  @State selectedFolderId: string = INBOX_FOLDER_ID;
  @State selectedFolderLabel: string = '收件箱';
  // Kept in sync with FoldObserver; updates here trigger an automatic
  // re-layout between Embed / Overlay without reopening the page.
  @StorageProp(KEY_FOLD_STATUS) foldStatus: FoldStatus = FoldStatus.EXPANDED;

  async aboutToAppear(): Promise<void> {
    // init is idempotent — EntryAbility also calls it on cold start.
    try {
      const ctx = getContext(this) as common.UIAbilityContext;
      await ShibeiService.instance.init(ctx);
      this.initReady = true;
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : err.message;
      this.initError = code;
      hilog.error(0x0000, 'shibei', 'Library init fail: %{public}s', code);
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
    // Only collapse the drawer in the folded single-column mode; on an
    // expanded device (tablet / unfolded Mate X5) the drawer is an always-
    // on side rail so dismissing it on every pick would be annoying.
    if (this.foldStatus === FoldStatus.FOLDED) {
      this.drawerOpen = false;
    }
  }

  private onOpenResource(id: string): void {
    // Push to the stub reader; Phase 3 replaces the stub with the real
    // ArkWeb + annotator.js page behind the same route.
    router.pushUrl({
      url: 'pages/Reader',
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
        SideBarContainer(
          this.foldStatus === FoldStatus.EXPANDED
            ? SideBarContainerType.Embed
            : SideBarContainerType.Overlay,
        ) {
          FolderDrawer({
            selectedFolderId: $selectedFolderId,
            onPick: (id: string) => this.onFolderPick(id),
          });

          Column() {
            // TopBar — manual ☰ that tracks `drawerOpen` (folded mode only).
            // The built-in SideBarContainer control button is hidden via
            // .showControlButton(false) below so the drawer doesn't end up
            // overlapping a fixed-position toggle when it slides in.
            //
            // In expanded mode the drawer is always visible (Embed), so we
            // hide the toggle entirely with a Stack slot that reserves the
            // 44px width for symmetry with the ⚙ on the right.
            Row() {
              if (this.foldStatus === FoldStatus.EXPANDED) {
                Text('').width(44).height(44);
              } else {
                Text(this.drawerOpen ? '✕' : '☰')
                  .fontSize(22).fontColor($r('sys.color.ohos_id_color_text_primary'))
                  .width(44).height(44).textAlign(TextAlign.Center)
                  .onClick(() => { this.drawerOpen = !this.drawerOpen; });
              }
              Text(this.selectedFolderLabel).fontSize(17).fontWeight(FontWeight.Medium).layoutWeight(1)
                .fontColor($r('sys.color.ohos_id_color_text_primary'))
                .textAlign(TextAlign.Center);
              // Plain Text + onClick (rather than Button) so the glyph isn't
              // squeezed by Button's default inner padding — ⚙ was clipping
              // inside a 40×40 Button on Mate X5.
              Text('🔍')
                .fontSize(20)
                .width(44).height(44).textAlign(TextAlign.Center)
                .onClick(() => {
                  router.pushUrl({ url: 'pages/Search' }).catch((err: Error) => {
                    hilog.warn(0x0000, 'shibei', 'Search pushUrl fail: %{public}s', err.message);
                  });
                });
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
        .showSideBar(this.foldStatus === FoldStatus.EXPANDED ? true : this.drawerOpen)
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
