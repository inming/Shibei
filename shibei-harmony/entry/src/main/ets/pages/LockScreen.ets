import { hilog } from '@kit.PerformanceAnalysisKit';
import { router, promptAction } from '@kit.ArkUI';
// `focusControl` is a global ArkTS namespace (not a Kit export) — use it directly.
import { ShibeiService, ShibeiError } from '../services/ShibeiService';
import { LockService } from '../services/LockService';
import { I18n } from '../services/I18n';

const PIN_INPUT_ID = 'lockScreenPinInput';

// Phase 4 lock screen. Entry condition (EntryAbility routes here):
//   App Lock configured + MK NOT loaded.
// Primary path: bio auth → HUKS unwrap → unlock.
// Fallback: 4-digit PIN (auto-submit on full entry); throttle enforced by NAPI.
// Escape: "忘记 PIN" → E2EE password + new PIN.

type RecoveryStep = 'password' | 'newPin';

@Entry
@Component
struct LockScreen {
  @State pin: string = '';
  @State errorMsg: string = '';
  @State throttleSecs: number = 0;
  @State bioAvailable: boolean = false;
  @State showRecovery: boolean = false;
  @State recoveryPassword: string = '';
  @State recoveryNewPin: string = '';
  @State recoveryStep: RecoveryStep = 'password';
  @State recovering: boolean = false;

  private throttleTimer: number = -1;

  private autoBioAttempted: boolean = false;

  async aboutToAppear(): Promise<void> {
    this.bioAvailable = ShibeiService.instance.lockIsBioEnabled();
    this.throttleSecs = ShibeiService.instance.lockLockoutRemainingSecs();
    if (this.throttleSecs > 0) this.startThrottleCountdown();
    // Bio auto-trigger is moved to onPageShow — aboutToAppear fires before
    // the page is visible, and calling HUKS initSession that early hits
    // `ClientInit: client init send fail` / HUKS -30 (IPC msg fail).
  }

  onPageShow(): void {
    // PIN input focus (soft keyboard auto-pop). First call + 120ms fallback
    // for slow layout frames.
    if (!this.showRecovery && this.throttleSecs <= 0) {
      try { focusControl.requestFocus(PIN_INPUT_ID); }
      catch (e) { hilog.warn(0x0000, 'shibei', 'focus pin fail: %{public}s', (e as Error).message); }
      setTimeout(() => {
        if (!this.showRecovery && this.throttleSecs <= 0) {
          try { focusControl.requestFocus(PIN_INPUT_ID); }
          catch (e) { /* already focused */ }
        }
      }, 120);
    }

    // Auto-trigger biometric on every page show — once per page instance
    // so the prompt doesn't re-pop if the user cancelled. Delay 400ms so
    // HUKS service IPC is warm (calling too early → HUKS -30).
    if (this.bioAvailable && this.throttleSecs <= 0 && !this.showRecovery && !this.autoBioAttempted) {
      this.autoBioAttempted = true;
      setTimeout(() => {
        if (this.bioAvailable && this.throttleSecs <= 0 && !this.showRecovery) {
          this.tryBio();
        }
      }, 400);
    }
  }

  aboutToDisappear(): void {
    if (this.throttleTimer !== -1) {
      clearInterval(this.throttleTimer);
      this.throttleTimer = -1;
    }
  }

  private startThrottleCountdown(): void {
    if (this.throttleTimer !== -1) return;
    this.throttleTimer = setInterval(() => {
      this.throttleSecs = ShibeiService.instance.lockLockoutRemainingSecs();
      if (this.throttleSecs <= 0) {
        clearInterval(this.throttleTimer);
        this.throttleTimer = -1;
      }
    }, 1000);
  }

  private async tryBio(): Promise<void> {
    try {
      await LockService.instance.unlockWithBio();
      router.replaceUrl({ url: 'pages/Library' }).catch((err: Error) => {
        hilog.error(0x0000, 'shibei', 'route to Library fail: %{public}s', err.message);
      });
    } catch (e) {
      const code: string = e instanceof ShibeiError ? e.code : (e as Error).message;
      hilog.warn(0x0000, 'shibei', 'tryBio failed: %{public}s', code);
      if (code === 'error.bioRevoked') {
        this.errorMsg = I18n.t($r('app.string.lock_bio_revoked'));
        this.bioAvailable = false;
      } else if (code === 'error.bioAuthFailed' || code.startsWith('error.bioAuthFailed:')) {
        // User cancel / wrong finger — silent, user can retry via button.
      } else {
        // HUKS service errors, etc. Surface so user isn't confused by silence.
        this.errorMsg = I18n.t($r('app.string.lock_bio_failed'), I18n.translateError(code));
      }
    }
  }

  private async tryPinSubmit(): Promise<void> {
    if (this.pin.length !== 4) return;
    this.errorMsg = '';
    try {
      await LockService.instance.unlockWithPin(this.pin);
      this.pin = '';
      router.replaceUrl({ url: 'pages/Library' }).catch((err: Error) => {
        hilog.error(0x0000, 'shibei', 'route to Library fail: %{public}s', err.message);
      });
    } catch (e) {
      const code: string = e instanceof ShibeiError ? e.code : (e as Error).message;
      this.pin = '';
      if (code.startsWith('error.lockThrottled:')) {
        const parts = code.split(':');
        const parsed = parts.length > 1 ? parseInt(parts[1], 10) : 0;
        const secs = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
        this.throttleSecs = secs;
        if (secs > 0) {
          this.errorMsg = I18n.t($r('app.string.lock_throttle_too_many'), secs);
          this.startThrottleCountdown();
        } else {
          this.errorMsg = I18n.t($r('app.string.lock_pin_error'));
        }
      } else if (code === 'error.pinIncorrect') {
        this.errorMsg = I18n.t($r('app.string.lock_pin_error'));
      } else {
        this.errorMsg = I18n.t($r('app.string.lock_unlock_failed'), I18n.translateError(code));
      }
    }
  }

  private async submitRecovery(): Promise<void> {
    if (this.recoveryStep === 'password') {
      if (!this.recoveryPassword) return;
      this.recoveryStep = 'newPin';
      return;
    }
    if (!/^\d{4}$/.test(this.recoveryNewPin)) {
      promptAction.showToast({
        message: I18n.t($r('app.string.lock_recovery_pin_invalid')),
      });
      return;
    }
    this.recovering = true;
    try {
      await LockService.instance.recoverWithE2ee(this.recoveryPassword, this.recoveryNewPin);
      this.recoveryPassword = '';
      this.recoveryNewPin = '';
      router.replaceUrl({ url: 'pages/Library' }).catch((err: Error) => {
        hilog.error(0x0000, 'shibei', 'route to Library fail: %{public}s', err.message);
      });
    } catch (e) {
      const code: string = e instanceof ShibeiError ? e.code : (e as Error).message;
      promptAction.showToast({
        message: I18n.t($r('app.string.lock_recovery_failed'), I18n.translateError(code)),
      });
      this.recoveryStep = 'password';
      this.recoveryPassword = '';
    }
    this.recovering = false;
  }

  @Builder
  PinDots() {
    Row() {
      ForEach([0, 1, 2, 3], (i: number) => {
        Circle({ width: 14, height: 14 })
          .fill(i < this.pin.length ? $r('sys.color.ohos_id_color_text_primary') : Color.Transparent)
          .stroke($r('sys.color.ohos_id_color_text_tertiary'))
          .strokeWidth(1.5)
          .margin({ left: 8, right: 8 });
      }, (i: number) => String(i));
    }
    .justifyContent(FlexAlign.Center)
    .width('100%');
  }

  build() {
    Column() {
      if (!this.showRecovery) {
        Text(I18n.t($r('app.string.lock_title')))
          .fontSize(28).fontWeight(FontWeight.Bold)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .margin({ top: 80, bottom: 32 });

        this.PinDots();

        TextInput({ placeholder: '', text: this.pin })
          .id(PIN_INPUT_ID)
          .type(InputType.Number)
          .maxLength(4)
          .opacity(0)
          .height(1)
          .enabled(this.throttleSecs <= 0)
          .defaultFocus(true)
          .onChange((v: string) => {
            const digits = v.replace(/\D/g, '').slice(0, 4);
            this.pin = digits;
            if (digits.length === 4) this.tryPinSubmit();
          });

        if (this.errorMsg) {
          Text(this.errorMsg).fontSize(13)
            .fontColor($r('sys.color.ohos_id_color_warning'))
            .margin({ top: 24, left: 32, right: 32 })
            .textAlign(TextAlign.Center);
        }

        if (this.throttleSecs > 0) {
          Text(I18n.t($r('app.string.lock_throttle_seconds'), this.throttleSecs))
            .fontSize(12)
            .fontColor($r('sys.color.ohos_id_color_text_tertiary'))
            .margin({ top: 8 });
        }

        if (this.bioAvailable && this.throttleSecs <= 0) {
          Button(I18n.t($r('app.string.lock_use_biometric')))
            .backgroundColor(Color.Transparent)
            .fontColor($r('sys.color.ohos_id_color_emphasize'))
            .margin({ top: 48 })
            .onClick(() => this.tryBio());
        }

        Blank().layoutWeight(1);

        Text(I18n.t($r('app.string.lock_forgot_pin'))).fontSize(12)
          .fontColor($r('sys.color.ohos_id_color_text_tertiary'))
          .margin({ bottom: 32 })
          .onClick(() => {
            this.showRecovery = true;
            this.errorMsg = '';
            this.recoveryStep = 'password';
            this.recoveryPassword = '';
            this.recoveryNewPin = '';
          });
      } else {
        // Recovery: E2EE password → new PIN
        Text(this.recoveryStep === 'password'
          ? I18n.t($r('app.string.lock_recovery_password_step'))
          : I18n.t($r('app.string.lock_recovery_pin_step')))
          .fontSize(22).fontWeight(FontWeight.Bold)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .margin({ top: 80, bottom: 32 });

        if (this.recoveryStep === 'password') {
          TextInput({
            placeholder: I18n.t($r('app.string.lock_recovery_password_placeholder')),
            text: this.recoveryPassword,
          })
            .type(InputType.Password)
            .width('80%')
            .enabled(!this.recovering)
            .onChange((v: string) => { this.recoveryPassword = v; });
        } else {
          TextInput({
            placeholder: I18n.t($r('app.string.lock_recovery_new_pin_placeholder')),
            text: this.recoveryNewPin,
          })
            .type(InputType.Number)
            .maxLength(4)
            .width('80%')
            .enabled(!this.recovering)
            .onChange((v: string) => {
              this.recoveryNewPin = v.replace(/\D/g, '').slice(0, 4);
            });
        }

        Button(this.recovering
          ? I18n.t($r('app.string.common_processing'))
          : (this.recoveryStep === 'password'
            ? I18n.t($r('app.string.common_next_step'))
            : I18n.t($r('app.string.common_done'))))
          .width('80%').height(44)
          .enabled(!this.recovering)
          .margin({ top: 24 })
          .onClick(() => this.submitRecovery());

        Button(I18n.t($r('app.string.common_cancel')))
          .backgroundColor(Color.Transparent)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .enabled(!this.recovering)
          .margin({ top: 12 })
          .onClick(() => {
            this.showRecovery = false;
            this.recoveryStep = 'password';
            this.recoveryPassword = '';
            this.recoveryNewPin = '';
          });
      }
    }
    .width('100%').height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
    .alignItems(HorizontalAlign.Center);
  }
}
