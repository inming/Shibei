// Research-note create / edit form. Routing:
//   - params.questionId only            → create a new note
//   - params.questionId + noteId + content → edit existing (content passed in
//     by the detail page, which already holds the note, so we avoid a
//     single-note fetch command).
// Save calls QuestionService.create/updateQuestionNote, then router.back();
// the detail page's notes subscriber refreshes automatically.

import { router, promptAction } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { ShibeiError } from '../services/ShibeiService';
import { QuestionService } from '../services/QuestionService';
import { I18n } from '../services/I18n';

interface QuestionNoteEditParams {
  questionId: string;
  noteId?: string;
  content?: string;
}

@Entry
@Component
struct QuestionNoteEdit {
  @State content: string = '';
  @State submitting: boolean = false;
  @State error: string = '';
  // Drives the title via build() (re-renders on change); $r() needs a literal
  // key, so the create/edit choice is a ternary *outside* $r (mirrors
  // QuestionEdit), not $r(ternary) which resolves to an empty string.
  @State isEditing: boolean = false;
  private questionId: string = '';
  private editingId: string | null = null;

  aboutToAppear(): void {
    const params = router.getParams() as QuestionNoteEditParams | undefined;
    if (!params || !params.questionId) {
      this.error = 'missing question id';
      return;
    }
    this.questionId = params.questionId;
    if (params.noteId) {
      this.editingId = params.noteId;
      this.isEditing = true;
      this.content = params.content ?? '';
    }
  }

  private async handleSave(): Promise<void> {
    const c = this.content.trim();
    if (c.length === 0) {
      // Empty note → treat as cancel rather than persisting a blank card.
      router.back();
      return;
    }
    this.submitting = true;
    try {
      if (this.editingId) {
        QuestionService.instance.updateQuestionNote(this.questionId, this.editingId, this.content);
      } else {
        QuestionService.instance.createQuestionNote(this.questionId, this.content);
      }
      router.back();
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
      hilog.warn(0x0000, 'shibei', 'QuestionNoteEdit save fail: %{public}s', code);
      promptAction.showToast({ message: I18n.t($r('app.string.question_operation_failed')) });
      this.submitting = false;
    }
  }

  build() {
    Column() {
      Row() {
        Text(I18n.t($r('app.string.common_cancel'))).fontSize(15)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .padding({ left: 12, right: 12, top: 4, bottom: 4 }).height(44).textAlign(TextAlign.Start)
          .onClick(() => router.back());
        Text(this.isEditing
          ? I18n.t($r('app.string.question_edit_note'))
          : I18n.t($r('app.string.question_add_note')))
          .fontSize(17).fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .layoutWeight(1).textAlign(TextAlign.Center);
        Text(I18n.t($r('app.string.question_save'))).fontSize(15)
          .fontColor(this.content.trim().length === 0 || this.submitting
            ? $r('sys.color.ohos_id_color_text_tertiary')
            : $r('app.color.accent_primary'))
          .fontWeight(FontWeight.Medium)
          .padding({ left: 12, right: 12, top: 4, bottom: 4 }).height(44).textAlign(TextAlign.End)
          .onClick(() => {
            if (this.content.trim().length === 0 || this.submitting) return;
            this.handleSave();
          });
      }
      .width('100%').padding({ left: 4, right: 4, top: 4, bottom: 4 })
      .backgroundColor($r('sys.color.ohos_id_color_background'));

      if (this.error) {
        Text(this.error).fontSize(12)
          .fontColor($r('sys.color.ohos_id_color_warning'))
          .margin({ left: 16, right: 16, top: 12 });
      }

      Scroll() {
        Column() {
          TextArea({
            text: this.content,
            placeholder: I18n.t($r('app.string.question_note_placeholder')),
          })
            .onChange((v: string) => { this.content = v; })
            .margin({ left: 16, right: 16, top: 16 })
            .fontSize(14)
            .height(320)
            .backgroundColor($r('sys.color.ohos_id_color_background'));
        }.alignItems(HorizontalAlign.Start).width('100%');
      }
      .align(Alignment.Top).layoutWeight(1).width('100%');
    }
    .width('100%').height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'));
  }
}
