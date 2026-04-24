import { ShibeiService, ShibeiError, Folder, SyncProgressEvent, SyncResult } from '../services/ShibeiService';
import { promptAction, router } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { I18n } from '../services/I18n';

// Virtual folder ids mirrored from desktop src/types/index.ts.
export const INBOX_FOLDER_ID = '__inbox__';
export const ALL_RESOURCES_ID = '__all__';

interface DrawerItem {
  id: string;
  label: string;
  icon: string;
  isVirtual: boolean;
  // Indent level for nested folders. Virtual folders are always 0.
  // Root user folders are 0, their children 1, grandchildren 2, ...
  depth: number;
}

// The shibei-db folder schema uses "__root__" as the synthetic parent of
// top-level user folders. Mirrored from desktop src/lib/folderTree.ts.
const ROOT_PARENT_ID = '__root__';

@Component
export struct FolderDrawer {
  @Link selectedFolderId: string;
  onPick?: (id: string) => void;
  @State folders: Folder[] = [];
  @State error: string = '';
  @State syncing: boolean = false;
  @State syncStatus: string = '';
  private unsubDataChanged?: () => void;

  aboutToAppear(): void {
    this.reload();
    this.unsubDataChanged = ShibeiService.instance.onDataChanged(() => this.reload());
  }

  aboutToDisappear(): void {
    if (this.unsubDataChanged) {
      this.unsubDataChanged();
      this.unsubDataChanged = undefined;
    }
  }

  private async syncNow(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    this.syncStatus = I18n.t($r('app.string.settings_sync_preparing'));
    const unsub = ShibeiService.instance.onSyncProgress((ev: SyncProgressEvent) => {
      this.syncStatus = ev.total > 0 ? `${ev.phase} ${ev.current}/${ev.total}` : ev.phase;
    });
    try {
      const result: SyncResult = await ShibeiService.instance.syncMetadata();
      if (result.kind === 'success') {
        promptAction.showToast({
          message: I18n.t(
            $r('app.string.settings_sync_complete'), result.uploaded, result.downloaded),
        });
        // Folder list may have changed — reload after a successful pull.
        this.reload();
      } else {
        promptAction.showToast({
          message: I18n.t($r('app.string.sidebar_sync_skipped')),
        });
      }
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
      promptAction.showToast({
        message: I18n.t($r('app.string.sidebar_sync_failed'), I18n.translateError(code)),
      });
    } finally {
      unsub();
      this.syncing = false;
      this.syncStatus = '';
    }
  }

  private reload(): void {
    try {
      this.folders = ShibeiService.instance.listFolders();
      this.error = '';
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : err.message;
      this.error = code;
      hilog.error(0x0000, 'shibei', 'FolderDrawer listFolders fail: %{public}s', code);
    }
  }

  private buildItems(): DrawerItem[] {
    const items: DrawerItem[] = [
      {
        id: ALL_RESOURCES_ID,
        label: I18n.t($r('app.string.sidebar_all_resources')),
        icon: '📚',
        isVirtual: true,
        depth: 0,
      },
      {
        id: INBOX_FOLDER_ID,
        label: I18n.t($r('app.string.sidebar_inbox')),
        icon: '📥',
        isVirtual: true,
        depth: 0,
      },
    ];
    // Group the remaining folders by parent_id so the recursion can look up
    // children cheaply. The __inbox__ seed is in the virtual section above
    // and must be excluded from the tree.
    const childrenByParent = new Map<string, Folder[]>();
    for (const f of this.folders) {
      if (f.id === INBOX_FOLDER_ID) continue;
      const parent = f.parent_id ?? ROOT_PARENT_ID;
      const bucket = childrenByParent.get(parent) ?? [];
      bucket.push(f);
      childrenByParent.set(parent, bucket);
    }
    // Stable ordering within each parent: sort_order then name.
    childrenByParent.forEach((list: Folder[]) => {
      list.sort((a: Folder, b: Folder) => {
        if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
        return a.name.localeCompare(b.name);
      });
    });

    const walk = (parentId: string, depth: number): void => {
      const kids = childrenByParent.get(parentId);
      if (!kids) return;
      for (const f of kids) {
        items.push({ id: f.id, label: f.name, icon: '📁', isVirtual: false, depth });
        walk(f.id, depth + 1);
      }
    };
    walk(ROOT_PARENT_ID, 0);
    return items;
  }

  private pick(id: string): void {
    this.selectedFolderId = id;
    if (this.onPick) this.onPick(id);
  }

  /// Long-press on a folder row: confirm + batch preload the folder's
  /// snapshots. The row includes both real folders and `__inbox__`; we
  /// disable the menu for `__all__` because preloading "everything" is
  /// almost never what the user means.
  private onLongPressFolder(item: DrawerItem): void {
    if (item.id === ALL_RESOURCES_ID) return;
    const folderId = item.id;
    const folderLabel = item.label;
    promptAction.showDialog({
      title: I18n.t($r('app.string.cache_folder_confirm_title')),
      message: I18n.t($r('app.string.cache_folder_confirm_body'), folderLabel),
      buttons: [
        { text: I18n.t($r('app.string.common_cancel')), color: $r('app.color.text_secondary') },
        { text: I18n.t($r('app.string.cache_folder_confirm_ok')), color: $r('app.color.accent_primary') },
      ],
    }).then(async (r) => {
      if (r.index !== 1) return;
      promptAction.showToast({ message: I18n.t($r('app.string.cache_toast_folder_started')) });
      try {
        const summary = await ShibeiService.instance.preloadFolder(folderId);
        promptAction.showToast({
          message: I18n.t(
            $r('app.string.cache_toast_folder_done'),
            summary.ok, summary.failed, summary.skipped,
          ),
        });
      } catch (err) {
        const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
        promptAction.showToast({
          message: I18n.t($r('app.string.cache_toast_folder_failed'), I18n.translateError(code)),
        });
      }
    }).catch((err: Error) => {
      hilog.warn(0x0000, 'shibei', 'folder cache dialog dismissed: %{public}s', err.message);
    });
  }

  build() {
    Column() {
      Text(I18n.t($r('app.string.sidebar_folders_label')))
        .fontSize(14).fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .margin({ top: 16, bottom: 8, left: 16 });

      if (this.error) {
        Text(I18n.t($r('app.string.resource_list_error'), this.error))
          .fontSize(12).fontColor($r('sys.color.ohos_id_color_warning'))
          .margin({ left: 16, right: 16 });
        Button(I18n.t($r('app.string.common_retry')))
          .width('90%').margin({ top: 8 }).onClick(() => this.reload());
      }

      List() {
        ForEach(this.buildItems(), (item: DrawerItem) => {
          ListItem() {
            Row() {
              Text(item.icon).fontSize(16).margin({ right: 8 });
              Text(item.label).fontSize(15)
                .fontColor($r('sys.color.ohos_id_color_text_primary'))
                .fontWeight(this.selectedFolderId === item.id ? FontWeight.Bold : FontWeight.Normal)
                .layoutWeight(1)
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis });
            }
            .width('100%')
            // 16px base left padding + 16px per nesting level.
            .padding({ left: 16 + item.depth * 16, right: 16, top: 10, bottom: 10 })
            .backgroundColor(
              this.selectedFolderId === item.id
                ? $r('sys.color.ohos_id_color_component_normal')
                : Color.Transparent
            )
            .onClick(() => this.pick(item.id))
            .gesture(
              LongPressGesture({ repeat: false, duration: 500 })
                .onAction(() => this.onLongPressFolder(item))
            );
          }
        }, (item: DrawerItem) => item.id);
      }
      .width('100%')
      .layoutWeight(1);

      // Footer — Settings + Sync pinned to drawer bottom.
      // Order (top to bottom inside the footer) is [Settings, Sync] so the
      // most-frequently-used action (sync) sits at the very edge where the
      // thumb lands. The top-bar ⚙ was removed to avoid two entry points.
      Divider().strokeWidth(0.5).color($r('sys.color.ohos_id_color_list_separator'));
      Column() {
        Row() {
          Text('⚙').fontSize(16).margin({ right: 8 })
            .fontColor($r('sys.color.ohos_id_color_text_primary'));
          Text(I18n.t($r('app.string.settings_page_title')))
            .fontSize(15)
            .fontColor($r('sys.color.ohos_id_color_text_primary'));
        }
        .width('100%')
        .padding({ left: 16, right: 16, top: 10, bottom: 10 })
        .onClick(() => {
          router.pushUrl({ url: 'pages/Settings' }).catch((err: Error) => {
            hilog.warn(0x0000, 'shibei', 'Settings pushUrl fail: %{public}s', err.message);
          });
        });

        Row() {
          Text('⟳').fontSize(16).margin({ right: 8 })
            .fontColor($r('sys.color.ohos_id_color_emphasize'));
          Text(this.syncing
            ? I18n.t($r('app.string.settings_sync_in_progress'))
            : I18n.t($r('app.string.settings_sync_now')))
            .fontSize(15)
            .fontColor($r('sys.color.ohos_id_color_text_primary'));
        }
        .width('100%')
        .padding({ left: 16, right: 16, top: 10, bottom: this.syncStatus ? 2 : 10 })
        .onClick(() => this.syncNow());
        if (this.syncStatus) {
          Text(this.syncStatus).fontSize(11)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .padding({ left: 40, right: 16, bottom: 10 });
        }
      }
      .width('100%');
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
    // Right edge divider. In dark mode the drawer background and the
    // Library content are both near-black, so without a visible edge the
    // boundary between sidebar and main view is invisible. 0.5 vp in the
    // list_separator token picks up the dark-mode override automatically.
    .border({
      width: { right: 0.5 },
      color: { right: $r('sys.color.ohos_id_color_list_separator') },
    });
  }
}
