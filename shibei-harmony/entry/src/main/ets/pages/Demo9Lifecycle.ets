import { hilog } from '@kit.PerformanceAnalysisKit';
import { common } from '@kit.AbilityKit';
import { ShibeiService, ShibeiError } from '../services/ShibeiService';

// Phase 2 Track A3 — exercises the 5 lifecycle commands wired through the
// ShibeiService facade. Consult `src-harmony-napi/src/state.rs` and
// `docs/superpowers/plans/2026-04-21-phase2-skeleton.md` §4.2.

@Entry
@Component
struct Demo9Lifecycle {
  @State dataDir: string = '';
  @State initLine: string = '(press init)';
  @State isInitLine: string = '(press probe)';
  @State hasConfigLine: string = '(press probe)';
  @State isUnlockedLine: string = '(press probe)';
  @State lockLine: string = '(call lockVault)';

  aboutToAppear(): void {
    const ctx = getContext(this) as common.UIAbilityContext;
    // filesDir resolves to ~ /data/storage/el2/base/haps/entry/files (el2 =
    // device-unlock class + app sandbox; see Phase 0 Demo 4 verification).
    this.dataDir = ctx.filesDir;
  }

  private async runInit(): Promise<void> {
    this.initLine = `calling init("${this.dataDir}")…`;
    try {
      await ShibeiService.instance.init(this.dataDir);
      this.initLine = `init ok (dataDir=${this.dataDir})`;
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : `${err.name}: ${err.message}`;
      this.initLine = `ERR: ${code}`;
      hilog.error(0x0000, 'shibei', 'demo9 init fail: %{public}s', code);
    }
  }

  private probeAll(): void {
    try {
      this.isInitLine = `isInitialized() → ${ShibeiService.instance.isInitialized()}`;
      this.hasConfigLine = `hasSavedConfig() → ${ShibeiService.instance.hasSavedConfig()}`;
      this.isUnlockedLine = `isUnlocked() → ${ShibeiService.instance.isUnlocked()}`;
    } catch (err) {
      hilog.error(0x0000, 'shibei', 'demo9 probe fail: %{public}s', err.message);
    }
  }

  private runLock(): void {
    try {
      ShibeiService.instance.lockVault();
      this.lockLine = `lockVault() returned; re-probe below`;
      this.isUnlockedLine = `isUnlocked() → ${ShibeiService.instance.isUnlocked()}`;
    } catch (err) {
      this.lockLine = `ERR: ${err.message}`;
      hilog.error(0x0000, 'shibei', 'demo9 lock fail: %{public}s', err.message);
    }
  }

  build() {
    Scroll() {
      Column() {
        Text('Demo 9: lifecycle (A3)').fontSize(20).margin({ top: 24, bottom: 16 });

        Text('data_dir (filesDir under el2):').fontSize(14);
        Text(this.dataDir).fontSize(12).fontFamily('monospace').width('90%');

        Text('1) init (idempotent)').fontSize(16).margin({ top: 20 });
        Button('run init').width('90%').margin({ top: 8 }).onClick(() => this.runInit());
        Text(this.initLine).margin({ top: 8 }).width('90%');

        Text('2) probe state').fontSize(16).margin({ top: 20 });
        Button('probe isInitialized / hasSavedConfig / isUnlocked')
          .width('90%').margin({ top: 8 }).onClick(() => this.probeAll());
        Text(this.isInitLine).margin({ top: 8 }).width('90%');
        Text(this.hasConfigLine).margin({ top: 4 }).width('90%');
        Text(this.isUnlockedLine).margin({ top: 4 }).width('90%');

        Text('3) lockVault').fontSize(16).margin({ top: 20 });
        Button('call lockVault').width('90%').margin({ top: 8 }).onClick(() => this.runLock());
        Text(this.lockLine).margin({ top: 8 }).width('90%');

        Text('Expected on fresh install:').fontSize(14).margin({ top: 24 });
        Text('  init → ok').fontSize(12).fontFamily('monospace');
        Text('  isInitialized → true').fontSize(12).fontFamily('monospace');
        Text('  hasSavedConfig → false  (no onboard yet)').fontSize(12).fontFamily('monospace');
        Text('  isUnlocked → false      (no E2EE password yet)').fontSize(12).fontFamily('monospace');
      }
      .width('100%').padding(16);
    }
    .width('100%').height('100%');
  }
}
