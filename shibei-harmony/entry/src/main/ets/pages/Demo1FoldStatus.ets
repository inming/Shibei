import { display } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';

@Entry
@Component
struct Demo1FoldStatus {
  @State current: string = '(unknown)';
  @State events: Array<string> = [];
  @State lastEventAt: number = 0;

  aboutToAppear(): void {
    try {
      const initial: display.FoldStatus = display.getFoldStatus();
      this.current = this.toLabel(initial);
      display.on('foldStatusChange', (s: display.FoldStatus) => {
        const now: number = Date.now();
        const delta: number = this.lastEventAt ? now - this.lastEventAt : 0;
        this.lastEventAt = now;
        const label: string = this.toLabel(s);
        const entry: string = `${new Date(now).toISOString().substring(11, 23)} ${label} (+${delta}ms)`;
        this.events = [entry, ...this.events].slice(0, 30);
        this.current = label;
        hilog.info(0x0000, 'shibei', 'foldStatus: %{public}s delta=%{public}dms', label, delta);
      });
    } catch (err) {
      const msg: string = `${err.name}: ${err.message}`;
      this.current = `ERROR: ${msg}`;
      hilog.error(0x0000, 'shibei', 'fold demo fail: %{public}s', msg);
    }
  }

  aboutToDisappear(): void {
    display.off('foldStatusChange');
  }

  private toLabel(s: display.FoldStatus): string {
    switch (s) {
      case display.FoldStatus.FOLD_STATUS_EXPANDED:
        return 'EXPANDED';
      case display.FoldStatus.FOLD_STATUS_FOLDED:
        return 'FOLDED';
      case display.FoldStatus.FOLD_STATUS_HALF_FOLDED:
        return 'HALF_FOLDED';
      default:
        return `UNKNOWN(${s})`;
    }
  }

  build() {
    Column() {
      Text('Demo 1: Fold status').fontSize(20).margin({ top: 24 });
      Text(`current: ${this.current}`).fontSize(16).margin({ top: 16 });
      Text('fold / unfold the device and observe event log:')
        .fontSize(14).margin({ top: 16 });
      Scroll() {
        Column() {
          ForEach(this.events, (e: string) => {
            Text(e).fontSize(12).fontFamily('monospace');
          }, (e: string) => e);
        }
      }.height('70%').width('100%').margin({ top: 8 });
    }
    .width('100%').height('100%').padding(16);
  }
}
