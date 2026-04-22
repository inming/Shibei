import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import { ShibeiService } from '../services/ShibeiService';
import { loadTheme, applyTheme } from '../app/ThemeManager';
import { FoldObserver } from '../app/FoldObserver';

// Cold-start routing (Track C/F):
//   no saved S3 config            → pages/Onboard      (fresh install)
//   saved config + locked vault   → pages/LockScreen   (E2EE password re-entry)
//   saved config + unlocked vault → pages/Library
//
// The vault is always locked on cold start in Phase 2 — the Master Key
// lives in memory only. Phase 3 will wire HUKS biometric unwrap so the
// MK can be restored without password re-entry. `isUnlocked` is still
// checked here because this method can also fire on window restoration
// within the same process lifetime, where the MK may still be cached.
//
// If NAPI init fails we fall through to Onboard so the user at least sees
// the wizard's error banner instead of a blank window.

export default class EntryAbility extends UIAbility {
  onCreate(_want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(0x0000, 'shibei', 'EntryAbility onCreate');
    // Register the `shibei-pdf://` scheme BEFORE any Web component is
    // created. ArkWeb's Chromium blocks fetches to unknown schemes at the
    // network layer; without this registration, pdfjs XHRs to
    // `shibei-pdf://resource/...` never reach onInterceptRequest and fail
    // with "Unexpected server response (0)". Must be called exactly once
    // per process — customizeSchemes is a static, process-wide call.
    try {
      webview.WebviewController.customizeSchemes([
        {
          schemeName: 'shibei-pdf',
          isSupportCORS: true,
          isSupportFetch: true,
          // Standard scheme makes Chromium treat URLs like http/https for
          // origin/CORS/XHR semantics. Without this, XHR to this scheme
          // reports status 0 even when onInterceptRequest returns 200 —
          // pdfjs interprets that as a network failure.
          isStandard: true,
        },
      ]);
    } catch (err) {
      hilog.warn(0x0000, 'shibei', 'customizeSchemes failed: %{public}s',
        (err as Error).message);
    }
    // Start the fold observer before any page can render so components
    // relying on @StorageProp(KEY_FOLD_STATUS) get a valid initial value.
    FoldObserver.instance.start();
  }

  async onWindowStageCreate(windowStage: window.WindowStage): Promise<void> {
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
      await ShibeiService.instance.init(this.context);
      if (!ShibeiService.instance.hasSavedConfig()) {
        route = 'pages/Onboard';
      } else if (ShibeiService.instance.isUnlocked()) {
        route = 'pages/Library';
      } else {
        route = 'pages/LockScreen';
      }
    } catch (err) {
      hilog.error(0x0000, 'shibei', 'cold-start init fail, falling to Onboard: %{public}s',
        (err as Error).message);
    }
    // SPIKE: reverted in Task 0 Step 8
    route = 'pages/PdfSpike';
    windowStage.loadContent(route, (err) => {
      if (err.code) {
        hilog.error(0x0000, 'shibei', 'loadContent failed: %{public}s', JSON.stringify(err));
      }
    });
  }
}
