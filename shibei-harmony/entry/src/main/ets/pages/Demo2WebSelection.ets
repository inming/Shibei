import { webview } from '@kit.ArkWeb';
import { hilog } from '@kit.PerformanceAnalysisKit';

class BridgeHost {
  private outer: Demo2WebSelection;

  constructor(outer: Demo2WebSelection) {
    this.outer = outer;
  }

  onEvent(payload: string): void {
    this.outer.receiveEvent(payload);
  }
}

@Entry
@Component
struct Demo2WebSelection {
  private controller: webview.WebviewController = new webview.WebviewController();
  @State events: Array<string> = [];
  @State count: number = 0;
  private bridge: BridgeHost = new BridgeHost(this);

  receiveEvent(payload: string): void {
    this.count += 1;
    const line: string = `#${this.count} ${payload.substring(0, 120)}`;
    this.events = [line, ...this.events].slice(0, 50);
    hilog.info(0x0000, 'shibei', 'sel: %{public}s', payload);
  }

  aboutToAppear(): void {
    // proxy registered before page load; the webview injects it on load finish
  }

  build() {
    Column() {
      Text('Demo 2: Web selectionchange').fontSize(18).margin({ top: 16 });
      Text(`total events: ${this.count}`).fontSize(14);

      Web({
        src: $rawfile('select-demo.html'),
        controller: this.controller
      })
      .javaScriptAccess(true)
      .domStorageAccess(true)
      .javaScriptProxy({
        object: this.bridge,
        name: 'shibeiHost',
        methodList: ['onEvent'],
        controller: this.controller
      })
      .height('50%')
      .onPageEnd(() => {
        hilog.info(0x0000, 'shibei', 'page loaded');
      });

      Scroll() {
        Column() {
          ForEach(this.events, (e: string) => {
            Text(e).fontSize(11).fontFamily('monospace');
          }, (e: string) => e);
        }
      }.height('40%');
    }
    .width('100%').height('100%').padding(8);
  }
}
