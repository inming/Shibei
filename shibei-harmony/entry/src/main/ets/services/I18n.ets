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
import { resourceManager } from '@kit.LocalizationKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

export class I18n {
  private static _ctx: common.UIAbilityContext | null = null;
  // Non-null when the user picked a non-system app language. ArkUI's
  // ctx.resourceManager always resolves against the system locale on
  // this OpenHarmony build (`setAppPreferredLanguage` updates the
  // preference but doesn't flip live lookups), so we lazily create an
  // override-locale manager and route `t()` through it.
  private static _overrideMgr: resourceManager.ResourceManager | null = null;
  private static _overrideTag: string = '';

  static init(ctx: common.UIAbilityContext): void {
    I18n._ctx = ctx;
  }

  /// Pin all subsequent `t()` lookups to `tag` (e.g. 'zh-Hans', 'en-US').
  /// Empty `tag` clears the override and falls back to the system locale.
  /// Idempotent — re-applying the same tag is a no-op.
  static setOverrideLocale(tag: string): void {
    if (!I18n._ctx) {
      hilog.warn(0x0000, 'shibei', 'I18n.setOverrideLocale before init');
      return;
    }
    if (tag === I18n._overrideTag) return;
    I18n._overrideTag = tag;
    if (!tag) {
      I18n._overrideMgr = null;
      return;
    }
    try {
      const baseMgr = I18n._ctx.resourceManager;
      // Mutate a copy of the live Configuration rather than constructing
      // an object literal — `Configuration` carries mandatory fields
      // (screenDensity, colorMode, mcc/mnc) that ArkTS strict mode
      // refuses to leave undefined. Keeping the rest of the config
      // identical means the override mgr inherits everything except
      // locale.
      const overrideConfig = baseMgr.getConfigurationSync();
      overrideConfig.locale = tag;
      I18n._overrideMgr = baseMgr.getOverrideResourceManager(overrideConfig);
    } catch (err) {
      hilog.error(0x0000, 'shibei', 'getOverrideResourceManager(%{public}s) failed: %{public}s',
        tag, (err as Error).message);
      I18n._overrideMgr = null;
    }
  }

  /// Sync lookup by Resource ($r('app.string.key')) with optional
  /// printf-style placeholders matching the value's `%1$s` / `%2$d` markers.
  static t(res: Resource, ...args: (string | number)[]): string {
    if (!I18n._ctx) {
      hilog.warn(0x0000, 'shibei', 'I18n.t called before init');
      return '';
    }
    try {
      const mgr = I18n._overrideMgr ?? I18n._ctx.resourceManager;
      return mgr.getStringSync(res, ...args);
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

  /// Map a NAPI / Rust error code (e.g. "error.notUnlocked") to a localized
  /// message. Unknown codes pass through verbatim so we don't swallow info.
  ///
  /// Many backend errors come formatted as "error.foo: <underlying detail>"
  /// because the Rust side prepends context with `format!`. We strip the
  /// trailing detail before the exact-match lookup so callers don't need
  /// to plumb two error-string conventions through the UI. The suffix is
  /// also passed to the localized template as `%1$s` for codes whose
  /// translation ends with a colon (e.g. network / download failures).
  static translateError(code: string): string {
    const colon = code.indexOf(':');
    const prefix = colon >= 0 ? code.substring(0, colon).trim() : code;
    const detail = colon >= 0 ? code.substring(colon + 1).trim() : '';
    switch (prefix) {
      case 'error.notUnlocked':
        return I18n.t($r('app.string.error_notUnlocked'));
      case 'error.encryptionNotUnlocked':
        return I18n.t($r('app.string.error_encryptionNotUnlocked'));
      case 'error.notInitialized':
        return I18n.t($r('app.string.error_notInitialized'));
      case 'error.notConfigured':
        return I18n.t($r('app.string.error_notConfigured'));
      case 'error.pinIncorrect':
        return I18n.t($r('app.string.error_pinIncorrect'));
      case 'error.wrongPassword':
        return I18n.t($r('app.string.error_wrongPassword'));
      case 'error.keyFileTampered':
        return I18n.t($r('app.string.error_keyFileTampered'));
      case 'error.credentialsNotPrimed':
        return I18n.t($r('app.string.error_credentialsNotPrimed'));
      case 'error.credentialsLockPoisoned':
        return I18n.t($r('app.string.error_credentialsLockPoisoned'));
      case 'error.pairingBadPin':
        return I18n.t($r('app.string.error_pairingBadPin'));
      case 'error.downloadFailed':
        return I18n.t($r('app.string.error_downloadFailed'), detail);
      case 'error.snapshotNotFound':
        return I18n.t($r('app.string.error_snapshotNotFound'));
      case 'error.resourceNotFound':
        return I18n.t($r('app.string.error_resourceNotFound'));
      case 'error.missingResourceId':
        return I18n.t($r('app.string.error_missingResourceId'));
      case 'error.invalidAutoSyncMode':
        return I18n.t($r('app.string.error_invalidAutoSyncMode'));
      default:
        return code;
    }
  }
}
