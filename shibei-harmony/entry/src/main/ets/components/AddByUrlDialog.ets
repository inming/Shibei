// Modal dialog opened from the Library FAB to start a manual web capture.
// Mirrors the share-intent path: takes a URL, optionally pre-filled from
// the system clipboard, and routes to CapturePage on confirm.
//
// Design contract (see 2026-04-28-harmony-web-capture-design.md §3.2):
//   - Clipboard sniff happens in `aboutToAppear`. We do NOT auto-fill the
//     input — only show a one-tap suggestion under the field, so the user
//     stays in control of what the app reads from their pasteboard.
//   - URL validation is local-only (regex). No probe request — that would
//     leak the URL before the user committed to capture.
//   - Schema-less input ("example.com") is auto-prefixed with "https://"
//     to match desktop browser behaviour.
//   - The dialog is a self-contained Stack overlay rendered at Library
//     root level (same pattern as Settings PIN modals) to avoid issues
//     with bindContentCover and route transitions.

import { router, promptAction } from '@kit.ArkUI';
import { pasteboard } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { I18n } from '../services/I18n';

interface ValidateResult { ok: boolean; normalized: string; }
interface CaptureRouteParams { url: string; }

@Component
export struct AddByUrlDialog {
  /// Bound from the parent: flipping this to false closes the dialog.
  /// Parent owns the lifecycle so the dialog can be re-opened cleanly.
  @Link open: boolean;

  /// Optional pre-fill, e.g. when re-opening after an invalid submit.
  /// Most callers pass empty string.
  @Prop initialUrl: string = '';

  @State private input: string = '';
  @State private error: string = '';
  @State private clipboardUrl: string = '';

  aboutToAppear(): void {
    this.input = this.initialUrl;
    this.sniffClipboard();
  }

  /// Best-effort clipboard read. Failures (no permission grant yet,
  /// empty clipboard, non-text content) leave `clipboardUrl` empty so
  /// the suggestion row stays hidden. We deliberately do NOT log the
  /// content — pasteboard data is sensitive and shouldn't end up in
  /// hilog/debug.log.
  private sniffClipboard(): void {
    try {
      const board = pasteboard.getSystemPasteboard();
      board.getData().then((data) => {
        try {
          const text = data.getPrimaryText();
          const trimmed = text ? text.trim() : '';
          if (trimmed && /^https?:\/\/[^\s]+$/i.test(trimmed)) {
            this.clipboardUrl = trimmed;
          }
        } catch (_inner) {
          // Pasteboard returned non-text payload — ignore.
        }
      }).catch((err: Error) => {
        hilog.debug(0x0000, 'shibei', 'pasteboard read denied: %{public}s', err.message);
      });
    } catch (err) {
      hilog.debug(0x0000, 'shibei', 'pasteboard sniff failed: %{public}s', (err as Error).message);
    }
  }

  /// Local URL validator. Matches `http(s)://` plus a host with at least
  /// one dot, optionally followed by path/query/fragment. Allows IPs and
  /// subdomains. Rejects whitespace and obvious garbage.
  private validate(raw: string): ValidateResult {
    let v = raw.trim();
    if (!v) return { ok: false, normalized: '' };
    // Auto-prefix scheme when the user typed bare host (matches desktop
    // browsers). We don't try to detect IPv6 — power users can paste a
    // full URL.
    if (!/^https?:\/\//i.test(v)) {
      v = `https://${v}`;
    }
    const ok = /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(v);
    return { ok, normalized: v };
  }

  private submit(): void {
    const result = this.validate(this.input);
    if (!result.ok) {
      this.error = I18n.t($r('app.string.capture_url_invalid'));
      return;
    }
    this.open = false;
    const captureParams: CaptureRouteParams = { url: result.normalized };
    router.pushUrl({
      url: 'pages/CapturePage',
      params: captureParams,
    }).catch((err: Error) => {
      hilog.error(0x0000, 'shibei', 'pushUrl CapturePage fail: %{public}s', err.message);
      promptAction.showToast({ message: I18n.t($r('app.string.common_open_failed')) });
    });
  }

  private cancel(): void {
    this.open = false;
    this.input = '';
    this.error = '';
  }

  build() {
    if (this.open) {
      // Full-screen backdrop with centered card (same shape as PIN modals
      // in Settings). Tap outside the card cancels.
      Column() {
        Column() {
          Text(I18n.t($r('app.string.capture_add_by_url')))
            .fontSize(17)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.text_primary'))
            .margin({ bottom: 16 });

          TextInput({
            placeholder: I18n.t($r('app.string.capture_url_placeholder')),
            text: this.input,
          })
            .type(InputType.URL)
            .enableKeyboardOnFocus(true)
            .defaultFocus(true)
            .fontSize(15)
            .placeholderColor($r('app.color.text_disabled'))
            .backgroundColor($r('app.color.bg_secondary'))
            .borderRadius(8)
            .height(44)
            .padding({ left: 12, right: 12 })
            .onChange((v: string) => {
              this.input = v;
              if (this.error) this.error = '';
            })
            .onSubmit(() => this.submit());

          if (this.error) {
            Text(this.error)
              .fontSize(12)
              .fontColor($r('app.color.accent_danger'))
              .margin({ top: 6, left: 4 })
              .alignSelf(ItemAlign.Start);
          }

          if (this.clipboardUrl) {
            Row() {
              Text('📋')
                .fontSize(13)
                .margin({ right: 6 });
              Text(I18n.t(
                $r('app.string.capture_url_paste_label'),
                this.truncateForLabel(this.clipboardUrl),
              ))
                .fontSize(13)
                .fontColor($r('app.color.accent_primary'))
                .layoutWeight(1)
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis });
            }
            .width('100%')
            .padding({ top: 10, bottom: 10, left: 4, right: 4 })
            .onClick(() => {
              this.input = this.clipboardUrl;
              this.clipboardUrl = '';
              this.error = '';
            });
          }

          Row() {
            Button(I18n.t($r('app.string.common_cancel')))
              .backgroundColor(Color.Transparent)
              .fontColor($r('app.color.text_secondary'))
              .layoutWeight(1)
              .onClick(() => this.cancel());

            Button(I18n.t($r('app.string.capture_open')))
              .backgroundColor($r('app.color.accent_primary'))
              .fontColor(Color.White)
              .layoutWeight(1)
              .margin({ left: 12 })
              .onClick(() => this.submit());
          }
          .width('100%')
          .margin({ top: 20 });
        }
        .width('86%')
        .padding({ top: 22, bottom: 18, left: 20, right: 20 })
        .backgroundColor($r('app.color.bg_primary'))
        .borderRadius(12)
        .alignItems(HorizontalAlign.Start);
      }
      .width('100%')
      .height('100%')
      .backgroundColor($r('sys.color.ohos_id_color_mask_thin'))
      .justifyContent(FlexAlign.Center)
      .alignItems(HorizontalAlign.Center)
      .onClick(() => this.cancel());
    }
  }

  /// Trim long URLs for the clipboard suggestion row so they don't blow
  /// past the dialog width. Keeps the host/start so it remains scannable.
  private truncateForLabel(s: string): string {
    const max = 36;
    if (s.length <= max) return s;
    return `${s.substring(0, max)}…`;
  }
}
