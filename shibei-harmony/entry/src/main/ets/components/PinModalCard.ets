import { I18n } from '../services/I18n';

// Shared 4-digit PIN card overlay used by Setup / Disable / Change PIN
// flows in Security settings. Layout = full-screen mask backdrop + a
// centered card with the title, a 4-dot row driven by `filled`, a
// hidden numeric TextInput holding the focus, and a Cancel button.
//
// The host page should render `PinModalCard({...})` inside a Stack
// at the root of its `build()` so the card visually floats over the
// page content.

export interface PinCardOpts {
  title: string;
  subtitle: string;
  inputId: string;
  filled: number;
  value: string;
  onChange: (v: string) => void;
  onCancel: () => void;
}

@Component
export struct PinModalCard {
  opts: PinCardOpts = {
    title: '',
    subtitle: '',
    inputId: '',
    filled: 0,
    value: '',
    onChange: (_v: string) => {
    },
    onCancel: () => {
    },
  };

  build() {
    Column() {
      Column() {
        Text(this.opts.title).fontSize(16).fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .margin({ top: 4, bottom: 4 });
        if (this.opts.subtitle) {
          Text(this.opts.subtitle).fontSize(12)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .textAlign(TextAlign.Center)
            .margin({ bottom: 20 });
        } else {
          Blank().height(20);
        }
        Row() {
          ForEach([0, 1, 2, 3], (i: number) => {
            Circle({ width: 14, height: 14 })
              .fill(i < this.opts.filled
                ? $r('sys.color.ohos_id_color_text_primary')
                : Color.Transparent)
              .stroke($r('sys.color.ohos_id_color_text_tertiary'))
              .strokeWidth(1.5)
              .margin({ left: 8, right: 8 });
          }, (i: number) => `${this.opts.inputId}:${i}`);
        }.justifyContent(FlexAlign.Center).margin({ bottom: 16 });
        // Hidden TextInput — numeric keyboard, opacity ~0, height 1.
        TextInput({ placeholder: '', text: this.opts.value })
          .id(this.opts.inputId)
          .type(InputType.Number)
          .maxLength(4)
          .defaultFocus(true)
          .opacity(0.01).height(1)
          .onChange(this.opts.onChange);
        Button(I18n.t($r('app.string.common_cancel')))
          .backgroundColor(Color.Transparent)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .margin({ top: 16 })
          .onClick(() => this.opts.onCancel());
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
}
