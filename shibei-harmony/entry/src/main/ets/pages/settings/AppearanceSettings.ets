import { common } from '@kit.AbilityKit';
import { promptAction } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { loadTheme, applyTheme, ThemeMode } from '../../app/ThemeManager';
import { loadLanguage, applyLanguage, AppLanguage } from '../../app/LanguageManager';
import { I18n } from '../../services/I18n';
import { SettingsTopBar } from '../../components/SettingsTopBar';

// Appearance sub-page: theme (system / light / dark) + app language
// (system / zh / en). Language switch persists immediately and pushes
// the new locale into `i18n.System`; views that already mounted keep
// their cached labels until they're re-entered (acceptable trade — the
// alternative is to evict every cached @State string in the app).

@Entry
@Component
struct AppearanceSettings {
  @State theme: ThemeMode = 'system';
  @State language: AppLanguage = 'system';

  async aboutToAppear(): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    this.theme = await loadTheme(ctx);
    this.language = await loadLanguage(ctx);
  }

  private async setTheme(mode: ThemeMode): Promise<void> {
    this.theme = mode;
    const ctx = getContext(this) as common.UIAbilityContext;
    await applyTheme(ctx, mode);
  }

  private async setLanguage(lang: AppLanguage): Promise<void> {
    if (lang === this.language) return;
    const ctx = getContext(this) as common.UIAbilityContext;
    try {
      await applyLanguage(ctx, lang);
      this.language = lang;
      promptAction.showToast({
        message: I18n.t($r('app.string.settings_language_changed_toast')),
      });
    } catch (err) {
      const msg = (err as Error).message;
      hilog.warn(0x0000, 'shibei', 'apply language fail: %{public}s', msg);
      promptAction.showToast({
        message: I18n.t($r('app.string.settings_language_apply_failed'), msg),
      });
    }
  }

  // Builders for theme + language rows. ArkTS @Builder doesn't reliably
  // forward function-typed parameters (`onTap: () => void` arrives but
  // the bound `onClick(onTap)` invocation doesn't fire), so each picker
  // type gets its own builder with the click handler inlined.
  @Builder
  ThemeRow(label: string, mode: ThemeMode) {
    Row() {
      Text(label).fontSize(15).layoutWeight(1)
        .fontColor($r('sys.color.ohos_id_color_text_primary'));
      Text(this.theme === mode ? '✓' : '').fontSize(16)
        .fontColor($r('sys.color.ohos_id_color_emphasize')).width(20);
    }
    .width('100%')
    .padding({ top: 12, bottom: 12, left: 12, right: 12 })
    .onClick(() => this.setTheme(mode));
  }

  @Builder
  LanguageRow(label: string, lang: AppLanguage) {
    Row() {
      Text(label).fontSize(15).layoutWeight(1)
        .fontColor($r('sys.color.ohos_id_color_text_primary'));
      Text(this.language === lang ? '✓' : '').fontSize(16)
        .fontColor($r('sys.color.ohos_id_color_emphasize')).width(20);
    }
    .width('100%')
    .padding({ top: 12, bottom: 12, left: 12, right: 12 })
    .onClick(() => this.setLanguage(lang));
  }

  build() {
    Column() {
      SettingsTopBar({ title: I18n.t($r('app.string.settings_section_appearance')) });

      Scroll() {
        Column() {
          // ── Theme ─────────────────────────────────────────
          Text(I18n.t($r('app.string.settings_appearance_theme_title'))).fontSize(13)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ top: 16, left: 16, bottom: 4 });
          Column() {
            this.ThemeRow(I18n.t($r('app.string.settings_theme_system')), 'system');
            Divider().color($r('sys.color.ohos_id_color_list_separator'));
            this.ThemeRow(I18n.t($r('app.string.settings_theme_light')), 'light');
            Divider().color($r('sys.color.ohos_id_color_list_separator'));
            this.ThemeRow(I18n.t($r('app.string.settings_theme_dark')), 'dark');
          }
          .backgroundColor($r('sys.color.ohos_id_color_background')).borderRadius(8)
          .margin({ left: 12, right: 12 });

          // ── Language ──────────────────────────────────────
          Text(I18n.t($r('app.string.settings_appearance_language'))).fontSize(13)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ top: 24, left: 16, bottom: 4 });
          Column() {
            this.LanguageRow(I18n.t($r('app.string.settings_language_system')), 'system');
            Divider().color($r('sys.color.ohos_id_color_list_separator'));
            this.LanguageRow(I18n.t($r('app.string.settings_language_zh')), 'zh');
            Divider().color($r('sys.color.ohos_id_color_list_separator'));
            this.LanguageRow(I18n.t($r('app.string.settings_language_en')), 'en');
          }
          .backgroundColor($r('sys.color.ohos_id_color_background')).borderRadius(8)
          .margin({ left: 12, right: 12, bottom: 24 });
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
