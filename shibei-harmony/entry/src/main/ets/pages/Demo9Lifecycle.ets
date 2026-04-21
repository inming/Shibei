import { hilog } from '@kit.PerformanceAnalysisKit';
import { common } from '@kit.AbilityKit';

// Phase 2 Track A3 — direct NAPI imports (no ShibeiService) so we can tell
// ArkTS-level failures from facade-layer failures.

import {
  initApp,
  isInitialized,
  hasSavedConfig,
  isUnlocked,
  lockVault,
} from 'libshibei_core.so';

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
    this.dataDir = ctx.filesDir;
    hilog.info(0x0000, 'shibei', 'demo9 page loaded; filesDir=%{public}s', this.dataDir);
  }

  private runInit(): void {
    this.initLine = `calling initApp("${this.dataDir}")…`;
    try {
      const result: string = initApp(this.dataDir);
      this.initLine = `initApp → ${result}`;
      hilog.info(0x0000, 'shibei', 'demo9 initApp: %{public}s', result);
    } catch (err) {
      this.initLine = `ERR: ${err.name}: ${err.message}`;
      hilog.error(0x0000, 'shibei', 'demo9 initApp fail: %{public}s', err.message);
    }
  }

  private probeAll(): void {
    try {
      const a: boolean = isInitialized();
      this.isInitLine = `isInitialized() → ${a}`;
    } catch (err) {
      this.isInitLine = `ERR isInitialized: ${err.message}`;
    }
    try {
      const b: boolean = hasSavedConfig();
      this.hasConfigLine = `hasSavedConfig() → ${b}`;
    } catch (err) {
      this.hasConfigLine = `ERR hasSavedConfig: ${err.message}`;
    }
    try {
      const c: boolean = isUnlocked();
      this.isUnlockedLine = `isUnlocked() → ${c}`;
    } catch (err) {
      this.isUnlockedLine = `ERR isUnlocked: ${err.message}`;
    }
    hilog.info(0x0000, 'shibei', 'demo9 probe done');
  }

  private runLock(): void {
    try {
      lockVault();
      this.lockLine = `lockVault() returned; re-probe below`;
      this.isUnlockedLine = `isUnlocked() → ${isUnlocked()}`;
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

        Text('1) initApp (idempotent)').fontSize(16).margin({ top: 20 });
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
        Text('  initApp → ok').fontSize(12).fontFamily('monospace');
        Text('  isInitialized → true').fontSize(12).fontFamily('monospace');
        Text('  hasSavedConfig → false').fontSize(12).fontFamily('monospace');
        Text('  isUnlocked → false').fontSize(12).fontFamily('monospace');
      }
      .width('100%').padding(16);
    }
    .width('100%').height('100%');
  }
}
