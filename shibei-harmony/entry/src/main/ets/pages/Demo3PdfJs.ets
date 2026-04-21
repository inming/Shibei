import { webview } from '@kit.ArkWeb';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import fs from '@ohos.file.fs';

class BridgeHost {
  private outer: Demo3PdfJs;

  constructor(outer: Demo3PdfJs) {
    this.outer = outer;
  }

  onEvent(payload: string): void {
    this.outer.receiveEvent(payload);
  }

  // pdfjs's default URL-based getDocument triggers an internal fetch()/XHR,
  // which ArkWeb blocks for sibling file:// assets. We hand the PDF bytes
  // across the JS bridge as base64 instead, and the page decodes to
  // Uint8Array before calling getDocument({ data: ... }). Production path
  // (Plan 4) will use the same shape — reader reads bytes via fs, hands
  // to pdfjs.
  getSamplePdfBase64(): string {
    return this.outer.sampleBase64;
  }
}

const ASSETS: Array<string> = ['index.html', 'pdf-bundle.js', 'pdf-worker-bundle.js', 'sample.pdf'];

@Entry
@Component
struct Demo3PdfJs {
  private controller: webview.WebviewController = new webview.WebviewController();
  @State log: Array<string> = [];
  @State count: number = 0;
  @State localPath: string = '';
  @State setupStatus: string = 'preparing assets…';
  sampleBase64: string = '';
  private bridge: BridgeHost = new BridgeHost(this);

  aboutToAppear(): void {
    try {
      const ctx = getContext(this) as common.UIAbilityContext;
      const destDir: string = `${ctx.filesDir}/pdfjs-demo`;
      try {
        fs.mkdirSync(destDir);
      } catch (e) {
        // already exists is fine
      }
      let sampleBytes: Uint8Array | null = null;
      for (const name of ASSETS) {
        const bytes: Uint8Array = ctx.resourceManager.getRawFileContentSync(`pdfjs-demo/${name}`);
        const destPath: string = `${destDir}/${name}`;
        const file = fs.openSync(destPath, fs.OpenMode.CREATE | fs.OpenMode.TRUNC | fs.OpenMode.READ_WRITE);
        fs.writeSync(file.fd, bytes.buffer);
        fs.closeSync(file);
        if (name === 'sample.pdf') {
          sampleBytes = bytes;
        }
      }
      if (sampleBytes) {
        const b64: util.Base64Helper = new util.Base64Helper();
        this.sampleBase64 = b64.encodeToStringSync(sampleBytes);
      }
      this.localPath = `file://${destDir}/index.html`;
      this.setupStatus = `assets ready (pdf base64 ${this.sampleBase64.length} chars)`;
      hilog.info(0x0000, 'shibei', 'demo3 staged assets, pdf base64 %{public}d chars',
        this.sampleBase64.length);
    } catch (err) {
      const msg: string = `${err.name}: ${err.message}`;
      this.setupStatus = `setup failed: ${msg}`;
      hilog.error(0x0000, 'shibei', 'demo3 setup fail: %{public}s', msg);
    }
  }

  receiveEvent(payload: string): void {
    this.count += 1;
    const line: string = `#${this.count} ${payload.substring(0, 120)}`;
    this.log = [line, ...this.log].slice(0, 40);
    hilog.info(0x0000, 'shibei', 'pdfjs: %{public}s', payload);
  }

  build() {
    Column() {
      Text('Demo 3: pdfjs streamTextContent').fontSize(18).margin({ top: 16 });
      Text(this.setupStatus).fontSize(11).margin({ top: 4 });
      if (this.localPath) {
        Web({
          src: this.localPath,
          controller: this.controller
        })
          .javaScriptAccess(true)
          .domStorageAccess(true)
          .fileAccess(true)
          .javaScriptProxy({
            object: this.bridge,
            name: 'shibeiHost',
            methodList: ['onEvent', 'getSamplePdfBase64'],
            controller: this.controller
          })
          .height('55%');
      }

      Scroll() {
        Column() {
          ForEach(this.log, (e: string) => {
            Text(e).fontSize(10).fontFamily('monospace');
          }, (e: string) => e);
        }
      }.height('35%');
    }
    .width('100%').height('100%').padding(8);
  }
}
