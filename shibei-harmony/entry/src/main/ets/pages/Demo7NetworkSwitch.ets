import { hilog } from '@kit.PerformanceAnalysisKit';
import { s3SmokeTest } from 'libshibei_core.so';

@Entry
@Component
struct Demo7NetworkSwitch {
  @State endpoint: string = '';
  @State region: string = '';
  @State bucket: string = '';
  @State accessKey: string = '';
  @State secretKey: string = '';
  @State result: string = '(not run yet)';
  @State running: boolean = false;

  private run(): void {
    this.running = true;
    this.result = 'running…';
    try {
      const json: string = s3SmokeTest(
        this.endpoint,
        this.region,
        this.bucket,
        this.accessKey,
        this.secretKey,
      );
      this.result = json;
      hilog.info(0x0000, 'shibei', 'demo7 s3 result: %{public}s', json);
    } catch (err) {
      const msg: string = `${err.name}: ${err.message}`;
      this.result = msg;
      hilog.error(0x0000, 'shibei', 'demo7 s3 error: %{public}s', msg);
    }
    this.running = false;
  }

  build() {
    Scroll() {
      Column() {
        Text('Demo 7: S3 PUT+GET smoke test')
          .fontSize(20)
          .margin({ top: 24, bottom: 16 });

        TextInput({ placeholder: 'endpoint (e.g. https://s3.example.com)', text: this.endpoint })
          .width('100%')
          .margin({ bottom: 8 })
          .onChange((v: string) => {
            this.endpoint = v;
          });

        TextInput({ placeholder: 'region (e.g. us-east-1)', text: this.region })
          .width('100%')
          .margin({ bottom: 8 })
          .onChange((v: string) => {
            this.region = v;
          });

        TextInput({ placeholder: 'bucket', text: this.bucket })
          .width('100%')
          .margin({ bottom: 8 })
          .onChange((v: string) => {
            this.bucket = v;
          });

        TextInput({ placeholder: 'access key', text: this.accessKey })
          .width('100%')
          .margin({ bottom: 8 })
          .onChange((v: string) => {
            this.accessKey = v;
          });

        TextInput({ placeholder: 'secret key', text: this.secretKey })
          .type(InputType.Password)
          .width('100%')
          .margin({ bottom: 16 })
          .onChange((v: string) => {
            this.secretKey = v;
          });

        Button(this.running ? 'running…' : 'run S3 PUT+GET')
          .width('100%')
          .enabled(!this.running)
          .onClick(() => this.run());

        Text('Result:')
          .fontWeight(FontWeight.Bold)
          .margin({ top: 16, bottom: 4 })
          .alignSelf(ItemAlign.Start);

        Text(this.result)
          .width('100%')
          .textAlign(TextAlign.Start)
          .fontFamily('monospace')
          .fontSize(12)
          .margin({ bottom: 24 });
      }
      .width('100%')
      .padding(16);
    }
    .width('100%')
    .height('100%');
  }
}
