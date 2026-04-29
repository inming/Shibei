import { hilog } from '@kit.PerformanceAnalysisKit';
import { promptAction } from '@kit.ArkUI';
import { ShibeiService, ShibeiError } from '../../services/ShibeiService';
import { I18n } from '../../services/I18n';
import { SettingsTopBar } from '../../components/SettingsTopBar';

const E2EE_PWD_ID = 'encryptionSettingsE2eePwd';

// Encryption sub-page. Two sub-states:
//   - vault unlocked: status row + a hint that password changes happen
//     on desktop (NAPI parity is intentionally deferred — no
//     change_encryption_password command yet on mobile).
//   - vault locked  : the same unlock-card flow that the old monolithic
//     Settings exposed at the top of the page (re-enter E2EE password
//     to repopulate MK in memory).

@Entry
@Component
struct EncryptionSettings {
  @State e2eeLocked: boolean = false;
  @State showUnlockE2ee: boolean = false;
  @State e2eePwdInput: string = '';
  @State e2eeUnlocking: boolean = false;
  @State e2eeUnlockError: string = '';

  aboutToAppear(): void {
    this.refreshE2eeLockState();
  }

  private refreshE2eeLockState(): void {
    try {
      this.e2eeLocked = ShibeiService.instance.hasSavedConfig()
        && !ShibeiService.instance.isUnlocked();
    } catch (err) {
      hilog.warn(0x0000, 'shibei', 'refreshE2eeLockState fail: %{public}s', (err as Error).message);
    }
  }

  private async submitUnlockE2ee(): Promise<void> {
    if (this.e2eeUnlocking) return;
    if (!this.e2eePwdInput) {
      this.e2eeUnlockError = I18n.t($r('app.string.unlock_e2ee_empty'));
      return;
    }
    this.e2eeUnlocking = true;
    this.e2eeUnlockError = '';
    try {
      await ShibeiService.instance.setE2eePassword(this.e2eePwdInput);
      this.showUnlockE2ee = false;
      this.e2eePwdInput = '';
      this.refreshE2eeLockState();
      promptAction.showToast({ message: I18n.t($r('app.string.unlock_e2ee_toast_ok')) });
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
      this.e2eeUnlockError = I18n.translateError(code);
      hilog.warn(0x0000, 'shibei', 'unlock e2ee fail: %{public}s', code);
    } finally {
      this.e2eeUnlocking = false;
    }
  }

  build() {
    Column() {
      SettingsTopBar({ title: I18n.t($r('app.string.settings_section_encryption')) });

      Scroll() {
        Column() {
          // ── Status row ──────────────────────────────────────
          Text(I18n.t($r('app.string.settings_encryption_status_title'))).fontSize(13)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ top: 16, left: 16, bottom: 4 });
          Column() {
            Row() {
              Text(this.e2eeLocked
                ? I18n.t($r('app.string.settings_encryption_status_locked'))
                : I18n.t($r('app.string.settings_encryption_status_unlocked')))
                .fontSize(15)
                .fontColor(this.e2eeLocked
                  ? $r('app.color.accent_danger')
                  : $r('sys.color.ohos_id_color_text_primary'))
                .layoutWeight(1);
            }
            .width('100%').padding({ top: 12, bottom: 12, left: 12, right: 12 });
          }
          .backgroundColor($r('sys.color.ohos_id_color_background')).borderRadius(8)
          .margin({ left: 12, right: 12 });

          // ── Unlock card (only when locked) ──────────────────
          if (this.e2eeLocked) {
            Column() {
              if (!this.showUnlockE2ee) {
                Row() {
                  Column() {
                    Text(I18n.t($r('app.string.unlock_e2ee_card_title')))
                      .fontSize(14)
                      .fontColor($r('app.color.accent_danger'))
                      .fontWeight(FontWeight.Medium);
                    Text(I18n.t($r('app.string.unlock_e2ee_card_hint')))
                      .fontSize(12).fontColor($r('app.color.text_secondary'))
                      .margin({ top: 2 });
                  }.alignItems(HorizontalAlign.Start).layoutWeight(1);
                  Button(I18n.t($r('app.string.unlock_e2ee_button')))
                    .height(32).fontSize(13)
                    .onClick(() => {
                      this.showUnlockE2ee = true;
                      this.e2eeUnlockError = '';
                      this.e2eePwdInput = '';
                      setTimeout(() => {
                        try { focusControl.requestFocus(E2EE_PWD_ID); }
                        catch (_e) { /* not mounted yet */ }
                      }, 50);
                    });
                }.width('100%').padding(12);
              } else {
                Column() {
                  Text(I18n.t($r('app.string.unlock_e2ee_prompt')))
                    .fontSize(14).margin({ top: 4 });
                  TextInput({
                    placeholder: I18n.t($r('app.string.unlock_e2ee_placeholder')),
                    text: this.e2eePwdInput,
                  })
                    .id(E2EE_PWD_ID)
                    .type(InputType.Password)
                    .defaultFocus(true)
                    .width('100%').margin({ top: 10 })
                    .onChange((v: string) => {
                      this.e2eePwdInput = v;
                      this.e2eeUnlockError = '';
                    })
                    .onSubmit(() => this.submitUnlockE2ee());
                  if (this.e2eeUnlockError) {
                    Text(this.e2eeUnlockError).fontSize(12)
                      .fontColor($r('app.color.accent_danger'))
                      .margin({ top: 6 });
                  }
                  Row() {
                    Button(I18n.t($r('app.string.common_cancel')))
                      .backgroundColor(Color.Transparent)
                      .fontColor($r('app.color.text_secondary'))
                      .layoutWeight(1)
                      .onClick(() => {
                        this.showUnlockE2ee = false;
                        this.e2eePwdInput = '';
                        this.e2eeUnlockError = '';
                      });
                    Button(this.e2eeUnlocking
                      ? I18n.t($r('app.string.unlock_e2ee_submitting'))
                      : I18n.t($r('app.string.unlock_e2ee_submit')))
                      .layoutWeight(1).margin({ left: 8 })
                      .enabled(!this.e2eeUnlocking)
                      .onClick(() => this.submitUnlockE2ee());
                  }.margin({ top: 12 });
                }.padding(12);
              }
            }
            .backgroundColor($r('sys.color.ohos_id_color_background')).borderRadius(8)
            .margin({ top: 16, left: 12, right: 12 });
          }

          // ── Password-change footnote ───────────────────────
          Text(I18n.t($r('app.string.settings_encryption_password_hint'))).fontSize(11)
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
