// shibei-harmony/entry/src/main/ets/services/LockService.ets
//
// State machine + 30s grace timer + lifecycle hooks.
//
// Invariants (spec §2.2):
//   NotConfigured — user never enabled App Lock. MK may still be cached.
//   Unlocked      — MK in memory, UI accessible.
//   GracePeriod   — app went to background less than 30s ago. MK still in
//                   memory; UI should render LockScreen overlay but not
//                   actually wipe MK until the timer fires.
//   Locked        — MK cleared (napi.lockVault()); route forced to LockScreen.

import { hilog } from '@kit.PerformanceAnalysisKit';
import { router } from '@kit.ArkUI';
import { ShibeiService, ShibeiError } from './ShibeiService';
import { HuksService } from './HuksService';

export enum LockState {
  NotConfigured = 'NotConfigured',
  Unlocked = 'Unlocked',
  GracePeriod = 'GracePeriod',
  Locked = 'Locked',
}

type Subscriber = (s: LockState) => void;

const GRACE_MS = 30 * 1000;

export class LockService {
  private static _instance: LockService | null = null;
  static get instance(): LockService {
    if (!LockService._instance) LockService._instance = new LockService();
    return LockService._instance;
  }

  private state: LockState = LockState.NotConfigured;
  private graceTimerId: number = -1;
  private backgroundedAtMs: number = 0;
  private subscribers: Set<Subscriber> = new Set<Subscriber>();

  getState(): LockState { return this.state; }

  subscribe(cb: Subscriber): () => void {
    this.subscribers.add(cb);
    return (): void => { this.subscribers.delete(cb); };
  }

  /// Inspect NAPI + in-memory state to classify the initial lifecycle.
  /// Called once by EntryAbility.onWindowStageCreate.
  async initialize(): Promise<void> {
    const svc = ShibeiService.instance;
    const configured = svc.lockIsConfigured();
    const mkLoaded = svc.lockIsMkLoaded();
    if (!configured) {
      this.setState(LockState.NotConfigured);
    } else if (mkLoaded) {
      this.setState(LockState.Unlocked);
    } else {
      this.setState(LockState.Locked);
    }
  }

  // ── Lifecycle hooks ────────────────────────────────────────

  onBackgrounded(): void {
    if (this.state !== LockState.Unlocked) return;
    this.backgroundedAtMs = Date.now();
    this.clearGraceTimer();
    this.graceTimerId = setTimeout(() => {
      this.graceTimerId = -1;
      if (this.state === LockState.GracePeriod) {
        this.performLock();
      }
    }, GRACE_MS);
    this.setState(LockState.GracePeriod);
  }

  onForegrounded(): void {
    this.clearGraceTimer();
    if (this.state !== LockState.GracePeriod) return;
    const elapsed = Date.now() - this.backgroundedAtMs;
    if (elapsed >= GRACE_MS) {
      this.performLock();
    } else {
      this.setState(LockState.Unlocked);
    }
  }

  lockNow(): void {
    this.clearGraceTimer();
    this.performLock();
  }

  // ── Setup / unlock / disable ───────────────────────────────

  async setupPin(pin: string, enableBio: boolean): Promise<void> {
    const svc = ShibeiService.instance;
    await svc.lockSetupPin(pin);
    if (enableBio) {
      await this.enableBio();
    }
    this.setState(LockState.Unlocked);
  }

  /// Enrolls (or re-enrolls) the biometric-gated key. Requires MK already
  /// loaded in memory — typically called right after setupPin or after a
  /// fresh PIN unlock. Runs:
  ///   1. Validate bio available at the system level
  ///   2. Confirm MK is loaded (fail fast before any side effects)
  ///   3. Fetch MK as base64
  ///   4. Generate (or rotate) shibei_bio_kek_v1
  ///   5. Prompt user for biometric auth → get authToken
  ///   6. HUKS-wrap MK with bio-gated key + authToken
  ///   7. Persist wrapped blob via NAPI lockEnableBio
  ///
  /// Ordering matters: the MK check + fetch happen BEFORE generateBioKey
  /// and the biometric prompt — otherwise a missing-MK failure leaves a
  /// stale fresh KEK in HUKS and wastes a biometric sheet on the user.
  async enableBio(): Promise<void> {
    const svc = ShibeiService.instance;
    const huks = HuksService.instance;
    if (!(await huks.isBioAvailable())) {
      throw new ShibeiError('error.bioUnavailable');
    }
    if (!svc.lockIsMkLoaded()) throw new ShibeiError('error.notUnlocked');
    const mkB64: string = svc.lockGetMkForBioEnroll();
    if (!mkB64) throw new ShibeiError('error.notUnlocked');
    await huks.generateBioKey();
    // wrapBio drives init → user-auth (with HUKS challenge) → finish internally.
    const wrapped = await huks.wrapBio(mkB64);
    await svc.lockEnableBio(wrapped);
  }

  async unlockWithPin(pin: string): Promise<void> {
    await ShibeiService.instance.lockUnlockWithPin(pin);
    this.setState(LockState.Unlocked);
  }

  async unlockWithBio(): Promise<void> {
    hilog.info(0x0000, 'shibei', 'unlockWithBio: entry');
    const svc = ShibeiService.instance;
    const huks = HuksService.instance;
    hilog.info(0x0000, 'shibei', 'unlockWithBio: calling lockGetBioWrappedMk');
    const wrapped = svc.lockGetBioWrappedMk();
    hilog.info(0x0000, 'shibei', 'unlockWithBio: wrapped len=%{public}d', wrapped.length);
    if (!wrapped) throw new ShibeiError('error.bioNotEnabled');
    let mkB64: string;
    try {
      hilog.info(0x0000, 'shibei', 'unlockWithBio: calling huks.unwrapBio');
      mkB64 = await huks.unwrapBio(wrapped);
      hilog.info(0x0000, 'shibei', 'unlockWithBio: unwrapBio ok, mk len=%{public}d', mkB64.length);
    } catch (e) {
      const msg = (e as Error).message;
      hilog.warn(0x0000, 'shibei', 'unwrapBio threw: %{public}s', msg);
      // Propagate the underlying error verbatim — don't auto-nuke the bio key.
      // A HUKS IPC hiccup (`-30`, surfaced as "The parameter does not exist.")
      // or a user-cancelled prompt doesn't mean the key is revoked; force-
      // deleting on those is what produced the mysterious "undefined is not
      // callable" cascade (the delete path throws, masking the real error).
      // Truly-revoked keys can be cleaned up by the user via Settings
      // 生物识别 toggle off → on, or the recoverWithE2ee path.
      if (msg.startsWith('error.bioAuthFailed')) {
        throw new ShibeiError('error.bioAuthFailed');
      }
      throw new ShibeiError(msg);
    }
    hilog.info(0x0000, 'shibei', 'unlockWithBio: pushing mk');
    await svc.lockPushUnwrappedMk(mkB64);
    this.setState(LockState.Unlocked);
  }

  async disable(pin: string): Promise<void> {
    await ShibeiService.instance.lockDisable(pin);
    await HuksService.instance.deleteBioKey();
    this.setState(LockState.NotConfigured);
  }

  async recoverWithE2ee(password: string, newPin: string): Promise<void> {
    await ShibeiService.instance.lockRecoverWithE2ee(password, newPin);
    await HuksService.instance.deleteBioKey();
    this.setState(LockState.Unlocked);
  }

  // ── internals ──────────────────────────────────────────────

  private performLock(): void {
    ShibeiService.instance.lockVault();
    this.setState(LockState.Locked);
    router.replaceUrl({ url: 'pages/LockScreen' }).catch((err: Error) => {
      hilog.error(0x0000, 'shibei', 'route to lockScreen failed: %{public}s', err.message);
    });
  }

  private setState(s: LockState): void {
    if (s === this.state) return;
    this.state = s;
    this.subscribers.forEach((sub: Subscriber) => {
      try { sub(s); } catch (e) {
        hilog.warn(0x0000, 'shibei', 'lock sub threw: %{public}s', (e as Error).message);
      }
    });
  }

  private clearGraceTimer(): void {
    if (this.graceTimerId !== -1) {
      clearTimeout(this.graceTimerId);
      this.graceTimerId = -1;
    }
  }
}
