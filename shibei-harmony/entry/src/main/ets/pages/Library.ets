import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { router, promptAction } from '@kit.ArkUI';
import { ShibeiService, ShibeiError } from '../services/ShibeiService';
import { I18n } from '../services/I18n';
import { FolderDrawer, INBOX_FOLDER_ID } from '../components/FolderDrawer';
import { ResourceList } from '../components/ResourceList';
import { KEY_FOLD_STATUS, KEY_PENDING_DEEP_LINK } from '../app/AppStorageKeys';
import { FoldStatus } from '../app/FoldObserver';
import { SessionState, SessionLibrary } from '../app/SessionState';

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
  // Default landing = "所有资料" (virtual __all__). Users mostly want to
  // see everything synced; Inbox stays available in the drawer but isn't
  // the first view anymore.
  @State selectedFolderId: string = '__all__';
  @State selectedFolderLabel: string = '';
  // Kept in sync with FoldObserver; updates here trigger an automatic
  // re-layout between Embed / Overlay without reopening the page.
  @StorageProp(KEY_FOLD_STATUS) foldStatus: FoldStatus = FoldStatus.EXPANDED;

  // Guard to prevent re-pushing Reader when the user navigates back from
  // Settings / Search to Library (aboutToAppear fires again).
  private restoredOnce: boolean = false;

  async aboutToAppear(): Promise<void> {
    // I18n is wired in EntryAbility.onWindowStageCreate before any page
    // renders, so lookup here is safe. Do it before init so the first
    // frame already has the localized landing label.
    this.selectedFolderLabel = I18n.t($r('app.string.sidebar_all_resources'));

    // init is idempotent — EntryAbility also calls it on cold start.
    try {
      const ctx = getContext(this) as common.UIAbilityContext;
      await ShibeiService.instance.init(ctx);
      this.initReady = true;
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : err.message;
      this.initError = code;
      hilog.error(0x0000, 'shibei', 'Library init fail: %{public}s', code);
      return;
    }

    // Restore persisted library state and open Reader if needed.
    const ctx = getContext(this) as common.UIAbilityContext;
    await this.restoreSession(ctx);

    // §7.3 auto-sync. Mode "on_open" is default; "manual" skips. Failures
    // (e.g. MK not loaded on a locked vault, no network) are swallowed —
    // the user never asked for this sync, so we shouldn't pop a toast.
    try {
      if (ShibeiService.instance.getAutoSyncMode() === 'on_open') {
        ShibeiService.instance.syncMetadata().catch((err: Error) => {
          hilog.info(0x0000, 'shibei', 'auto-sync skipped: %{public}s', err.message);
        });
      }
    } catch (err) {
      hilog.warn(0x0000, 'shibei', 'auto-sync gate fail: %{public}s', (err as Error).message);
    }
  }

  private async restoreSession(ctx: common.UIAbilityContext): Promise<void> {
    try {
      const state = await SessionState.load(ctx);
      // Restore folder selection.
      if (state.library.selectedFolderId) {
        this.selectedFolderId = state.library.selectedFolderId;
        this.syncFolderLabel(state.library.selectedFolderId);
      }
      if (!this.restoredOnce && state.inReader && state.readerResourceId) {
        // Verify the resource still exists before pushing.
        try {
          const resource = ShibeiService.instance.getResource(state.readerResourceId);
          if (resource) {
            this.restoredOnce = true;
            router.pushUrl({
              url: 'pages/Reader',
              params: { resourceId: state.readerResourceId },
            }).catch((err: Error) => {
              hilog.error(0x0000, 'shibei', 'restore Reader pushUrl fail: %{public}s', err.message);
            });
          }
        } catch (_e) {
          // Resource deleted — clear the stale entry silently.
          await SessionState.save(ctx, { inReader: false, readerResourceId: null });
        }
      }
      this.restoredOnce = true;
    } catch (_e) {
      // Session restore failure is non-fatal.
      this.restoredOnce = true;
    }
    // Consume any deep link that was stashed during lock-screen / onboard.
    this.consumePendingDeepLink();
  }

  private syncFolderLabel(id: string): void {
    if (id === '__all__') {
      this.selectedFolderLabel = I18n.t($r('app.string.sidebar_all_resources'));
    } else if (id === INBOX_FOLDER_ID) {
      this.selectedFolderLabel = I18n.t($r('app.string.sidebar_inbox'));
    } else {
      const folders = ShibeiService.instance.listFolders();
      const found = folders.find(f => f.id === id);
      this.selectedFolderLabel = found ? found.name : id;
    }
  }

  private consumePendingDeepLink(): void {
    try {
      const uri = AppStorage.get<string>(KEY_PENDING_DEEP_LINK);
      if (!uri || uri === '') return;
      AppStorage.setOrCreate<string>(KEY_PENDING_DEEP_LINK, '');
      const match = uri.match(/^shibei:\/\/open\/resource\/([^?]+)(?:\?highlight=(.+))?$/);
      if (!match) return;
      const resourceId = match[1];
      const highlightId = match[2] || undefined;
      SessionState.save(getContext(this) as common.UIAbilityContext, {
        inReader: true,
        readerResourceId: resourceId,
      });
      router.pushUrl({
        url: 'pages/Reader',
        params: { resourceId, highlightId },
      }).catch((err: Error) => {
        hilog.error(0x0000, 'shibei', 'deepLink pushUrl fail: %{public}s', err.message);
      });
    } catch (err) {
      hilog.warn(0x0000, 'shibei', 'consumePendingDeepLink fail: %{public}s',
        (err as Error).message);
    }
  }

  // Two-step exit guard: when the drawer is already open, the first back
  // shows a toast and arms the exit; a second back within 2s falls through
  // to the system (app closes). Resets on any other state change (e.g.
  // drawer closed via button, folder pick) so the user always starts from
  // "one back to open drawer".
  private exitArmed: boolean = false;
  private exitArmTimer: number = -1;

  // Intercept the system back gesture (any edge). HarmonyOS NEXT's edge
  // swipe is OS-level — priorityGesture/PanGesture cannot pre-empt it, so
  // the only hook is this page callback. Returning true consumes the event
  // (no router pop / app exit); returning false lets the system close the
  // Library window (== exit the app since Library is the root page).
  onBackPress(): boolean {
    if (this.foldStatus !== FoldStatus.FOLDED) {
      // Expanded (unfolded Mate X5 / tablet): drawer is always visible,
      // no toggle makes sense — let the system handle back normally.
      return false;
    }
    // Drawer open → close it, arm the exit toast so the next back-swipe
    // enters the exit flow (don't exit immediately: the user probably
    // just wanted to dismiss the drawer). Either-edge back works.
    if (this.drawerOpen) {
      this.setDrawerOpen(false);
      this.armExitToast();
      return true;
    }
    // Drawer closed + exit armed (user already saw "再滑一次关闭应用"
    // after closing the drawer) → let the OS close the app.
    if (this.exitArmed) {
      this.disarmExit();
      return false;
    }
    // Drawer closed, cold start on Library → open the drawer.
    this.setDrawerOpen(true);
    return true;
  }

  // Show the "swipe again to exit" toast and start a 2 s arm window. If
  // the user back-swipes again inside that window, onBackPress returns
  // false and the system closes the Library window. Called after closing
  // the drawer via any back gesture.
  private armExitToast(): void {
    if (this.exitArmed) return;
    this.exitArmed = true;
    promptAction.showToast({
      message: I18n.t($r('app.string.library_back_confirm_exit')),
      duration: 1800,
      alignment: Alignment.Top,
      offset: { dx: 0, dy: 300 },
    });
    if (this.exitArmTimer !== -1) clearTimeout(this.exitArmTimer);
    this.exitArmTimer = setTimeout(() => {
      this.exitArmed = false;
      this.exitArmTimer = -1;
    }, 2000);
  }

  private disarmExit(): void {
    this.exitArmed = false;
    if (this.exitArmTimer !== -1) {
      clearTimeout(this.exitArmTimer);
      this.exitArmTimer = -1;
    }
  }

  private onFolderPick(id: string): void {
    this.selectedFolderId = id;
    this.syncFolderLabel(id);
    const ctx = getContext(this) as common.UIAbilityContext;
    const lib: SessionLibrary = {
      selectedFolderId: id,
      selectedTagIds: [],
      selectedResourceId: null,
    };
    SessionState.save(ctx, { library: lib });
    // Only collapse the drawer in the folded single-column mode; on an
    // expanded device (tablet / unfolded Mate X5) the drawer is an always-
    // on side rail so dismissing it on every pick would be annoying.
    if (this.foldStatus === FoldStatus.FOLDED) {
      this.setDrawerOpen(false);
    }
  }

  /// Toggle drawer state inside animateTo so the SideBarContainer width and
  /// the scrim opacity interpolate to the new value instead of popping.
  /// 260ms / FastOutSlowIn mirrors the HarmonyOS system drawer curve.
  private setDrawerOpen(open: boolean): void {
    animateTo({ duration: 260, curve: Curve.FastOutSlowIn }, () => {
      this.drawerOpen = open;
    });
  }

  private async onOpenResource(id: string): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    await SessionState.save(ctx, { inReader: true, readerResourceId: id });
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
            Text(I18n.t($r('app.string.common_init_failed'), this.initError))
              .fontColor($r('app.color.accent_error_strong'));
          } else {
            Text(I18n.t($r('app.string.common_initializing')))
              .fontColor($r('app.color.text_tertiary'));
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

          Stack() {
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
                    .onClick(() => { this.setDrawerOpen(!this.drawerOpen); });
                }
                Text(this.selectedFolderLabel).fontSize(17).fontWeight(FontWeight.Medium).layoutWeight(1)
                  .fontColor($r('sys.color.ohos_id_color_text_primary'))
                  .textAlign(TextAlign.Center);
                // Settings entry moved to the drawer footer (above Sync) so
                // the top bar only carries the primary navigation (Search).
                // Plain Text + onClick (rather than Button) so the glyph isn't
                // squeezed by Button's default inner padding.
                Text('🔍')
                  .fontSize(20)
                  .width(44).height(44).textAlign(TextAlign.Center)
                  .onClick(() => {
                    router.pushUrl({ url: 'pages/Search' }).catch((err: Error) => {
                      hilog.warn(0x0000, 'shibei', 'Search pushUrl fail: %{public}s', err.message);
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

            // Tap-catcher scrim — only in FOLDED mode when the drawer is open.
            // SideBarContainer's autoHide doesn't fire when inner components
            // (lists, scroll views) swallow touches. This transparent layer
            // sits on top of the Column only while the drawer is visible,
            // intercepts the tap, and closes the drawer.
            if (this.foldStatus === FoldStatus.FOLDED && this.drawerOpen) {
              Column()
                .width('100%').height('100%')
                .backgroundColor($r('app.color.surface_tap_invisible'))
                .onClick(() => { this.setDrawerOpen(false); });
            }
          }
          .width('100%').height('100%');
        }
        .showSideBar(this.foldStatus === FoldStatus.EXPANDED ? true : this.drawerOpen)
        .onChange((value: boolean) => {
          // SideBarContainer may close its own sidebar via autoHide when
          // inner components swallow the tap that would've hit our scrim.
          // Without this sync, this.drawerOpen stays `true` while the
          // sidebar is visually closed — the top-bar toggle gets stuck
          // showing ✕ and onBackPress thinks the drawer is still open.
          if (this.foldStatus === FoldStatus.FOLDED) {
            this.drawerOpen = value;
          }
        })
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
