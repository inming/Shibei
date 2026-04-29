// Per-app language override. By default HarmonyOS hands `getStringSync`
// the system locale; this manager lets the user pin the app to zh-Hans /
// en regardless of system setting (parity with desktop). The choice is
// persisted in `shibei_prefs` and pushed into `i18n.System` on cold start
// so the first frame already paints in the chosen language.

import { common } from '@kit.AbilityKit';
import { i18n } from '@kit.LocalizationKit';
import { preferences } from '@kit.ArkData';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { I18n } from '../services/I18n';

export type AppLanguage = 'system' | 'zh' | 'en';

const PREF_STORE = 'shibei_prefs';
const PREF_KEY = 'shibei-language';

// HarmonyOS locale tag for each app-level choice. The system flavor is
// signalled by passing an empty string to `setAppPreferredLanguage`,
// which clears the override and re-falls-back to the system locale.
function localeTag(lang: AppLanguage): string {
  if (lang === 'zh') return 'zh-Hans';
  if (lang === 'en') return 'en-US';
  return '';
}

/// Load the persisted language. Defaults to 'system' on first launch /
/// missing pref / unrecognised value.
export async function loadLanguage(ctx: common.UIAbilityContext): Promise<AppLanguage> {
  try {
    const store = await preferences.getPreferences(ctx, PREF_STORE);
    const v = await store.get(PREF_KEY, 'system') as string;
    if (v === 'zh' || v === 'en' || v === 'system') return v;
    return 'system';
  } catch (err) {
    hilog.warn(0x0000, 'shibei', 'loadLanguage failed: %{public}s', (err as Error).message);
    return 'system';
  }
}

/// Persist + apply a language. Persists to preferences and pushes the
/// matching tag into `i18n.System.setAppPreferredLanguage`. The next
/// `getStringSync` call returns strings from the new locale's resources;
/// in-memory ArkUI views need to be remounted (or re-fetch their labels)
/// to actually pick up the change.
export async function applyLanguage(
  ctx: common.UIAbilityContext,
  lang: AppLanguage,
): Promise<void> {
  try {
    const store = await preferences.getPreferences(ctx, PREF_STORE);
    await store.put(PREF_KEY, lang);
    await store.flush();
  } catch (err) {
    hilog.warn(0x0000, 'shibei', 'saveLanguage failed: %{public}s', (err as Error).message);
  }
  const tag = localeTag(lang);
  // setAppPreferredLanguage records the preference for future Ability
  // launches; on this OpenHarmony SDK it does NOT flip live lookups.
  // We additionally swap I18n's resource manager to a per-locale
  // override (getOverrideResourceManager) so already-mounted UI starts
  // returning strings from the chosen language folder immediately —
  // text already drawn keeps its old label until the page re-mounts.
  try {
    i18n.System.setAppPreferredLanguage(tag);
  } catch (err) {
    hilog.error(0x0000, 'shibei', 'setAppPreferredLanguage(%{public}s) failed: %{public}s', tag, (err as Error).message);
  }
  I18n.setOverrideLocale(tag);
  hilog.info(0x0000, 'shibei', 'applied app language=%{public}s tag=%{public}s', lang, tag || '<system>');
}
