import { router } from '@kit.ArkUI';

interface DemoEntry {
  title: string;
  url: string;
}

@Entry
@Component
struct Index {
  private demos: DemoEntry[] = [
    { title: '0. NAPI smoke test', url: 'pages/Demo0Napi' },
    { title: '1. Fold status', url: 'pages/Demo1FoldStatus' },
    { title: '2. Web selection', url: 'pages/Demo2WebSelection' },
    { title: '3. pdfjs streamTextContent', url: 'pages/Demo3PdfJs' },
    { title: '4. file:// URL', url: 'pages/Demo4FileProtocol' },
    { title: '5. HUKS biometric', url: 'pages/Demo5Biometric' },
    { title: '6. Background task', url: 'pages/Demo6BackgroundTask' },
    { title: '7. S3 network switch', url: 'pages/Demo7NetworkSwitch' },
    { title: '8. NAPI codegen (Phase 2)', url: 'pages/Demo8NapiCodegen' },
    { title: '9. Lifecycle commands (A3)', url: 'pages/Demo9Lifecycle' },
    { title: '10. Queries on empty DB (A4 batch 2)', url: 'pages/Demo10Queries' },
    { title: '11. Library skeleton (Track E)', url: 'pages/Demo11Library' },
    { title: '12. Config + Sync (A4 batch 1+3)', url: 'pages/Demo12Sync' },
    { title: '13. Onboard wizard (Track C)', url: 'pages/Onboard' },
    { title: '14. Settings (Track F)', url: 'pages/Settings' },
    { title: '15. Lock screen', url: 'pages/LockScreen' },
    { title: '16. Search (Track E)', url: 'pages/Search' }
  ];

  build() {
    Column() {
      Text('拾贝 Phase 0').fontSize(24).margin({ top: 24, bottom: 16 });
      ForEach(this.demos, (d: DemoEntry) => {
        Button(d.title)
          .width('90%').margin({ top: 8 })
          .onClick(() => router.pushUrl({ url: d.url }));
      }, (d: DemoEntry) => d.title);
    }
    .width('100%').height('100%');
  }
}
