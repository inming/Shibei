import { hilog } from '@kit.PerformanceAnalysisKit';
import { router } from '@kit.ArkUI';
import { ShibeiService } from '../services/ShibeiService';
import { I18n } from '../services/I18n';
import { SettingsTopBar } from '../components/SettingsTopBar';

// Top-level settings menu (Phase 5.2 redesign). Each row pushes a
// dedicated sub-page that owns its controls + state. Keeps this file
// short and predictable as we add new categories.
//
// Encryption row carries a small status pill so the user can see at a
// glance whether the vault is currently locked (the only state that
// blocks sync).

interface MenuItem {
  id: string;
  // `$r()` is a compile-time macro; it must be invoked with a literal
  // string argument. We store the resolved Resource here so the row
  // builder can hand it to I18n.t() at render time. Building the key
  // dynamically (e.g. `$r(`app.string.${id}`)`) silently produces an
  // empty Resource and the row label disappears.
  label: Resource;
  route: string;
}

const MENU_GROUPS: MenuItem[][] = [
  [
    { id: 'appearance', label: $r('app.string.settings_section_appearance'), route: 'pages/settings/AppearanceSettings' },
  ],
  [
    { id: 'sync', label: $r('app.string.settings_section_sync'), route: 'pages/settings/SyncSettings' },
    { id: 'encryption', label: $r('app.string.settings_section_encryption'), route: 'pages/settings/EncryptionSettings' },
    { id: 'security', label: $r('app.string.settings_section_security'), route: 'pages/settings/SecuritySettings' },
  ],
  [
    { id: 'data', label: $r('app.string.settings_section_data'), route: 'pages/settings/DataSettings' },
    { id: 'trash', label: $r('app.string.settings_section_trash'), route: 'pages/settings/TrashSettings' },
  ],
  [
    { id: 'about', label: $r('app.string.settings_section_about'), route: 'pages/settings/AboutSettings' },
  ],
];

@Entry
@Component
struct Settings {
  // Refreshed on aboutToAppear so the encryption pill stays accurate
  // when the user comes back from EncryptionSettings.
  @State e2eeLocked: boolean = false;

  aboutToAppear(): void {
    this.refreshE2eeLockState();
  }

  // ArkUI re-runs aboutToAppear when the page is re-entered via
  // router.back() (the page instance stays mounted during the push).
  // Hooking into onPageShow keeps the encryption pill fresh after the
  // user unlocks from the sub-page.
  onPageShow(): void {
    this.refreshE2eeLockState();
  }

  private refreshE2eeLockState(): void {
    try {
      this.e2eeLocked = ShibeiService.instance.hasSavedConfig()
        && !ShibeiService.instance.isUnlocked();
    } catch (err) {
      hilog.warn(0x0000, 'shibei', 'refreshE2eeLockState fail: %{public}s', (err as Error).message);
    }
  }

  private gotoSubpage(route: string): void {
    router.pushUrl({ url: route }).catch((err: Error) => {
      hilog.error(0x0000, 'shibei', 'router.pushUrl fail: %{public}s', err.message);
    });
  }

  // Single menu row. `subtitle` is optional and sits under the label
  // (e.g. "未解锁" for the encryption row when locked).
  @Builder
  MenuRow(item: MenuItem) {
    Row() {
      Column() {
        Text(I18n.t(item.label)).fontSize(15)
          .fontColor($r('sys.color.ohos_id_color_text_primary'));
        if (item.id === 'encryption' && this.e2eeLocked) {
          Text(I18n.t($r('app.string.settings_encryption_status_locked'))).fontSize(11)
            .fontColor($r('app.color.accent_danger'))
            .margin({ top: 2 });
        }
      }.alignItems(HorizontalAlign.Start).layoutWeight(1);
      Text('›').fontSize(18)
        .fontColor($r('sys.color.ohos_id_color_text_tertiary'));
    }
    .width('100%').padding({ top: 12, bottom: 12, left: 12, right: 12 })
    .onClick(() => this.gotoSubpage(item.route));
  }

  build() {
    Column() {
      SettingsTopBar({ title: I18n.t($r('app.string.settings_page_title')) });

      Scroll() {
        Column() {
          ForEach(MENU_GROUPS, (group: MenuItem[], gi: number) => {
            Column() {
              ForEach(group, (item: MenuItem, idx: number) => {
                this.MenuRow(item);
                if (idx < group.length - 1) {
                  Divider().color($r('sys.color.ohos_id_color_list_separator'));
                }
              }, (item: MenuItem) => item.id);
            }
            .backgroundColor($r('sys.color.ohos_id_color_background')).borderRadius(8)
            .margin({
              top: 16,
              left: 12,
              right: 12,
              bottom: gi === MENU_GROUPS.length - 1 ? 24 : 0,
            });
          }, (group: MenuItem[], gi: number) => `g${gi}`);
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%');
      }
      // Align content to the top — without this, ArkUI's Scroll vertically
      // centers its child Column when the content is shorter than the
      // viewport, which leaves a large empty band above the first row.
      .align(Alignment.Top)
      .layoutWeight(1)
      .width('100%');
    }
    .width('100%').height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'));
  }
}
