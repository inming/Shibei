import { ShibeiService, ShibeiError, Folder, SyncProgressEvent, SyncResult } from '../services/ShibeiService';
import { promptAction } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';

// Virtual folder ids mirrored from desktop src/types/index.ts.
export const INBOX_FOLDER_ID = '__inbox__';
export const ALL_RESOURCES_ID = '__all__';

interface DrawerItem {
  id: string;
  label: string;
  icon: string;
  isVirtual: boolean;
}

@Component
export struct FolderDrawer {
  @Link selectedFolderId: string;
  onPick?: (id: string) => void;
  @State folders: Folder[] = [];
  @State error: string = '';
  @State syncing: boolean = false;
  @State syncStatus: string = '';

  aboutToAppear(): void {
    this.reload();
  }

  private async syncNow(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    this.syncStatus = '准备中…';
    const unsub = ShibeiService.instance.onSyncProgress((ev: SyncProgressEvent) => {
      this.syncStatus = ev.total > 0 ? `${ev.phase} ${ev.current}/${ev.total}` : ev.phase;
    });
    try {
      const result: SyncResult = await ShibeiService.instance.syncMetadata();
      if (result.kind === 'success') {
        promptAction.showToast({
          message: `同步完成 ↑${result.uploaded} ↓${result.downloaded}`,
        });
        // Folder list may have changed — reload after a successful pull.
        this.reload();
      } else {
        promptAction.showToast({ message: '同步跳过' });
      }
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
      promptAction.showToast({ message: `同步失败: ${code}` });
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
      { id: ALL_RESOURCES_ID, label: '所有资料', icon: '📚', isVirtual: true },
      { id: INBOX_FOLDER_ID, label: '收件箱', icon: '📥', isVirtual: true },
    ];
    // Filter the __inbox__ seed out of the regular folder list (it's in the
    // virtual section above).
    for (const f of this.folders) {
      if (f.id === INBOX_FOLDER_ID) continue;
      items.push({ id: f.id, label: f.name, icon: '📁', isVirtual: false });
    }
    return items;
  }

  private pick(id: string): void {
    this.selectedFolderId = id;
    if (this.onPick) this.onPick(id);
  }

  build() {
    Column() {
      Text('文件夹').fontSize(14).fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .margin({ top: 16, bottom: 8, left: 16 });

      if (this.error) {
        Text(`err: ${this.error}`).fontSize(12).fontColor($r('sys.color.ohos_id_color_warning'))
          .margin({ left: 16, right: 16 });
        Button('retry').width('90%').margin({ top: 8 }).onClick(() => this.reload());
      }

      List() {
        ForEach(this.buildItems(), (item: DrawerItem) => {
          ListItem() {
            Row() {
              Text(item.icon).fontSize(16).margin({ right: 8 });
              Text(item.label).fontSize(15)
                .fontColor($r('sys.color.ohos_id_color_text_primary'))
                .fontWeight(this.selectedFolderId === item.id ? FontWeight.Bold : FontWeight.Normal);
            }
            .width('100%')
            .padding({ left: 16, right: 16, top: 10, bottom: 10 })
            .backgroundColor(
              this.selectedFolderId === item.id
                ? $r('sys.color.ohos_id_color_component_normal')
                : Color.Transparent
            )
            .onClick(() => this.pick(item.id));
          }
        }, (item: DrawerItem) => item.id);
      }
      .width('100%')
      .layoutWeight(1);

      // Footer — sync button always visible at drawer bottom.
      Divider().strokeWidth(0.5).color($r('sys.color.ohos_id_color_list_separator'));
      Column() {
        Row() {
          Text('⟳').fontSize(16).margin({ right: 8 })
            .fontColor($r('sys.color.ohos_id_color_emphasize'));
          Text(this.syncing ? '同步中…' : '立即同步')
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
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'));
  }
}
