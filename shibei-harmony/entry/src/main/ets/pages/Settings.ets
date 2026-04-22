import { hilog } from '@kit.PerformanceAnalysisKit';
import { common } from '@kit.AbilityKit';
import { router, promptAction } from '@kit.ArkUI';
import { ShibeiService, ShibeiError } from '../services/ShibeiService';
import { loadTheme, applyTheme, ThemeMode } from '../app/ThemeManager';

// Track F — Phase 2 Settings (精简).
//
// Sections: 外观(深色模式) / 安全(立即锁定) / 数据(重置设备).
// Language toggle was scoped out per design decision — mobile i18n infra
// doesn't exist yet in Phase 2.

@Entry
@Component
struct Settings {
  @State theme: ThemeMode = 'system';
  @State resetting: boolean = false;
  @State resetError: string = '';
  @State syncing: boolean = false;
  @State syncStatus: string = '';

  async aboutToAppear(): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    this.theme = await loadTheme(ctx);
  }

  private async setTheme(mode: ThemeMode): Promise<void> {
    this.theme = mode;
    const ctx = getContext(this) as common.UIAbilityContext;
    await applyTheme(ctx, mode);
  }

  private async lockNow(): Promise<void> {
    ShibeiService.instance.lockVault();
    router.replaceUrl({ url: 'pages/LockScreen' }).catch((err: Error) => {
      hilog.error(0x0000, 'shibei', 'replaceUrl fail: %{public}s', err.message);
    });
  }

  // Manual sync trigger. Mobile has no automatic sync loop yet — the user
  // pulls fresh data via this button. Progress events update `syncStatus`
  // so the row reflects live phase ("downloading", "applying"...).
  private async syncNow(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    this.syncStatus = '准备中…';
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
          message: `同步完成 ↑${result.uploaded} ↓${result.downloaded}`,
        });
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

  // Two-tap confirmation: native dialog first (hard confirm), then the
  // call itself. `promptAction.showDialog` returns the index of the
  // pressed button — 1 means user tapped the destructive confirm.
  private async resetDevice(): Promise<void> {
    let confirmed = false;
    try {
      const res = await promptAction.showDialog({
        title: '重置设备',
        message: '这会清除本地全部资料和凭据,下次启动需要重新配对云端。\n\n(云端数据不受影响,同步后会重新拉回)',
        buttons: [
          { text: '取消', color: '#666' },
          { text: '确认重置', color: '#d33' },
        ],
      });
      confirmed = res.index === 1;
    } catch (err) {
      // showDialog throws on dismiss in some OS versions — treat as cancel.
      hilog.info(0x0000, 'shibei', 'resetDevice dialog dismissed: %{public}s',
        (err as Error).message);
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
      this.resetError = `重置失败: ${code}`;
    }
    this.resetting = false;
  }

  // Radio-style theme row. `label` is shown; `mode` is the underlying value.
  @Builder
  ThemeOption(label: string, mode: ThemeMode) {
    Row() {
      Text(label).fontSize(15).layoutWeight(1)
        .fontColor($r('sys.color.ohos_id_color_text_primary'));
      Text(this.theme === mode ? '✓' : '').fontSize(16)
        .fontColor($r('sys.color.ohos_id_color_emphasize')).width(20);
    }
    .width('100%')
    .padding({ top: 12, bottom: 12, left: 12, right: 12 })
    .onClick(() => this.setTheme(mode));
  }

  build() {
    Column() {
      // Top bar
      Row() {
        Text('‹').fontSize(26).fontColor($r('sys.color.ohos_id_color_text_primary'))
          .width(44).height(44).textAlign(TextAlign.Center)
          .onClick(() => router.back());
        Text('设置').fontSize(17).fontWeight(FontWeight.Medium).layoutWeight(1)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .textAlign(TextAlign.Center);
        Text('').width(44);
      }
      .width('100%').padding({ left: 4, right: 4, top: 4, bottom: 4 })
      .backgroundColor($r('sys.color.ohos_id_color_background'));

      Scroll() {
        Column() {
          // ── 外观 ─────────────────────────────────────────
          Text('外观').fontSize(13)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ top: 16, left: 16, bottom: 4 });
          Column() {
            this.ThemeOption('跟随系统', 'system');
            Divider().color($r('sys.color.ohos_id_color_list_separator'));
            this.ThemeOption('浅色', 'light');
            Divider().color($r('sys.color.ohos_id_color_list_separator'));
            this.ThemeOption('深色', 'dark');
          }
          .backgroundColor($r('sys.color.ohos_id_color_background')).borderRadius(8)
          .margin({ left: 12, right: 12 });

          // ── 同步 ─────────────────────────────────────────
          Text('同步').fontSize(13)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ top: 24, left: 16, bottom: 4 });
          Column() {
            Row() {
              Column() {
                Text(this.syncing ? '同步中…' : '立即同步').fontSize(15)
                  .fontColor($r('sys.color.ohos_id_color_text_primary'));
                if (this.syncing && this.syncStatus) {
                  Text(this.syncStatus).fontSize(12)
                    .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                    .margin({ top: 2 });
                }
              }.alignItems(HorizontalAlign.Start).layoutWeight(1);
              Text('›').fontSize(18)
                .fontColor($r('sys.color.ohos_id_color_text_tertiary'));
            }
            .width('100%').padding({ top: 12, bottom: 12, left: 12, right: 12 })
            .onClick(() => this.syncNow());
          }
          .backgroundColor($r('sys.color.ohos_id_color_background')).borderRadius(8)
          .margin({ left: 12, right: 12 });

          // ── 安全 ─────────────────────────────────────────
          Text('安全').fontSize(13)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ top: 24, left: 16, bottom: 4 });
          Column() {
            Row() {
              Text('立即锁定').fontSize(15).layoutWeight(1)
                .fontColor($r('sys.color.ohos_id_color_text_primary'));
              Text('›').fontSize(18)
                .fontColor($r('sys.color.ohos_id_color_text_tertiary'));
            }
            .width('100%').padding({ top: 12, bottom: 12, left: 12, right: 12 })
            .onClick(() => this.lockNow());
          }
          .backgroundColor($r('sys.color.ohos_id_color_background')).borderRadius(8)
          .margin({ left: 12, right: 12 });

          // ── 数据 ─────────────────────────────────────────
          Text('数据').fontSize(13)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ top: 24, left: 16, bottom: 4 });
          Column() {
            Row() {
              Text(this.resetting ? '重置中…' : '重置设备').fontSize(15)
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

          Text('云端数据永不会被这些操作删除。').fontSize(11)
            .fontColor($r('sys.color.ohos_id_color_text_tertiary'))
            .margin({ top: 24, left: 16, right: 16, bottom: 32 });
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%');
      }
      .layoutWeight(1)
      .width('100%');
    }
    .width('100%').height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'));
  }
}
