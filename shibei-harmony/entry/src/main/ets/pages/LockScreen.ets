import { hilog } from '@kit.PerformanceAnalysisKit';
import { router } from '@kit.ArkUI';
import { ShibeiService, ShibeiError } from '../services/ShibeiService';

// Displayed after Settings → 安全 → 立即锁定 is tapped, or when cold-start
// routing detects `hasSavedConfig() && !isUnlocked()`. Only ask for the
// E2EE password — S3 config is already saved; we just need to re-derive
// the Master Key before sync can resume.
//
// Unlike Onboard step 3, there's no "return" path: the user must enter
// the correct password to proceed. They can long-press the title (dev
// escape hatch) to reach the demo menu.

@Entry
@Component
struct LockScreen {
  @State password: string = '';
  @State unlocking: boolean = false;
  @State error: string = '';

  private async tryUnlock(): Promise<void> {
    if (!this.password) {
      this.error = '请输入密码';
      return;
    }
    this.unlocking = true;
    this.error = '';
    try {
      await ShibeiService.instance.setE2eePassword(this.password);
      this.password = '';
      router.replaceUrl({ url: 'pages/Demo11Library' }).catch((err: Error) => {
        hilog.error(0x0000, 'shibei', 'replaceUrl fail: %{public}s', err.message);
      });
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : err.message;
      this.error = `解锁失败: ${code}`;
    }
    this.unlocking = false;
  }

  build() {
    Column() {
      Text('已锁定').fontSize(28).fontWeight(FontWeight.Bold).margin({ top: 120, bottom: 8 })
        .gesture(
          LongPressGesture({ duration: 2000 }).onAction(() => {
            router.pushUrl({ url: 'pages/Index' }).catch((err: Error) => {
              hilog.warn(0x0000, 'shibei', 'dev-menu pushUrl fail: %{public}s', err.message);
            });
          })
        );
      Text('输入加密密码以继续').fontSize(13).fontColor('#888').margin({ bottom: 48 });

      TextInput({ placeholder: '密码', text: this.password })
        .type(InputType.Password)
        .width('80%')
        .onChange((v: string) => this.password = v)
        .onSubmit(() => this.tryUnlock());

      if (this.error) {
        Text(this.error).fontSize(12).fontColor('#d33').margin({ top: 12 });
      }

      Button(this.unlocking ? '解锁中…' : '解锁')
        .width('80%').height(44).margin({ top: 24 })
        .enabled(!this.unlocking)
        .onClick(() => this.tryUnlock());
    }
    .width('100%').height('100%')
    .alignItems(HorizontalAlign.Center);
  }
}
