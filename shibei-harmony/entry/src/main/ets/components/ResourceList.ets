import { ShibeiService, ShibeiError, Resource } from '../services/ShibeiService';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { promptAction } from '@kit.ArkUI';
import { pasteboard } from '@kit.BasicServicesKit';
import { ResourceItem } from './ResourceItem';
import { I18n } from '../services/I18n';

@Component
export struct ResourceList {
  @Prop @Watch('onFolderChange') folderId: string;
  @Prop @Watch('onTagIdsChange') tagIds: string[] = [];
  onOpenResource?: (id: string) => void;
  @State resources: Resource[] = [];
  @State loading: boolean = false;
  @State error: string = '';
  @State refreshing: boolean = false;
  // Stringified CSV of cached ids; an @State Set<string> would work but
  // ArkUI change detection on Set is flaky, so we keep a parallel string
  // as the diff trigger and resolve `isCached(id)` in build().
  @State cachedKey: string = '';
  private cachedSet: Set<string> = new Set<string>();
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

  private onTagIdsChange(): void {
    this.reload();
  }

  private reload(): void {
    this.loading = true;
    this.error = '';
    try {
      this.resources = ShibeiService.instance.listResources(this.folderId, this.tagIds, [], { by: 'created_at', order: 'desc' });
      this.refreshCachedSet();
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : err.message;
      this.error = code;
      this.resources = [];
      hilog.error(0x0000, 'shibei', 'ResourceList listResources fail: %{public}s', code);
    }
    this.loading = false;
  }

  /// Rebuild the cached-id set for the currently loaded resources. Called
  /// after `reload()` and after a long-press 「缓存到本地」 completes.
  private refreshCachedSet(): void {
    if (this.resources.length === 0) {
      this.cachedSet = new Set<string>();
      this.cachedKey = '';
      return;
    }
    const ids: string[] = this.resources.map((r: Resource) => r.id);
    try {
      const cached: string[] = ShibeiService.instance.getCachedIds(ids);
      this.cachedSet = new Set<string>(cached);
      this.cachedKey = cached.join(',');
    } catch (err) {
      hilog.warn(0x0000, 'shibei', 'getCachedIds fail: %{public}s', (err as Error).message);
    }
  }

  /// Long-press on a row: offer to cache-this + cache-entire-folder. We
  /// keep it as two rows rather than a dialog so the primary action (cache
  /// one) is a single tap.
  private onLongPress(id: string): void {
    promptAction.showDialog({
      title: I18n.t($r('app.string.cache_menu_title')),
      buttons: [
        { text: I18n.t($r('app.string.cache_action_this_resource')), color: $r('app.color.accent_primary') },
        { text: I18n.t($r('app.string.cache_action_this_folder')), color: $r('app.color.accent_primary_alt') },
        { text: I18n.t($r('app.string.annotation_copy_link')), color: $r('app.color.accent_primary_alt') },
        { text: I18n.t($r('app.string.common_cancel')), color: $r('app.color.text_secondary') },
      ],
    }).then((r) => {
      if (r.index === 0) this.preloadOne(id);
      else if (r.index === 1) this.preloadFolder();
      else if (r.index === 2) this.copyLink(id);
    }).catch((err: Error) => {
      hilog.warn(0x0000, 'shibei', 'cache dialog dismissed: %{public}s', err.message);
    });
  }

  private copyLink(id: string): void {
    try {
      const data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN,
        `shibei://open/resource/${id}`);
      pasteboard.getSystemPasteboard().setData(data).then(() => {
        promptAction.showToast({ message: I18n.t($r('app.string.common_copy_success')) });
      }).catch((err: Error) => {
        hilog.warn(0x0000, 'shibei', 'pasteboard set fail: %{public}s', err.message);
        promptAction.showToast({ message: I18n.t($r('app.string.common_copy_failed')) });
      });
    } catch (err) {
      hilog.warn(0x0000, 'shibei', 'copyLink fail: %{public}s', (err as Error).message);
      promptAction.showToast({ message: I18n.t($r('app.string.common_copy_failed')) });
    }
  }

  private async preloadOne(id: string): Promise<void> {
    try {
      await ShibeiService.instance.preloadResource(id);
      this.refreshCachedSet();
      promptAction.showToast({ message: I18n.t($r('app.string.cache_toast_one_ok')) });
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
      promptAction.showToast({
        message: I18n.t($r('app.string.cache_toast_one_failed'), I18n.translateError(code)),
      });
    }
  }

  private async preloadFolder(): Promise<void> {
    promptAction.showToast({ message: I18n.t($r('app.string.cache_toast_folder_started')) });
    try {
      const summary = await ShibeiService.instance.preloadFolder(this.folderId);
      this.refreshCachedSet();
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
      promptAction.showToast({
        message: I18n.t($r('app.string.sidebar_sync_failed'), I18n.translateError(code)),
      });
    } finally {
      this.refreshing = false;
    }
  }

  build() {
    Refresh({ refreshing: $$this.refreshing }) {
      Column() {
        if (this.error) {
          Column() {
            Text(I18n.t($r('app.string.resource_list_error'), this.error))
              .fontSize(13).fontColor($r('app.color.accent_error_strong'));
            Button(I18n.t($r('app.string.common_retry')))
              .margin({ top: 8 }).onClick(() => this.reload());
          }.padding(24).alignItems(HorizontalAlign.Center).width('100%');
        } else if (this.resources.length === 0 && !this.loading) {
          Column() {
            Text(I18n.t($r('app.string.resource_list_empty')))
              .fontSize(14).fontColor($r('app.color.text_subtle'));
            Text(I18n.t($r('app.string.resource_list_empty_hint')))
              .fontSize(11).fontColor($r('app.color.text_disabled'))
              .margin({ top: 4 });
          }.padding(40).alignItems(HorizontalAlign.Center).width('100%');
        } else {
          List({ space: 0 }) {
            // Re-read the @State cachedKey here so the ForEach builder is
            // dependency-tracked against it. Reading `this.cachedSet` alone
            // would not — the Set is a plain field and ArkUI won't notice
            // its mutation. `cachedIsReactive` just pulls the string into
            // the build-time read set.
            ForEach(this.resources, (r: Resource) => {
              ListItem() {
                Stack({ alignContent: Alignment.TopEnd }) {
                  ResourceItem({
                    resource: r,
                    onTap: (id: string) => { if (this.onOpenResource) this.onOpenResource(id); },
                    onLongPress: (id: string) => this.onLongPress(id),
                  });
                  if (this.cachedKey.length > 0 && this.cachedSet.has(r.id)) {
                    Text('●')
                      .fontSize(10)
                      .fontColor($r('app.color.accent_primary'))
                      .margin({ top: 14, right: 18 });
                  }
                }
                .width('100%');
              }
            }, (r: Resource) => r.id);
          }
          .width('100%')
          .layoutWeight(1)
          .divider({
            strokeWidth: 0.5,
            color: $r('app.color.border_divider'),
            startMargin: 16,
            endMargin: 16,
          });
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
