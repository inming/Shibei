// Lightweight i18n facade over `resourceManager.getStringSync`.
//
// Usage:
//   I18n.init(this.context);                                // EntryAbility.onCreate
//   Text(I18n.t($r('app.string.common_save')))              // no-arg
//   I18n.t($r('app.string.settings_sync_complete'), 3, 7)   // %1$d / %2$d
//
// Resource resolution follows HarmonyOS qualifier rules:
//   resources/zh_CN/element/string.json  ← when system locale = zh
//   resources/en_US/element/string.json  ← when system locale = en
//   resources/base/element/string.json   ← fallback
//
// Caller must have called `init(ctx)` from EntryAbility.onWindowStageCreate
// before any page renders. If `t()` is called without init, returns "" and
// logs a warning rather than throwing.
//
// Why a wrapper around `getStringSync`:
//   1. centralized try/catch (sync API throws on missing resource id)
//   2. centralized null-context guard
//   3. one knob to swap implementation later (e.g. async hot-reload)

import { common } from '@kit.AbilityKit';
import { i18n } from '@kit.LocalizationKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

export class I18n {
  private static _ctx: common.UIAbilityContext | null = null;

  static init(ctx: common.UIAbilityContext): void {
    I18n._ctx = ctx;
  }

  /// Sync lookup by Resource ($r('app.string.key')) with optional
  /// printf-style placeholders matching the value's `%1$s` / `%2$d` markers.
  static t(res: Resource, ...args: (string | number)[]): string {
    if (!I18n._ctx) {
      hilog.warn(0x0000, 'shibei', 'I18n.t called before init');
      return '';
    }
    try {
      return I18n._ctx.resourceManager.getStringSync(res, ...args);
    } catch (err) {
      hilog.warn(0x0000, 'shibei', 'I18n.t failed: %{public}s',
        (err as Error).message);
      return '';
    }
  }

  /// Returns 'zh' or 'en' (used by pdf-shell URL param injection).
  /// Defaults to 'zh' if system locale lookup fails.
  static currentLocale(): 'zh' | 'en' {
    try {
      const lang = i18n.System.getSystemLanguage();
      return lang.startsWith('zh') ? 'zh' : 'en';
    } catch {
      return 'zh';
    }
  }
}
