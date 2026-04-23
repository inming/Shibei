import { hilog } from '@kit.PerformanceAnalysisKit';
import { common } from '@kit.AbilityKit';
import { router, promptAction } from '@kit.ArkUI';
import { ShibeiService, ShibeiError } from '../services/ShibeiService';
import { loadTheme, applyTheme, ThemeMode } from '../app/ThemeManager';
import { LockService } from '../services/LockService';
import { HuksService } from '../services/HuksService';
import { I18n } from '../services/I18n';

// Track F — Phase 2 Settings (精简).
//
// Sections: 外观 / 同步 / 安全 / 数据. All user-visible text flows through
// I18n.t($r('app.string.settings_*')); theme-aware colors use either
// $r('sys.color.ohos_id_color_*') system tokens or $r('app.color.*') app
// tokens (accent_primary / accent_danger / text_secondary / accent_primary_alt)
// for dialog buttons where the SDK expects an explicit color argument.

@Entry
@Component
struct Settings {
  @State theme: ThemeMode = 'system';
  @State resetting: boolean = false;
  @State resetError: string = '';
  @State syncing: boolean = false;
  @State syncStatus: string = '';
  @State resetCursorsBusy: boolean = false;
  @State lockEnabled: boolean = false;
  @State bioEnabled: boolean = false;
  @State bioAvailable: boolean = false;
  @State showSetupLock: boolean = false;
  @State showDisableLock: boolean = false;
  @State showChangePin: boolean = false;
  @State pinInput: string = '';
  @State pinConfirm: string = '';
  @State pinStep: 'enter' | 'confirm' = 'enter';
  @State oldPinInput: string = '';

  async aboutToAppear(): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    this.theme = await loadTheme(ctx);
    this.lockEnabled = ShibeiService.instance.lockIsConfigured();
    this.bioEnabled = ShibeiService.instance.lockIsBioEnabled();
    this.bioAvailable = await HuksService.instance.isBioAvailable();
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

  private startSetupLock(): void {
    this.showSetupLock = true;
    this.pinStep = 'enter';
    this.pinInput = '';
    this.pinConfirm = '';
  }

  private async submitSetupLock(): Promise<void> {
    if (this.pinStep === 'enter') {
      if (!/^\d{4}$/.test(this.pinInput)) {
        promptAction.showToast({
          message: I18n.t($r('app.string.settings_pin_must_be_4_digits')),
        });
        return;
      }
      this.pinStep = 'confirm';
      this.pinConfirm = '';
      return;
    }
    if (this.pinConfirm !== this.pinInput) {
      promptAction.showToast({
        message: I18n.t($r('app.string.settings_pin_mismatch')),
      });
      this.pinStep = 'enter';
      this.pinInput = '';
      return;
    }
    try {
      let wantBio = false;
      if (this.bioAvailable) {
        const dlg = await promptAction.showDialog({
          title: I18n.t($r('app.string.settings_bio_enroll_title')),
          message: I18n.t($r('app.string.settings_bio_enroll_message')),
          buttons: [
            {
              text: I18n.t($r('app.string.settings_bio_enroll_pin_only')),
              color: $r('app.color.text_secondary'),
            },
            {
              text: I18n.t($r('app.string.settings_bio_enroll_yes')),
              color: $r('app.color.accent_primary'),
            },
          ],
        });
        wantBio = dlg.index === 1;
      }
      await LockService.instance.setupPin(this.pinInput, wantBio);
      this.lockEnabled = true;
      this.bioEnabled = wantBio;
      this.showSetupLock = false;
      this.pinInput = '';
      this.pinConfirm = '';
      promptAction.showToast({
        message: I18n.t($r('app.string.settings_lock_enabled_toast')),
      });
    } catch (e) {
      const code: string = e instanceof ShibeiError ? e.code : (e as Error).message;
      promptAction.showToast({
        message: I18n.t($r('app.string.settings_lock_enable_failed'), I18n.translateError(code)),
      });
    }
  }

  private async submitDisableLock(): Promise<void> {
    try {
      await LockService.instance.disable(this.pinInput);
      this.lockEnabled = false;
      this.bioEnabled = false;
      this.showDisableLock = false;
      this.pinInput = '';
      promptAction.showToast({
        message: I18n.t($r('app.string.settings_lock_disabled_toast')),
      });
    } catch (e) {
      const code: string = e instanceof ShibeiError ? e.code : (e as Error).message;
      this.pinInput = '';
      const message = code === 'error.pinIncorrect'
        ? I18n.t($r('app.string.settings_lock_pin_incorrect'))
        : I18n.t($r('app.string.settings_lock_disable_failed'), I18n.translateError(code));
      promptAction.showToast({ message });
    }
  }

  private async toggleBio(target: boolean): Promise<void> {
    try {
      if (target) {
        await LockService.instance.enableBio();
        this.bioEnabled = true;
        promptAction.showToast({
          message: I18n.t($r('app.string.settings_bio_enabled_toast')),
        });
      } else {
        await HuksService.instance.deleteBioKey();
        await ShibeiService.instance.lockDeleteBioOnly();
        this.bioEnabled = false;
        promptAction.showToast({
          message: I18n.t($r('app.string.settings_bio_disabled_toast')),
        });
      }
    } catch (e) {
      const code: string = e instanceof ShibeiError ? e.code : (e as Error).message;
      promptAction.showToast({
        message: I18n.t($r('app.string.settings_bio_toggle_failed'), I18n.translateError(code)),
      });
      // Re-read live state so the toggle UI reflects reality
      this.bioEnabled = ShibeiService.instance.lockIsBioEnabled();
    }
  }

  private async submitChangePin(): Promise<void> {
    if (this.oldPinInput.length !== 4) return;
    if (this.pinInput.length !== 4) return;
    if (this.pinConfirm !== this.pinInput) {
      promptAction.showToast({
        message: I18n.t($r('app.string.settings_pin_new_mismatch')),
      });
      this.pinStep = 'enter';
      this.pinInput = '';
      this.pinConfirm = '';
      return;
    }
    try {
      await ShibeiService.instance.lockUnlockWithPin(this.oldPinInput);
      await ShibeiService.instance.lockSetupPin(this.pinInput);
      this.showChangePin = false;
      this.oldPinInput = '';
      this.pinInput = '';
      this.pinConfirm = '';
      promptAction.showToast({
        message: I18n.t($r('app.string.settings_lock_pin_changed')),
      });
    } catch (e) {
      const code: string = e instanceof ShibeiError ? e.code : (e as Error).message;
      this.oldPinInput = '';
      this.pinInput = '';
      this.pinConfirm = '';
      this.pinStep = 'enter';
      const message = code === 'error.pinIncorrect'
        ? I18n.t($r('app.string.settings_lock_old_pin_incorrect'))
        : I18n.t($r('app.string.settings_lock_pin_change_failed'), I18n.translateError(code));
      promptAction.showToast({ message });
    }
  }

  // Manual sync trigger. Mobile has no automatic sync loop yet — the user
  // pulls fresh data via this button. Progress events update `syncStatus`
  // so the row reflects live phase ("downloading", "applying"...).
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
    }
  }

  // Recovery for the historical snapshot-cursor bug. Clears
  // `remote:*:last_seq` + `last_sync_at` so the next sync re-runs the
  // snapshot-import pass. Not destructive — S3 data + local data untouched.
  private async resetSyncCursors(): Promise<void> {
    if (this.resetCursorsBusy) return;
    let confirmed = false;
    try {
      const res = await promptAction.showDialog({
        title: I18n.t($r('app.string.settings_reset_cursors')),
        message: I18n.t($r('app.string.settings_reset_cursors_body')),
        buttons: [
          {
            text: I18n.t($r('app.string.common_cancel')),
            color: $r('app.color.text_secondary'),
          },
          {
            text: I18n.t($r('app.string.settings_reset_cursors_confirm')),
            color: $r('app.color.accent_primary_alt'),
          },
        ],
      });
      confirmed = res.index === 1;
    } catch (err) {
      hilog.info(0x0000, 'shibei', 'resetSyncCursors dialog dismissed: %{public}s',
        (err as Error).message);
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

  // Two-tap confirmation: native dialog first (hard confirm), then the
  // call itself. `promptAction.showDialog` returns the index of the
  // pressed button — 1 means user tapped the destructive confirm.
  private async resetDevice(): Promise<void> {
    let confirmed = false;
    try {
      const res = await promptAction.showDialog({
        title: I18n.t($r('app.string.settings_reset_device')),
        message: I18n.t($r('app.string.settings_reset_device_body')),
        buttons: [
          {
            text: I18n.t($r('app.string.common_cancel')),
            color: $r('app.color.text_secondary'),
          },
          {
            text: I18n.t($r('app.string.settings_reset_device_confirm')),
            color: $r('app.color.accent_danger'),
          },
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
      this.resetError = I18n.t($r('app.string.settings_reset_device_failed'), I18n.translateError(code));
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
        Text(I18n.t($r('app.string.settings_page_title')))
          .fontSize(17).fontWeight(FontWeight.Medium).layoutWeight(1)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .textAlign(TextAlign.Center);
        Text('').width(44);
      }
      .width('100%').padding({ left: 4, right: 4, top: 4, bottom: 4 })
      .backgroundColor($r('sys.color.ohos_id_color_background'));

      Scroll() {
        Column() {
          // ── 外观 ─────────────────────────────────────────
          Text(I18n.t($r('app.string.settings_section_appearance'))).fontSize(13)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ top: 16, left: 16, bottom: 4 });
          Column() {
            this.ThemeOption(I18n.t($r('app.string.settings_theme_system')), 'system');
            Divider().color($r('sys.color.ohos_id_color_list_separator'));
            this.ThemeOption(I18n.t($r('app.string.settings_theme_light')), 'light');
            Divider().color($r('sys.color.ohos_id_color_list_separator'));
            this.ThemeOption(I18n.t($r('app.string.settings_theme_dark')), 'dark');
          }
          .backgroundColor($r('sys.color.ohos_id_color_background')).borderRadius(8)
          .margin({ left: 12, right: 12 });

          // ── 同步 ─────────────────────────────────────────
          Text(I18n.t($r('app.string.settings_section_sync'))).fontSize(13)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ top: 24, left: 16, bottom: 4 });
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
                }
              }.alignItems(HorizontalAlign.Start).layoutWeight(1);
              Text('›').fontSize(18)
                .fontColor($r('sys.color.ohos_id_color_text_tertiary'));
            }
            .width('100%').padding({ top: 12, bottom: 12, left: 12, right: 12 })
            .onClick(() => this.syncNow());

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
          .margin({ left: 12, right: 12 });

          // ── 安全 ─────────────────────────────────────────
          Text(I18n.t($r('app.string.settings_section_security'))).fontSize(13)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ top: 24, left: 16, bottom: 4 });
          Column() {
            Row() {
              Text(I18n.t($r('app.string.settings_lock_enable'))).fontSize(15).layoutWeight(1)
                .fontColor($r('sys.color.ohos_id_color_text_primary'));
              Toggle({ type: ToggleType.Switch, isOn: this.lockEnabled })
                .onChange((isOn: boolean) => {
                  if (isOn && !this.lockEnabled) {
                    this.startSetupLock();
                  } else if (!isOn && this.lockEnabled) {
                    this.showDisableLock = true;
                    this.pinInput = '';
                  }
                });
            }.width('100%').padding({ top: 12, bottom: 12, left: 12, right: 12 });

            if (this.lockEnabled) {
              Divider().color($r('sys.color.ohos_id_color_list_separator'));
              Row() {
                Column() {
                  Text(I18n.t($r('app.string.settings_bio_unlock'))).fontSize(15)
                    .fontColor($r('sys.color.ohos_id_color_text_primary'));
                  if (!this.bioAvailable) {
                    Text(I18n.t($r('app.string.settings_bio_hint_no_enroll'))).fontSize(11)
                      .fontColor($r('sys.color.ohos_id_color_text_tertiary'));
                  }
                }.alignItems(HorizontalAlign.Start).layoutWeight(1);
                Toggle({ type: ToggleType.Switch, isOn: this.bioEnabled })
                  .enabled(this.bioAvailable)
                  .onChange((isOn: boolean) => {
                    if (isOn !== this.bioEnabled) this.toggleBio(isOn);
                  });
              }.width('100%').padding({ top: 12, bottom: 12, left: 12, right: 12 });

              Divider().color($r('sys.color.ohos_id_color_list_separator'));
              Row() {
                Text(I18n.t($r('app.string.settings_change_pin'))).fontSize(15).layoutWeight(1)
                  .fontColor($r('sys.color.ohos_id_color_text_primary'));
                Text('›').fontSize(18)
                  .fontColor($r('sys.color.ohos_id_color_text_tertiary'));
              }.width('100%').padding({ top: 12, bottom: 12, left: 12, right: 12 })
                .onClick(() => {
                  this.showChangePin = true;
                  this.oldPinInput = '';
                  this.pinInput = '';
                  this.pinConfirm = '';
                  this.pinStep = 'enter';
                });

              Divider().color($r('sys.color.ohos_id_color_list_separator'));
            }

            // 立即锁定 — always shown (pre-existing behavior)
            Row() {
              Text(I18n.t($r('app.string.settings_lock_now'))).fontSize(15).layoutWeight(1)
                .fontColor($r('sys.color.ohos_id_color_text_primary'));
              Text('›').fontSize(18)
                .fontColor($r('sys.color.ohos_id_color_text_tertiary'));
            }.width('100%').padding({ top: 12, bottom: 12, left: 12, right: 12 })
              .onClick(() => this.lockNow());
          }
          .backgroundColor($r('sys.color.ohos_id_color_background')).borderRadius(8)
          .margin({ left: 12, right: 12 });

          // Setup PIN dialog (inline, shown when toggle enabled)
          if (this.showSetupLock) {
            Column() {
              Text(this.pinStep === 'enter'
                ? I18n.t($r('app.string.settings_pin_set_prompt_enter'))
                : I18n.t($r('app.string.settings_pin_set_prompt_confirm')))
                .fontSize(14).margin({ top: 16 });
              TextInput({
                placeholder: '',
                text: this.pinStep === 'enter' ? this.pinInput : this.pinConfirm,
              })
                .type(InputType.Number).maxLength(4).width('60%')
                .margin({ top: 12 })
                .onChange((v: string) => {
                  const d = v.replace(/\D/g, '').slice(0, 4);
                  if (this.pinStep === 'enter') {
                    this.pinInput = d;
                  } else {
                    this.pinConfirm = d;
                  }
                  if (d.length === 4) this.submitSetupLock();
                });
              Button(I18n.t($r('app.string.common_cancel')))
                .backgroundColor(Color.Transparent)
                .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                .margin({ top: 12 })
                .onClick(() => {
                  this.showSetupLock = false;
                  this.pinInput = '';
                  this.pinConfirm = '';
                });
            }.width('100%').padding(12);
          }

          // Disable PIN dialog
          if (this.showDisableLock) {
            Column() {
              Text(I18n.t($r('app.string.settings_pin_disable_prompt')))
                .fontSize(14).margin({ top: 16 });
              TextInput({
                placeholder: I18n.t($r('app.string.settings_pin_placeholder_4')),
                text: this.pinInput,
              })
                .type(InputType.Number).maxLength(4).width('60%').margin({ top: 12 })
                .onChange((v: string) => {
                  const d = v.replace(/\D/g, '').slice(0, 4);
                  this.pinInput = d;
                  if (d.length === 4) this.submitDisableLock();
                });
              Button(I18n.t($r('app.string.common_cancel')))
                .backgroundColor(Color.Transparent)
                .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                .margin({ top: 12 })
                .onClick(() => {
                  this.showDisableLock = false;
                  this.pinInput = '';
                });
            }.width('100%').padding(12);
          }

          // Change PIN dialog
          if (this.showChangePin) {
            Column() {
              Text(I18n.t($r('app.string.settings_pin_old_prompt')))
                .fontSize(14).margin({ top: 16 });
              TextInput({
                placeholder: I18n.t($r('app.string.settings_pin_placeholder_old')),
                text: this.oldPinInput,
              })
                .type(InputType.Number).maxLength(4).width('60%').margin({ top: 8 })
                .onChange((v: string) => {
                  this.oldPinInput = v.replace(/\D/g, '').slice(0, 4);
                });
              Text(this.pinStep === 'enter'
                ? I18n.t($r('app.string.settings_pin_new_prompt'))
                : I18n.t($r('app.string.settings_pin_set_prompt_confirm')))
                .fontSize(14).margin({ top: 16 });
              TextInput({
                placeholder: I18n.t($r('app.string.settings_pin_placeholder_new')),
                text: this.pinStep === 'enter' ? this.pinInput : this.pinConfirm,
              })
                .type(InputType.Number).maxLength(4).width('60%').margin({ top: 8 })
                .onChange((v: string) => {
                  const d = v.replace(/\D/g, '').slice(0, 4);
                  if (this.pinStep === 'enter') {
                    this.pinInput = d;
                    if (d.length === 4) this.pinStep = 'confirm';
                  } else {
                    this.pinConfirm = d;
                    if (d.length === 4) this.submitChangePin();
                  }
                });
              Button(I18n.t($r('app.string.common_cancel')))
                .backgroundColor(Color.Transparent)
                .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                .margin({ top: 12 })
                .onClick(() => {
                  this.showChangePin = false;
                  this.oldPinInput = '';
                  this.pinInput = '';
                  this.pinConfirm = '';
                });
            }.width('100%').padding(12);
          }

          // ── 数据 ─────────────────────────────────────────
          Text(I18n.t($r('app.string.settings_section_data'))).fontSize(13)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ top: 24, left: 16, bottom: 4 });
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
      .layoutWeight(1)
      .width('100%');
    }
    .width('100%').height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'));
  }
}
