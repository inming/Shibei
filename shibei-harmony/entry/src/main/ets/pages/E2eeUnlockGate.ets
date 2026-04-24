import { hilog } from '@kit.PerformanceAnalysisKit';
import { router } from '@kit.ArkUI';
import { ShibeiService, ShibeiError } from '../services/ShibeiService';
import { I18n } from '../services/I18n';

const PWD_INPUT_ID = 'e2eeUnlockGatePwd';

// Cold-start E2EE unlock gate. Entry condition (EntryAbility routes here):
//   hasSavedConfig() && !isUnlocked() && App Lock NOT configured
// The user cannot dismiss — without MK loaded, S3 + snapshot decryption
// cannot run and the Library has nothing to show. On success → Library.
//
// This mirrors the recovery card in Settings (§7.7) but as a hard blocker
// at cold start. The Settings card is kept as a secondary surface in case
// the user ever reaches Settings without going through this gate (e.g.
// if future code adds a route that bypasses cold-start init).

@Entry
@Component
struct E2eeUnlockGate {
  @State password: string = '';
  @State errorMsg: string = '';
  @State submitting: boolean = false;

  onPageShow(): void {
    // Surface the soft keyboard on entry. First call + 120 ms fallback
    // for slow layout frames, matching the LockScreen PIN approach.
    try { focusControl.requestFocus(PWD_INPUT_ID); }
    catch (e) { hilog.warn(0x0000, 'shibei', 'focus e2ee pwd fail: %{public}s', (e as Error).message); }
    setTimeout(() => {
      try { focusControl.requestFocus(PWD_INPUT_ID); }
      catch (_e) { /* already focused */ }
    }, 120);
  }

  private async submit(): Promise<void> {
    if (this.submitting) return;
    if (!this.password) {
      this.errorMsg = I18n.t($r('app.string.unlock_e2ee_empty'));
      return;
    }
    this.submitting = true;
    this.errorMsg = '';
    try {
      await ShibeiService.instance.setE2eePassword(this.password);
      this.password = '';
      router.replaceUrl({ url: 'pages/Library' }).catch((err: Error) => {
        hilog.error(0x0000, 'shibei', 'route to Library fail: %{public}s', err.message);
      });
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
      this.errorMsg = I18n.translateError(code);
      hilog.warn(0x0000, 'shibei', 'e2ee unlock gate fail: %{public}s', code);
    } finally {
      this.submitting = false;
    }
  }

  build() {
    Column() {
      Text(I18n.t($r('app.string.unlock_e2ee_gate_title')))
        .fontSize(28).fontWeight(FontWeight.Bold)
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
        .margin({ top: 100, bottom: 12 });

      Text(I18n.t($r('app.string.unlock_e2ee_gate_subtitle')))
        .fontSize(14)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .margin({ left: 32, right: 32, bottom: 40 })
        .textAlign(TextAlign.Center);

      TextInput({ placeholder: I18n.t($r('app.string.unlock_e2ee_placeholder')), text: this.password })
        .id(PWD_INPUT_ID)
        .type(InputType.Password)
        .width('80%')
        .enabled(!this.submitting)
        .defaultFocus(true)
        .onChange((v: string) => {
          this.password = v;
          this.errorMsg = '';
        })
        .onSubmit(() => this.submit());

      if (this.errorMsg) {
        Text(this.errorMsg).fontSize(13)
          .fontColor($r('sys.color.ohos_id_color_warning'))
          .margin({ top: 16, left: 32, right: 32 })
          .textAlign(TextAlign.Center);
      }

      Button(this.submitting
        ? I18n.t($r('app.string.unlock_e2ee_submitting'))
        : I18n.t($r('app.string.unlock_e2ee_submit')))
        .width('80%').height(44)
        .enabled(!this.submitting)
        .margin({ top: 24 })
        .onClick(() => this.submit());

      Blank().layoutWeight(1);
    }
    .width('100%').height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
    .alignItems(HorizontalAlign.Center);
  }
}
