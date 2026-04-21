import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { ShibeiService } from '../services/ShibeiService';
import { loadTheme, applyTheme } from '../app/ThemeManager';

// Cold-start routing (Track C/F):
//   no saved S3 config            → pages/Onboard      (fresh install)
//   saved config + locked vault   → pages/LockScreen   (E2EE password re-entry)
//   saved config + unlocked vault → pages/Demo11Library
//
// The vault is always locked on cold start in Phase 2 — the Master Key
// lives in memory only. Phase 3 will wire HUKS biometric unwrap so the
// MK can be restored without password re-entry. `isUnlocked` is still
// checked here because this method can also fire on window restoration
// within the same process lifetime, where the MK may still be cached.
//
// If NAPI init fails we fall through to Onboard so the user at least sees
// the wizard's error banner instead of a blank window.
//
// The dev demo menu (pages/Index) is still reachable — Onboard's Welcome
// title, LockScreen title, and Demo 11 Library header all long-press
// into it.

export default class EntryAbility extends UIAbility {
  onCreate(_want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(0x0000, 'shibei', 'EntryAbility onCreate');
  }

  async onWindowStageCreate(windowStage: window.WindowStage): Promise<void> {
    const dataDir = this.context.filesDir;

    // Apply persisted color mode before first frame so the user's dark/light
    // choice survives restarts. Await'd — tens of ms at most.
    try {
      const theme = await loadTheme(this.context);
      await applyTheme(this.context, theme);
    } catch (err) {
      hilog.warn(0x0000, 'shibei', 'theme apply fail: %{public}s', (err as Error).message);
    }

    let route = 'pages/Onboard';
    try {
      await ShibeiService.instance.init(dataDir);
      if (!ShibeiService.instance.hasSavedConfig()) {
        route = 'pages/Onboard';
      } else if (ShibeiService.instance.isUnlocked()) {
        route = 'pages/Demo11Library';
      } else {
        route = 'pages/LockScreen';
      }
    } catch (err) {
      hilog.error(0x0000, 'shibei', 'cold-start init fail, falling to Onboard: %{public}s',
        (err as Error).message);
    }
    windowStage.loadContent(route, (err) => {
      if (err.code) {
        hilog.error(0x0000, 'shibei', 'loadContent failed: %{public}s', JSON.stringify(err));
      }
    });
  }
}
