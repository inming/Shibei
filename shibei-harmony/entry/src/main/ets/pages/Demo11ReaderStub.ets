import { router } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { ShibeiService, ShibeiError, Resource } from '../services/ShibeiService';

interface ReaderParams {
  resourceId: string;
}

// Phase 3 will replace this body with an ArkWeb-based reader + annotator.
// For Phase 2 we render the resource metadata loaded through the A4 batch 2
// query path, so the Library → Reader navigation + id-carrying pattern is
// real. Nothing else on this page is load-bearing past Phase 3.

@Entry
@Component
struct Demo11ReaderStub {
  @State resource: Resource | null = null;
  @State loading: boolean = true;
  @State error: string = '';
  @State resourceId: string = '';
  @State summary: string = '';

  aboutToAppear(): void {
    const params = router.getParams() as ReaderParams | undefined;
    this.resourceId = params?.resourceId ?? '';
    this.load();
  }

  private load(): void {
    this.loading = true;
    this.error = '';
    try {
      this.resource = ShibeiService.instance.getResource(this.resourceId);
      this.summary = ShibeiService.instance.getResourceSummary(this.resourceId, 300);
      if (!this.resource) {
        this.error = `resource not found: ${this.resourceId}`;
      }
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : err.message;
      this.error = code;
      hilog.error(0x0000, 'shibei', 'ReaderStub load fail: %{public}s', code);
    }
    this.loading = false;
  }

  build() {
    Column() {
      // Custom top bar with back button — router.back() returns to Library.
      Row() {
        Button('←').fontSize(20).width(40).height(40)
          .fontColor('#333').backgroundColor(Color.Transparent)
          .onClick(() => router.back());
        Text('资料详情 (Phase 3 占位)').fontSize(16).fontWeight(FontWeight.Medium).layoutWeight(1)
          .textAlign(TextAlign.Center);
        Text('').width(40);
      }
      .width('100%')
      .padding({ left: 8, right: 8, top: 6, bottom: 6 });

      if (this.loading) {
        Text('loading…').margin({ top: 40 });
      } else if (this.error) {
        Column() {
          Text('ERR').fontColor('#c00').fontSize(16).margin({ top: 40 });
          Text(this.error).fontSize(13).fontColor('#888').margin({ top: 8 }).width('90%');
        }.width('100%');
      } else if (this.resource) {
        Scroll() {
          Column() {
            Text(this.resource.title || '(无标题)')
              .fontSize(20).fontWeight(FontWeight.Bold)
              .width('100%');
            Text(this.resource.url)
              .fontSize(12).fontColor('#666')
              .margin({ top: 8 }).width('100%');
            Row() {
              Text(`📅 ${this.resource.created_at.substring(0, 10)}`).fontSize(12).fontColor('#888');
              Text(`·`).fontSize(12).fontColor('#888').margin({ left: 8, right: 8 });
              Text(this.resource.resource_type).fontSize(12).fontColor('#888');
              Text(`·`).fontSize(12).fontColor('#888').margin({ left: 8, right: 8 });
              Text(this.resource.folder_id).fontSize(12).fontColor('#888');
            }.margin({ top: 8 });

            if (this.resource.description) {
              Text('描述').fontSize(13).fontColor('#444').fontWeight(FontWeight.Medium).margin({ top: 24 });
              Text(this.resource.description!).fontSize(14).margin({ top: 4 }).width('100%');
            }

            if (this.summary) {
              Text('正文摘要').fontSize(13).fontColor('#444').fontWeight(FontWeight.Medium).margin({ top: 24 });
              Text(this.summary).fontSize(13).margin({ top: 4 }).width('100%');
            } else {
              Text('(暂无正文摘要 — 此资料尚未同步或未提取 plain_text)')
                .fontSize(12).fontColor('#bbb').margin({ top: 24 });
            }

            Column() {
              Text('——').fontColor('#bbb').textAlign(TextAlign.Center).width('100%').margin({ top: 40 });
              Text('Phase 3 将在此处渲染 ArkWeb + annotator.js').fontSize(12).fontColor('#888').textAlign(TextAlign.Center).width('100%').margin({ top: 8 });
              Text('标注系统 / 高亮选词 / Markdown 评论等').fontSize(11).fontColor('#aaa').textAlign(TextAlign.Center).width('100%').margin({ top: 4 });
            }
          }
          .padding(16)
          .alignItems(HorizontalAlign.Start)
          .width('100%');
        }
        .layoutWeight(1)
        .width('100%');
      }
    }
    .width('100%')
    .height('100%');
  }
}
