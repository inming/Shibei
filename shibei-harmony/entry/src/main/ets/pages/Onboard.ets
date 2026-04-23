import { hilog } from '@kit.PerformanceAnalysisKit';
import { common } from '@kit.AbilityKit';
import { scanBarcode, scanCore } from '@kit.ScanKit';
import { router, promptAction } from '@kit.ArkUI';
import {
  ShibeiService,
  ShibeiError,
  S3ConfigInput,
  SyncResult,
  SyncResultSuccess,
  SyncProgressEvent,
} from '../services/ShibeiService';
import { LockService } from '../services/LockService';
import { I18n } from '../services/I18n';
// Track C — 4-step Onboard wizard wrapping the Demo 12 flow:
//   Welcome → Config (scan/form + save) → Password unlock → First sync
// After the final sync completes the user is replaced into Demo 11 Library.
// On failure in any step the user stays on that step and sees an error; a
// "返回上一步" button keeps them from getting stuck.
//
// Step 2 scan failure is non-fatal: the form stays editable so the user can
// fall back to typing S3 config manually.

@Entry
@Component
struct Onboard {
  @State currentStep: number = 0;          // 0 welcome | 1 config | 2 password | 3 sync | 4 lock-enroll
  @State dataDir: string = '';
  @State initError: string = '';

  // Step 4 — optional App Lock enrollment
  @State onboardPinInput: string = '';
  @State onboardPinConfirm: string = '';
  @State onboardPinStep: 'enter' | 'confirm' = 'enter';
  @State onboardPinError: string = '';
  @State enrollingLock: boolean = false;

// Step 1 — S3 config
  @State endpoint: string = 'https://';
  @State region: string = '';
  @State bucket: string = '';
  @State accessKey: string = '';
  @State secretKey: string = '';
  @State scanInfo: string = '';
  @State configError: string = '';
  @State savingConfig: boolean = false;
  @State pinInput: string = '';
  @State scannedEnvelope: string = '';

  // Step 2 — password
  @State password: string = '';
  @State unlocking: boolean = false;
  @State unlockError: string = '';

  // Step 3 — first sync (reuses A5+D progress bar)
  @State syncing: boolean = false;
  @State syncError: string = '';
  @State syncSummary: string = '';
  @State showProgress: boolean = false;
  @State progressPhase: string = '';
  @State progressCurrent: number = 0;
  @State progressTotal: number = 0;

  private unsubProgress: (() => void) | null = null;

  async aboutToAppear(): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    this.dataDir = ctx.filesDir;
    try {
      await ShibeiService.instance.init(ctx);
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : err.message;
      this.initError = code;
      hilog.error(0x0000, 'shibei', 'Onboard init fail: %{public}s', code);
    }
    // The sync-progress subscription lives for the whole wizard so we can
    // wire it once here rather than in step 3. Unsubscribed in
    // aboutToDisappear / before routing into Library.
    this.unsubProgress = ShibeiService.instance.onSyncProgress((ev: SyncProgressEvent) => {
      if (ev.phase === 'done') {
        this.progressPhase = 'done';
        this.progressCurrent = this.progressTotal;
        setTimeout(() => { this.showProgress = false; }, 400);
        return;
      }
      this.showProgress = true;
      this.progressPhase = ev.phase;
      this.progressCurrent = ev.current;
      this.progressTotal = ev.total;
    });
  }

  aboutToDisappear(): void {
    if (this.unsubProgress) {
      this.unsubProgress();
      this.unsubProgress = null;
    }
  }

  // ── Step 1: scan / form → save S3 config ──────────────────────

  private async runScan(): Promise<void> {
    this.scanInfo = I18n.t($r('app.string.onboard_scan_opening'));
    try {
      const options: scanBarcode.ScanOptions = {
        scanTypes: [scanCore.ScanType.QR_CODE],
        enableMultiMode: false,
        enableAlbum: true,
      };
      const result: scanBarcode.ScanResult = await scanBarcode.startScanForResult(
        getContext(this), options);
      if (!result.originalValue) {
        this.scanInfo = I18n.t($r('app.string.onboard_scan_cancelled'));
        return;
      }
      this.scannedEnvelope = result.originalValue;
      this.scanInfo = I18n.t(
        $r('app.string.onboard_scan_success_info'), result.originalValue.length);
    } catch (err) {
      this.scanInfo = I18n.t($r('app.string.onboard_scan_failed'), I18n.translateError(err.message));
      hilog.warn(0x0000, 'shibei', 'scan fail: %{public}s', err.message);
    }
  }

  private applyPin(): void {
    if (!this.scannedEnvelope) {
      this.scanInfo = I18n.t($r('app.string.onboard_scan_not_yet'));
      return;
    }
    if (!/^\d{6}$/.test(this.pinInput)) {
      this.scanInfo = I18n.t($r('app.string.onboard_pin_must_be_6_digits'));
      return;
    }
    try {
      const cfg: S3ConfigInput = ShibeiService.instance.decryptPairingPayload(
        this.pinInput, this.scannedEnvelope);
      this.endpoint = cfg.endpoint ?? '';
      this.region = cfg.region;
      this.bucket = cfg.bucket;
      this.accessKey = cfg.accessKey;
      this.secretKey = cfg.secretKey;
      this.scanInfo = I18n.t($r('app.string.onboard_decrypt_success'));
      this.pinInput = '';
      this.scannedEnvelope = '';
      promptAction.showToast({
        message: I18n.t($r('app.string.onboard_scan_toast')),
        duration: 1200,
      });
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : err.message;
      this.scanInfo = I18n.t($r('app.string.onboard_decrypt_failed'), I18n.translateError(code));
    }
  }

  private async saveConfigAndAdvance(): Promise<void> {
    const cfg: S3ConfigInput = {
      endpoint: this.endpoint.trim() ? this.endpoint.trim() : undefined,
      region: this.region.trim(),
      bucket: this.bucket.trim(),
      accessKey: this.accessKey.trim(),
      secretKey: this.secretKey.trim(),
    };
    if (!cfg.region || !cfg.bucket || !cfg.accessKey || !cfg.secretKey) {
      this.configError = I18n.t($r('app.string.onboard_config_required'));
      return;
    }
    this.savingConfig = true;
    this.configError = '';
    try {
      await ShibeiService.instance.setS3Config(cfg);
      this.currentStep = 2;
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : err.message;
      this.configError = I18n.t($r('app.string.onboard_config_save_failed'), I18n.translateError(code));
    }
    this.savingConfig = false;
  }

  // ── Step 2: E2EE unlock ───────────────────────────────────────

  private async tryUnlockAndAdvance(): Promise<void> {
    if (!this.password) {
      this.unlockError = I18n.t($r('app.string.onboard_password_required'));
      return;
    }
    this.unlocking = true;
    this.unlockError = '';
    try {
      await ShibeiService.instance.setE2eePassword(this.password);
      this.password = '';   // scrub — we never need the plaintext again
      this.currentStep = 3;
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : err.message;
      this.unlockError = I18n.t($r('app.string.onboard_unlock_failed'), I18n.translateError(code));
    }
    this.unlocking = false;
  }

  // ── Step 3: first sync → Library ──────────────────────────────

  private async runFirstSync(): Promise<void> {
    this.syncing = true;
    this.syncError = '';
    this.syncSummary = '';
    this.progressPhase = '';
    this.progressCurrent = 0;
    this.progressTotal = 0;
    this.showProgress = false;
    try {
      const result: SyncResult = await ShibeiService.instance.syncMetadata();
      if (result.kind === 'success') {
        const r = result as SyncResultSuccess;
        this.syncSummary = I18n.t(
          $r('app.string.onboard_sync_summary'), r.uploaded, r.downloaded, r.applied);
      } else {
        this.syncSummary = I18n.t($r('app.string.onboard_sync_skipped'));
      }
      // Small delay so the 400ms "done" tick from the progress bar finishes
      // animating before advancing to the optional app-lock enrollment step.
      setTimeout(() => {
        this.currentStep = 4;
      }, 600);
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : err.message;
      this.syncError = I18n.t($r('app.string.onboard_sync_failed'), I18n.translateError(code));
      this.showProgress = false;
    }
    this.syncing = false;
  }

  private enterLibrary(): void {
    router.replaceUrl({ url: 'pages/Library' }).catch((err: Error) => {
      hilog.error(0x0000, 'shibei', 'replaceUrl fail: %{public}s', err.message);
    });
  }

  // ── Step 4: optional App Lock enrollment ──────────────────────

  private async submitOnboardPin(): Promise<void> {
    if (this.onboardPinStep === 'enter') {
      if (!/^\d{4}$/.test(this.onboardPinInput)) {
        this.onboardPinError = I18n.t($r('app.string.onboard_lock_enroll_pin_invalid'));
        return;
      }
      this.onboardPinError = '';
      this.onboardPinConfirm = '';
      this.onboardPinStep = 'confirm';
      return;
    }
    if (this.onboardPinConfirm !== this.onboardPinInput) {
      this.onboardPinError = I18n.t($r('app.string.onboard_lock_enroll_pin_mismatch'));
      this.onboardPinStep = 'enter';
      this.onboardPinInput = '';
      this.onboardPinConfirm = '';
      return;
    }
    this.enrollingLock = true;
    try {
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
      const wantBio = dlg.index === 1;
      await LockService.instance.setupPin(this.onboardPinInput, wantBio);
      this.onboardPinInput = '';
      this.onboardPinConfirm = '';
      this.enterLibrary();
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
      this.onboardPinError = I18n.t($r('app.string.onboard_lock_enroll_failed'), I18n.translateError(code));
      this.onboardPinStep = 'enter';
      this.onboardPinInput = '';
      this.onboardPinConfirm = '';
    }
    this.enrollingLock = false;
  }

  private skipAppLock(): void {
    this.enterLibrary();
  }

  private phaseLabel(phase: string): string {
    if (phase === 'uploading') return I18n.t($r('app.string.onboard_phase_uploading'));
    if (phase === 'downloading') return I18n.t($r('app.string.onboard_phase_downloading'));
    if (phase === 'downloading_snapshots') return I18n.t($r('app.string.onboard_phase_downloading_snapshots'));
    if (phase === 'done') return I18n.t($r('app.string.onboard_phase_done'));
    return phase;
  }

  // ── Render ────────────────────────────────────────────────────

  build() {
    Stack() {
      if (this.currentStep === 0) {
        this.StepWelcome();
      } else if (this.currentStep === 1) {
        this.StepConfig();
      } else if (this.currentStep === 2) {
        this.StepPassword();
      } else if (this.currentStep === 3) {
        this.StepSync();
      } else {
        this.StepLockEnroll();
      }
    }.width('100%').height('100%');
  }

  @Builder
  StepWelcome() {
    Column() {
      Text(I18n.t($r('app.string.onboard_app_name')))
        .fontSize(36).fontWeight(FontWeight.Bold).margin({ top: 120, bottom: 12 });
      Text(I18n.t($r('app.string.onboard_app_tagline')))
        .fontSize(16).fontColor($r('app.color.text_secondary')).margin({ bottom: 48 });
      Text(I18n.t($r('app.string.onboard_welcome_body')))
        .fontSize(14).fontColor($r('app.color.text_tertiary')).textAlign(TextAlign.Center)
        .padding({ left: 32, right: 32 }).margin({ bottom: 48 });
      if (this.initError) {
        Text(I18n.t($r('app.string.common_init_failed'), this.initError))
          .fontSize(12).fontColor($r('app.color.accent_danger')).margin({ bottom: 16 });
      }
      Button(I18n.t($r('app.string.onboard_start')))
        .width('70%').height(48)
        .enabled(!this.initError)
        .onClick(() => { this.currentStep = 1; });
      Text(I18n.t($r('app.string.onboard_step_indicator'), 1, 4))
        .fontSize(11).fontColor($r('app.color.text_pagenum')).margin({ top: 64 });
    }
    .width('100%').height('100%')
    .alignItems(HorizontalAlign.Center);
  }

  @Builder
  StepConfig() {
    Scroll() {
      Column() {
        Text(I18n.t($r('app.string.onboard_step2_title')))
          .fontSize(22).fontWeight(FontWeight.Bold).margin({ top: 48, bottom: 8 });
        Text(I18n.t($r('app.string.onboard_step2_body')))
          .fontSize(12).fontColor($r('app.color.text_tertiary')).margin({ bottom: 24 });

        // Scan flow
        Text(I18n.t($r('app.string.onboard_method_a_title')))
          .fontSize(14).fontWeight(FontWeight.Medium);
        Text(I18n.t($r('app.string.onboard_method_a_hint')))
          .fontSize(11).fontColor($r('app.color.text_tertiary'))
          .margin({ top: 2, bottom: 8 });
        Row() {
          Button(I18n.t($r('app.string.onboard_scan_button')))
            .layoutWeight(1).margin({ right: 8 })
            .onClick(() => this.runScan());
          TextInput({
            placeholder: I18n.t($r('app.string.onboard_pin_placeholder_6')),
            text: this.pinInput,
          })
            .type(InputType.Number).maxLength(6).layoutWeight(1)
            .onChange((v: string) => this.pinInput = v);
          Button(I18n.t($r('app.string.onboard_apply_pin')))
            .layoutWeight(1).margin({ left: 8 })
            .onClick(() => this.applyPin());
        };
        if (this.scanInfo) {
          Text(this.scanInfo).fontSize(11)
            .fontColor($r('app.color.text_secondary')).margin({ top: 4 });
        }

        // Manual form
        Text(I18n.t($r('app.string.onboard_method_b_title')))
          .fontSize(14).fontWeight(FontWeight.Medium).margin({ top: 24, bottom: 8 });
        TextInput({
          placeholder: I18n.t($r('app.string.onboard_endpoint_placeholder')),
          text: this.endpoint,
        })
          .onChange((v: string) => this.endpoint = v).margin({ bottom: 6 });
        TextInput({
          placeholder: I18n.t($r('app.string.onboard_region_placeholder')),
          text: this.region,
        })
          .onChange((v: string) => this.region = v).margin({ bottom: 6 });
        TextInput({
          placeholder: I18n.t($r('app.string.onboard_bucket_placeholder')),
          text: this.bucket,
        })
          .onChange((v: string) => this.bucket = v).margin({ bottom: 6 });
        TextInput({
          placeholder: I18n.t($r('app.string.onboard_access_key_placeholder')),
          text: this.accessKey,
        })
          .onChange((v: string) => this.accessKey = v).margin({ bottom: 6 });
        TextInput({
          placeholder: I18n.t($r('app.string.onboard_secret_key_placeholder')),
          text: this.secretKey,
        })
          .type(InputType.Password)
          .onChange((v: string) => this.secretKey = v).margin({ bottom: 6 });

        if (this.configError) {
          Text(this.configError).fontSize(12)
            .fontColor($r('app.color.accent_danger')).margin({ top: 8 });
        }

        Row() {
          Button(I18n.t($r('app.string.common_prev_step')))
            .layoutWeight(1).margin({ right: 8 })
            .backgroundColor($r('app.color.bg_button_neutral'))
            .fontColor($r('app.color.text_primary'))
            .onClick(() => { this.currentStep = 0; });
          Button(this.savingConfig
            ? I18n.t($r('app.string.onboard_saving'))
            : I18n.t($r('app.string.common_next_step')))
            .layoutWeight(1).enabled(!this.savingConfig)
            .onClick(() => this.saveConfigAndAdvance());
        }.margin({ top: 24 });

        Text(I18n.t($r('app.string.onboard_step_indicator'), 2, 4))
          .fontSize(11).fontColor($r('app.color.text_pagenum')).textAlign(TextAlign.Center)
          .width('100%').margin({ top: 16, bottom: 24 });
      }
      .padding({ left: 20, right: 20 })
      .alignItems(HorizontalAlign.Start);
    }.width('100%').height('100%');
  }

  @Builder
  StepPassword() {
    Column() {
      Text(I18n.t($r('app.string.onboard_step3_title')))
        .fontSize(22).fontWeight(FontWeight.Bold).margin({ top: 80, bottom: 8 });
      Text(I18n.t($r('app.string.onboard_step3_body')))
        .fontSize(12).fontColor($r('app.color.text_tertiary'))
        .padding({ left: 32, right: 32 }).textAlign(TextAlign.Center)
        .margin({ bottom: 40 });
      TextInput({
        placeholder: I18n.t($r('app.string.onboard_password_placeholder')),
        text: this.password,
      })
        .type(InputType.Password)
        .width('80%')
        .onChange((v: string) => this.password = v);
      if (this.unlockError) {
        Text(this.unlockError).fontSize(12)
          .fontColor($r('app.color.accent_danger')).margin({ top: 12 });
      }
      Row() {
        Button(I18n.t($r('app.string.common_prev_step')))
          .layoutWeight(1).margin({ right: 8 })
          .backgroundColor($r('app.color.bg_button_neutral'))
          .fontColor($r('app.color.text_primary'))
          .onClick(() => { this.currentStep = 1; });
        Button(this.unlocking
          ? I18n.t($r('app.string.onboard_unlocking'))
          : I18n.t($r('app.string.onboard_unlock')))
          .layoutWeight(1).enabled(!this.unlocking)
          .onClick(() => this.tryUnlockAndAdvance());
      }.width('80%').margin({ top: 24 });

      Text(I18n.t($r('app.string.onboard_step_indicator'), 3, 4))
        .fontSize(11).fontColor($r('app.color.text_pagenum')).margin({ top: 64 });
    }
    .width('100%').height('100%')
    .alignItems(HorizontalAlign.Center);
  }

  @Builder
  StepSync() {
    Column() {
      Text(I18n.t($r('app.string.onboard_step4_title')))
        .fontSize(22).fontWeight(FontWeight.Bold).margin({ top: 80, bottom: 8 });
      Text(I18n.t($r('app.string.onboard_step4_body')))
        .fontSize(12).fontColor($r('app.color.text_tertiary'))
        .padding({ left: 32, right: 32 }).textAlign(TextAlign.Center)
        .margin({ bottom: 40 });

      if (this.showProgress) {
        Progress({
          value: this.progressCurrent,
          total: this.progressTotal > 0 ? this.progressTotal : 1,
          type: ProgressType.Linear,
        }).width('80%');
        Text(`${this.phaseLabel(this.progressPhase)} ${this.progressCurrent}/${this.progressTotal}`)
          .fontSize(11).fontColor($r('app.color.text_secondary')).margin({ top: 6 });
      }

      if (this.syncSummary) {
        Text(this.syncSummary).fontSize(12)
          .fontColor($r('app.color.accent_success')).margin({ top: 12 });
      }
      if (this.syncError) {
        Text(this.syncError).fontSize(12)
          .fontColor($r('app.color.accent_danger')).margin({ top: 12 });
      }

      Row() {
        // 允许在失败后回到密码页(有可能是 MK 错,想重新解锁)
        Button(I18n.t($r('app.string.common_prev_step')))
          .layoutWeight(1).margin({ right: 8 })
          .backgroundColor($r('app.color.bg_button_neutral'))
          .fontColor($r('app.color.text_primary'))
          .enabled(!this.syncing)
          .onClick(() => { this.currentStep = 2; });
        Button(this.syncing
          ? I18n.t($r('app.string.settings_sync_in_progress'))
          : (this.syncError
            ? I18n.t($r('app.string.common_retry'))
            : I18n.t($r('app.string.onboard_sync_start'))))
          .layoutWeight(1).enabled(!this.syncing)
          .onClick(() => this.runFirstSync());
      }.width('80%').margin({ top: 24 });

      Text(I18n.t($r('app.string.onboard_step_indicator'), 4, 4))
        .fontSize(11).fontColor($r('app.color.text_pagenum')).margin({ top: 48 });
    }
    .width('100%').height('100%')
    .alignItems(HorizontalAlign.Center);
  }

  @Builder
  StepLockEnroll() {
    Column() {
      Text(I18n.t($r('app.string.onboard_lock_enroll_title')))
        .fontSize(22).fontWeight(FontWeight.Bold)
        .margin({ top: 80, bottom: 12 });
      Text(I18n.t($r('app.string.onboard_lock_enroll_body')))
        .fontSize(13).fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .margin({ left: 32, right: 32, bottom: 48 })
        .textAlign(TextAlign.Center);

      Text(this.onboardPinStep === 'enter'
        ? I18n.t($r('app.string.onboard_lock_enroll_enter'))
        : I18n.t($r('app.string.onboard_lock_enroll_confirm')))
        .fontSize(14)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .margin({ bottom: 12 });

      TextInput({
        placeholder: '',
        text: this.onboardPinStep === 'enter' ? this.onboardPinInput : this.onboardPinConfirm,
      })
        .type(InputType.Number)
        .maxLength(4)
        .width('60%')
        .enabled(!this.enrollingLock)
        .onChange((v: string) => {
          const d = v.replace(/\D/g, '').slice(0, 4);
          if (this.onboardPinStep === 'enter') {
            this.onboardPinInput = d;
          } else {
            this.onboardPinConfirm = d;
          }
          if (d.length === 4) this.submitOnboardPin();
        });

      if (this.onboardPinError) {
        Text(this.onboardPinError).fontSize(12)
          .fontColor($r('sys.color.ohos_id_color_warning'))
          .margin({ top: 12, left: 32, right: 32 })
          .textAlign(TextAlign.Center);
      }

      Blank().layoutWeight(1);

      Button(I18n.t($r('app.string.onboard_lock_skip'))).width('80%').height(44)
        .backgroundColor(Color.Transparent)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .enabled(!this.enrollingLock)
        .margin({ bottom: 32 })
        .onClick(() => this.skipAppLock());
    }
    .width('100%').height('100%')
    .alignItems(HorizontalAlign.Center);
  }
}
