import { hilog } from '@kit.PerformanceAnalysisKit';
import { router, promptAction } from '@kit.ArkUI';
import { ShibeiService, ShibeiError } from '../../services/ShibeiService';
import { LockService } from '../../services/LockService';
import { HuksService } from '../../services/HuksService';
import { I18n } from '../../services/I18n';
import { SettingsTopBar } from '../../components/SettingsTopBar';
import { PinModalCard } from '../../components/PinModalCard';

const SETUP_PIN_ID = 'securitySetupPin';
const DISABLE_PIN_ID = 'securityDisablePin';
const CHANGE_PIN_ID = 'securityChangePin';

type ChangePinStep = 'oldPin' | 'newPin' | 'confirm';

// Security sub-page: App Lock toggle, biometric toggle, change PIN,
// and lock-now action. Pure functional copy of the security section
// from the old monolithic Settings — only structural changes are the
// SettingsTopBar at the top and PinModalCard pulled into a shared
// component.

@Entry
@Component
struct SecuritySettings {
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
  @State changePinStep: ChangePinStep = 'oldPin';

  async aboutToAppear(): Promise<void> {
    this.lockEnabled = ShibeiService.instance.lockIsConfigured();
    this.bioEnabled = ShibeiService.instance.lockIsBioEnabled();
    this.bioAvailable = await HuksService.instance.isBioAvailable();
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
    this.refocusSetupPin();
  }

  private async submitSetupLock(): Promise<void> {
    if (this.pinStep === 'enter') {
      if (!/^\d{4}$/.test(this.pinInput)) {
        promptAction.showToast({ message: I18n.t($r('app.string.settings_pin_must_be_4_digits')) });
        return;
      }
      this.pinStep = 'confirm';
      this.pinConfirm = '';
      this.refocusSetupPin();
      return;
    }
    if (this.pinConfirm !== this.pinInput) {
      promptAction.showToast({ message: I18n.t($r('app.string.settings_pin_mismatch')) });
      this.pinStep = 'enter';
      this.pinInput = '';
      this.refocusSetupPin();
      return;
    }
    try {
      let wantBio = false;
      if (this.bioAvailable) {
        const dlg = await promptAction.showDialog({
          title: I18n.t($r('app.string.settings_bio_enroll_title')),
          message: I18n.t($r('app.string.settings_bio_enroll_message')),
          buttons: [
            { text: I18n.t($r('app.string.settings_bio_enroll_pin_only')), color: $r('app.color.text_secondary') },
            { text: I18n.t($r('app.string.settings_bio_enroll_yes')), color: $r('app.color.accent_primary') },
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
      promptAction.showToast({ message: I18n.t($r('app.string.settings_lock_enabled_toast')) });
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
      promptAction.showToast({ message: I18n.t($r('app.string.settings_lock_disabled_toast')) });
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
        promptAction.showToast({ message: I18n.t($r('app.string.settings_bio_enabled_toast')) });
      } else {
        await HuksService.instance.deleteBioKey();
        await ShibeiService.instance.lockDeleteBioOnly();
        this.bioEnabled = false;
        promptAction.showToast({ message: I18n.t($r('app.string.settings_bio_disabled_toast')) });
      }
    } catch (e) {
      const code: string = e instanceof ShibeiError ? e.code : (e as Error).message;
      promptAction.showToast({
        message: I18n.t($r('app.string.settings_bio_toggle_failed'), I18n.translateError(code)),
      });
      this.bioEnabled = ShibeiService.instance.lockIsBioEnabled();
    }
  }

  private async submitChangePin(): Promise<void> {
    if (this.oldPinInput.length !== 4) return;
    if (this.pinInput.length !== 4) return;
    if (this.pinConfirm !== this.pinInput) {
      promptAction.showToast({ message: I18n.t($r('app.string.settings_pin_new_mismatch')) });
      this.changePinStep = 'newPin';
      this.pinInput = '';
      this.pinConfirm = '';
      this.refocusChangePin();
      return;
    }
    try {
      await ShibeiService.instance.lockUnlockWithPin(this.oldPinInput);
      await ShibeiService.instance.lockSetupPin(this.pinInput);
      this.showChangePin = false;
      this.oldPinInput = '';
      this.pinInput = '';
      this.pinConfirm = '';
      promptAction.showToast({ message: I18n.t($r('app.string.settings_lock_pin_changed')) });
    } catch (e) {
      const code: string = e instanceof ShibeiError ? e.code : (e as Error).message;
      this.oldPinInput = '';
      this.pinInput = '';
      this.pinConfirm = '';
      this.changePinStep = 'oldPin';
      this.refocusChangePin();
      const message = code === 'error.pinIncorrect'
        ? I18n.t($r('app.string.settings_lock_old_pin_incorrect'))
        : I18n.t($r('app.string.settings_lock_pin_change_failed'), I18n.translateError(code));
      promptAction.showToast({ message });
    }
  }

  private refocusSetupPin(): void {
    setTimeout(() => {
      try { focusControl.requestFocus(SETUP_PIN_ID); }
      catch (_e) { /* dialog closed */ }
    }, 50);
  }

  private refocusChangePin(): void {
    setTimeout(() => {
      try { focusControl.requestFocus(CHANGE_PIN_ID); }
      catch (_e) { /* dialog closed */ }
    }, 50);
  }

  private changePinTitle(): string {
    if (this.changePinStep === 'oldPin') return I18n.t($r('app.string.settings_pin_old_prompt'));
    if (this.changePinStep === 'newPin') return I18n.t($r('app.string.settings_pin_new_prompt'));
    return I18n.t($r('app.string.settings_pin_set_prompt_confirm'));
  }

  private changePinValue(): string {
    if (this.changePinStep === 'oldPin') return this.oldPinInput;
    if (this.changePinStep === 'newPin') return this.pinInput;
    return this.pinConfirm;
  }

  build() {
    Stack() {
      Column() {
        SettingsTopBar({ title: I18n.t($r('app.string.settings_section_security')) });

        Scroll() {
          Column() {
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
                      setTimeout(() => {
                        try { focusControl.requestFocus(DISABLE_PIN_ID); }
                        catch (_e) { /* dismissed */ }
                      }, 50);
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
                    this.changePinStep = 'oldPin';
                    this.refocusChangePin();
                  });

                Divider().color($r('sys.color.ohos_id_color_list_separator'));
              }

              Row() {
                Text(I18n.t($r('app.string.settings_lock_now'))).fontSize(15).layoutWeight(1)
                  .fontColor($r('sys.color.ohos_id_color_text_primary'));
                Text('›').fontSize(18)
                  .fontColor($r('sys.color.ohos_id_color_text_tertiary'));
              }.width('100%').padding({ top: 12, bottom: 12, left: 12, right: 12 })
                .onClick(() => this.lockNow());
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

      // ── PIN overlays — render at the Stack root so they float over scroll
      if (this.showSetupLock) {
        PinModalCard({
          opts: {
            title: this.pinStep === 'enter'
              ? I18n.t($r('app.string.settings_pin_set_prompt_enter'))
              : I18n.t($r('app.string.settings_pin_set_prompt_confirm')),
            subtitle: '',
            inputId: SETUP_PIN_ID,
            filled: (this.pinStep === 'enter' ? this.pinInput : this.pinConfirm).length,
            value: this.pinStep === 'enter' ? this.pinInput : this.pinConfirm,
            onChange: (v: string) => {
              const d = v.replace(/\D/g, '').slice(0, 4);
              if (this.pinStep === 'enter') {
                this.pinInput = d;
              } else {
                this.pinConfirm = d;
              }
              if (d.length === 4) this.submitSetupLock();
            },
            onCancel: () => {
              this.showSetupLock = false;
              this.pinInput = '';
              this.pinConfirm = '';
            },
          },
        });
      }

      if (this.showDisableLock) {
        PinModalCard({
          opts: {
            title: I18n.t($r('app.string.settings_pin_disable_prompt')),
            subtitle: '',
            inputId: DISABLE_PIN_ID,
            filled: this.pinInput.length,
            value: this.pinInput,
            onChange: (v: string) => {
              const d = v.replace(/\D/g, '').slice(0, 4);
              this.pinInput = d;
              if (d.length === 4) this.submitDisableLock();
            },
            onCancel: () => {
              this.showDisableLock = false;
              this.pinInput = '';
            },
          },
        });
      }

      if (this.showChangePin) {
        PinModalCard({
          opts: {
            title: this.changePinTitle(),
            subtitle: '',
            inputId: CHANGE_PIN_ID,
            filled: this.changePinValue().length,
            value: this.changePinValue(),
            onChange: (v: string) => {
              const d = v.replace(/\D/g, '').slice(0, 4);
              if (this.changePinStep === 'oldPin') {
                this.oldPinInput = d;
                if (d.length === 4) {
                  this.changePinStep = 'newPin';
                  this.refocusChangePin();
                }
              } else if (this.changePinStep === 'newPin') {
                this.pinInput = d;
                if (d.length === 4) {
                  this.changePinStep = 'confirm';
                  this.refocusChangePin();
                }
              } else {
                this.pinConfirm = d;
                if (d.length === 4) this.submitChangePin();
              }
            },
            onCancel: () => {
              this.showChangePin = false;
              this.oldPinInput = '';
              this.pinInput = '';
              this.pinConfirm = '';
              this.changePinStep = 'oldPin';
            },
          },
        });
      }
    }
    .width('100%').height('100%');
  }
}
