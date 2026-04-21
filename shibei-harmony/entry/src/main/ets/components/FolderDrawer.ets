import { ShibeiService, ShibeiError, Folder } from '../services/ShibeiService';
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

  aboutToAppear(): void {
    this.reload();
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
      Text('文件夹').fontSize(14).fontColor('#888').margin({ top: 16, bottom: 8, left: 16 });

      if (this.error) {
        Text(`err: ${this.error}`).fontSize(12).fontColor('#c00').margin({ left: 16, right: 16 });
        Button('retry').width('90%').margin({ top: 8 }).onClick(() => this.reload());
      }

      List() {
        ForEach(this.buildItems(), (item: DrawerItem) => {
          ListItem() {
            Row() {
              Text(item.icon).fontSize(16).margin({ right: 8 });
              Text(item.label).fontSize(15).fontWeight(this.selectedFolderId === item.id ? FontWeight.Bold : FontWeight.Normal);
            }
            .width('100%')
            .padding({ left: 16, right: 16, top: 10, bottom: 10 })
            .backgroundColor(this.selectedFolderId === item.id ? '#E3F2FD' : Color.Transparent)
            .onClick(() => this.pick(item.id));
          }
        }, (item: DrawerItem) => item.id);
      }
      .width('100%')
      .layoutWeight(1);
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#FAFAFA');
  }
}
