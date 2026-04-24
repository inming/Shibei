import { hilog } from '@kit.PerformanceAnalysisKit';
import { common } from '@kit.AbilityKit';
import { router, promptAction } from '@kit.ArkUI';
import { ShibeiService, ShibeiError, CacheStats, CacheListRow, AutoSyncMode } from '../services/ShibeiService';
import { loadTheme, applyTheme, ThemeMode } from '../app/ThemeManager';
import { LockService } from '../services/LockService';
import { HuksService } from '../services/HuksService';
import { I18n } from '../services/I18n';

// Track F — Phase 2 Settings (精简).
//
// Sections: 外观 / 同步 / 安全 / 数据. All user-visible text flows through
// I18n.t($r('app.string.settings_*')); theme-aware colors use either
// $r('sys.color.ohos_id_color_*') system tokens or $r('app.color.*') app
// tokens (accent_primary / accent_danger / text_secondary / accent_primary_alt)
// for dialog buttons where the SDK expects an explicit color argument.

// Hidden-TextInput ids for programmatic focus. Separate ids per PIN flow so
// re-opening a dialog after a previous one resolved doesn't steal focus
// from the wrong input element.
const E2EE_PWD_ID = 'settingsE2eePwd';
const SETUP_PIN_ID = 'settingsSetupPin';
const DISABLE_PIN_ID = 'settingsDisablePin';
const CHANGE_PIN_ID = 'settingsChangePin';

// Change-PIN flow has 3 sequential steps (vs setup's 2). Separate state
// from setupPinStep so the union type stays tight.
type ChangePinStep = 'oldPin' | 'newPin' | 'confirm';

// Shared shape for all three PIN modals. Named so ArkTS @Builder doesn't
// trip on "object literal as type". `onChange` is where each flow maps
// the typed value back to its @State slot; `filled` drives the 4-dot row.
interface PinCardOpts {
  title: string;
  subtitle: string;
  inputId: string;
  filled: number;
  value: string;
  onChange: (v: string) => void;
  onCancel: () => void;
}

@Entry
@Component
struct Settings {
  @State theme: ThemeMode = 'system';
  @State resetting: boolean = false;
  @State resetError: string = '';
  @State syncing: boolean = false;
  @State syncStatus: string = '';
  @State resetCursorsBusy: boolean = false;
  @State lockEnabled: boolean = false;
  @State bioEnabled: boolean = false;
  @State bioAvailable: boolean = false;
  @State showSetupLock: boolean = false;
  @State showDisableLock: boolean = false;
  @State showChangePin: boolean = false;
  @State pinInput: string = '';
  @State pinConfirm: string = '';
  @State pinStep: 'enter' | 'confirm' = 'enter';
  @State oldPinInput: string = '';
  @State changePinStep: ChangePinStep = 'oldPin';
  // ── Cache management state (§7.2) ──
  @State cacheStats: CacheStats = { totalBytes: 0, limitBytes: 0, entryCount: 0 };
  @State cacheList: CacheListRow[] = [];
  @State showCacheList: boolean = false;
  @State cacheBusy: boolean = false;
  // Sync settings (§7.3)
  @State autoSyncMode: AutoSyncMode = 'on_open';
  @State lastSyncAt: string = '';
  // E2EE unlock (§7.7): surfaces a recovery card at the top of Settings
  // when the vault has an S3 keyring but this session's MK is not loaded.
  // Happens after `reset_device` + re-onboard on devices without App Lock,
  // or after HUKS key loss — design doc's "回退 输 E2EE 密码" fallback.
  @State e2eeLocked: boolean = false;
  @State showUnlockE2ee: boolean = false;
  @State e2eePwdInput: string = '';
  @State e2eeUnlocking: boolean = false;
  @State e2eeUnlockError: string = '';

  async aboutToAppear(): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    this.theme = await loadTheme(ctx);
    this.lockEnabled = ShibeiService.instance.lockIsConfigured();
    this.bioEnabled = ShibeiService.instance.lockIsBioEnabled();
    this.bioAvailable = await HuksService.instance.isBioAvailable();
    this.reloadCache();
    this.reloadSyncSettings();
    this.refreshE2eeLockState();
  }

  /// Update `e2eeLocked`. True when the app knows it's onboarded (has S3
  /// config) but no Master Key is in memory — typical after a cold start
  /// on a device without App Lock. The card appears at the top of Settings
  /// so the user has a clear path back to a working sync.
  private refreshE2eeLockState(): void {
    try {
      this.e2eeLocked = ShibeiService.instance.hasSavedConfig()
        && !ShibeiService.instance.isUnlocked();
    } catch (err) {
      hilog.warn(0x0000, 'shibei', 'refreshE2eeLockState fail: %{public}s', (err as Error).message);
    }
  }

  private async submitUnlockE2ee(): Promise<void> {
    if (this.e2eeUnlocking) return;
    if (!this.e2eePwdInput) {
      this.e2eeUnlockError = I18n.t($r('app.string.unlock_e2ee_empty'));
      return;
    }
    this.e2eeUnlocking = true;
    this.e2eeUnlockError = '';
    try {
      await ShibeiService.instance.setE2eePassword(this.e2eePwdInput);
      this.showUnlockE2ee = false;
      this.e2eePwdInput = '';
      this.refreshE2eeLockState();
      promptAction.showToast({ message: I18n.t($r('app.string.unlock_e2ee_toast_ok')) });
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
      this.e2eeUnlockError = I18n.translateError(code);
      hilog.warn(0x0000, 'shibei', 'unlock e2ee fail: %{public}s', code);
    } finally {
      this.e2eeUnlocking = false;
    }
  }

  private reloadSyncSettings(): void {
    try {
      this.autoSyncMode = ShibeiService.instance.getAutoSyncMode();
      this.lastSyncAt = ShibeiService.instance.getLastSyncAt();
    } catch (err) {
      hilog.warn(0x0000, 'shibei', 'reloadSyncSettings fail: %{public}s', (err as Error).message);
    }
  }

  private async pickAutoSyncMode(): Promise<void> {
    try {
      const r = await promptAction.showDialog({
        title: I18n.t($r('app.string.sync_auto_title')),
        buttons: [
          { text: I18n.t($r('app.string.sync_auto_on_open')), color: $r('app.color.accent_primary') },
          { text: I18n.t($r('app.string.sync_auto_manual')), color: $r('app.color.text_secondary') },
        ],
      });
      const mode: AutoSyncMode = r.index === 1 ? 'manual' : 'on_open';
      ShibeiService.instance.setAutoSyncMode(mode);
      this.autoSyncMode = mode;
    } catch (err) {
      hilog.warn(0x0000, 'shibei', 'pickAutoSyncMode dismissed: %{public}s', (err as Error).message);
    }
  }

  private async pickCacheLimit(): Promise<void> {
    try {
      const r = await promptAction.showDialog({
        title: I18n.t($r('app.string.cache_limit_title')),
        buttons: [
          { text: '200 MB', color: $r('app.color.text_primary') },
          { text: '500 MB', color: $r('app.color.text_primary') },
          { text: '1 GB', color: $r('app.color.accent_primary') },
          { text: '2 GB', color: $r('app.color.text_primary') },
        ],
      });
      const mb = [200, 500, 1024, 2048][r.index] ?? 1024;
      ShibeiService.instance.setCacheLimit(mb * 1024 * 1024);
      this.reloadCache();
      promptAction.showToast({
        message: I18n.t($r('app.string.cache_limit_toast_ok'), mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`),
      });
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
      hilog.warn(0x0000, 'shibei', 'pickCacheLimit fail: %{public}s', code);
    }
  }

  /// Format `lastSyncAt` ISO8601 into a compact label. Empty ISO → the
  /// "从未同步" placeholder. Same-day → "HH:MM"; otherwise "MM-DD HH:MM"
  /// so the value is still readable without a full year stamp.
  private formatLastSync(): string {
    if (!this.lastSyncAt) {
      return I18n.t($r('app.string.sync_last_never'));
    }
    const d = new Date(this.lastSyncAt);
    if (isNaN(d.getTime())) return this.lastSyncAt;
    const now = new Date();
    const sameDay = d.getFullYear() === now.getFullYear()
      && d.getMonth() === now.getMonth()
      && d.getDate() === now.getDate();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    if (sameDay) return `${hh}:${mm}`;
    const MM = String(d.getMonth() + 1).padStart(2, '0');
    const DD = String(d.getDate()).padStart(2, '0');
    return `${MM}-${DD} ${hh}:${mm}`;
  }

  private autoSyncLabel(): string {
    return this.autoSyncMode === 'on_open'
      ? I18n.t($r('app.string.sync_auto_on_open'))
      : I18n.t($r('app.string.sync_auto_manual'));
  }

  private cacheLimitLabel(): string {
    const mb = Math.round(this.cacheStats.limitBytes / (1024 * 1024));
    return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB` : `${mb} MB`;
  }

  private reloadCache(): void {
    try {
      this.cacheStats = ShibeiService.instance.getCacheStats();
      if (this.showCacheList) {
        this.cacheList = ShibeiService.instance.getCacheList();
      }
    } catch (err) {
      hilog.warn(0x0000, 'shibei', 'reloadCache fail: %{public}s', (err as Error).message);
    }
  }

  private toggleCacheList(): void {
    this.showCacheList = !this.showCacheList;
    if (this.showCacheList) {
      try {
        this.cacheList = ShibeiService.instance.getCacheList();
      } catch (err) {
        hilog.warn(0x0000, 'shibei', 'getCacheList fail: %{public}s', (err as Error).message);
      }
    }
  }

  private async clearCacheConfirm(): Promise<void> {
    if (this.cacheBusy) return;
    try {
      const r = await promptAction.showDialog({
        title: I18n.t($r('app.string.cache_clear_confirm_title')),
        message: I18n.t($r('app.string.cache_clear_confirm_body')),
        buttons: [
          { text: I18n.t($r('app.string.common_cancel')), color: $r('app.color.text_secondary') },
          { text: I18n.t($r('app.string.cache_clear_confirm_ok')), color: $r('app.color.accent_danger') },
        ],
      });
      if (r.index !== 1) return;
    } catch (err) {
      hilog.warn(0x0000, 'shibei', 'cache clear dismissed: %{public}s', (err as Error).message);
      return;
    }
    this.cacheBusy = true;
    try {
      const n = ShibeiService.instance.clearCache();
      this.reloadCache();
      promptAction.showToast({ message: I18n.t($r('app.string.cache_clear_toast_ok'), n) });
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
      promptAction.showToast({
        message: I18n.t($r('app.string.cache_clear_toast_failed'), I18n.translateError(code)),
      });
    } finally {
      this.cacheBusy = false;
    }
  }

  private formatBytes(b: number): string {
    if (b < 1024) return `${b} B`;
    const kb = b / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(1)} MB`;
    return `${(mb / 1024).toFixed(2)} GB`;
  }

  private async setTheme(mode: ThemeMode): Promise<void> {
    this.theme = mode;
    const ctx = getContext(this) as common.UIAbilityContext;
    await applyTheme(ctx, mode);
  }

  private async lockNow(): Promise<void> {
    ShibeiService.instance.lockVault();
    router.replaceUrl({ url: 'pages/LockScreen' }).catch((err: Error) => {
      hilog.error(0x0000, 'shibei', 'replaceUrl fail: %{public}s', err.message);
    });
  }

  private startSetupLock(): void {
    this.showSetupLock = true;
    this.pinStep = 'enter';
    this.pinInput = '';
    this.pinConfirm = '';
    this.refocusSetupPin();
  }

  private async submitSetupLock(): Promise<void> {
    if (this.pinStep === 'enter') {
      if (!/^\d{4}$/.test(this.pinInput)) {
        promptAction.showToast({
          message: I18n.t($r('app.string.settings_pin_must_be_4_digits')),
        });
        return;
      }
      this.pinStep = 'confirm';
      this.pinConfirm = '';
      this.refocusSetupPin();
      return;
    }
    if (this.pinConfirm !== this.pinInput) {
      promptAction.showToast({
        message: I18n.t($r('app.string.settings_pin_mismatch')),
      });
      this.pinStep = 'enter';
      this.pinInput = '';
      this.refocusSetupPin();
      return;
    }
    try {
      let wantBio = false;
      if (this.bioAvailable) {
        const dlg = await promptAction.showDialog({
          title: I18n.t($r('app.string.settings_bio_enroll_title')),
          message: I18n.t($r('app.string.settings_bio_enroll_message')),
          buttons: [
            {
              text: I18n.t($r('app.string.settings_bio_enroll_pin_only')),
              color: $r('app.color.text_secondary'),
            },
            {
              text: I18n.t($r('app.string.settings_bio_enroll_yes')),
              color: $r('app.color.accent_primary'),
            },
          ],
        });
        wantBio = dlg.index === 1;
      }
      await LockService.instance.setupPin(this.pinInput, wantBio);
      this.lockEnabled = true;
      this.bioEnabled = wantBio;
      this.showSetupLock = false;
      this.pinInput = '';
      this.pinConfirm = '';
      promptAction.showToast({
        message: I18n.t($r('app.string.settings_lock_enabled_toast')),
      });
    } catch (e) {
      const code: string = e instanceof ShibeiError ? e.code : (e as Error).message;
      promptAction.showToast({
        message: I18n.t($r('app.string.settings_lock_enable_failed'), I18n.translateError(code)),
      });
    }
  }

  private async submitDisableLock(): Promise<void> {
    try {
      await LockService.instance.disable(this.pinInput);
      this.lockEnabled = false;
      this.bioEnabled = false;
      this.showDisableLock = false;
      this.pinInput = '';
      promptAction.showToast({
        message: I18n.t($r('app.string.settings_lock_disabled_toast')),
      });
    } catch (e) {
      const code: string = e instanceof ShibeiError ? e.code : (e as Error).message;
      this.pinInput = '';
      const message = code === 'error.pinIncorrect'
        ? I18n.t($r('app.string.settings_lock_pin_incorrect'))
        : I18n.t($r('app.string.settings_lock_disable_failed'), I18n.translateError(code));
      promptAction.showToast({ message });
    }
  }

  private async toggleBio(target: boolean): Promise<void> {
    try {
      if (target) {
        await LockService.instance.enableBio();
        this.bioEnabled = true;
        promptAction.showToast({
          message: I18n.t($r('app.string.settings_bio_enabled_toast')),
        });
      } else {
        await HuksService.instance.deleteBioKey();
        await ShibeiService.instance.lockDeleteBioOnly();
        this.bioEnabled = false;
        promptAction.showToast({
          message: I18n.t($r('app.string.settings_bio_disabled_toast')),
        });
      }
    } catch (e) {
      const code: string = e instanceof ShibeiError ? e.code : (e as Error).message;
      promptAction.showToast({
        message: I18n.t($r('app.string.settings_bio_toggle_failed'), I18n.translateError(code)),
      });
      // Re-read live state so the toggle UI reflects reality
      this.bioEnabled = ShibeiService.instance.lockIsBioEnabled();
    }
  }

  private async submitChangePin(): Promise<void> {
    if (this.oldPinInput.length !== 4) return;
    if (this.pinInput.length !== 4) return;
    if (this.pinConfirm !== this.pinInput) {
      promptAction.showToast({
        message: I18n.t($r('app.string.settings_pin_new_mismatch')),
      });
      this.changePinStep = 'newPin';
      this.pinInput = '';
      this.pinConfirm = '';
      this.refocusChangePin();
      return;
    }
    try {
      await ShibeiService.instance.lockUnlockWithPin(this.oldPinInput);
      await ShibeiService.instance.lockSetupPin(this.pinInput);
      this.showChangePin = false;
      this.oldPinInput = '';
      this.pinInput = '';
      this.pinConfirm = '';
      promptAction.showToast({
        message: I18n.t($r('app.string.settings_lock_pin_changed')),
      });
    } catch (e) {
      const code: string = e instanceof ShibeiError ? e.code : (e as Error).message;
      this.oldPinInput = '';
      this.pinInput = '';
      this.pinConfirm = '';
      this.changePinStep = 'oldPin';
      this.refocusChangePin();
      const message = code === 'error.pinIncorrect'
        ? I18n.t($r('app.string.settings_lock_old_pin_incorrect'))
        : I18n.t($r('app.string.settings_lock_pin_change_failed'), I18n.translateError(code));
      promptAction.showToast({ message });
    }
  }

  /// Pop the numeric keyboard focus on the current step's hidden TextInput.
  /// Called after each step flip (oldPin → newPin → confirm) + on mismatch
  /// reset. 50ms delay lets ArkUI rebuild the opened dialog before we poke
  /// focus — otherwise the input element doesn't exist yet.
  private refocusChangePin(): void {
    setTimeout(() => {
      try { focusControl.requestFocus(CHANGE_PIN_ID); }
      catch (_e) { /* dialog closed */ }
    }, 50);
  }

  private refocusSetupPin(): void {
    setTimeout(() => {
      try { focusControl.requestFocus(SETUP_PIN_ID); }
      catch (_e) { /* dialog closed */ }
    }, 50);
  }

  // Manual sync trigger. Mobile has no automatic sync loop yet — the user
  // pulls fresh data via this button. Progress events update `syncStatus`
  // so the row reflects live phase ("downloading", "applying"...).
  private async syncNow(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    this.syncStatus = I18n.t($r('app.string.settings_sync_preparing'));
    const unsub = ShibeiService.instance.onSyncProgress((ev) => {
      if (ev.total > 0) {
        this.syncStatus = `${ev.phase} ${ev.current}/${ev.total}`;
      } else {
        this.syncStatus = ev.phase;
      }
    });
    try {
      const result = await ShibeiService.instance.syncMetadata();
      if (result.kind === 'success') {
        promptAction.showToast({
          message: I18n.t(
            $r('app.string.settings_sync_complete'),
            result.uploaded,
            result.downloaded,
          ),
        });
      } else {
        promptAction.showToast({
          message: I18n.t($r('app.string.settings_sync_skipped')),
        });
      }
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
      promptAction.showToast({
        message: I18n.t($r('app.string.settings_sync_failed'), I18n.translateError(code)),
      });
    } finally {
      unsub();
      this.syncing = false;
      this.syncStatus = '';
    }
  }

  // Recovery for the historical snapshot-cursor bug. Clears
  // `remote:*:last_seq` + `last_sync_at` so the next sync re-runs the
  // snapshot-import pass. Not destructive — S3 data + local data untouched.
  private async resetSyncCursors(): Promise<void> {
    if (this.resetCursorsBusy) return;
    let confirmed = false;
    try {
      const res = await promptAction.showDialog({
        title: I18n.t($r('app.string.settings_reset_cursors')),
        message: I18n.t($r('app.string.settings_reset_cursors_body')),
        buttons: [
          {
            text: I18n.t($r('app.string.common_cancel')),
            color: $r('app.color.text_secondary'),
          },
          {
            text: I18n.t($r('app.string.settings_reset_cursors_confirm')),
            color: $r('app.color.accent_primary_alt'),
          },
        ],
      });
      confirmed = res.index === 1;
    } catch (err) {
      hilog.info(0x0000, 'shibei', 'resetSyncCursors dialog dismissed: %{public}s',
        (err as Error).message);
      return;
    }
    if (!confirmed) return;

    this.resetCursorsBusy = true;
    try {
      const n = ShibeiService.instance.resetSyncCursors();
      promptAction.showToast({
        message: I18n.t($r('app.string.settings_reset_cursors_success'), n),
      });
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
      promptAction.showToast({
        message: I18n.t($r('app.string.settings_reset_cursors_failed'), I18n.translateError(code)),
      });
    }
    this.resetCursorsBusy = false;
  }

  // Two-tap confirmation: native dialog first (hard confirm), then the
  // call itself. `promptAction.showDialog` returns the index of the
  // pressed button — 1 means user tapped the destructive confirm.
  private async resetDevice(): Promise<void> {
    let confirmed = false;
    try {
      const res = await promptAction.showDialog({
        title: I18n.t($r('app.string.settings_reset_device')),
        message: I18n.t($r('app.string.settings_reset_device_body')),
        buttons: [
          {
            text: I18n.t($r('app.string.common_cancel')),
            color: $r('app.color.text_secondary'),
          },
          {
            text: I18n.t($r('app.string.settings_reset_device_confirm')),
            color: $r('app.color.accent_danger'),
          },
        ],
      });
      confirmed = res.index === 1;
    } catch (err) {
      // showDialog throws on dismiss in some OS versions — treat as cancel.
      hilog.info(0x0000, 'shibei', 'resetDevice dialog dismissed: %{public}s',
        (err as Error).message);
      return;
    }
    if (!confirmed) return;

    this.resetting = true;
    this.resetError = '';
    try {
      ShibeiService.instance.resetDevice();
      router.replaceUrl({ url: 'pages/Onboard' }).catch((err: Error) => {
        hilog.error(0x0000, 'shibei', 'replaceUrl fail: %{public}s', err.message);
      });
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : err.message;
      this.resetError = I18n.t($r('app.string.settings_reset_device_failed'), I18n.translateError(code));
    }
    this.resetting = false;
  }

  // Radio-style theme row. `label` is shown; `mode` is the underlying value.
  @Builder
  ThemeOption(label: string, mode: ThemeMode) {
    Row() {
      Text(label).fontSize(15).layoutWeight(1)
        .fontColor($r('sys.color.ohos_id_color_text_primary'));
      Text(this.theme === mode ? '✓' : '').fontSize(16)
        .fontColor($r('sys.color.ohos_id_color_emphasize')).width(20);
    }
    .width('100%')
    .padding({ top: 12, bottom: 12, left: 12, right: 12 })
    .onClick(() => this.setTheme(mode));
  }

  build() {
    // Wrap the page in a Stack so the PIN modal overlays can render on
    // top of the scroll content. bindContentCover turned out to flicker
    // closed mid-transition (likely a Toggle onChange race); a plain
    // Stack+conditional render avoids the cover lifecycle entirely.
    Stack() {
    Column() {
      // Top bar
      Row() {
        Text('‹').fontSize(26).fontColor($r('sys.color.ohos_id_color_text_primary'))
          .width(44).height(44).textAlign(TextAlign.Center)
          .onClick(() => router.back());
        Text(I18n.t($r('app.string.settings_page_title')))
          .fontSize(17).fontWeight(FontWeight.Medium).layoutWeight(1)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .textAlign(TextAlign.Center);
        Text('').width(44);
      }
      .width('100%').padding({ left: 4, right: 4, top: 4, bottom: 4 })
      .backgroundColor($r('sys.color.ohos_id_color_background'));

      Scroll() {
        Column() {
          // ── E2EE unlock recovery card (§7.7) ───────────────
          // Shown only when hasSavedConfig && !isUnlocked. After tapping
          // "解锁" the inline dialog below takes the password and calls
          // setE2eePassword. On success the card disappears + a toast
          // confirms the MK is loaded. Failures stay inline so the user
          // can correct the password without losing their input.
          if (this.e2eeLocked) {
            Column() {
              if (!this.showUnlockE2ee) {
                Row() {
                  Column() {
                    Text(I18n.t($r('app.string.unlock_e2ee_card_title')))
                      .fontSize(14)
                      .fontColor($r('app.color.accent_danger'))
                      .fontWeight(FontWeight.Medium);
                    Text(I18n.t($r('app.string.unlock_e2ee_card_hint')))
                      .fontSize(12).fontColor($r('app.color.text_secondary'))
                      .margin({ top: 2 });
                  }.alignItems(HorizontalAlign.Start).layoutWeight(1);
                  Button(I18n.t($r('app.string.unlock_e2ee_button')))
                    .height(32).fontSize(13)
                    .onClick(() => {
                      this.showUnlockE2ee = true;
                      this.e2eeUnlockError = '';
                      this.e2eePwdInput = '';
                      setTimeout(() => {
                        try { focusControl.requestFocus(E2EE_PWD_ID); }
                        catch (_e) { /* not mounted yet */ }
                      }, 50);
                    });
                }.width('100%').padding(12);
              } else {
                Column() {
                  Text(I18n.t($r('app.string.unlock_e2ee_prompt')))
                    .fontSize(14).margin({ top: 4 });
                  TextInput({ placeholder: I18n.t($r('app.string.unlock_e2ee_placeholder')), text: this.e2eePwdInput })
                    .id(E2EE_PWD_ID)
                    .type(InputType.Password)
                    .defaultFocus(true)
                    .width('100%').margin({ top: 10 })
                    .onChange((v: string) => {
                      this.e2eePwdInput = v;
                      this.e2eeUnlockError = '';
                    })
                    .onSubmit(() => this.submitUnlockE2ee());
                  if (this.e2eeUnlockError) {
                    Text(this.e2eeUnlockError).fontSize(12)
                      .fontColor($r('app.color.accent_danger'))
                      .margin({ top: 6 });
                  }
                  Row() {
                    Button(I18n.t($r('app.string.common_cancel')))
                      .backgroundColor(Color.Transparent)
                      .fontColor($r('app.color.text_secondary'))
                      .layoutWeight(1)
                      .onClick(() => {
                        this.showUnlockE2ee = false;
                        this.e2eePwdInput = '';
                        this.e2eeUnlockError = '';
                      });
                    Button(this.e2eeUnlocking
                      ? I18n.t($r('app.string.unlock_e2ee_submitting'))
                      : I18n.t($r('app.string.unlock_e2ee_submit')))
                      .layoutWeight(1).margin({ left: 8 })
                      .enabled(!this.e2eeUnlocking)
                      .onClick(() => this.submitUnlockE2ee());
                  }.margin({ top: 12 });
                }.padding(12);
              }
            }
            .backgroundColor($r('sys.color.ohos_id_color_background')).borderRadius(8)
            .margin({ top: 16, left: 12, right: 12 });
          }

          // ── 外观 ─────────────────────────────────────────
          Text(I18n.t($r('app.string.settings_section_appearance'))).fontSize(13)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ top: 16, left: 16, bottom: 4 });
          Column() {
            this.ThemeOption(I18n.t($r('app.string.settings_theme_system')), 'system');
            Divider().color($r('sys.color.ohos_id_color_list_separator'));
            this.ThemeOption(I18n.t($r('app.string.settings_theme_light')), 'light');
            Divider().color($r('sys.color.ohos_id_color_list_separator'));
            this.ThemeOption(I18n.t($r('app.string.settings_theme_dark')), 'dark');
          }
          .backgroundColor($r('sys.color.ohos_id_color_background')).borderRadius(8)
          .margin({ left: 12, right: 12 });

          // ── 同步 ─────────────────────────────────────────
          Text(I18n.t($r('app.string.settings_section_sync'))).fontSize(13)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ top: 24, left: 16, bottom: 4 });
          Column() {
            Row() {
              Column() {
                Text(this.syncing
                  ? I18n.t($r('app.string.settings_sync_in_progress'))
                  : I18n.t($r('app.string.settings_sync_now'))).fontSize(15)
                  .fontColor($r('sys.color.ohos_id_color_text_primary'));
                if (this.syncing && this.syncStatus) {
                  Text(this.syncStatus).fontSize(12)
                    .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                    .margin({ top: 2 });
                } else {
                  Text(I18n.t($r('app.string.sync_last_label'), this.formatLastSync()))
                    .fontSize(11)
                    .fontColor($r('sys.color.ohos_id_color_text_tertiary'))
                    .margin({ top: 2 });
                }
              }.alignItems(HorizontalAlign.Start).layoutWeight(1);
              Text('›').fontSize(18)
                .fontColor($r('sys.color.ohos_id_color_text_tertiary'));
            }
            .width('100%').padding({ top: 12, bottom: 12, left: 12, right: 12 })
            .onClick(() => this.syncNow());

            Divider().color($r('sys.color.ohos_id_color_list_separator'));

            Row() {
              Text(I18n.t($r('app.string.sync_auto_row_title'))).fontSize(15)
                .fontColor($r('sys.color.ohos_id_color_text_primary'))
                .layoutWeight(1);
              Text(this.autoSyncLabel()).fontSize(14)
                .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                .margin({ right: 6 });
              Text('›').fontSize(18)
                .fontColor($r('sys.color.ohos_id_color_text_tertiary'));
            }
            .width('100%').padding({ top: 12, bottom: 12, left: 12, right: 12 })
            .onClick(() => this.pickAutoSyncMode());

            Divider().color($r('sys.color.ohos_id_color_list_separator'));

            Row() {
              Column() {
                Text(this.resetCursorsBusy
                  ? I18n.t($r('app.string.settings_reset_cursors_busy'))
                  : I18n.t($r('app.string.settings_reset_cursors')))
                  .fontSize(15)
                  .fontColor($r('sys.color.ohos_id_color_text_primary'));
                Text(I18n.t($r('app.string.settings_reset_cursors_help')))
                  .fontSize(11)
                  .fontColor($r('sys.color.ohos_id_color_text_tertiary'))
                  .margin({ top: 2 });
              }.alignItems(HorizontalAlign.Start).layoutWeight(1);
              Text('›').fontSize(18)
                .fontColor($r('sys.color.ohos_id_color_text_tertiary'));
            }
            .width('100%').padding({ top: 12, bottom: 12, left: 12, right: 12 })
            .onClick(() => this.resetSyncCursors());
          }
          .backgroundColor($r('sys.color.ohos_id_color_background')).borderRadius(8)
          .margin({ left: 12, right: 12 });

          // ── 安全 ─────────────────────────────────────────
          Text(I18n.t($r('app.string.settings_section_security'))).fontSize(13)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ top: 24, left: 16, bottom: 4 });
          Column() {
            Row() {
              Text(I18n.t($r('app.string.settings_lock_enable'))).fontSize(15).layoutWeight(1)
                .fontColor($r('sys.color.ohos_id_color_text_primary'));
              Toggle({ type: ToggleType.Switch, isOn: this.lockEnabled })
                .onChange((isOn: boolean) => {
                  if (isOn && !this.lockEnabled) {
                    this.startSetupLock();
                  } else if (!isOn && this.lockEnabled) {
                    this.showDisableLock = true;
                    this.pinInput = '';
                    setTimeout(() => {
                      try { focusControl.requestFocus(DISABLE_PIN_ID); }
                      catch (_e) { /* dismissed */ }
                    }, 50);
                  }
                });
            }.width('100%').padding({ top: 12, bottom: 12, left: 12, right: 12 });

            if (this.lockEnabled) {
              Divider().color($r('sys.color.ohos_id_color_list_separator'));
              Row() {
                Column() {
                  Text(I18n.t($r('app.string.settings_bio_unlock'))).fontSize(15)
                    .fontColor($r('sys.color.ohos_id_color_text_primary'));
                  if (!this.bioAvailable) {
                    Text(I18n.t($r('app.string.settings_bio_hint_no_enroll'))).fontSize(11)
                      .fontColor($r('sys.color.ohos_id_color_text_tertiary'));
                  }
                }.alignItems(HorizontalAlign.Start).layoutWeight(1);
                Toggle({ type: ToggleType.Switch, isOn: this.bioEnabled })
                  .enabled(this.bioAvailable)
                  .onChange((isOn: boolean) => {
                    if (isOn !== this.bioEnabled) this.toggleBio(isOn);
                  });
              }.width('100%').padding({ top: 12, bottom: 12, left: 12, right: 12 });

              Divider().color($r('sys.color.ohos_id_color_list_separator'));
              Row() {
                Text(I18n.t($r('app.string.settings_change_pin'))).fontSize(15).layoutWeight(1)
                  .fontColor($r('sys.color.ohos_id_color_text_primary'));
                Text('›').fontSize(18)
                  .fontColor($r('sys.color.ohos_id_color_text_tertiary'));
              }.width('100%').padding({ top: 12, bottom: 12, left: 12, right: 12 })
                .onClick(() => {
                  this.showChangePin = true;
                  this.oldPinInput = '';
                  this.pinInput = '';
                  this.pinConfirm = '';
                  this.changePinStep = 'oldPin';
                  this.refocusChangePin();
                });

              Divider().color($r('sys.color.ohos_id_color_list_separator'));
            }

            // 立即锁定 — always shown (pre-existing behavior)
            Row() {
              Text(I18n.t($r('app.string.settings_lock_now'))).fontSize(15).layoutWeight(1)
                .fontColor($r('sys.color.ohos_id_color_text_primary'));
              Text('›').fontSize(18)
                .fontColor($r('sys.color.ohos_id_color_text_tertiary'));
            }.width('100%').padding({ top: 12, bottom: 12, left: 12, right: 12 })
              .onClick(() => this.lockNow());
          }
          .backgroundColor($r('sys.color.ohos_id_color_background')).borderRadius(8)
          .margin({ left: 12, right: 12 });

          // Setup/Disable/Change PIN flows moved to bindContentCover modals
          // attached at the root Column (end of build()) so they float over
          // the page instead of tucking into the scroll footer where they
          // were hard to notice.

          // ── 数据 / 缓存管理 (§7.2) ────────────────────────
          Text(I18n.t($r('app.string.settings_section_data'))).fontSize(13)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ top: 24, left: 16, bottom: 4 });
          Column() {
            Row() {
              Text(I18n.t($r('app.string.cache_header_title'))).fontSize(15)
                .fontColor($r('app.color.text_primary'))
                .layoutWeight(1);
              Text(I18n.t(
                $r('app.string.cache_header_total'),
                this.formatBytes(this.cacheStats.totalBytes),
                this.formatBytes(this.cacheStats.limitBytes),
              ))
                .fontSize(12)
                .fontColor($r('app.color.text_secondary'));
            }
            .width('100%').padding({ top: 12, bottom: 6, left: 12, right: 12 });
            // Progress bar — clamp visually at 100% even if file-system drift
            // ever puts us slightly over.
            Progress({
              value: Math.min(this.cacheStats.totalBytes, this.cacheStats.limitBytes),
              total: this.cacheStats.limitBytes || 1,
              type: ProgressType.Linear,
            })
              .width('96%').height(4)
              .margin({ left: 12, right: 12, bottom: 8 });
            Row() {
              Text(I18n.t(
                $r('app.string.cache_header_entry_count'),
                this.cacheStats.entryCount,
              ))
                .fontSize(12).fontColor($r('app.color.text_secondary'))
                .layoutWeight(1);
              Text(this.showCacheList
                ? I18n.t($r('app.string.cache_collapse_list'))
                : I18n.t($r('app.string.cache_expand_list')))
                .fontSize(13).fontColor($r('app.color.accent_primary'))
                .onClick(() => this.toggleCacheList());
            }
            .width('100%').padding({ left: 12, right: 12, bottom: 10 });

            if (this.showCacheList) {
              if (this.cacheList.length === 0) {
                Text(I18n.t($r('app.string.cache_list_empty')))
                  .fontSize(12).fontColor($r('app.color.text_subtle'))
                  .padding({ left: 12, right: 12, bottom: 12 });
              } else {
                Column() {
                  ForEach(this.cacheList, (row: CacheListRow) => {
                    Column() {
                      Text(row.title || row.url)
                        .fontSize(13).fontColor($r('app.color.text_primary'))
                        .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis });
                      Row() {
                        Text(row.resourceType.toUpperCase()).fontSize(10)
                          .fontColor($r('app.color.text_subtle'))
                          .margin({ right: 8 });
                        Text(this.formatBytes(row.bytes)).fontSize(11)
                          .fontColor($r('app.color.text_secondary'))
                          .layoutWeight(1);
                      }.width('100%').margin({ top: 2 });
                    }
                    .alignItems(HorizontalAlign.Start)
                    .width('100%')
                    .padding({ left: 12, right: 12, top: 8, bottom: 8 });
                  }, (row: CacheListRow) => row.resourceId);
                }
                .width('100%');
              }
            }

            Divider().strokeWidth(0.5).color($r('app.color.border_divider'));
            Row() {
              Text(I18n.t($r('app.string.cache_limit_row_title'))).fontSize(15)
                .fontColor($r('app.color.text_primary'))
                .layoutWeight(1);
              Text(this.cacheLimitLabel()).fontSize(14)
                .fontColor($r('app.color.text_secondary'))
                .margin({ right: 6 });
              Text('›').fontSize(18)
                .fontColor($r('app.color.text_disabled'));
            }
            .width('100%').padding({ top: 12, bottom: 12, left: 12, right: 12 })
            .onClick(() => this.pickCacheLimit());

            Divider().strokeWidth(0.5).color($r('app.color.border_divider'));
            Row() {
              Text(this.cacheBusy
                ? I18n.t($r('app.string.cache_clear_busy'))
                : I18n.t($r('app.string.cache_clear_button')))
                .fontSize(15)
                .fontColor($r('app.color.accent_danger'))
                .layoutWeight(1);
              Text('›').fontSize(18)
                .fontColor($r('app.color.text_disabled'));
            }
            .width('100%').padding({ top: 12, bottom: 12, left: 12, right: 12 })
            .onClick(() => this.clearCacheConfirm());
          }
          .backgroundColor($r('app.color.bg_secondary')).borderRadius(8)
          .margin({ left: 12, right: 12, bottom: 12 });

          Column() {
            Row() {
              Text(this.resetting
                ? I18n.t($r('app.string.settings_reset_device_busy'))
                : I18n.t($r('app.string.settings_reset_device'))).fontSize(15)
                .fontColor($r('sys.color.ohos_id_color_warning'))
                .layoutWeight(1);
              Text('›').fontSize(18)
                .fontColor($r('sys.color.ohos_id_color_text_tertiary'));
            }
            .width('100%').padding({ top: 12, bottom: 12, left: 12, right: 12 })
            .onClick(() => { if (!this.resetting) this.resetDevice(); });
          }
          .backgroundColor($r('sys.color.ohos_id_color_background')).borderRadius(8)
          .margin({ left: 12, right: 12 });

          if (this.resetError) {
            Text(this.resetError).fontSize(12)
              .fontColor($r('sys.color.ohos_id_color_warning'))
              .margin({ top: 8, left: 16, right: 16 });
          }

          Text(I18n.t($r('app.string.settings_data_disclaimer'))).fontSize(11)
            .fontColor($r('sys.color.ohos_id_color_text_tertiary'))
            .margin({ top: 24, left: 16, right: 16, bottom: 32 });
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%');
      }
      .layoutWeight(1)
      .width('100%');
    }
    .width('100%').height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'));

      // PIN overlays — conditional render at the root Stack level so the
      // card sits on top of the scroll content with its own backdrop. Each
      // overlay is self-contained: backdrop Column fills the screen,
      // centered card in the middle. No bindContentCover.
      if (this.showSetupLock) {
        this.SetupLockModal();
      }
      if (this.showDisableLock) {
        this.DisableLockModal();
      }
      if (this.showChangePin) {
        this.ChangePinModal();
      }
    }
    .width('100%').height('100%');
  }

  /// PIN "card" layout shared by all three modals. Renders a full-screen
  /// backdrop with a centered card holding the title, a 4-dot progress
  /// row, a hidden numeric TextInput driving the dots, and a cancel
  /// button. The flow's onChange handler routes the typed string into
  /// the right @State slot. Stack-parented at the root Column so the
  /// card visually floats over the page content.
  @Builder
  PinModalCard(opts: PinCardOpts) {
    // Full-screen backdrop + centered card.
    Column() {
      Column() {
        Text(opts.title).fontSize(16).fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .margin({ top: 4, bottom: 4 });
        if (opts.subtitle) {
          Text(opts.subtitle).fontSize(12)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .textAlign(TextAlign.Center)
            .margin({ bottom: 20 });
        } else {
          Blank().height(20);
        }
        // 4 dots, filled based on `opts.filled` (digits typed so far).
        Row() {
          ForEach([0, 1, 2, 3], (i: number) => {
            Circle({ width: 14, height: 14 })
              .fill(i < opts.filled
                ? $r('sys.color.ohos_id_color_text_primary')
                : Color.Transparent)
              .stroke($r('sys.color.ohos_id_color_text_tertiary'))
              .strokeWidth(1.5)
              .margin({ left: 8, right: 8 });
          }, (i: number) => `${opts.inputId}:${i}`);
        }.justifyContent(FlexAlign.Center).margin({ bottom: 16 });
        // Hidden TextInput — numeric keyboard, opacity 0, height 1. The
        // focus lives here; the visible Circle row just renders dots.
        TextInput({ placeholder: '', text: opts.value })
          .id(opts.inputId)
          .type(InputType.Number)
          .maxLength(4)
          .defaultFocus(true)
          .opacity(0.01).height(1)
          .onChange(opts.onChange);
        Button(I18n.t($r('app.string.common_cancel')))
          .backgroundColor(Color.Transparent)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .margin({ top: 16 })
          .onClick(opts.onCancel);
      }
      .width('80%')
      .padding({ top: 24, bottom: 16, left: 20, right: 20 })
      .backgroundColor($r('sys.color.ohos_id_color_background'))
      .borderRadius(12)
      .alignItems(HorizontalAlign.Center);
    }
    .width('100%').height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_mask_thin'))
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center);
  }

  /// Setup PIN: enter (4 digits) → confirm (4 digits).
  @Builder
  SetupLockModal() {
    this.PinModalCard({
      title: this.pinStep === 'enter'
        ? I18n.t($r('app.string.settings_pin_set_prompt_enter'))
        : I18n.t($r('app.string.settings_pin_set_prompt_confirm')),
      subtitle: '',
      inputId: SETUP_PIN_ID,
      filled: (this.pinStep === 'enter' ? this.pinInput : this.pinConfirm).length,
      value: this.pinStep === 'enter' ? this.pinInput : this.pinConfirm,
      onChange: (v: string) => {
        const d = v.replace(/\D/g, '').slice(0, 4);
        if (this.pinStep === 'enter') {
          this.pinInput = d;
        } else {
          this.pinConfirm = d;
        }
        if (d.length === 4) this.submitSetupLock();
      },
      onCancel: () => {
        this.showSetupLock = false;
        this.pinInput = '';
        this.pinConfirm = '';
      },
    });
  }

  /// Disable PIN: single step (enter 4 digits to confirm identity).
  @Builder
  DisableLockModal() {
    this.PinModalCard({
      title: I18n.t($r('app.string.settings_pin_disable_prompt')),
      subtitle: '',
      inputId: DISABLE_PIN_ID,
      filled: this.pinInput.length,
      value: this.pinInput,
      onChange: (v: string) => {
        const d = v.replace(/\D/g, '').slice(0, 4);
        this.pinInput = d;
        if (d.length === 4) this.submitDisableLock();
      },
      onCancel: () => {
        this.showDisableLock = false;
        this.pinInput = '';
      },
    });
  }

  /// Change PIN: oldPin → newPin → confirm. Single visible dot row,
  /// title changes per step. Focus stays on the same hidden TextInput
  /// so the keyboard never drops between steps. @Builder can only hold
  /// UI-component statements, so the per-step title/value/filled selector
  /// lives in changePinOpts() below.
  @Builder
  ChangePinModal() {
    this.PinModalCard(this.changePinOpts());
  }

  private changePinOpts(): PinCardOpts {
    let currentValue: string;
    let filled: number;
    let title: string;
    if (this.changePinStep === 'oldPin') {
      currentValue = this.oldPinInput;
      filled = this.oldPinInput.length;
      title = I18n.t($r('app.string.settings_pin_old_prompt'));
    } else if (this.changePinStep === 'newPin') {
      currentValue = this.pinInput;
      filled = this.pinInput.length;
      title = I18n.t($r('app.string.settings_pin_new_prompt'));
    } else {
      currentValue = this.pinConfirm;
      filled = this.pinConfirm.length;
      title = I18n.t($r('app.string.settings_pin_set_prompt_confirm'));
    }
    return {
      title,
      subtitle: '',
      inputId: CHANGE_PIN_ID,
      filled,
      value: currentValue,
      onChange: (v: string) => {
        const d = v.replace(/\D/g, '').slice(0, 4);
        if (this.changePinStep === 'oldPin') {
          this.oldPinInput = d;
          if (d.length === 4) {
            this.changePinStep = 'newPin';
            this.refocusChangePin();
          }
        } else if (this.changePinStep === 'newPin') {
          this.pinInput = d;
          if (d.length === 4) {
            this.changePinStep = 'confirm';
            this.refocusChangePin();
          }
        } else {
          this.pinConfirm = d;
          if (d.length === 4) this.submitChangePin();
        }
      },
      onCancel: () => {
        this.showChangePin = false;
        this.oldPinInput = '';
        this.pinInput = '';
        this.pinConfirm = '';
        this.changePinStep = 'oldPin';
      },
    };
  }
}
