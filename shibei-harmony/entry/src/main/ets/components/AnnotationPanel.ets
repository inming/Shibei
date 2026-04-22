import { Highlight, Comment, AnnotationsBundle } from '../services/ShibeiService';

// Four-color palette — same order as Reader.ets so the "change color" swatch
// in the long-press menu reads left-to-right in the familiar sequence.
interface HlColorOption { value: string; label: string; }
const HL_COLORS: HlColorOption[] = [
  { value: '#ffeb3b', label: '黄' },
  { value: '#81c784', label: '绿' },
  { value: '#64b5f6', label: '蓝' },
  { value: '#f48fb1', label: '粉' },
];

@Component
export struct AnnotationPanel {
  @Prop bundle: AnnotationsBundle = { highlights: [], comments: [] };
  // Short tap on a highlight card → flash on page (Reader calls runJavaScript).
  onTapHighlight: (id: string) => void = () => {};
  onDeleteHighlight: (id: string) => void = () => {};
  onChangeHighlightColor: (id: string, color: string) => void = () => {};
  onCopyHighlightLink: (id: string) => void = () => {};
  onAddHighlightComment: (hlId: string) => void = () => {};
  onAddResourceComment: () => void = () => {};
  onEditComment: (id: string) => void = () => {};
  onDeleteComment: (id: string) => void = () => {};

  build() {
    Column() {
      // Header — title only; "+ 笔记" moved to a sticky footer for parity
      // with the desktop panel layout.
      Row() {
        Text(`标注 (${this.bundle.highlights.length})`)
          .fontSize(16).fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .layoutWeight(1);
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 12, bottom: 8 });

      Divider().strokeWidth(0.5).color($r('sys.color.ohos_id_color_list_separator'));

      // Body — scrollable list
      Scroll() {
        Column() {
          ForEach(this.bundle.highlights, (h: Highlight) => {
            this.HighlightCard(h);
          // Key includes color so in-place color edits (long-press swatch
          // or remote sync) force a card re-render — otherwise ArkUI skips
          // the diff and the left color strip stays stale.
          }, (h: Highlight) => `${h.id}:${h.color}`);

          if (this.resourceComments().length > 0) {
            Text('笔记').fontSize(13)
              .fontColor($r('sys.color.ohos_id_color_text_secondary'))
              .padding({ left: 12, right: 12, top: 16, bottom: 4 });
            ForEach(this.resourceComments(), (c: Comment) => {
              this.CommentCard(c);
            }, (c: Comment) => c.id);
          }

          if (this.bundle.highlights.length === 0 && this.resourceComments().length === 0) {
            Column() {
              Text('长按页面文字创建高亮').fontSize(13)
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

      // Footer — sticky "+ 笔记" button at the bottom of the drawer.
      Divider().strokeWidth(0.5).color($r('sys.color.ohos_id_color_list_separator'));
      Row() {
        Text('+ 笔记')
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
  // text preview, small meta row (dot + date), inline "+ 评论" action.
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

      // Inline "+ 评论" — primary text, left-aligned. Opens comment sheet
      // with the highlight id preset so the saved comment is attached here.
      Row() {
        Text('+ 评论')
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
    .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
    .borderRadius(6)
    .border({
      width: { left: 3 },
      color: { left: h.color },
    })
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
        Text('复制链接')
          .fontSize(15)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .layoutWeight(1);
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 12, bottom: 12 })
      .onClick(() => this.onCopyHighlightLink(h.id));

      Divider().strokeWidth(0.5).color($r('sys.color.ohos_id_color_list_separator'));

      Row() {
        Text('删除')
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
