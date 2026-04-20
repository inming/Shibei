import { backgroundTaskManager } from '@kit.BackgroundTasksKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

@Entry
@Component
struct Demo6BackgroundTask {
  @State log: Array<string> = [];
  @State running: boolean = false;
  private tickTimer: number | null = null;

  private append(s: string): void {
    this.log = [`${new Date().toISOString().substring(11, 23)} ${s}`, ...this.log].slice(0, 60);
    hilog.info(0x0000, 'shibei', 'demo6 %{public}s', s);
  }

  private startShortTask(): void {
    if (this.running) {
      return;
    }
    try {
      const info: backgroundTaskManager.DelaySuspendInfo =
        backgroundTaskManager.requestSuspendDelay('shibei sync simulation', () => {
          this.append('→ system wants us to stop (delayInfo expired)');
          this.running = false;
        });
      this.running = true;
      this.append(`short task requested: id=${info.requestId} remaining=${info.actualDelayTime}ms`);

      let tick: number = 0;
      this.tickTimer = setInterval(() => {
        tick += 1;
        this.append(`tick ${tick} (${tick * 2}s)`);
      }, 2000);
    } catch (err) {
      const msg: string = `${err.name}: ${err.message}`;
      this.append(`request fail: ${msg}`);
    }
  }

  private stopShortTask(): void {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    try {
      backgroundTaskManager.cancelSuspendDelay(0);
    } catch {
      // cancelSuspendDelay may fail if no active request; ignore
    }
    this.running = false;
    this.append('stopped');
  }

  build() {
    Column() {
      Text('Demo 6: BackgroundTaskManager').fontSize(18).margin({ top: 16 });
      Button(this.running ? 'stop' : 'start short task').margin({ top: 8 })
        .onClick(() => {
          if (this.running) {
            this.stopShortTask();
          } else {
            this.startShortTask();
          }
        });
      Text('After "start", press home to background app; reopen; observe log.')
        .fontSize(12).margin({ top: 8 });
      Scroll() {
        Column() {
          ForEach(this.log, (e: string) => {
            Text(e).fontSize(11).fontFamily('monospace');
          }, (e: string) => e);
        }
      }.height('70%').margin({ top: 16 });
    }
    .width('100%').height('100%').padding(16);
  }
}
