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
import { runSpike } from '../app/HuksSpike';

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
  @State currentStep: number = 0;          // 0 welcome | 1 config | 2 password | 3 sync
  @State dataDir: string = '';
  @State initError: string = '';

  // Phase 4 HUKS spike — throwaway hidden trigger (5 long-presses on title)
  @State private spikeCounter: number = 0;

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
    this.scanInfo = '打开扫描中…';
    try {
      const options: scanBarcode.ScanOptions = {
        scanTypes: [scanCore.ScanType.QR_CODE],
        enableMultiMode: false,
        enableAlbum: true,
      };
      const result: scanBarcode.ScanResult = await scanBarcode.startScanForResult(
        getContext(this), options);
      if (!result.originalValue) {
        this.scanInfo = '已取消扫描';
        return;
      }
      this.scannedEnvelope = result.originalValue;
      this.scanInfo = `扫码成功 (${result.originalValue.length} 字节),请在下方输入 6 位 PIN`;
    } catch (err) {
      this.scanInfo = `扫码失败: ${err.message}`;
      hilog.warn(0x0000, 'shibei', 'scan fail: %{public}s', err.message);
    }
  }

  private applyPin(): void {
    if (!this.scannedEnvelope) {
      this.scanInfo = '尚未扫码';
      return;
    }
    if (!/^\d{6}$/.test(this.pinInput)) {
      this.scanInfo = 'PIN 必须是 6 位数字';
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
      this.scanInfo = '解密成功,5 项配置已自动填入';
      this.pinInput = '';
      this.scannedEnvelope = '';
      promptAction.showToast({ message: '扫码成功', duration: 1200 });
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : err.message;
      this.scanInfo = `解密失败: ${code}`;
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
      this.configError = '请填写 region / bucket / accessKey / secretKey(endpoint 可留空,走 AWS)';
      return;
    }
    this.savingConfig = true;
    this.configError = '';
    try {
      ShibeiService.instance.setS3Config(cfg);
      this.currentStep = 2;
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : err.message;
      this.configError = `保存失败: ${code}`;
    }
    this.savingConfig = false;
  }

  // ── Step 2: E2EE unlock ───────────────────────────────────────

  private async tryUnlockAndAdvance(): Promise<void> {
    if (!this.password) {
      this.unlockError = '请输入密码';
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
      this.unlockError = `解锁失败: ${code}`;
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
        this.syncSummary = `同步完成:上传 ${r.uploaded} 条,下载 ${r.downloaded} 条,应用 ${r.applied} 条`;
      } else {
        this.syncSummary = '同步已跳过(已在进行中?)';
      }
      // Small delay so the 400ms "done" tick from the progress bar finishes
      // animating before the page replaces.
      setTimeout(() => this.enterLibrary(), 600);
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : err.message;
      this.syncError = `同步失败: ${code}`;
      this.showProgress = false;
    }
    this.syncing = false;
  }

  private enterLibrary(): void {
    router.replaceUrl({ url: 'pages/Library' }).catch((err: Error) => {
      hilog.error(0x0000, 'shibei', 'replaceUrl fail: %{public}s', err.message);
    });
  }

  // Phase 4 HUKS spike — throwaway. 5 consecutive long-presses on the welcome
  // title runs the spike and shows the result in a dialog.
  private async handleSpikeLongPress(): Promise<void> {
    this.spikeCounter += 1;
    if (this.spikeCounter < 5) {
      return;
    }
    this.spikeCounter = 0;
    try {
      const result: string = await runSpike();
      promptAction.showDialog({
        title: 'HUKS Spike',
        message: result,
        buttons: [{ text: 'OK', color: '#333' }],
      });
    } catch (err) {
      const msg: string = err instanceof Error ? err.message : String(err);
      promptAction.showDialog({
        title: 'HUKS Spike',
        message: `spike threw: ${msg}`,
        buttons: [{ text: 'OK', color: '#333' }],
      });
    }
  }

  private phaseLabel(phase: string): string {
    if (phase === 'uploading') return '上传本地变更';
    if (phase === 'downloading') return '下载远端变更';
    if (phase === 'downloading_snapshots') return '下载快照';
    if (phase === 'done') return '完成';
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
      } else {
        this.StepSync();
      }
    }.width('100%').height('100%');
  }

  @Builder
  StepWelcome() {
    Column() {
      Text('拾贝').fontSize(36).fontWeight(FontWeight.Bold).margin({ top: 120, bottom: 12 })
        .gesture(LongPressGesture().onAction(() => { this.handleSpikeLongPress(); }));
      Text('个人只读资料库').fontSize(16).fontColor('#666').margin({ bottom: 48 });
      Text('连接你的桌面端,同步书签、笔记与全文搜索索引。')
        .fontSize(14).fontColor('#888').textAlign(TextAlign.Center)
        .padding({ left: 32, right: 32 }).margin({ bottom: 48 });
      if (this.initError) {
        Text(`初始化失败: ${this.initError}`).fontSize(12).fontColor('#d33').margin({ bottom: 16 });
      }
      Button('开始')
        .width('70%').height(48)
        .enabled(!this.initError)
        .onClick(() => { this.currentStep = 1; });
      Text('1 / 4').fontSize(11).fontColor('#aaa').margin({ top: 64 });
    }
    .width('100%').height('100%')
    .alignItems(HorizontalAlign.Center);
  }

  @Builder
  StepConfig() {
    Scroll() {
      Column() {
        Text('配置云存储').fontSize(22).fontWeight(FontWeight.Bold).margin({ top: 48, bottom: 8 });
        Text('扫描桌面端的配对二维码最快,也可以手动输入 S3 凭据。')
          .fontSize(12).fontColor('#888').margin({ bottom: 24 });

        // Scan flow
        Text('方式 A:扫描桌面配对 QR').fontSize(14).fontWeight(FontWeight.Medium);
        Text('桌面:Settings → 同步 → 「添加移动设备」')
          .fontSize(11).fontColor('#888').margin({ top: 2, bottom: 8 });
        Row() {
          Button('📷 扫码').layoutWeight(1).margin({ right: 8 })
            .onClick(() => this.runScan());
          TextInput({ placeholder: '6 位 PIN', text: this.pinInput })
            .type(InputType.Number).maxLength(6).layoutWeight(1)
            .onChange((v: string) => this.pinInput = v);
          Button('应用').layoutWeight(1).margin({ left: 8 })
            .onClick(() => this.applyPin());
        };
        if (this.scanInfo) {
          Text(this.scanInfo).fontSize(11).fontColor('#666').margin({ top: 4 });
        }

        // Manual form
        Text('方式 B:手动填写').fontSize(14).fontWeight(FontWeight.Medium).margin({ top: 24, bottom: 8 });
        TextInput({ placeholder: 'endpoint (https://… 留空走 AWS)', text: this.endpoint })
          .onChange((v: string) => this.endpoint = v).margin({ bottom: 6 });
        TextInput({ placeholder: 'region (如 us-east-1)', text: this.region })
          .onChange((v: string) => this.region = v).margin({ bottom: 6 });
        TextInput({ placeholder: 'bucket', text: this.bucket })
          .onChange((v: string) => this.bucket = v).margin({ bottom: 6 });
        TextInput({ placeholder: 'access key', text: this.accessKey })
          .onChange((v: string) => this.accessKey = v).margin({ bottom: 6 });
        TextInput({ placeholder: 'secret key', text: this.secretKey })
          .type(InputType.Password)
          .onChange((v: string) => this.secretKey = v).margin({ bottom: 6 });

        if (this.configError) {
          Text(this.configError).fontSize(12).fontColor('#d33').margin({ top: 8 });
        }

        Row() {
          Button('上一步').layoutWeight(1).margin({ right: 8 })
            .backgroundColor('#eee').fontColor('#333')
            .onClick(() => { this.currentStep = 0; });
          Button(this.savingConfig ? '保存中…' : '下一步')
            .layoutWeight(1).enabled(!this.savingConfig)
            .onClick(() => this.saveConfigAndAdvance());
        }.margin({ top: 24 });

        Text('2 / 4').fontSize(11).fontColor('#aaa').textAlign(TextAlign.Center)
          .width('100%').margin({ top: 16, bottom: 24 });
      }
      .padding({ left: 20, right: 20 })
      .alignItems(HorizontalAlign.Start);
    }.width('100%').height('100%');
  }

  @Builder
  StepPassword() {
    Column() {
      Text('输入加密密码').fontSize(22).fontWeight(FontWeight.Bold).margin({ top: 80, bottom: 8 });
      Text('这是你在桌面端设置的主密码。它用于解开 E2EE 主密钥,不会上传。')
        .fontSize(12).fontColor('#888')
        .padding({ left: 32, right: 32 }).textAlign(TextAlign.Center)
        .margin({ bottom: 40 });
      TextInput({ placeholder: '密码', text: this.password })
        .type(InputType.Password)
        .width('80%')
        .onChange((v: string) => this.password = v);
      if (this.unlockError) {
        Text(this.unlockError).fontSize(12).fontColor('#d33').margin({ top: 12 });
      }
      Row() {
        Button('上一步').layoutWeight(1).margin({ right: 8 })
          .backgroundColor('#eee').fontColor('#333')
          .onClick(() => { this.currentStep = 1; });
        Button(this.unlocking ? '解锁中…' : '解锁')
          .layoutWeight(1).enabled(!this.unlocking)
          .onClick(() => this.tryUnlockAndAdvance());
      }.width('80%').margin({ top: 24 });

      Text('3 / 4').fontSize(11).fontColor('#aaa').margin({ top: 64 });
    }
    .width('100%').height('100%')
    .alignItems(HorizontalAlign.Center);
  }

  @Builder
  StepSync() {
    Column() {
      Text('首次同步').fontSize(22).fontWeight(FontWeight.Bold).margin({ top: 80, bottom: 8 });
      Text('从云端拉取你的全部资料库。根据数据量可能需要几秒到几十秒。')
        .fontSize(12).fontColor('#888')
        .padding({ left: 32, right: 32 }).textAlign(TextAlign.Center)
        .margin({ bottom: 40 });

      if (this.showProgress) {
        Progress({
          value: this.progressCurrent,
          total: this.progressTotal > 0 ? this.progressTotal : 1,
          type: ProgressType.Linear,
        }).width('80%');
        Text(`${this.phaseLabel(this.progressPhase)} ${this.progressCurrent}/${this.progressTotal}`)
          .fontSize(11).fontColor('#666').margin({ top: 6 });
      }

      if (this.syncSummary) {
        Text(this.syncSummary).fontSize(12).fontColor('#2a7').margin({ top: 12 });
      }
      if (this.syncError) {
        Text(this.syncError).fontSize(12).fontColor('#d33').margin({ top: 12 });
      }

      Row() {
        // 允许在失败后回到密码页(有可能是 MK 错,想重新解锁)
        Button('上一步').layoutWeight(1).margin({ right: 8 })
          .backgroundColor('#eee').fontColor('#333')
          .enabled(!this.syncing)
          .onClick(() => { this.currentStep = 2; });
        Button(this.syncing ? '同步中…' : (this.syncError ? '重试' : '开始同步'))
          .layoutWeight(1).enabled(!this.syncing)
          .onClick(() => this.runFirstSync());
      }.width('80%').margin({ top: 24 });

      Text('4 / 4').fontSize(11).fontColor('#aaa').margin({ top: 48 });
    }
    .width('100%').height('100%')
    .alignItems(HorizontalAlign.Center);
  }
}
