import { bundleManager } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { I18n } from '../../services/I18n';
import { SettingsTopBar } from '../../components/SettingsTopBar';

// About sub-page. Pure read-only — surfaces app name / tagline / version
// / bundle id / license / homepage. Uses bundleManager to look up the
// installed bundleInfo so we don't have to hard-code version strings
// (they live in AppScope/app.json5 as the source of truth). On lookup
// failure each row falls back to '—' rather than blowing up the page.

@Entry
@Component
struct AboutSettings {
  @State versionName: string = '—';
  @State bundleName: string = '—';

  async aboutToAppear(): Promise<void> {
    try {
      const info = await bundleManager.getBundleInfoForSelf(
        bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT,
      );
      // BundleInfo carries versionName + name (the bundle id) at the top
      // level. Both arrive as plain strings on this SDK; falsy means the
      // value isn't set, and we keep the placeholder.
      if (info && info.versionName) this.versionName = info.versionName;
      if (info && info.name) this.bundleName = info.name;
      hilog.info(0x0000, 'shibei', 'About: version=%{public}s bundle=%{public}s',
        this.versionName, this.bundleName);
    } catch (err) {
      hilog.warn(0x0000, 'shibei', 'AboutSettings load fail: %{public}s', (err as Error).message);
    }
  }


  build() {
    Column() {
      SettingsTopBar({ title: I18n.t($r('app.string.settings_section_about')) });

      Scroll() {
        Column() {
          // ── Hero block ────────────────────────────────────
          Column() {
            Text(I18n.t($r('app.string.settings_about_app_name')))
              .fontSize(22).fontWeight(FontWeight.Medium)
              .fontColor($r('sys.color.ohos_id_color_text_primary'));
            Text(I18n.t($r('app.string.settings_about_tagline')))
              .fontSize(13)
              .fontColor($r('sys.color.ohos_id_color_text_secondary'))
              .margin({ top: 4 });
          }
          .alignItems(HorizontalAlign.Center)
          .width('100%')
          .padding({ top: 32, bottom: 24 });

          // ── Info rows ─────────────────────────────────────
          // Inlined rather than using a shared @Builder. ArkTS's @Builder
          // dependency tracking doesn't reliably re-render when a value
          // arrives via parameter from an @State field, so passing
          // `this.versionName` would freeze on the initial '—'.
          Column() {
            Row() {
              Text(I18n.t($r('app.string.settings_about_version'))).fontSize(15)
                .layoutWeight(1).fontColor($r('sys.color.ohos_id_color_text_primary'));
              Text(this.versionName).fontSize(14)
                .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis });
            }.width('100%').padding({ top: 12, bottom: 12, left: 12, right: 12 });
            Divider().color($r('sys.color.ohos_id_color_list_separator'));
            Row() {
              Text(I18n.t($r('app.string.settings_about_bundle'))).fontSize(15)
                .layoutWeight(1).fontColor($r('sys.color.ohos_id_color_text_primary'));
              Text(this.bundleName).fontSize(14)
                .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis });
            }.width('100%').padding({ top: 12, bottom: 12, left: 12, right: 12 });
            Divider().color($r('sys.color.ohos_id_color_list_separator'));
            Row() {
              Text(I18n.t($r('app.string.settings_about_license'))).fontSize(15)
                .layoutWeight(1).fontColor($r('sys.color.ohos_id_color_text_primary'));
              Text(I18n.t($r('app.string.settings_about_license_value'))).fontSize(14)
                .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis });
            }.width('100%').padding({ top: 12, bottom: 12, left: 12, right: 12 });
            Divider().color($r('sys.color.ohos_id_color_list_separator'));
            Row() {
              Text(I18n.t($r('app.string.settings_about_homepage'))).fontSize(15)
                .layoutWeight(1).fontColor($r('sys.color.ohos_id_color_text_primary'));
              Text(I18n.t($r('app.string.settings_about_homepage_value'))).fontSize(14)
                .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis });
            }.width('100%').padding({ top: 12, bottom: 12, left: 12, right: 12 });
          }
          .backgroundColor($r('sys.color.ohos_id_color_background')).borderRadius(8)
          .margin({ left: 12, right: 12, bottom: 32 });
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%');
      }
      .align(Alignment.Top)
      .layoutWeight(1)
      .width('100%');
    }
    .width('100%').height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'));
  }
}
