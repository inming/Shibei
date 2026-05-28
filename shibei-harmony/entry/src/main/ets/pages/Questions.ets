// Questions list page (Phase H4). Mirrors desktop sidebar's QuestionSection
// with active / archived collapsible groups. Tap a question → push
// QuestionDetail; tap + → push QuestionEdit in create mode; long-press a
// question → archive / unarchive / delete actions.

import { router, promptAction } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { pasteboard } from '@kit.BasicServicesKit';
import { ShibeiService, ShibeiError, Question } from '../services/ShibeiService';
import {
  QuestionService,
  QuestionListSnapshot,
} from '../services/QuestionService';
import { I18n } from '../services/I18n';
import { SettingsTopBar } from '../components/SettingsTopBar';

@Entry
@Component
struct Questions {
  @State active: Question[] = [];
  @State archived: Question[] = [];
  @State activeOpen: boolean = true;
  @State archivedOpen: boolean = false;
  @State error: string = '';
  @State loading: boolean = true;
  private unsub?: () => void;

  aboutToAppear(): void {
    this.reload();
    this.unsub = QuestionService.instance.subscribeList((snap: QuestionListSnapshot) => {
      this.active = snap.active;
      this.archived = snap.archived;
    });
  }

  onPageShow(): void {
    // Re-enter from QuestionDetail / QuestionEdit may have mutated data.
    this.reload();
  }

  aboutToDisappear(): void {
    if (this.unsub) this.unsub();
  }

  private async reload(): Promise<void> {
    try {
      this.loading = true;
      const snap = await QuestionService.instance.loadList();
      this.active = snap.active;
      this.archived = snap.archived;
      this.error = '';
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
      this.error = code;
      hilog.error(0x0000, 'shibei', 'Questions reload fail: %{public}s', code);
    } finally {
      this.loading = false;
    }
  }

  private gotoDetail(q: Question): void {
    router.pushUrl({ url: 'pages/QuestionDetail', params: { id: q.id } }).catch((err: Error) => {
      hilog.error(0x0000, 'shibei', 'QuestionDetail push fail: %{public}s', err.message);
    });
  }

  private gotoCreate(): void {
    router.pushUrl({ url: 'pages/QuestionEdit' }).catch((err: Error) => {
      hilog.error(0x0000, 'shibei', 'QuestionEdit push fail: %{public}s', err.message);
    });
  }

  private gotoEdit(q: Question): void {
    router.pushUrl({ url: 'pages/QuestionEdit', params: { id: q.id } }).catch((err: Error) => {
      hilog.error(0x0000, 'shibei', 'QuestionEdit push fail: %{public}s', err.message);
    });
  }

  private copyLink(q: Question): void {
    try {
      const data = pasteboard.createData(
        pasteboard.MIMETYPE_TEXT_PLAIN,
        `shibei://open/question/${encodeURIComponent(q.id)}`,
      );
      pasteboard.getSystemPasteboard().setData(data).then(() => {
        promptAction.showToast({ message: I18n.t($r('app.string.common_copy_success')) });
      }).catch((err: Error) => {
        hilog.warn(0x0000, 'shibei', 'question link copy fail: %{public}s', err.message);
      });
    } catch (err) {
      hilog.warn(0x0000, 'shibei', 'copy question link fail: %{public}s', (err as Error).message);
    }
  }

  private onLongPress(q: Question): void {
    interface ActionButton { text: string; color: ResourceStr; }
    const buttons: ActionButton[] = [
      { text: I18n.t($r('app.string.question_edit')), color: $r('app.color.accent_primary') },
      { text: I18n.t($r('app.string.annotation_copy_link')), color: $r('app.color.accent_primary_alt') },
      {
        text: q.status === 'archived'
          ? I18n.t($r('app.string.question_unarchive'))
          : I18n.t($r('app.string.question_archive')),
        color: $r('app.color.accent_primary_alt'),
      },
      { text: I18n.t($r('app.string.question_delete')), color: $r('app.color.accent_danger') },
      { text: I18n.t($r('app.string.common_cancel')), color: $r('app.color.text_secondary') },
    ];
    promptAction.showDialog({
      title: q.title,
      buttons,
    }).then((r) => {
      if (r.index === 0) this.gotoEdit(q);
      else if (r.index === 1) this.copyLink(q);
      else if (r.index === 2) this.toggleArchive(q);
      else if (r.index === 3) this.confirmDelete(q);
    }).catch((err: Error) => {
      hilog.warn(0x0000, 'shibei', 'question dialog dismissed: %{public}s', err.message);
    });
  }

  private toggleArchive(q: Question): void {
    try {
      if (q.status === 'archived') {
        QuestionService.instance.unarchiveQuestion(q.id);
      } else {
        QuestionService.instance.archiveQuestion(q.id);
      }
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
      hilog.warn(0x0000, 'shibei', 'archive toggle fail: %{public}s', code);
      promptAction.showToast({ message: I18n.t($r('app.string.question_operation_failed')) });
    }
  }

  private confirmDelete(q: Question): void {
    // We need link count for the confirmation copy. listQuestionLinks is
    // synchronous and cheap on mobile (small datasets).
    let linkCount = 0;
    try {
      linkCount = ShibeiService.instance.listQuestionLinks(q.id).length;
    } catch {
      // best effort — fall back to the generic confirm message
    }
    const msg = linkCount === 0
      ? I18n.t($r('app.string.question_delete_confirm'), q.title)
      : I18n.t($r('app.string.question_delete_confirm_with_links'), q.title, linkCount);
    promptAction.showDialog({
      title: I18n.t($r('app.string.question_delete')),
      message: msg,
      buttons: [
        { text: I18n.t($r('app.string.common_cancel')), color: $r('app.color.text_secondary') },
        { text: I18n.t($r('app.string.question_delete')), color: $r('app.color.accent_danger') },
      ],
    }).then((r) => {
      if (r.index !== 1) return;
      try {
        QuestionService.instance.deleteQuestion(q.id);
      } catch (err) {
        const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
        hilog.warn(0x0000, 'shibei', 'deleteQuestion fail: %{public}s', code);
        promptAction.showToast({ message: I18n.t($r('app.string.question_operation_failed')) });
      }
    }).catch((err: Error) => {
      hilog.warn(0x0000, 'shibei', 'delete dialog dismissed: %{public}s', err.message);
    });
  }

  @Builder
  GroupHeader(title: string, count: number, isOpen: boolean, onToggle: () => void) {
    Row() {
      Text(isOpen ? '▼' : '▶').fontSize(10)
        .fontColor($r('sys.color.ohos_id_color_text_tertiary'))
        .margin({ right: 6 });
      Text(`${title} (${count})`).fontSize(13)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'));
    }
    .width('100%').padding({ left: 16, right: 16, top: 10, bottom: 10 })
    .onClick(() => onToggle());
  }

  @Builder
  QuestionRow(q: Question) {
    Row() {
      // Status dot — green for active, gray for archived. Reuses accent
      // palette to stay theme-aware.
      Circle({ width: 8, height: 8 })
        .fill(q.status === 'archived'
          ? $r('app.color.text_secondary')
          : $r('app.color.accent_primary'))
        .margin({ right: 10 });
      Column() {
        Text(q.title).fontSize(15)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis });
        if (q.description) {
          Text(q.description.split('\n')[0])
            .fontSize(12)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
            .margin({ top: 2 });
        }
      }.alignItems(HorizontalAlign.Start).layoutWeight(1);
      Text('›').fontSize(18)
        .fontColor($r('sys.color.ohos_id_color_text_tertiary'));
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 12, bottom: 12 })
    .onClick(() => this.gotoDetail(q))
    .gesture(
      LongPressGesture({ repeat: false, duration: 500 })
        .onAction(() => this.onLongPress(q))
    );
  }

  build() {
    Column() {
      // Top bar with title + back chevron. We reuse SettingsTopBar's
      // layout but the back arrow goes to Library.
      Row() {
        Text('‹').fontSize(26)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .width(44).height(44).textAlign(TextAlign.Center)
          .onClick(() => router.back());
        Text(I18n.t($r('app.string.question_section_title')))
          .fontSize(17).fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .layoutWeight(1).textAlign(TextAlign.Center);
        Text('+').fontSize(26)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .width(44).height(44).textAlign(TextAlign.Center)
          .onClick(() => this.gotoCreate());
      }
      .width('100%').padding({ left: 4, right: 4, top: 4, bottom: 4 })
      .backgroundColor($r('sys.color.ohos_id_color_background'));

      if (this.error) {
        Text(I18n.t($r('app.string.resource_list_error'), this.error))
          .fontSize(12).fontColor($r('sys.color.ohos_id_color_warning'))
          .margin({ left: 16, right: 16, top: 12 });
      }

      Scroll() {
        Column() {
          // Active group
          this.GroupHeader(
            I18n.t($r('app.string.question_active')),
            this.active.length,
            this.activeOpen,
            () => { this.activeOpen = !this.activeOpen; },
          );
          if (this.activeOpen) {
            if (this.active.length === 0) {
              Text(this.loading ? '' : I18n.t($r('app.string.question_empty_active')))
                .fontSize(13)
                .fontColor($r('sys.color.ohos_id_color_text_tertiary'))
                .fontStyle(FontStyle.Italic)
                .padding({ left: 32, right: 16, top: 8, bottom: 8 });
            } else {
              ForEach(this.active, (q: Question) => {
                this.QuestionRow(q);
                Divider().color($r('sys.color.ohos_id_color_list_separator'));
              }, (q: Question) => q.id);
            }
          }

          // Archived group
          this.GroupHeader(
            I18n.t($r('app.string.question_archived')),
            this.archived.length,
            this.archivedOpen,
            () => { this.archivedOpen = !this.archivedOpen; },
          );
          if (this.archivedOpen) {
            if (this.archived.length === 0) {
              Text(I18n.t($r('app.string.question_empty_archived')))
                .fontSize(13)
                .fontColor($r('sys.color.ohos_id_color_text_tertiary'))
                .fontStyle(FontStyle.Italic)
                .padding({ left: 32, right: 16, top: 8, bottom: 8 });
            } else {
              ForEach(this.archived, (q: Question) => {
                this.QuestionRow(q);
                Divider().color($r('sys.color.ohos_id_color_list_separator'));
              }, (q: Question) => q.id);
            }
          }
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%');
      }
      .align(Alignment.Top)
      .layoutWeight(1)
      .width('100%');
    }
    .width('100%').height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'));
  }
}
