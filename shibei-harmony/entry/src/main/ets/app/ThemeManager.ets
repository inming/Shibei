// Theme manager for Phase 2 — persists the user's chosen color mode and
// pushes it into the application-level ColorMode so the system chrome
// (status bar, system dialogs) inverts correctly.
//
// NOTE: Most ArkTS components in the Phase 2 demo pages use hardcoded hex
// colors (`#888`, `#333`, …) rather than `$r('sys.color.…')` resources,
// so the effect on page-level UI is limited until Phase 3 migrates to
// resource tokens. The preference itself still persists across restarts.

import { ConfigurationConstant, common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { PREF_THEME } from './AppStorageKeys';

export type ThemeMode = 'system' | 'light' | 'dark';

const PREF_STORE = 'shibei_prefs';

/// Load the persisted theme. Defaults to 'system' on first launch / error.
export async function loadTheme(ctx: common.UIAbilityContext): Promise<ThemeMode> {
  try {
    const store = await preferences.getPreferences(ctx, PREF_STORE);
    const v = await store.get(PREF_THEME, 'system') as string;
    if (v === 'light' || v === 'dark' || v === 'system') {
      return v;
    }
    return 'system';
  } catch (err) {
    hilog.warn(0x0000, 'shibei', 'loadTheme failed: %{public}s', (err as Error).message);
    return 'system';
  }
}

/// Persist + apply a theme. The mode is written to preferences AND pushed
/// into `context.getApplicationContext().setColorMode(...)` so the system
/// knows which chrome variant to render.
export async function applyTheme(ctx: common.UIAbilityContext, mode: ThemeMode): Promise<void> {
  try {
    const store = await preferences.getPreferences(ctx, PREF_STORE);
    await store.put(PREF_THEME, mode);
    await store.flush();
  } catch (err) {
    hilog.warn(0x0000, 'shibei', 'saveTheme failed: %{public}s', (err as Error).message);
  }
  const appCtx = ctx.getApplicationContext();
  const target: number = mode === 'light'
    ? ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT
    : mode === 'dark'
      ? ConfigurationConstant.ColorMode.COLOR_MODE_DARK
      : ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET;
  appCtx.setColorMode(target);
}
