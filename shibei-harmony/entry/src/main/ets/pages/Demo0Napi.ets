import { hilog } from '@kit.PerformanceAnalysisKit';
import { hello, add } from 'libshibei_core.so';

@Entry
@Component
struct Demo0Napi {
  @State status: string = 'pressing button will call hello() + add(3, 4)';
  @State result: string = '';

  private run(): void {
    try {
      const greet: string = hello();
      const sum: number = add(3, 4);
      this.result = `hello: ${greet}\nadd(3,4): ${sum}`;
      this.status = 'OK';
      hilog.info(0x0000, 'shibei', 'demo0 hello: %{public}s, sum=%{public}d', greet, sum);
    } catch (err) {
      const msg: string = `${err.name}: ${err.message}`;
      this.status = 'ERROR';
      this.result = msg;
      hilog.error(0x0000, 'shibei', 'demo0 fail: %{public}s', msg);
    }
  }

  build() {
    Column() {
      Text('Demo 0: NAPI smoke test').fontSize(20).margin({ top: 24 });
      Button('run').margin({ top: 16 }).onClick(() => this.run());
      Text(this.status).margin({ top: 16 });
      Text(this.result).margin({ top: 8 }).textAlign(TextAlign.Start);
    }
    .width('100%').height('100%').padding(16);
  }
}
