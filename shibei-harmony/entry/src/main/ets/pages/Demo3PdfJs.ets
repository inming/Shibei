import { webview } from '@kit.ArkWeb';
import { hilog } from '@kit.PerformanceAnalysisKit';

class BridgeHost {
  private outer: Demo3PdfJs;

  constructor(outer: Demo3PdfJs) {
    this.outer = outer;
  }

  onEvent(payload: string): void {
    this.outer.receiveEvent(payload);
  }
}

@Entry
@Component
struct Demo3PdfJs {
  private controller: webview.WebviewController = new webview.WebviewController();
  @State log: Array<string> = [];
  @State count: number = 0;
  private bridge: BridgeHost = new BridgeHost(this);

  receiveEvent(payload: string): void {
    this.count += 1;
    const line: string = `#${this.count} ${payload.substring(0, 120)}`;
    this.log = [line, ...this.log].slice(0, 40);
    hilog.info(0x0000, 'shibei', 'pdfjs: %{public}s', payload);
  }

  build() {
    Column() {
      Text('Demo 3: pdfjs streamTextContent').fontSize(18).margin({ top: 16 });
      Web({
        src: $rawfile('pdfjs-demo/index.html'),
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
      .height('60%');

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
