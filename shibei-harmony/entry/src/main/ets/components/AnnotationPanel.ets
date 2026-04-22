import { Highlight, Comment, AnnotationsBundle } from '../services/ShibeiService';

@Component
export struct AnnotationPanel {
  @Prop bundle: AnnotationsBundle = { highlights: [], comments: [] };
  // Emits the highlight id to scroll to; Reader calls runJavaScript to flash.
  onTapHighlight: (id: string) => void = () => {};
  onDeleteHighlight: (id: string) => void = () => {};
  onAddResourceComment: () => void = () => {};
  onEditComment: (id: string) => void = () => {};
  onDeleteComment: (id: string) => void = () => {};

  build() {
    Column() {
      // Header
      Row() {
        Text(`标注 (${this.bundle.highlights.length})`)
          .fontSize(16).fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .layoutWeight(1);
        Text('+ 备注')
          .fontSize(13).fontColor($r('sys.color.ohos_id_color_emphasize'))
          .padding({ left: 8, right: 8, top: 4, bottom: 4 })
          .onClick(() => this.onAddResourceComment());
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 12, bottom: 8 });

      Divider().strokeWidth(0.5).color($r('sys.color.ohos_id_color_list_separator'));

      // Body — scrollable list
      Scroll() {
        Column() {
          ForEach(this.bundle.highlights, (h: Highlight) => {
            this.HighlightCard(h);
          }, (h: Highlight) => h.id);

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

  @Builder HighlightCard(h: Highlight) {
    Column() {
      Row() {
        // Color dot — using Text fallback instead of Circle() to avoid ArkTS
        // strict-mode constructor-arg issues; visual result is identical.
        Text('').width(10).height(10).backgroundColor(h.color).borderRadius(5);
        Text(h.text_content)
          .fontSize(14).maxLines(3).textOverflow({ overflow: TextOverflow.Ellipsis })
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .layoutWeight(1)
          .margin({ left: 8 });
        Text('×').fontSize(18)
          .fontColor($r('sys.color.ohos_id_color_text_tertiary'))
          .width(28).height(28).textAlign(TextAlign.Center)
          .onClick(() => this.onDeleteHighlight(h.id));
      }
      .width('100%').alignItems(VerticalAlign.Top);

      ForEach(this.commentsFor(h.id), (c: Comment) => {
        Row() {
          Text(c.content).fontSize(13)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .layoutWeight(1);
        }
        .width('100%')
        .padding({ left: 18, top: 4, right: 4 })
        .onClick(() => this.onEditComment(c.id));
      }, (c: Comment) => c.id);
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 8, bottom: 8 })
    .onClick(() => this.onTapHighlight(h.id));
  }

  @Builder CommentCard(c: Comment) {
    Row() {
      Text(c.content).fontSize(14)
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
        .layoutWeight(1);
      Text('×').fontSize(18)
        .fontColor($r('sys.color.ohos_id_color_text_tertiary'))
        .width(28).height(28).textAlign(TextAlign.Center)
        .onClick(() => this.onDeleteComment(c.id));
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 8, bottom: 8 })
    .onClick(() => this.onEditComment(c.id));
  }
}
