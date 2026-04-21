import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { ShibeiService } from '../services/ShibeiService';

// Cold-start routing (Track C follow-on):
//   no saved S3 config  → pages/Onboard      (fresh install walks the wizard)
//   saved config exists → pages/Demo11Library (returning user goes straight
//                                              to the library)
// If NAPI init fails we fall through to Onboard so the user at least sees
// the wizard's error banner instead of a blank window.
//
// The dev demo menu (pages/Index) is still reachable — Onboard's Welcome
// step + Demo 11 Library header both long-press into it.

export default class EntryAbility extends UIAbility {
  onCreate(_want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(0x0000, 'shibei', 'EntryAbility onCreate');
  }

  async onWindowStageCreate(windowStage: window.WindowStage): Promise<void> {
    const dataDir = this.context.filesDir;
    let route = 'pages/Onboard';
    try {
      await ShibeiService.instance.init(dataDir);
      route = ShibeiService.instance.hasSavedConfig()
        ? 'pages/Demo11Library'
        : 'pages/Onboard';
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
}
