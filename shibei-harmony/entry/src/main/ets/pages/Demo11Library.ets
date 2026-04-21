import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
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
  @State tappedResourceId: string = '';

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
    // Phase 3 will push the Reader page here. For Phase 2 we just record
    // the tap so the user can confirm the event path.
    this.tappedResourceId = id;
    hilog.info(0x0000, 'shibei', 'Demo11 open resource %{public}s', id);
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
              Button(this.drawerOpen ? '✕' : '☰')
                .fontSize(20).fontColor('#333')
                .backgroundColor(Color.Transparent)
                .width(40).height(40)
                .onClick(() => { this.drawerOpen = !this.drawerOpen; });
              Text(this.selectedFolderLabel).fontSize(17).fontWeight(FontWeight.Medium).layoutWeight(1)
                .textAlign(TextAlign.Center);
              Text('').width(40);  // spacer to keep title centered
            }
            .width('100%')
            .padding({ left: 8, right: 8, top: 6, bottom: 6 });

            ResourceList({
              folderId: this.selectedFolderId,
              onOpenResource: (id: string) => this.onOpenResource(id),
            });

            if (this.tappedResourceId) {
              Text(`(Phase 3 will open: ${this.tappedResourceId})`)
                .fontSize(11).fontColor('#bbb').margin({ top: 8, bottom: 8 });
            }
          }.width('100%').height('100%');
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
