import { Highlight, Comment, AnnotationsBundle, Resource, ShibeiService } from '../services/ShibeiService';
import { I18n } from '../services/I18n';
import { MarkdownText } from './MarkdownText';
import { hilog } from '@kit.PerformanceAnalysisKit';

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
  // Resource owning the annotations — drives the SummarySection +
  // MetaRow at the top of the scroll body. @Watch refires when the
  // resource id changes so the cached summaryText is invalidated.
  @Prop @Watch('onResourceChanged') resource: Resource | null = null;
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
  // Summary text shown at the top of the scroll body. Populated from
  // `resource.description` when the user has manually written one;
  // otherwise lazily filled with the first 200 chars of plain_text via
  // ShibeiService.getResourceSummary. Empty string → SummarySection is
  // omitted entirely (and so is the divider above MetaRow).
  @State summaryText: string = '';
  // In-place expand toggle for SummarySection. Default collapsed at 3
  // lines. Reset to false whenever the resource changes — we don't
  // persist the expanded state (per design, MVP keeps it ephemeral).
  @State summaryExpanded: boolean = false;
  // Sticky title mode: when the in-scroll 笔记 section header crosses the
  // top, the panel's sticky title switches from `标注 (N)` to `笔记 (M)`.
  @State inNotesSection: boolean = false;
  // Captured via the 笔记 header's onAreaChange — position.y within the
  // Scroll content's coordinate space. Compared with Scroll's currentOffset
  // to decide whether the header has crossed the sticky top.
  private notesHeaderOffsetTop: number = -1;
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
  // Single tap on URL → open in system browser. Long press → copy.
  // Reader implements both because it already imports pasteboard +
  // common.UIAbilityContext; keeps AnnotationPanel free of those.
  onOpenUrl: (url: string) => void = () => {};
  onCopyUrl: (url: string) => void = () => {};

  aboutToAppear(): void {
    this.refreshSummary();
  }

  // Refires when the parent swaps the resource (e.g. data:resource-changed
  // sync, or a different resource opened in the same Reader instance).
  onResourceChanged(): void {
    // Force collapse + clear the cached text so the new resource starts
    // from a known state. refreshSummary then re-populates.
    this.summaryText = '';
    this.summaryExpanded = false;
    this.refreshSummary();
  }

  // Description (user-written) wins; otherwise pull a 200-char plain_text
  // preview from NAPI. NAPI returns sync — no async race to guard. Empty
  // result is fine: SummarySection won't render and the divider drops.
  private refreshSummary(): void {
    const r = this.resource;
    if (!r) {
      this.summaryText = '';
      return;
    }
    const desc = (r.description ?? '').trim();
    if (desc) {
      this.summaryText = desc;
      return;
    }
    try {
      const s: string = ShibeiService.instance.getResourceSummary(r.id, 200);
      this.summaryText = s.trim();
    } catch (e) {
      hilog.warn(0x0000, 'shibei', 'getResourceSummary fail %{public}s: %{public}s',
        r.id, (e as Error).message);
      this.summaryText = '';
    }
  }
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
      // Header — title only; add-note button moved to a sticky footer for
      // parity with the desktop panel layout. Title text swaps to 笔记 (M)
      // when the user scrolls past the in-scroll 笔记 section header.
      Row() {
        Text(this.inNotesSection
          ? I18n.t($r('app.string.annotation_note_section_title'),
                   this.resourceComments().length)
          : I18n.t($r('app.string.annotation_section_title'),
                   this.bundle.highlights.length))
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
          // Summary + meta row: top of scroll body, above the highlight
          // ForEach. Both are conditional — when neither summary nor URL
          // nor a usable date is present, this whole prelude omits and
          // the highlights start flush against the sticky 标注 header.
          if (this.summaryText.length > 0) {
            this.SummarySection();
          }
          if (this.resource) {
            this.MetaRow();
          }

          ForEach(this.bundle.highlights, (h: Highlight) => {
            this.HighlightCard(h);
          // Key includes color so in-place color edits (long-press swatch
          // or remote sync) force a card re-render — otherwise ArkUI skips
          // the diff and the left color strip stays stale.
          }, (h: Highlight) => `${h.id}:${h.color}`);

          // 笔记 section header — always rendered (even when M=0) so users
          // always see the section boundary and can add their first note
          // from the familiar position. Its position.y is the swap
          // threshold for the top sticky title.
          Row() {
            Text(I18n.t($r('app.string.annotation_note_section_title'),
                        this.resourceComments().length))
              .fontSize(16).fontWeight(FontWeight.Medium)
              .fontColor($r('sys.color.ohos_id_color_text_primary'))
              .layoutWeight(1);
          }
          .width('100%')
          .padding({ left: 12, right: 12, top: 16, bottom: 8 })
          .onAreaChange((_old: Area, area: Area) => {
            const y: number = parseFloat(`${area.position.y}`) || 0;
            if (y >= 0 && y !== this.notesHeaderOffsetTop) {
              this.notesHeaderOffsetTop = y;
              this.recomputeSection();
            }
          });

          ForEach(this.resourceComments(), (c: Comment) => {
            this.CommentCard(c);
          }, (c: Comment) => c.id);

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
      .align(Alignment.Top)
      .onDidScroll(() => this.recomputeSection());

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

  // Decide which sticky title to show. Compared with notesHeaderOffsetTop
  // (set by the 笔记 header's onAreaChange): when scroll yOffset reaches
  // that threshold, the 笔记 header has scrolled up to sit exactly at the
  // top of the scroll viewport — which is directly beneath the sticky
  // title row — so we swap. Small negative tolerance absorbs sub-pixel
  // drift from layout rounding.
  private recomputeSection(): void {
    if (this.notesHeaderOffsetTop < 0) return;
    let cur: number = 0;
    try {
      cur = this.scroller.currentOffset().yOffset;
    } catch (_e) {
      return;
    }
    const next: boolean = cur >= this.notesHeaderOffsetTop - 1;
    if (next !== this.inNotesSection) {
      this.inNotesSection = next;
    }
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

  // Resource summary at the top of the scroll body. Default 3 lines with
  // ellipsis; tap anywhere on the block to toggle in-place expand. Header
  // label "摘要" matches the desktop SummarySection. No persistence —
  // every Reader open returns to collapsed (per design decision).
  @Builder SummarySection() {
    Column() {
      Text(I18n.t($r('app.string.annotation_summary_label')))
        .fontSize(13).fontWeight(FontWeight.Medium)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .margin({ bottom: 4 });
      Text(this.summaryText)
        .fontSize(13)
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
        .maxLines(this.summaryExpanded ? 100 : 3)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .width('100%');
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 12, bottom: 8 })
    .alignItems(HorizontalAlign.Start)
    .onClick(() => { this.summaryExpanded = !this.summaryExpanded; });
  }

  // Compact one-line meta below SummarySection: URL on the left (single
  // tap → system browser, long press → copy), date on the right. Both
  // sides degrade independently — when URL is empty (e.g. local-imported
  // PDF) we drop it and the date sits alone, right-aligned. captured_at
  // wins when present; created_at is the fallback (PDFs imported locally
  // have no capture timestamp).
  @Builder MetaRow() {
    Row() {
      if (this.resource && this.resource.url) {
        Text(this.displayUrl(this.resource.url))
          .fontSize(12)
          .fontColor($r('sys.color.ohos_id_color_text_tertiary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
          // Single tap opens URL externally; gestureModifier captures the
          // long-press separately so they don't fight each other.
          .onClick(() => {
            if (this.resource && this.resource.url) {
              this.onOpenUrl(this.resource.url);
            }
          })
          .gesture(
            LongPressGesture({ repeat: false, duration: 400 })
              .onAction(() => {
                if (this.resource && this.resource.url) {
                  this.onCopyUrl(this.resource.url);
                }
              })
          );
      } else {
        // Pad the row so the date stays right-aligned even without URL.
        Blank().layoutWeight(1);
      }
      Text(this.metaDate())
        .fontSize(12)
        .fontColor($r('sys.color.ohos_id_color_text_tertiary'))
        .margin({ left: 8 });
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 4, bottom: 12 });
  }

  // Strip protocol prefix for visual cleanliness. Keeps host + path so
  // the user can recognize the source. Kept simple — no path-segment
  // truncation; Text's ellipsis takes care of overflow.
  private displayUrl(url: string): string {
    return url.replace(/^https?:\/\//, '');
  }

  // captured_at when present (HTML clips have it); else created_at (PDF
  // local imports). Same YYYY/M/D format as the highlight card meta so
  // the panel speaks one date dialect throughout.
  private metaDate(): string {
    if (!this.resource) return '';
    const iso = (this.resource.captured_at && this.resource.captured_at.length > 0)
      ? this.resource.captured_at
      : this.resource.created_at;
    return this.formatDate(iso);
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

      // Nested comments: native markdown render; edit is a footer action
      // so that inline tables can horizontally scroll without fighting the
      // row-level tap gesture.
      ForEach(this.commentsFor(h.id), (c: Comment) => {
        Column() {
          MarkdownText({ content: c.content, baseFontSize: 13 })
            .width('100%');
          this.CommentEditButton(c);
        }
        .width('100%')
        .padding({ left: 8, top: 6, right: 4 });
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
    // color (with low alpha so text stays legible and the pulse reads as
    // a soft wash, not a jump) and the left strip widens from 3 to 6 px.
    // Off-pulse: normal component background + 3 px strip. animation()
    // wraps the state change so every toggle reads as a smooth throb.
    .backgroundColor(this.flashingHighlightId === h.id
      ? `${h.color}22`
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
    Column() {
      MarkdownText({ content: c.content, baseFontSize: 14 })
        .width('100%');
      this.CommentEditButton(c);
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 8, bottom: 8 });
  }

  @Builder CommentEditButton(c: Comment) {
    Row() {
      Blank();
      Text(I18n.t($r('app.string.common_edit')))
        .fontSize(13)
        .fontColor($r('sys.color.ohos_id_color_emphasize'))
        .padding({ left: 10, right: 10, top: 6, bottom: 6 })
        .onClick(() => this.onEditComment(c.id));
    }
    .width('100%')
    .margin({ top: 4 });
  }
}
