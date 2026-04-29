import { hilog } from '@kit.PerformanceAnalysisKit';
import { router, promptAction } from '@kit.ArkUI';
import {
  ShibeiService, ShibeiError, CacheStats, CacheListRow,
} from '../../services/ShibeiService';
import { I18n } from '../../services/I18n';
import { SettingsTopBar } from '../../components/SettingsTopBar';

// Data sub-page: cache management (size + per-resource list + limit
// picker + clear) plus the destructive reset-device button. Pure
// extraction from the old monolithic Settings.

@Entry
@Component
struct DataSettings {
  @State cacheStats: CacheStats = { totalBytes: 0, limitBytes: 0, entryCount: 0 };
  @State cacheList: CacheListRow[] = [];
  @State showCacheList: boolean = false;
  @State cacheBusy: boolean = false;
  @State resetting: boolean = false;
  @State resetError: string = '';

  aboutToAppear(): void {
    this.reloadCache();
  }

  private reloadCache(): void {
    try {
      this.cacheStats = ShibeiService.instance.getCacheStats();
      if (this.showCacheList) {
        this.cacheList = ShibeiService.instance.getCacheList();
      }
    } catch (err) {
      hilog.warn(0x0000, 'shibei', 'reloadCache fail: %{public}s', (err as Error).message);
    }
  }

  private toggleCacheList(): void {
    this.showCacheList = !this.showCacheList;
    if (this.showCacheList) {
      try {
        this.cacheList = ShibeiService.instance.getCacheList();
      } catch (err) {
        hilog.warn(0x0000, 'shibei', 'getCacheList fail: %{public}s', (err as Error).message);
      }
    }
  }

  private cacheLimitLabel(): string {
    const mb = Math.round(this.cacheStats.limitBytes / (1024 * 1024));
    return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB` : `${mb} MB`;
  }

  private formatBytes(b: number): string {
    if (b < 1024) return `${b} B`;
    const kb = b / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(1)} MB`;
    return `${(mb / 1024).toFixed(2)} GB`;
  }

  private async pickCacheLimit(): Promise<void> {
    try {
      const r = await promptAction.showDialog({
        title: I18n.t($r('app.string.cache_limit_title')),
        buttons: [
          { text: '200 MB', color: $r('app.color.text_primary') },
          { text: '500 MB', color: $r('app.color.text_primary') },
          { text: '1 GB', color: $r('app.color.accent_primary') },
          { text: '2 GB', color: $r('app.color.text_primary') },
        ],
      });
      const mb = [200, 500, 1024, 2048][r.index] ?? 1024;
      ShibeiService.instance.setCacheLimit(mb * 1024 * 1024);
      this.reloadCache();
      promptAction.showToast({
        message: I18n.t($r('app.string.cache_limit_toast_ok'),
          mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`),
      });
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
      hilog.warn(0x0000, 'shibei', 'pickCacheLimit fail: %{public}s', code);
    }
  }

  private async clearCacheConfirm(): Promise<void> {
    if (this.cacheBusy) return;
    try {
      const r = await promptAction.showDialog({
        title: I18n.t($r('app.string.cache_clear_confirm_title')),
        message: I18n.t($r('app.string.cache_clear_confirm_body')),
        buttons: [
          { text: I18n.t($r('app.string.common_cancel')), color: $r('app.color.text_secondary') },
          { text: I18n.t($r('app.string.cache_clear_confirm_ok')), color: $r('app.color.accent_danger') },
        ],
      });
      if (r.index !== 1) return;
    } catch (err) {
      hilog.warn(0x0000, 'shibei', 'cache clear dismissed: %{public}s', (err as Error).message);
      return;
    }
    this.cacheBusy = true;
    try {
      const n = ShibeiService.instance.clearCache();
      this.reloadCache();
      promptAction.showToast({ message: I18n.t($r('app.string.cache_clear_toast_ok'), n) });
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
      promptAction.showToast({
        message: I18n.t($r('app.string.cache_clear_toast_failed'), I18n.translateError(code)),
      });
    } finally {
      this.cacheBusy = false;
    }
  }

  private async resetDevice(): Promise<void> {
    let confirmed = false;
    try {
      const res = await promptAction.showDialog({
        title: I18n.t($r('app.string.settings_reset_device')),
        message: I18n.t($r('app.string.settings_reset_device_body')),
        buttons: [
          { text: I18n.t($r('app.string.common_cancel')), color: $r('app.color.text_secondary') },
          { text: I18n.t($r('app.string.settings_reset_device_confirm')), color: $r('app.color.accent_danger') },
        ],
      });
      confirmed = res.index === 1;
    } catch (err) {
      hilog.info(0x0000, 'shibei', 'resetDevice dialog dismissed: %{public}s', (err as Error).message);
      return;
    }
    if (!confirmed) return;

    this.resetting = true;
    this.resetError = '';
    try {
      ShibeiService.instance.resetDevice();
      router.replaceUrl({ url: 'pages/Onboard' }).catch((err: Error) => {
        hilog.error(0x0000, 'shibei', 'replaceUrl fail: %{public}s', err.message);
      });
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : err.message;
      this.resetError = I18n.t($r('app.string.settings_reset_device_failed'), I18n.translateError(code));
    }
    this.resetting = false;
  }

  build() {
    Column() {
      SettingsTopBar({ title: I18n.t($r('app.string.settings_section_data')) });

      Scroll() {
        Column() {
          // ── Cache management ──────────────────────────────
          Column() {
            Row() {
              Text(I18n.t($r('app.string.cache_header_title'))).fontSize(15)
                .fontColor($r('app.color.text_primary'))
                .layoutWeight(1);
              Text(I18n.t(
                $r('app.string.cache_header_total'),
                this.formatBytes(this.cacheStats.totalBytes),
                this.formatBytes(this.cacheStats.limitBytes),
              ))
                .fontSize(12)
                .fontColor($r('app.color.text_secondary'));
            }
            .width('100%').padding({ top: 12, bottom: 6, left: 12, right: 12 });
            Progress({
              value: Math.min(this.cacheStats.totalBytes, this.cacheStats.limitBytes),
              total: this.cacheStats.limitBytes || 1,
              type: ProgressType.Linear,
            })
              .width('96%').height(4)
              .margin({ left: 12, right: 12, bottom: 8 });
            Row() {
              Text(I18n.t(
                $r('app.string.cache_header_entry_count'),
                this.cacheStats.entryCount,
              ))
                .fontSize(12).fontColor($r('app.color.text_secondary'))
                .layoutWeight(1);
              Text(this.showCacheList
                ? I18n.t($r('app.string.cache_collapse_list'))
                : I18n.t($r('app.string.cache_expand_list')))
                .fontSize(13).fontColor($r('app.color.accent_primary'))
                .onClick(() => this.toggleCacheList());
            }
            .width('100%').padding({ left: 12, right: 12, bottom: 10 });

            if (this.showCacheList) {
              if (this.cacheList.length === 0) {
                Text(I18n.t($r('app.string.cache_list_empty')))
                  .fontSize(12).fontColor($r('app.color.text_subtle'))
                  .padding({ left: 12, right: 12, bottom: 12 });
              } else {
                Column() {
                  ForEach(this.cacheList, (row: CacheListRow) => {
                    Column() {
                      Text(row.title || row.url)
                        .fontSize(13).fontColor($r('app.color.text_primary'))
                        .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis });
                      Row() {
                        Text(row.resourceType.toUpperCase()).fontSize(10)
                          .fontColor($r('app.color.text_subtle'))
                          .margin({ right: 8 });
                        Text(this.formatBytes(row.bytes)).fontSize(11)
                          .fontColor($r('app.color.text_secondary'))
                          .layoutWeight(1);
                      }.width('100%').margin({ top: 2 });
                    }
                    .alignItems(HorizontalAlign.Start)
                    .width('100%')
                    .padding({ left: 12, right: 12, top: 8, bottom: 8 });
                  }, (row: CacheListRow) => row.resourceId);
                }
                .width('100%');
              }
            }

            Divider().strokeWidth(0.5).color($r('app.color.border_divider'));
            Row() {
              Text(I18n.t($r('app.string.cache_limit_row_title'))).fontSize(15)
                .fontColor($r('app.color.text_primary'))
                .layoutWeight(1);
              Text(this.cacheLimitLabel()).fontSize(14)
                .fontColor($r('app.color.text_secondary'))
                .margin({ right: 6 });
              Text('›').fontSize(18)
                .fontColor($r('app.color.text_disabled'));
            }
            .width('100%').padding({ top: 12, bottom: 12, left: 12, right: 12 })
            .onClick(() => this.pickCacheLimit());

            Divider().strokeWidth(0.5).color($r('app.color.border_divider'));
            Row() {
              Text(this.cacheBusy
                ? I18n.t($r('app.string.cache_clear_busy'))
                : I18n.t($r('app.string.cache_clear_button')))
                .fontSize(15)
                .fontColor($r('app.color.accent_danger'))
                .layoutWeight(1);
              Text('›').fontSize(18)
                .fontColor($r('app.color.text_disabled'));
            }
            .width('100%').padding({ top: 12, bottom: 12, left: 12, right: 12 })
            .onClick(() => this.clearCacheConfirm());
          }
          .backgroundColor($r('app.color.bg_secondary')).borderRadius(8)
          .margin({ top: 16, left: 12, right: 12, bottom: 12 });

          // ── Reset device ──────────────────────────────────
          Column() {
            Row() {
              Text(this.resetting
                ? I18n.t($r('app.string.settings_reset_device_busy'))
                : I18n.t($r('app.string.settings_reset_device'))).fontSize(15)
                .fontColor($r('sys.color.ohos_id_color_warning'))
                .layoutWeight(1);
              Text('›').fontSize(18)
                .fontColor($r('sys.color.ohos_id_color_text_tertiary'));
            }
            .width('100%').padding({ top: 12, bottom: 12, left: 12, right: 12 })
            .onClick(() => { if (!this.resetting) this.resetDevice(); });
          }
          .backgroundColor($r('sys.color.ohos_id_color_background')).borderRadius(8)
          .margin({ left: 12, right: 12 });

          if (this.resetError) {
            Text(this.resetError).fontSize(12)
              .fontColor($r('sys.color.ohos_id_color_warning'))
              .margin({ top: 8, left: 16, right: 16 });
          }

          Text(I18n.t($r('app.string.settings_data_disclaimer'))).fontSize(11)
            .fontColor($r('sys.color.ohos_id_color_text_tertiary'))
            .margin({ top: 24, left: 16, right: 16, bottom: 32 });
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%');
      }
      .align(Alignment.Top)
      .layoutWeight(1)
      .width('100%');
    }
    .width('100%').height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'));
  }
}
