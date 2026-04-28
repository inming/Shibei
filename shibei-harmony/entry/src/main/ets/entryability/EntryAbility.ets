import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { router, window } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import { ShibeiService } from '../services/ShibeiService';
import { LockService, LockState } from '../services/LockService';
import { I18n } from '../services/I18n';
import { loadTheme, applyTheme } from '../app/ThemeManager';
import { FoldObserver } from '../app/FoldObserver';
import { KEY_PENDING_DEEP_LINK, KEY_PENDING_SHARE_URL } from '../app/AppStorageKeys';
import { SessionState } from '../app/SessionState';

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
  onCreate(want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(0x0000, 'shibei', 'EntryAbility onCreate');
    // Stash any deep-link URI for consumption after lock-screen / onboard.
    const uri = want?.uri;
    if (uri && uri.startsWith('shibei://')) {
      AppStorage.setOrCreate<string>(KEY_PENDING_DEEP_LINK, uri);
    }
    // Stash any share-intent URL — Library.aboutToAppear consumes after
    // unlock. We still stash on cold start (rather than route directly)
    // because routing decisions happen in onWindowStageCreate based on
    // lock state; pushing CapturePage here would race with that.
    const sharedUrl = extractShareUrl(want);
    if (sharedUrl) {
      AppStorage.setOrCreate<string>(KEY_PENDING_SHARE_URL, sharedUrl);
    }
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
      } else if (!ShibeiService.instance.isUnlocked()) {
        // App Lock not configured but MK not in memory (process was killed
        // between sessions). Without this gate the user lands on Library
        // with a config but no way to decrypt S3 / snapshots, and the
        // Settings recovery card is the only exit — too buried. This page
        // is unskippable and replaces to Library on success.
        route = 'pages/E2eeUnlockGate';
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

  onNewWant(want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    // Branch 1: shibei:// deep link (existing behavior).
    const uri = want?.uri;
    if (uri && uri.startsWith('shibei://')) {
      if (LockService.instance.getState() === LockState.Locked ||
          !ShibeiService.instance.isUnlocked()) {
        AppStorage.setOrCreate<string>(KEY_PENDING_DEEP_LINK, uri);
      } else {
        const match = uri.match(/^shibei:\/\/open\/resource\/([^?]+)(?:\?highlight=(.+))?$/);
        if (!match) return;
        const resourceId = match[1];
        const highlightId = match[2] || undefined;
        SessionState.save(this.context, { inReader: true, readerResourceId: resourceId }).then(() => {
          router.pushUrl({
            url: 'pages/Reader',
            params: { resourceId, highlightId },
          }).catch((err: Error) => {
            hilog.warn(0x0000, 'shibei', 'deep link pushUrl fail: %{public}s', err.message);
          });
        }).catch((err: Error) => {
          hilog.warn(0x0000, 'shibei', 'deep link session save fail: %{public}s', err.message);
        });
      }
      return;
    }
    // Branch 2: system share intent — http(s) URL we should route to
    // CapturePage. Same lock-aware policy: stash for Library if locked,
    // otherwise push directly.
    const sharedUrl = extractShareUrl(want);
    if (!sharedUrl) return;
    if (LockService.instance.getState() === LockState.Locked ||
        !ShibeiService.instance.isUnlocked()) {
      AppStorage.setOrCreate<string>(KEY_PENDING_SHARE_URL, sharedUrl);
      return;
    }
    router.pushUrl({
      url: 'pages/CapturePage',
      params: { url: sharedUrl },
    }).catch((err: Error) => {
      hilog.warn(0x0000, 'shibei', 'share intent pushUrl fail: %{public}s', err.message);
    });
  }
}

/// Pull a shareable http(s) URL out of a system share Want.
///
/// HarmonyOS share intents may carry the URL in any of:
///   - `want.uri` directly (newer browsers / OneDrive-style apps)
///   - `want.parameters['ability.params.stream']` (file URIs in
///     stream form — we only accept http(s) here)
///   - `want.parameters.text` / `parameters['content']` (fallback for
///     plain-text share that happens to contain a URL)
///
/// Returns `null` when nothing useful is found. We deliberately do NOT
/// log the URL itself — share targets shouldn't accumulate user reading
/// history in hilog.
function extractShareUrl(want: Want | undefined): string | null {
  if (!want) return null;
  const direct = want.uri;
  if (direct && /^https?:\/\//i.test(direct)) return direct;

  const params = want.parameters;
  if (!params) return null;
  const candidateKeys: string[] = [
    'ability.params.stream',
    'text',
    'content',
    'shareText',
  ];
  for (const key of candidateKeys) {
    const raw = params[key];
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    // Some share targets prepend a label, e.g.
    // "Look at this: https://example.com". Pluck the first http(s) URL.
    const match = trimmed.match(/https?:\/\/[^\s]+/i);
    if (match) return match[0];
  }
  return null;
}
