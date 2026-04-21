// Listens to `display.foldStatusChange` and mirrors the latest _stable_ state
// into AppStorage under KEY_FOLD_STATUS so components can `@StorageProp`
// react without subscribing to display events themselves.
//
// Mate X5 on HarmonyOS 6 emits HALF_FOLDED during the hinge motion (Phase 0
// verification report, §3). Treating every raw event as a layout trigger
// causes flicker; we debounce by requiring the same status to stay quiet
// for SETTLE_MS before propagating. For two FOLDED-stable ↔ EXPANDED-stable
// transitions the net effect is a ~100ms delay after motion completes,
// which matches the fold animation and feels natural.

import { display } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { KEY_FOLD_STATUS } from './AppStorageKeys';

export enum FoldStatus {
  FOLDED = 'FOLDED',
  EXPANDED = 'EXPANDED',
}

const SETTLE_MS = 100;

export class FoldObserver {
  private static _instance: FoldObserver | null = null;
  private pendingTimer: number = -1;
  private started: boolean = false;

  static get instance(): FoldObserver {
    if (!FoldObserver._instance) {
      FoldObserver._instance = new FoldObserver();
    }
    return FoldObserver._instance;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    try {
      const initial: display.FoldStatus = display.getFoldStatus();
      AppStorage.setOrCreate(KEY_FOLD_STATUS, this.normalize(initial));
    } catch (err) {
      // Non-foldable device — default to EXPANDED (matches phone/tablet UX).
      AppStorage.setOrCreate(KEY_FOLD_STATUS, FoldStatus.EXPANDED);
      return;
    }

    display.on('foldStatusChange', (s: display.FoldStatus) => {
      const normalized: FoldStatus = this.normalize(s);
      if (this.pendingTimer >= 0) {
        clearTimeout(this.pendingTimer);
      }
      this.pendingTimer = setTimeout(() => {
        const prev: FoldStatus = AppStorage.get<FoldStatus>(KEY_FOLD_STATUS) ?? FoldStatus.FOLDED;
        if (prev !== normalized) {
          AppStorage.set(KEY_FOLD_STATUS, normalized);
          hilog.info(0x0000, 'shibei', 'foldStatus settled: %{public}s', normalized);
        }
        this.pendingTimer = -1;
      }, SETTLE_MS);
    });
  }

  stop(): void {
    display.off('foldStatusChange');
    if (this.pendingTimer >= 0) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = -1;
    }
    this.started = false;
  }

  private normalize(s: display.FoldStatus): FoldStatus {
    // HALF_FOLDED on Mate X5 reports during motion; treat as EXPANDED so the
    // layout is ready by the time the hinge reaches the open angle.
    return s === display.FoldStatus.FOLD_STATUS_FOLDED ? FoldStatus.FOLDED : FoldStatus.EXPANDED;
  }
}
