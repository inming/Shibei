import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import { ShibeiService } from '../services/ShibeiService';
import { LockService, LockState } from '../services/LockService';
import { I18n } from '../services/I18n';
import { loadTheme, applyTheme } from '../app/ThemeManager';
import { FoldObserver } from '../app/FoldObserver';

// Cold-start routing (Track C/F + Phase 4):
//   no saved S3 config            → pages/Onboard      (fresh install)
//   saved config + Locked state   → pages/LockScreen   (PIN / bio / E2EE recovery)
//   saved config + other state    → pages/Library
//
// Phase 4 introduces LockService as the authoritative lock-state oracle.
// On cold start `LockService.initialize()` classifies the app as Locked
// (PIN configured) or Disabled (no PIN); subsequent background/foreground
// transitions drive the 30 s grace timer. `primeS3Creds()` runs before
// classification to repopulate the runtime S3 cache from disk (both calls
// are independent — order is primeS3Creds → initialize purely for
// readability).
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
    // Wire i18n before first frame so any page can call `I18n.t(...)`
    // without an init guard (the wrapper still has one, but routing the
    // context here keeps callers terse).
    I18n.init(this.context);

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
      // Phase 4: prime creds + classify lock state before routing.
      await ShibeiService.instance.primeS3Creds().catch((e: Error) => {
        hilog.warn(0x0000, 'shibei', 'prime s3 creds failed: %{public}s', e.message);
      });
      await LockService.instance.initialize();

      if (!ShibeiService.instance.hasSavedConfig()) {
        route = 'pages/Onboard';
      } else if (LockService.instance.getState() === LockState.Locked) {
        route = 'pages/LockScreen';
      } else {
        route = 'pages/Library';
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

  onBackground(): void {
    hilog.info(0x0000, 'shibei', 'EntryAbility onBackground');
    LockService.instance.onBackgrounded();
  }

  onForeground(): void {
    hilog.info(0x0000, 'shibei', 'EntryAbility onForeground');
    LockService.instance.onForegrounded();
  }
}
