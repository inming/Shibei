import { hilog } from '@kit.PerformanceAnalysisKit';
import { router, promptAction } from '@kit.ArkUI';
import { ShibeiService, ShibeiError } from '../services/ShibeiService';
import { LockService } from '../services/LockService';

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

  async aboutToAppear(): Promise<void> {
    this.bioAvailable = ShibeiService.instance.lockIsBioEnabled();
    this.throttleSecs = ShibeiService.instance.lockLockoutRemainingSecs();
    if (this.throttleSecs > 0) this.startThrottleCountdown();
    // Auto-trigger biometric if enabled and not throttled.
    if (this.bioAvailable && this.throttleSecs <= 0) {
      await this.tryBio();
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
      if (code === 'error.bioRevoked') {
        this.errorMsg = '指纹库已变更,请用 PIN 解锁后在设置里重新启用生物识别';
        this.bioAvailable = false;
      }
      // Other failures (user-cancel, auth-fail) silently fall back to PIN input.
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
          this.errorMsg = `连续错误,${secs} 秒后再试`;
          this.startThrottleCountdown();
        } else {
          this.errorMsg = 'PIN 错误';
        }
      } else if (code === 'error.pinIncorrect') {
        this.errorMsg = 'PIN 错误';
      } else {
        this.errorMsg = `解锁失败: ${code}`;
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
      promptAction.showToast({ message: '新 PIN 必须是 4 位数字' });
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
      promptAction.showToast({ message: `恢复失败: ${code}` });
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
        Text('已锁定').fontSize(28).fontWeight(FontWeight.Bold)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .margin({ top: 80, bottom: 32 });

        this.PinDots();

        TextInput({ placeholder: '', text: this.pin })
          .type(InputType.Number)
          .maxLength(4)
          .opacity(0)
          .height(1)
          .enabled(this.throttleSecs <= 0)
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
          Text(`${this.throttleSecs} 秒后可重试`).fontSize(12)
            .fontColor($r('sys.color.ohos_id_color_text_tertiary'))
            .margin({ top: 8 });
        }

        if (this.bioAvailable && this.throttleSecs <= 0) {
          Button('使用生物识别')
            .backgroundColor(Color.Transparent)
            .fontColor($r('sys.color.ohos_id_color_emphasize'))
            .margin({ top: 48 })
            .onClick(() => this.tryBio());
        }

        Blank().layoutWeight(1);

        Text('忘记 PIN?').fontSize(12)
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
        Text(this.recoveryStep === 'password' ? '输入 E2EE 密码' : '设置新 PIN')
          .fontSize(22).fontWeight(FontWeight.Bold)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .margin({ top: 80, bottom: 32 });

        if (this.recoveryStep === 'password') {
          TextInput({ placeholder: 'E2EE 密码', text: this.recoveryPassword })
            .type(InputType.Password)
            .width('80%')
            .enabled(!this.recovering)
            .onChange((v: string) => { this.recoveryPassword = v; });
        } else {
          TextInput({ placeholder: '4 位数字新 PIN', text: this.recoveryNewPin })
            .type(InputType.Number)
            .maxLength(4)
            .width('80%')
            .enabled(!this.recovering)
            .onChange((v: string) => {
              this.recoveryNewPin = v.replace(/\D/g, '').slice(0, 4);
            });
        }

        Button(this.recovering
          ? '处理中…'
          : (this.recoveryStep === 'password' ? '下一步' : '完成'))
          .width('80%').height(44)
          .enabled(!this.recovering)
          .margin({ top: 24 })
          .onClick(() => this.submitRecovery());

        Button('取消')
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
