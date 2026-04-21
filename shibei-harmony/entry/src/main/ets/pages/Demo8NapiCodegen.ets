import { hilog } from '@kit.PerformanceAnalysisKit';
import { hello, echoAsync, onTick } from 'libshibei_core.so';

// Phase 2 Track A1 M1.b — exercises the codegen-produced sync / async / event
// paths. Consult `crates/shibei-napi-codegen/` and
// `docs/superpowers/plans/2026-04-21-phase2-skeleton.md` §4.1.

@Entry
@Component
struct Demo8NapiCodegen {
  @State syncLine: string = '(press sync)';
  @State asyncLine: string = '(press async)';
  @State tickLine: string = '(press start)';
  @State tickTotal: number = 0;
  private unsub: (() => void) | null = null;

  private runSync(): void {
    try {
      const s: string = hello();
      this.syncLine = `hello() → ${s}`;
      hilog.info(0x0000, 'shibei', 'demo8 sync: %{public}s', s);
    } catch (err) {
      this.syncLine = `ERR: ${err.name}: ${err.message}`;
      hilog.error(0x0000, 'shibei', 'demo8 sync fail: %{public}s', err.message);
    }
  }

  private async runAsync(): Promise<void> {
    this.asyncLine = 'calling echoAsync("hi")...';
    try {
      const t0: number = Date.now();
      const s: string = await echoAsync('hi');
      const dt: number = Date.now() - t0;
      this.asyncLine = `echoAsync → "${s}" (${dt}ms)`;
      hilog.info(0x0000, 'shibei', 'demo8 async: %{public}s dt=%{public}d', s, dt);
    } catch (err) {
      this.asyncLine = `ERR: ${err.name}: ${err.message}`;
      hilog.error(0x0000, 'shibei', 'demo8 async fail: %{public}s', err.message);
    }
  }

  private startTick(): void {
    if (this.unsub) {
      this.tickLine = 'already running, press stop first';
      return;
    }
    this.tickTotal = 0;
    this.tickLine = 'onTick(500ms) started';
    try {
      this.unsub = onTick(500, (n: number) => {
        this.tickTotal = n + 1;
        this.tickLine = `tick #${n} received`;
        hilog.info(0x0000, 'shibei', 'demo8 tick: %{public}d', n);
      });
    } catch (err) {
      this.tickLine = `ERR: ${err.name}: ${err.message}`;
      hilog.error(0x0000, 'shibei', 'demo8 tick fail: %{public}s', err.message);
    }
  }

  private stopTick(): void {
    if (!this.unsub) {
      this.tickLine = 'not running';
      return;
    }
    this.unsub();
    this.unsub = null;
    this.tickLine = `stopped after ${this.tickTotal} ticks`;
  }

  aboutToDisappear(): void {
    // leaving the page should cancel the background thread
    if (this.unsub) {
      this.unsub();
      this.unsub = null;
    }
  }

  build() {
    Scroll() {
      Column() {
        Text('Demo 8: NAPI codegen').fontSize(20).margin({ top: 24, bottom: 16 });

        Text('sync: hello()').fontSize(16).margin({ top: 8 });
        Button('run sync').width('90%').margin({ top: 8 }).onClick(() => this.runSync());
        Text(this.syncLine).margin({ top: 8 }).width('90%');

        Text('async: echoAsync("hi")').fontSize(16).margin({ top: 24 });
        Button('run async').width('90%').margin({ top: 8 }).onClick(() => this.runAsync());
        Text(this.asyncLine).margin({ top: 8 }).width('90%');

        Text('event: onTick(500)').fontSize(16).margin({ top: 24 });
        Row() {
          Button('start').margin({ right: 8 }).onClick(() => this.startTick());
          Button('stop').onClick(() => this.stopTick());
        }.margin({ top: 8 });
        Text(this.tickLine).margin({ top: 8 }).width('90%');
        Text(`total ticks: ${this.tickTotal}`).margin({ top: 4 }).width('90%');
      }
      .width('100%').padding(16);
    }
    .width('100%').height('100%');
  }
}
