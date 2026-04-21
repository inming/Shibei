import { hilog } from '@kit.PerformanceAnalysisKit';
import { common } from '@kit.AbilityKit';
import { scanBarcode, scanCore } from '@kit.ScanKit';
import {
  ShibeiService,
  ShibeiError,
  S3ConfigInput,
  SyncResult,
  SyncResultSuccess,
} from '../services/ShibeiService';
import { router, promptAction } from '@kit.ArkUI';

// Phase 2 Track A4 batch 1 + 3 — end-to-end S3 config → E2EE unlock →
// first metadata sync, bypassing the Onboard QR flow (Track C). The
// five S3 fields + password are typed in by hand; in production they
// come from scanning the desktop pairing QR.

@Entry
@Component
struct Demo12Sync {
  @State dataDir: string = '';
  @State initLine: string = '(run init first)';
  @State endpoint: string = 'https://';
  @State region: string = '';
  @State bucket: string = '';
  @State accessKey: string = '';
  @State secretKey: string = '';
  @State password: string = '';
  @State scannedEnvelope: string = '';
  @State pinInput: string = '';
  @State scanLine: string = '';
  @State configLine: string = '';
  @State unlockLine: string = '';
  @State syncLine: string = '';
  @State counts: string = '';
  @State syncing: boolean = false;
  @State unlocking: boolean = false;

  async aboutToAppear(): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    this.dataDir = ctx.filesDir;
    try {
      await ShibeiService.instance.init(this.dataDir);
      this.initLine = `init ok`;
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : err.message;
      this.initLine = `ERR: ${code}`;
    }
  }

  private async runScan(): Promise<void> {
    this.scanLine = 'opening scanner…';
    try {
      // QR_CODE is the canonical ScanType in API 12+. If DevEco's typecheck
      // complains "Property QR_CODE does not exist on type ScanType", the
      // older alias is QRCODE_SCAN_TYPE — swap there.
      const options: scanBarcode.ScanOptions = {
        scanTypes: [scanCore.ScanType.QR_CODE],
        enableMultiMode: false,
        enableAlbum: true,
      };
      const result: scanBarcode.ScanResult = await scanBarcode.startScanForResult(
        getContext(this), options);
      if (!result.originalValue) {
        this.scanLine = 'scan cancelled';
        return;
      }
      this.scannedEnvelope = result.originalValue;
      this.scanLine = `scanned envelope (${result.originalValue.length} bytes); now enter the 6-digit PIN below.`;
    } catch (err) {
      this.scanLine = `scan ERR: ${err.message}`;
      hilog.error(0x0000, 'shibei', 'scan fail: %{public}s', err.message);
    }
  }

  private applyPin(): void {
    if (!this.scannedEnvelope) {
      this.scanLine = 'nothing scanned yet';
      return;
    }
    if (!/^\d{6}$/.test(this.pinInput)) {
      this.scanLine = 'PIN must be exactly 6 digits';
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
      this.scanLine = `decrypt ok — 5 fields filled; press save below.`;
      this.pinInput = '';
      this.scannedEnvelope = '';
      promptAction.showToast({ message: '扫码成功,配置已填入', duration: 1500 });
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : err.message;
      this.scanLine = `decrypt ERR: ${code}`;
    }
  }

  private trySaveConfig(): void {
    const cfg: S3ConfigInput = {
      endpoint: this.endpoint.trim() ? this.endpoint.trim() : undefined,
      region: this.region.trim(),
      bucket: this.bucket.trim(),
      accessKey: this.accessKey.trim(),
      secretKey: this.secretKey.trim(),
    };
    if (!cfg.region || !cfg.bucket || !cfg.accessKey || !cfg.secretKey) {
      this.configLine = 'ERR: region / bucket / accessKey / secretKey all required';
      return;
    }
    try {
      ShibeiService.instance.setS3Config(cfg);
      this.configLine = `setS3Config → ok (bucket=${cfg.bucket}, region=${cfg.region})`;
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : err.message;
      this.configLine = `ERR: ${code}`;
    }
  }

  private async tryUnlock(): Promise<void> {
    if (!this.password) {
      this.unlockLine = 'ERR: password empty';
      return;
    }
    this.unlocking = true;
    this.unlockLine = 'downloading meta/keyring.json + deriving…';
    try {
      const t0: number = Date.now();
      await ShibeiService.instance.setE2eePassword(this.password);
      this.unlockLine = `setE2eePassword → ok (${Date.now() - t0}ms)`;
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : err.message;
      this.unlockLine = `ERR: ${code}`;
    }
    this.unlocking = false;
  }

  private async runSync(): Promise<void> {
    this.syncing = true;
    this.syncLine = 'syncing… (could take a while on first run)';
    try {
      const t0: number = Date.now();
      const result: SyncResult = await ShibeiService.instance.syncMetadata();
      if (result.kind === 'success') {
        const r = result as SyncResultSuccess;
        this.syncLine = `sync ok in ${Date.now() - t0}ms — uploaded=${r.uploaded}, downloaded=${r.downloaded}, applied=${r.applied}`;
      } else {
        this.syncLine = `sync skipped (already in flight?)`;
      }
      this.refreshCounts();
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : err.message;
      this.syncLine = `ERR: ${code}`;
    }
    this.syncing = false;
  }

  private refreshCounts(): void {
    try {
      const folders = ShibeiService.instance.listFolders();
      const allResources = ShibeiService.instance.listResources('__all__');
      const tags = ShibeiService.instance.listTags();
      this.counts = `local DB now: ${folders.length} folders, ${allResources.length} resources, ${tags.length} tags`;
    } catch (err) {
      this.counts = `count err: ${err.message}`;
    }
  }

  private openLibrary(): void {
    router.pushUrl({ url: 'pages/Demo11Library' }).catch((err: Error) => {
      hilog.error(0x0000, 'shibei', 'pushUrl fail: %{public}s', err.message);
    });
  }

  build() {
    Scroll() {
      Column() {
        Text('Demo 12: Config + Sync (A4 batch 1+3)').fontSize(18).margin({ top: 20, bottom: 8 });
        Text(this.initLine).fontSize(12).fontColor('#888').margin({ bottom: 16 });

        Text('1a) Scan desktop pairing QR (shortcut)').fontSize(15).fontWeight(FontWeight.Medium);
        Text('桌面 Settings → 同步 → 「添加移动设备」,显示 QR + 6 位 PIN')
          .fontSize(11).fontColor('#888').margin({ top: 2 });
        Row() {
          Button('📷 scan').layoutWeight(1).margin({ right: 8 })
            .onClick(() => this.runScan());
          TextInput({ placeholder: '6-digit PIN', text: this.pinInput })
            .type(InputType.Number).maxLength(6).layoutWeight(1)
            .onChange(v => this.pinInput = v);
          Button('apply').layoutWeight(1).margin({ left: 8 })
            .onClick(() => this.applyPin());
        }.margin({ top: 8 });
        Text(this.scanLine).fontSize(11).fontColor('#666').margin({ top: 4 });

        Text('1b) or type S3 config manually').fontSize(15).fontWeight(FontWeight.Medium).margin({ top: 20 });
        TextInput({ placeholder: 'endpoint (https://… or empty for AWS)', text: this.endpoint })
          .onChange(v => this.endpoint = v).margin({ top: 4 });
        TextInput({ placeholder: 'region (e.g. us-east-1)', text: this.region })
          .onChange(v => this.region = v).margin({ top: 4 });
        TextInput({ placeholder: 'bucket', text: this.bucket })
          .onChange(v => this.bucket = v).margin({ top: 4 });
        TextInput({ placeholder: 'access_key', text: this.accessKey })
          .onChange(v => this.accessKey = v).margin({ top: 4 });
        TextInput({ placeholder: 'secret_key', text: this.secretKey })
          .type(InputType.Password)
          .onChange(v => this.secretKey = v).margin({ top: 4 });
        Button('save S3 config').width('100%').margin({ top: 8 }).onClick(() => this.trySaveConfig());
        Text(this.configLine).fontSize(12).margin({ top: 4 });

        Text('2) E2EE password (unlock)').fontSize(15).fontWeight(FontWeight.Medium).margin({ top: 24 });
        TextInput({ placeholder: 'E2EE password (desktop master password)', text: this.password })
          .type(InputType.Password)
          .onChange(v => this.password = v).margin({ top: 4 });
        Button(this.unlocking ? 'unlocking…' : 'unlock')
          .enabled(!this.unlocking)
          .width('100%').margin({ top: 8 })
          .onClick(() => this.tryUnlock());
        Text(this.unlockLine).fontSize(12).margin({ top: 4 });

        Text('3) Sync metadata').fontSize(15).fontWeight(FontWeight.Medium).margin({ top: 24 });
        Button(this.syncing ? 'syncing…' : 'syncMetadata()')
          .enabled(!this.syncing)
          .width('100%').margin({ top: 8 })
          .onClick(() => this.runSync());
        Text(this.syncLine).fontSize(12).margin({ top: 4 });
        Text(this.counts).fontSize(12).fontColor('#666').margin({ top: 4 });

        Button('→ go to Demo 11 Library')
          .width('100%').margin({ top: 24, bottom: 32 })
          .onClick(() => this.openLibrary());
      }
      .padding(16)
      .alignItems(HorizontalAlign.Start)
      .width('100%');
    }
    .width('100%').height('100%');
  }
}
