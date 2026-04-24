import { Highlight, Comment, AnnotationsBundle } from '../services/ShibeiService';
import { I18n } from '../services/I18n';

// Four-color palette — same order as Reader.ets so the "change color" swatch
// in the long-press menu reads left-to-right in the familiar sequence.
//
// `value` is the CSS color used as annotation data key — cross-device
// annotation storage, do not change. No label field: the menu only
// renders colored circles. Future a11y/tooltip can look up
// reader_hl_color_{yellow,green,blue,pink} via I18n.t.
interface HlColorOption { value: string; }
const HL_COLORS: HlColorOption[] = [
  { value: '#ffeb3b' },
  { value: '#81c784' },
  { value: '#64b5f6' },
  { value: '#f48fb1' },
];

@Component
export struct AnnotationPanel {
  @Prop bundle: AnnotationsBundle = { highlights: [], comments: [] };
  // Reader sets this to `${ts}:${hlId}` whenever the user taps a highlight
  // in the Web — we parse the suffix, scroll that card into view and pulse
  // its left color strip. The `ts:` prefix makes @Watch re-fire even when
  // the same id is tapped repeatedly (@Prop dedups equal values).
  @Prop @Watch('onFocusedChanged') focusedHighlightId: string = '';
  // Per-card flash state: `id -> {flashing: bool, generation: number}`.
  // `generation` lets the animation loop cancel itself when a newer flash
  // targets a different id. The card @Builder reads `flashState` to choose
  // the border opacity — 0.3 during off-beat, 1.0 otherwise.
  @State flashingHighlightId: string = '';
  @State flashGeneration: number = 0;
  // Scroller controller for programmatic scrollTo.
  private scroller: Scroller = new Scroller();
  // Short tap on a highlight card → flash on page (Reader calls runJavaScript).
  onTapHighlight: (id: string) => void = () => {};
  onDeleteHighlight: (id: string) => void = () => {};
  onChangeHighlightColor: (id: string, color: string) => void = () => {};
  onCopyHighlightLink: (id: string) => void = () => {};
  onAddHighlightComment: (hlId: string) => void = () => {};
  onAddResourceComment: () => void = () => {};
  onEditComment: (id: string) => void = () => {};
  onDeleteComment: (id: string) => void = () => {};
  // Parse ts:id back to id (strip the timestamp prefix Reader prepends).
  private parseFocusId(raw: string): string {
    if (!raw) return '';
    const colon = raw.indexOf(':');
    return colon >= 0 ? raw.substring(colon + 1) : raw;
  }
  // Drive the pulse: ON / off / ON / off, 250ms each phase. The `animation`
  // decorator on the card already interpolates the width change so each
  // toggle reads as a soft breathe rather than a blink. `generation` is
  // checked between phases to bail cleanly when a newer flash targets a
  // different id.
  private async runFlash(id: string): Promise<void> {
    const gen = ++this.flashGeneration;
    for (let cycle = 0; cycle < 2; cycle++) {
      this.flashingHighlightId = id;
      await new Promise<void>((r) => setTimeout(r, 250));
      if (this.flashGeneration !== gen) return;
      this.flashingHighlightId = '';
      await new Promise<void>((r) => setTimeout(r, 250));
      if (this.flashGeneration !== gen) return;
    }
  }
  // @Watch target — fires each time focusedHighlightId mutates (including
  // repeated taps thanks to the ts: prefix in Reader).
  onFocusedChanged(): void {
    const id = this.parseFocusId(this.focusedHighlightId);
    if (!id) return;
    const idx = this.bundle.highlights.findIndex((h: Highlight) => h.id === id);
    if (idx < 0) return;
    // Scroll the target card into view. List.scrollToIndex would be cleaner
    // but we're inside a Scroll+Column; use scrollTo with a rough estimate
    // based on the card index. 120px per card is a generous average (some
    // have multiple comments, some have none) — the flash still lands on a
    // visible card because the panel is narrow and cards are tall.
    try {
      this.scroller.scrollTo({ xOffset: 0, yOffset: Math.max(0, idx * 120 - 40) });
    } catch (_e) { /* scroller not attached yet — OK, ignore */ }
    this.runFlash(id);
  }

  build() {
    Column() {
      // Header — title only; the add-note button moved to a sticky footer
      // for parity with the desktop panel layout.
      Row() {
        Text(I18n.t($r('app.string.annotation_section_title'), this.bundle.highlights.length))
          .fontSize(16).fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .layoutWeight(1);
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 12, bottom: 8 });

      Divider().strokeWidth(0.5).color($r('sys.color.ohos_id_color_list_separator'));

      // Body — scrollable list
      Scroll(this.scroller) {
        Column() {
          ForEach(this.bundle.highlights, (h: Highlight) => {
            this.HighlightCard(h);
          // Key includes color so in-place color edits (long-press swatch
          // or remote sync) force a card re-render — otherwise ArkUI skips
          // the diff and the left color strip stays stale.
          }, (h: Highlight) => `${h.id}:${h.color}`);

          if (this.resourceComments().length > 0) {
            Text(I18n.t($r('app.string.annotation_note_label'))).fontSize(13)
              .fontColor($r('sys.color.ohos_id_color_text_secondary'))
              .padding({ left: 12, right: 12, top: 16, bottom: 4 });
            ForEach(this.resourceComments(), (c: Comment) => {
              this.CommentCard(c);
            }, (c: Comment) => c.id);
          }

          if (this.bundle.highlights.length === 0 && this.resourceComments().length === 0) {
            Column() {
              Text(I18n.t($r('app.string.annotation_empty_hint'))).fontSize(13)
                .fontColor($r('sys.color.ohos_id_color_text_tertiary'))
                .textAlign(TextAlign.Center);
            }
            .width('100%').padding(32);
          }
        }
        .width('100%');
      }
      .layoutWeight(1)
      .width('100%')
      .align(Alignment.Top);

      // Footer — sticky add-note button at the bottom of the drawer.
      Divider().strokeWidth(0.5).color($r('sys.color.ohos_id_color_list_separator'));
      Row() {
        Text(I18n.t($r('app.string.annotation_note_add')))
          .fontSize(15)
          .fontColor($r('sys.color.ohos_id_color_emphasize'))
          .layoutWeight(1)
          .textAlign(TextAlign.Center);
      }
      .width('100%')
      .padding({ top: 12, bottom: 12 })
      .onClick(() => this.onAddResourceComment());
    }
    .width('100%').height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'));
  }

  private resourceComments(): Comment[] {
    return this.bundle.comments.filter((c: Comment) => !c.highlight_id);
  }

  private commentsFor(hlId: string): Comment[] {
    return this.bundle.comments.filter((c: Comment) => c.highlight_id === hlId);
  }

  // Desktop displays dates as `YYYY/M/D` via toLocaleDateString; match that
  // here with manual formatting since ArkTS's Intl surface is limited.
  private formatDate(iso: string): string {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  }

  // Card visual mirrors the desktop AnnotationPanel: 3px left color strip,
  // text preview, small meta row (dot + date), inline add-comment action.
  // Destructive actions (delete, copy link, change color) live behind
  // long-press so single taps aren't misread as "delete".
  @Builder HighlightCard(h: Highlight) {
    Column() {
      Text(h.text_content)
        .fontSize(14)
        .maxLines(3)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
        .width('100%');

      Row() {
        Text('●').fontSize(10).fontColor(h.color);
        Blank();
        Text(this.formatDate(h.created_at))
          .fontSize(11)
          .fontColor($r('sys.color.ohos_id_color_text_tertiary'));
      }
      .width('100%')
      .margin({ top: 6 });

      // Nested comments — tap to edit.
      ForEach(this.commentsFor(h.id), (c: Comment) => {
        Row() {
          Text(c.content).fontSize(13)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .layoutWeight(1);
        }
        .width('100%')
        .padding({ left: 8, top: 6, right: 4 })
        .onClick(() => this.onEditComment(c.id));
      }, (c: Comment) => c.id);

      // Inline add-comment — primary text, left-aligned. Opens comment sheet
      // with the highlight id preset so the saved comment is attached here.
      Row() {
        Text(I18n.t($r('app.string.annotation_comment_add')))
          .fontSize(13)
          .fontColor($r('sys.color.ohos_id_color_emphasize'));
      }
      .width('100%')
      .margin({ top: 8 })
      .onClick(() => this.onAddHighlightComment(h.id));
    }
    .width('100%')
    .padding({ left: 10, right: 10, top: 10, bottom: 10 })
    .margin({ left: 12, right: 12, bottom: 8 })
    // Flash effect: during pulses the whole card tints to the highlight
    // color (with alpha so text stays legible) and the left strip widens
    // from 3 to 6 px. Off-pulse: normal component background + 3 px strip.
    // animation() wraps the state change so every toggle reads as a smooth
    // throb rather than a blink cut.
    .backgroundColor(this.flashingHighlightId === h.id
      ? `${h.color}55`
      : $r('sys.color.ohos_id_color_component_normal'))
    .borderRadius(6)
    .border({
      width: { left: this.flashingHighlightId === h.id ? 6 : 3 },
      color: { left: h.color },
    })
    .animation({ duration: 250, curve: Curve.EaseInOut })
    .onClick(() => this.onTapHighlight(h.id))
    .bindContextMenu(this.HighlightContextMenu(h), ResponseType.LongPress);
  }

  // Long-press menu for a highlight card: 4-color swatch row + copy link +
  // delete. Matches the desktop right-click popover (minus dark-palette row
  // since mobile doesn't invert snapshot colors yet).
  @Builder HighlightContextMenu(h: Highlight) {
    Column() {
      Row() {
        ForEach(HL_COLORS, (c: HlColorOption) => {
          Stack() {
            Text('')
              .width(26).height(26)
              .backgroundColor(c.value)
              .borderRadius(13)
              .border({
                width: c.value === h.color ? 2 : 0,
                color: $r('sys.color.ohos_id_color_emphasize'),
              });
          }
          .width(40).height(40)
          .onClick(() => this.onChangeHighlightColor(h.id, c.value));
        }, (c: HlColorOption) => c.value);
      }
      .width('100%')
      .padding({ left: 8, right: 8, top: 6, bottom: 6 })
      .justifyContent(FlexAlign.SpaceAround);

      Divider().strokeWidth(0.5).color($r('sys.color.ohos_id_color_list_separator'));

      Row() {
        Text(I18n.t($r('app.string.annotation_copy_link')))
          .fontSize(15)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .layoutWeight(1);
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 12, bottom: 12 })
      .onClick(() => this.onCopyHighlightLink(h.id));

      Divider().strokeWidth(0.5).color($r('sys.color.ohos_id_color_list_separator'));

      Row() {
        Text(I18n.t($r('app.string.common_delete')))
          .fontSize(15)
          .fontColor($r('sys.color.ohos_id_color_warning'))
          .layoutWeight(1);
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 12, bottom: 12 })
      .onClick(() => this.onDeleteHighlight(h.id));
    }
    .width(240)
    .backgroundColor($r('sys.color.ohos_id_color_background'));
  }

  @Builder CommentCard(c: Comment) {
    Row() {
      Text(c.content).fontSize(14)
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
        .layoutWeight(1);
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 8, bottom: 8 })
    .onClick(() => this.onEditComment(c.id));
  }
}
