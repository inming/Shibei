import { hilog } from '@kit.PerformanceAnalysisKit';
import { promptAction } from '@kit.ArkUI';
import { ShibeiService, ShibeiError, AutoSyncMode } from '../../services/ShibeiService';
import { I18n } from '../../services/I18n';
import { SettingsTopBar } from '../../components/SettingsTopBar';

// Sync sub-page: Sync now / auto-sync mode / repair sync cursors. Pure
// extraction from the old monolithic Settings — every behavior here is
// identical to the pre-split version. Mounted via `pages/settings/Sync`.

@Entry
@Component
struct SyncSettings {
  @State syncing: boolean = false;
  @State syncStatus: string = '';
  @State autoSyncMode: AutoSyncMode = 'on_open';
  @State lastSyncAt: string = '';
  @State resetCursorsBusy: boolean = false;

  aboutToAppear(): void {
    this.reloadSyncSettings();
  }

  private reloadSyncSettings(): void {
    try {
      this.autoSyncMode = ShibeiService.instance.getAutoSyncMode();
      this.lastSyncAt = ShibeiService.instance.getLastSyncAt();
    } catch (err) {
      hilog.warn(0x0000, 'shibei', 'reloadSyncSettings fail: %{public}s', (err as Error).message);
    }
  }

  private autoSyncLabel(): string {
    return this.autoSyncMode === 'on_open'
      ? I18n.t($r('app.string.sync_auto_on_open'))
      : I18n.t($r('app.string.sync_auto_manual'));
  }

  /// Same compact "today / earlier this year" formatting as the old
  /// monolithic Settings — mostly ISO → "HH:MM" or "MM-DD HH:MM".
  private formatLastSync(): string {
    if (!this.lastSyncAt) return I18n.t($r('app.string.sync_last_never'));
    const d = new Date(this.lastSyncAt);
    if (isNaN(d.getTime())) return this.lastSyncAt;
    const now = new Date();
    const sameDay = d.getFullYear() === now.getFullYear()
      && d.getMonth() === now.getMonth()
      && d.getDate() === now.getDate();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    if (sameDay) return `${hh}:${mm}`;
    const MM = String(d.getMonth() + 1).padStart(2, '0');
    const DD = String(d.getDate()).padStart(2, '0');
    return `${MM}-${DD} ${hh}:${mm}`;
  }

  private async pickAutoSyncMode(): Promise<void> {
    try {
      const r = await promptAction.showDialog({
        title: I18n.t($r('app.string.sync_auto_title')),
        buttons: [
          { text: I18n.t($r('app.string.sync_auto_on_open')), color: $r('app.color.accent_primary') },
          { text: I18n.t($r('app.string.sync_auto_manual')), color: $r('app.color.text_secondary') },
        ],
      });
      const mode: AutoSyncMode = r.index === 1 ? 'manual' : 'on_open';
      ShibeiService.instance.setAutoSyncMode(mode);
      this.autoSyncMode = mode;
    } catch (err) {
      hilog.warn(0x0000, 'shibei', 'pickAutoSyncMode dismissed: %{public}s', (err as Error).message);
    }
  }

  private async syncNow(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    this.syncStatus = I18n.t($r('app.string.settings_sync_preparing'));
    const unsub = ShibeiService.instance.onSyncProgress((ev) => {
      if (ev.total > 0) {
        this.syncStatus = `${ev.phase} ${ev.current}/${ev.total}`;
      } else {
        this.syncStatus = ev.phase;
      }
    });
    try {
      const result = await ShibeiService.instance.syncMetadata();
      if (result.kind === 'success') {
        promptAction.showToast({
          message: I18n.t(
            $r('app.string.settings_sync_complete'),
            result.uploaded,
            result.downloaded,
          ),
        });
      } else {
        promptAction.showToast({
          message: I18n.t($r('app.string.settings_sync_skipped')),
        });
      }
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
      promptAction.showToast({
        message: I18n.t($r('app.string.settings_sync_failed'), I18n.translateError(code)),
      });
    } finally {
      unsub();
      this.syncing = false;
      this.syncStatus = '';
      this.lastSyncAt = ShibeiService.instance.getLastSyncAt();
    }
  }

  private async resetSyncCursors(): Promise<void> {
    if (this.resetCursorsBusy) return;
    let confirmed = false;
    try {
      const res = await promptAction.showDialog({
        title: I18n.t($r('app.string.settings_reset_cursors')),
        message: I18n.t($r('app.string.settings_reset_cursors_body')),
        buttons: [
          { text: I18n.t($r('app.string.common_cancel')), color: $r('app.color.text_secondary') },
          { text: I18n.t($r('app.string.settings_reset_cursors_confirm')), color: $r('app.color.accent_primary_alt') },
        ],
      });
      confirmed = res.index === 1;
    } catch (err) {
      hilog.info(0x0000, 'shibei', 'resetSyncCursors dialog dismissed: %{public}s', (err as Error).message);
      return;
    }
    if (!confirmed) return;

    this.resetCursorsBusy = true;
    try {
      const n = ShibeiService.instance.resetSyncCursors();
      promptAction.showToast({
        message: I18n.t($r('app.string.settings_reset_cursors_success'), n),
      });
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
      promptAction.showToast({
        message: I18n.t($r('app.string.settings_reset_cursors_failed'), I18n.translateError(code)),
      });
    }
    this.resetCursorsBusy = false;
  }

  build() {
    Column() {
      SettingsTopBar({ title: I18n.t($r('app.string.settings_section_sync')) });

      Scroll() {
        Column() {
          Column() {
            Row() {
              Column() {
                Text(this.syncing
                  ? I18n.t($r('app.string.settings_sync_in_progress'))
                  : I18n.t($r('app.string.settings_sync_now'))).fontSize(15)
                  .fontColor($r('sys.color.ohos_id_color_text_primary'));
                if (this.syncing && this.syncStatus) {
                  Text(this.syncStatus).fontSize(12)
                    .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                    .margin({ top: 2 });
                } else {
                  Text(I18n.t($r('app.string.sync_last_label'), this.formatLastSync()))
                    .fontSize(11)
                    .fontColor($r('sys.color.ohos_id_color_text_tertiary'))
                    .margin({ top: 2 });
                }
              }.alignItems(HorizontalAlign.Start).layoutWeight(1);
              Text('›').fontSize(18)
                .fontColor($r('sys.color.ohos_id_color_text_tertiary'));
            }
            .width('100%').padding({ top: 12, bottom: 12, left: 12, right: 12 })
            .onClick(() => this.syncNow());

            Divider().color($r('sys.color.ohos_id_color_list_separator'));

            Row() {
              Text(I18n.t($r('app.string.sync_auto_row_title'))).fontSize(15)
                .fontColor($r('sys.color.ohos_id_color_text_primary'))
                .layoutWeight(1);
              Text(this.autoSyncLabel()).fontSize(14)
                .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                .margin({ right: 6 });
              Text('›').fontSize(18)
                .fontColor($r('sys.color.ohos_id_color_text_tertiary'));
            }
            .width('100%').padding({ top: 12, bottom: 12, left: 12, right: 12 })
            .onClick(() => this.pickAutoSyncMode());

            Divider().color($r('sys.color.ohos_id_color_list_separator'));

            Row() {
              Column() {
                Text(this.resetCursorsBusy
                  ? I18n.t($r('app.string.settings_reset_cursors_busy'))
                  : I18n.t($r('app.string.settings_reset_cursors')))
                  .fontSize(15)
                  .fontColor($r('sys.color.ohos_id_color_text_primary'));
                Text(I18n.t($r('app.string.settings_reset_cursors_help')))
                  .fontSize(11)
                  .fontColor($r('sys.color.ohos_id_color_text_tertiary'))
                  .margin({ top: 2 });
              }.alignItems(HorizontalAlign.Start).layoutWeight(1);
              Text('›').fontSize(18)
                .fontColor($r('sys.color.ohos_id_color_text_tertiary'));
            }
            .width('100%').padding({ top: 12, bottom: 12, left: 12, right: 12 })
            .onClick(() => this.resetSyncCursors());
          }
          .backgroundColor($r('sys.color.ohos_id_color_background')).borderRadius(8)
          .margin({ top: 16, left: 12, right: 12, bottom: 24 });
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
