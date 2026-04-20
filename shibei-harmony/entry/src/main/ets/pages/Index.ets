import { router } from '@kit.ArkUI';

@Entry
@Component
struct Index {
  private demos: Array<{ title: string; url: string }> = [
    { title: '0. NAPI smoke test', url: 'pages/Demo0Napi' },
    { title: '1. Fold status', url: 'pages/Demo1FoldStatus' },
    { title: '2. Web selection', url: 'pages/Demo2WebSelection' },
    { title: '3. pdfjs streamTextContent', url: 'pages/Demo3PdfJs' },
    { title: '4. file:// URL', url: 'pages/Demo4FileProtocol' },
    { title: '5. HUKS biometric', url: 'pages/Demo5Biometric' },
    { title: '6. Background task', url: 'pages/Demo6BackgroundTask' },
    { title: '7. S3 network switch', url: 'pages/Demo7NetworkSwitch' }
  ];

  build() {
    Column() {
      Text('拾贝 Phase 0').fontSize(24).margin({ top: 24, bottom: 16 });
      ForEach(this.demos, (d: { title: string; url: string }) => {
        Button(d.title)
          .width('90%').margin({ top: 8 })
          .onClick(() => router.pushUrl({ url: d.url }));
      }, (d: { title: string; url: string }) => d.title);
    }
    .width('100%').height('100%');
  }
}
