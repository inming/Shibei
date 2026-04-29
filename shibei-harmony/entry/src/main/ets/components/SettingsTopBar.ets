import { router } from '@kit.ArkUI';

// Shared 44pt-tall top bar for every settings sub-page. Centered title,
// `‹` back chevron on the left that pops the navigation stack. Kept as
// a @Component (not @Builder) so each page can mount it once at the top
// of its Column without bringing along the parent's lifecycle.

@Component
export struct SettingsTopBar {
  title: string = '';

  build() {
    Row() {
      Text('‹').fontSize(26)
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
        .width(44).height(44).textAlign(TextAlign.Center)
        .onClick(() => router.back());
      Text(this.title).fontSize(17).fontWeight(FontWeight.Medium)
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
        .layoutWeight(1).textAlign(TextAlign.Center);
      Text('').width(44);
    }
    .width('100%').padding({ left: 4, right: 4, top: 4, bottom: 4 })
    .backgroundColor($r('sys.color.ohos_id_color_background'));
  }
}
