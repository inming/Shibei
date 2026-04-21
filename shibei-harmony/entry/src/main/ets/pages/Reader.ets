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
struct Reader {
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
      Row() {
        Text('‹').fontSize(26)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .width(44).height(44).textAlign(TextAlign.Center)
          .onClick(() => router.back());
        Text('资料详情').fontSize(17).fontWeight(FontWeight.Medium).layoutWeight(1)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .textAlign(TextAlign.Center);
        Text('').width(44);
      }
      .width('100%')
      .padding({ left: 4, right: 4, top: 4, bottom: 4 })
      .backgroundColor($r('sys.color.ohos_id_color_background'));

      if (this.loading) {
        Text('加载中…').margin({ top: 40 })
          .fontColor($r('sys.color.ohos_id_color_text_secondary'));
      } else if (this.error) {
        Column() {
          Text('ERR').fontColor($r('sys.color.ohos_id_color_warning'))
            .fontSize(16).margin({ top: 40 });
          Text(this.error).fontSize(13)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ top: 8 }).width('90%');
        }.width('100%');
      } else if (this.resource) {
        Scroll() {
          Column() {
            Text(this.resource.title || '(无标题)')
              .fontSize(20).fontWeight(FontWeight.Bold)
              .fontColor($r('sys.color.ohos_id_color_text_primary'))
              .width('100%');
            Text(this.resource.url)
              .fontSize(12)
              .fontColor($r('sys.color.ohos_id_color_text_secondary'))
              .margin({ top: 8 }).width('100%');
            Row() {
              Text(`📅 ${this.resource.created_at.substring(0, 10)}`).fontSize(12)
                .fontColor($r('sys.color.ohos_id_color_text_tertiary'));
              Text(`·`).fontSize(12)
                .fontColor($r('sys.color.ohos_id_color_text_tertiary'))
                .margin({ left: 8, right: 8 });
              Text(this.resource.resource_type).fontSize(12)
                .fontColor($r('sys.color.ohos_id_color_text_tertiary'));
              Text(`·`).fontSize(12)
                .fontColor($r('sys.color.ohos_id_color_text_tertiary'))
                .margin({ left: 8, right: 8 });
              Text(this.resource.folder_id).fontSize(12)
                .fontColor($r('sys.color.ohos_id_color_text_tertiary'));
            }.margin({ top: 8 });

            if (this.resource.description) {
              Text('描述').fontSize(13)
                .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                .fontWeight(FontWeight.Medium).margin({ top: 24 });
              Text(this.resource.description!).fontSize(14)
                .fontColor($r('sys.color.ohos_id_color_text_primary'))
                .margin({ top: 4 }).width('100%');
            }

            if (this.summary) {
              Text('正文摘要').fontSize(13)
                .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                .fontWeight(FontWeight.Medium).margin({ top: 24 });
              Text(this.summary).fontSize(13)
                .fontColor($r('sys.color.ohos_id_color_text_primary'))
                .margin({ top: 4 }).width('100%');
            } else {
              Text('(暂无正文摘要)')
                .fontSize(12)
                .fontColor($r('sys.color.ohos_id_color_text_tertiary'))
                .margin({ top: 24 });
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
    .height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'));
  }
}
