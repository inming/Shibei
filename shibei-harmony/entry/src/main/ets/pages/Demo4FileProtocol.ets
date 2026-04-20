import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import fs from '@ohos.file.fs';
import { hilog } from '@kit.PerformanceAnalysisKit';

@Entry
@Component
struct Demo4FileProtocol {
  private controller: webview.WebviewController = new webview.WebviewController();
  @State status: string = 'preparing…';
  @State filePath: string = '';

  aboutToAppear(): void {
    try {
      const ctx = getContext(this) as common.UIAbilityContext;
      const dir = ctx.filesDir;
      const path = `${dir}/demo4.html`;
      const html = `<!DOCTYPE html><html><body>
        <h1>hello from file://</h1>
        <p>path: ${path}</p>
        <p>time: ${new Date().toISOString()}</p>
      </body></html>`;
      const file = fs.openSync(path, fs.OpenMode.CREATE | fs.OpenMode.TRUNC | fs.OpenMode.READ_WRITE);
      fs.writeSync(file.fd, html);
      fs.closeSync(file);
      this.filePath = path;
      this.status = `wrote ${html.length} bytes → ${path}`;
      hilog.info(0x0000, 'shibei', 'demo4 wrote %{public}s', path);
    } catch (err) {
      const msg: string = `${err.name}: ${err.message}`;
      this.status = `write fail: ${msg}`;
      hilog.error(0x0000, 'shibei', 'demo4 fail: %{public}s', msg);
    }
  }

  build() {
    Column() {
      Text('Demo 4: file:// in el2').fontSize(18).margin({ top: 16 });
      Text(this.status).fontSize(12).margin({ top: 8 });
      if (this.filePath) {
        Web({
          src: `file://${this.filePath}`,
          controller: this.controller
        })
        .javaScriptAccess(true)
        .fileAccess(true)
        .domStorageAccess(true)
        .height('70%')
        .onErrorReceive((event) => {
          const errMsg: string = `${event.error.getErrorCode()}: ${event.error.getErrorInfo()}`;
          hilog.error(0x0000, 'shibei', 'web error: %{public}s', errMsg);
        });
      }
    }
    .width('100%').height('100%').padding(8);
  }
}
