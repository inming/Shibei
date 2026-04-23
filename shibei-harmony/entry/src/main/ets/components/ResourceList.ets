import { ShibeiService, ShibeiError, Resource } from '../services/ShibeiService';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { promptAction } from '@kit.ArkUI';
import { ResourceItem } from './ResourceItem';

@Component
export struct ResourceList {
  @Prop @Watch('onFolderChange') folderId: string;
  onOpenResource?: (id: string) => void;
  @State resources: Resource[] = [];
  @State loading: boolean = false;
  @State error: string = '';
  @State refreshing: boolean = false;
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

  private onFolderChange(): void {
    this.reload();
  }

  private reload(): void {
    this.loading = true;
    this.error = '';
    try {
      this.resources = ShibeiService.instance.listResources(this.folderId, [], { by: 'created_at', order: 'desc' });
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : err.message;
      this.error = code;
      this.resources = [];
      hilog.error(0x0000, 'shibei', 'ResourceList listResources fail: %{public}s', code);
    }
    this.loading = false;
  }

  // Pull-to-refresh handler. Silent on success — the list auto-reloads via
  // `onDataChanged` when sync applies anything. Toasts only on failure so
  // users aren't left guessing after a connectivity error.
  private async onPullRefresh(): Promise<void> {
    try {
      await ShibeiService.instance.syncMetadata();
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
      hilog.warn(0x0000, 'shibei', 'pull-to-refresh sync fail: %{public}s', code);
      promptAction.showToast({ message: `同步失败: ${code}` });
    } finally {
      this.refreshing = false;
    }
  }

  build() {
    Refresh({ refreshing: $$this.refreshing }) {
      Column() {
        if (this.error) {
          Column() {
            Text(`err: ${this.error}`).fontSize(13).fontColor('#c00');
            Button('retry').margin({ top: 8 }).onClick(() => this.reload());
          }.padding(24).alignItems(HorizontalAlign.Center).width('100%');
        } else if (this.resources.length === 0 && !this.loading) {
          Column() {
            Text('当前文件夹没有资料').fontSize(14).fontColor('#999');
            Text('(Phase 2 阶段暂无导入入口,等同步完成后再看)').fontSize(11).fontColor('#bbb').margin({ top: 4 });
          }.padding(40).alignItems(HorizontalAlign.Center).width('100%');
        } else {
          List({ space: 0 }) {
            ForEach(this.resources, (r: Resource) => {
              ListItem() {
                ResourceItem({
                  resource: r,
                  onTap: (id: string) => { if (this.onOpenResource) this.onOpenResource(id); },
                });
              }
            }, (r: Resource) => r.id);
          }
          .width('100%')
          .layoutWeight(1)
          .divider({ strokeWidth: 0.5, color: '#EEE', startMargin: 16, endMargin: 16 });
        }
      }
      .width('100%')
      .height('100%');
    }
    .onRefreshing(() => { this.onPullRefresh(); })
    .width('100%')
    .height('100%');
  }
}
