// Question create / edit form (Phase H5). Routing:
//   - no params  → create new question
//   - params.id  → load existing for edit
// Save button calls QuestionService.create or update, then router.back().

import { router, promptAction } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { ShibeiService, ShibeiError } from '../services/ShibeiService';
import { QuestionService } from '../services/QuestionService';
import { I18n } from '../services/I18n';

interface QuestionEditParams {
  id?: string;
}

@Entry
@Component
struct QuestionEdit {
  @State title: string = '';
  @State description: string = '';
  @State submitting: boolean = false;
  @State error: string = '';
  private editingId: string | null = null;

  aboutToAppear(): void {
    const params = router.getParams() as QuestionEditParams | undefined;
    if (params && params.id) {
      this.editingId = params.id;
      try {
        const q = ShibeiService.instance.getQuestion(params.id);
        this.title = q.title;
        this.description = q.description ?? '';
      } catch (err) {
        const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
        this.error = code;
        hilog.error(0x0000, 'shibei', 'QuestionEdit load fail: %{public}s', code);
      }
    }
  }

  private async handleSave(): Promise<void> {
    const t = this.title.trim();
    if (t.length === 0) return;
    this.submitting = true;
    try {
      const desc = this.description.trim().length === 0 ? null : this.description;
      if (this.editingId) {
        QuestionService.instance.updateQuestion(this.editingId, t, desc);
      } else {
        QuestionService.instance.createQuestion(t, desc);
        promptAction.showToast({ message: I18n.t($r('app.string.question_create_success')) });
      }
      router.back();
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
      hilog.warn(0x0000, 'shibei', 'QuestionEdit save fail: %{public}s', code);
      promptAction.showToast({ message: I18n.t($r('app.string.question_operation_failed')) });
      this.submitting = false;
    }
  }

  build() {
    Column() {
      // Top bar with title + cancel/save
      Row() {
        Text(I18n.t($r('app.string.common_cancel'))).fontSize(15)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .padding({ left: 12, right: 12, top: 4, bottom: 4 }).height(44).textAlign(TextAlign.Start)
          .onClick(() => router.back());
        Text(this.editingId
          ? I18n.t($r('app.string.question_edit'))
          : I18n.t($r('app.string.question_create')))
          .fontSize(17).fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .layoutWeight(1).textAlign(TextAlign.Center);
        Text(I18n.t($r('app.string.question_save'))).fontSize(15)
          .fontColor(this.title.trim().length === 0 || this.submitting
            ? $r('sys.color.ohos_id_color_text_tertiary')
            : $r('app.color.accent_primary'))
          .fontWeight(FontWeight.Medium)
          .padding({ left: 12, right: 12, top: 4, bottom: 4 }).height(44).textAlign(TextAlign.End)
          .onClick(() => {
            if (this.title.trim().length === 0 || this.submitting) return;
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
          // Title field
          Text(I18n.t($r('app.string.question_title_placeholder'))).fontSize(12)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .padding({ left: 16, right: 16, top: 16, bottom: 4 });
          TextInput({ text: this.title, placeholder: I18n.t($r('app.string.question_title_placeholder')) })
            .onChange((v: string) => { this.title = v; })
            .margin({ left: 16, right: 16 })
            .fontSize(15)
            .backgroundColor($r('sys.color.ohos_id_color_background'));

          // Description field
          Text(I18n.t($r('app.string.question_description_placeholder'))).fontSize(12)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .padding({ left: 16, right: 16, top: 20, bottom: 4 });
          TextArea({ text: this.description, placeholder: I18n.t($r('app.string.question_description_placeholder')) })
            .onChange((v: string) => { this.description = v; })
            .margin({ left: 16, right: 16 })
            .fontSize(14)
            .height(220)
            .backgroundColor($r('sys.color.ohos_id_color_background'));
        }.alignItems(HorizontalAlign.Start).width('100%');
      }
      .align(Alignment.Top).layoutWeight(1).width('100%');
    }
    .width('100%').height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'));
  }
}
