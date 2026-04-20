import { webview } from '@kit.ArkWeb';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { common } from '@kit.AbilityKit';
import fs from '@ohos.file.fs';

class BridgeHost {
  private outer: Demo3PdfJs;

  constructor(outer: Demo3PdfJs) {
    this.outer = outer;
  }

  onEvent(payload: string): void {
    this.outer.receiveEvent(payload);
  }

  // WebView calls this to obtain the pdf.worker.mjs bundle source as a
  // string. ArkWeb blocks both ES module imports and fetch() of sibling
  // files under file://; handing the worker code across the JS bridge
  // lets the page build a blob: URL (the one scheme pdfjs and Worker
  // accept without restriction).
  getWorkerBundle(): string {
    return this.outer.workerBundleText;
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
      for (const name of ASSETS) {
        const bytes: Uint8Array = ctx.resourceManager.getRawFileContentSync(`pdfjs-demo/${name}`);
        const destPath: string = `${destDir}/${name}`;
        const file = fs.openSync(destPath, fs.OpenMode.CREATE | fs.OpenMode.TRUNC | fs.OpenMode.READ_WRITE);
        fs.writeSync(file.fd, bytes.buffer);
        fs.closeSync(file);
      }
      this.localPath = `file://${destDir}/index.html`;
      this.setupStatus = `assets ready at ${destDir}`;
      hilog.info(0x0000, 'shibei', 'demo3 staged assets to %{public}s', destDir);
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
            methodList: ['onEvent'],
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
