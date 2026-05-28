// Questions list embedded inside Library's main area. Replaces the
// standalone pages/Questions.ets full-screen page introduced in Phase H.
//
// Layout (mirrors desktop QuestionList):
//   - Search input (≥ 2 chars triggers FTS via cmd_search_questions)
//   - Three-chip filter strip (Active / Archived / All; single-select)
//   - Flat list (active first when filter=all; status dot encodes archived)
//
// Interactions:
//   - Tap a row → push QuestionDetail
//   - Long-press → Edit / Copy link / Archive toggle / Delete dialog
//   - (Create is owned by the parent Library's FAB, so this view has no +)

import { router, promptAction } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { pasteboard } from '@kit.BasicServicesKit';
import { ShibeiService, ShibeiError, Question } from '../services/ShibeiService';
import {
  QuestionService,
  QuestionListSnapshot,
} from '../services/QuestionService';
import { I18n } from '../services/I18n';
import { QuestionFilter } from '../app/SessionState';

const MIN_SEARCH_CHARS = 2;

@Component
export struct QuestionListView {
  /**
   * Active filter chip — must be @Prop so a parent state change re-renders
   * the chip row's selected styling. Bare fields capture the initial value
   * only; chip click would fire onFilterChange (updating the parent), but
   * the visual selection would stay stuck on the initial value.
   */
  @Prop filter: QuestionFilter = 'active';
  onFilterChange?: (next: QuestionFilter) => void;

  @State active: Question[] = [];
  @State archived: Question[] = [];
  @State searchInput: string = '';
  /** Debounced query that actually drives the FTS call. */
  @State debouncedQuery: string = '';
  @State searchHits: Question[] = [];
  @State loading: boolean = true;
  private unsub?: () => void;
  private searchTimer: number = -1;

  aboutToAppear(): void {
    this.reload();
    this.unsub = QuestionService.instance.subscribeList((snap: QuestionListSnapshot) => {
      this.active = snap.active;
      this.archived = snap.archived;
    });
  }

  onPageShow(): void {
    // Library is the only host; re-entering from QuestionDetail / QuestionEdit
    // could have mutated the data, so refresh.
    this.reload();
  }

  aboutToDisappear(): void {
    if (this.unsub) this.unsub();
    if (this.searchTimer !== -1) clearTimeout(this.searchTimer);
  }

  private async reload(): Promise<void> {
    try {
      this.loading = true;
      const snap = await QuestionService.instance.loadList();
      this.active = snap.active;
      this.archived = snap.archived;
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
      hilog.warn(0x0000, 'shibei', 'QuestionListView reload fail: %{public}s', code);
    } finally {
      this.loading = false;
    }
  }

  // Debounce 300ms — same as the desktop QuestionList.
  private scheduleSearch(): void {
    if (this.searchTimer !== -1) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.debouncedQuery = this.searchInput.trim();
      this.runSearch();
    }, 300);
  }

  private runSearch(): void {
    const q = this.debouncedQuery;
    if (q.length < MIN_SEARCH_CHARS) {
      this.searchHits = [];
      return;
    }
    try {
      this.searchHits = ShibeiService.instance.searchQuestions(q);
    } catch (err) {
      hilog.warn(0x0000, 'shibei', 'searchQuestions fail: %{public}s', (err as Error).message);
      this.searchHits = [];
    }
  }

  /**
   * Spec §"搜索行为详解 — Questions 模式": chip filter is authoritative;
   * search results intersect with the chip's candidate set.
   */
  private displayed(): Question[] {
    let candidates: Question[];
    if (this.filter === 'active') {
      candidates = this.active;
    } else if (this.filter === 'archived') {
      candidates = this.archived;
    } else {
      candidates = this.active.concat(this.archived);
    }
    if (this.debouncedQuery.length < MIN_SEARCH_CHARS) {
      return candidates;
    }
    const allowed = new Set<string>();
    for (let i = 0; i < candidates.length; i++) allowed.add(candidates[i].id);
    return this.searchHits.filter((q) => allowed.has(q.id));
  }

  private chipCount(filter: QuestionFilter): number {
    if (filter === 'active') return this.active.length;
    if (filter === 'archived') return this.archived.length;
    return this.active.length + this.archived.length;
  }

  private gotoDetail(q: Question): void {
    router.pushUrl({
      url: 'pages/QuestionDetail',
      params: { id: q.id },
    }).catch((err: Error) => {
      hilog.error(0x0000, 'shibei', 'QuestionDetail push fail: %{public}s', err.message);
    });
  }

  private gotoEdit(q: Question): void {
    router.pushUrl({
      url: 'pages/QuestionEdit',
      params: { id: q.id },
    }).catch((err: Error) => {
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
    let linkCount = 0;
    try {
      linkCount = ShibeiService.instance.listQuestionLinks(q.id).length;
    } catch {
      // best effort
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

  @Builder
  ChipButton(value: QuestionFilter, label: string) {
    Row() {
      Text(label).fontSize(13)
        .fontColor(
          this.filter === value
            ? $r('sys.color.ohos_id_color_text_primary')
            : $r('sys.color.ohos_id_color_text_secondary'),
        )
        .fontWeight(this.filter === value ? FontWeight.Medium : FontWeight.Regular);
      Text(`${this.chipCount(value)}`).fontSize(11)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .margin({ left: 6 })
        .padding({ left: 5, right: 5 });
    }
    .padding({ left: 12, right: 12, top: 4, bottom: 4 })
    .borderRadius(14)
    .borderWidth(1)
    .borderColor(
      this.filter === value
        ? $r('app.color.accent_primary')
        : $r('sys.color.ohos_id_color_component_normal'),
    )
    .backgroundColor(
      this.filter === value
        ? $r('sys.color.ohos_id_color_component_normal')
        : Color.Transparent,
    )
    .margin({ right: 6 })
    .onClick(() => {
      if (this.onFilterChange) this.onFilterChange(value);
    });
  }

  private emptyMessage(): string {
    if (this.loading) return '';
    if (this.debouncedQuery.length >= MIN_SEARCH_CHARS) {
      return I18n.t($r('app.string.question_list_empty_search'));
    }
    return I18n.t($r('app.string.question_list_empty_all'));
  }

  @Builder
  ListBody() {
    Column() {
      if (this.displayed().length === 0) {
        Text(this.emptyMessage())
          .fontSize(13)
          .fontColor($r('sys.color.ohos_id_color_text_tertiary'))
          .fontStyle(FontStyle.Italic)
          .padding({ left: 32, right: 16, top: 24, bottom: 8 });
      } else {
        ForEach(this.displayed(), (q: Question) => {
          this.QuestionRow(q);
          Divider().color($r('sys.color.ohos_id_color_list_separator'));
        }, (q: Question) => q.id);
      }
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%');
  }

  @Builder
  QuestionRow(q: Question) {
    Row() {
      Circle({ width: 8, height: 8 })
        .fill(
          q.status === 'archived'
            ? $r('app.color.text_secondary')
            : $r('app.color.accent_primary'),
        )
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
        .onAction(() => this.onLongPress(q)),
    );
  }

  build() {
    Column() {
      // Search input
      Row() {
        TextInput({ placeholder: I18n.t($r('app.string.question_search_placeholder')), text: this.searchInput })
          .layoutWeight(1)
          .height(36)
          .fontSize(14)
          .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
          .borderRadius(8)
          .padding({ left: 12, right: 12 })
          .onChange((value: string) => {
            this.searchInput = value;
            this.scheduleSearch();
          });
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 8, bottom: 4 });

      // Filter chips
      Row() {
        this.ChipButton('active', I18n.t($r('app.string.question_active')));
        this.ChipButton('archived', I18n.t($r('app.string.question_archived')));
        this.ChipButton('all', I18n.t($r('app.string.question_filter_all')));
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 4, bottom: 8 });

      // List
      Scroll() {
        this.ListBody();
      }
      .align(Alignment.Top)
      .layoutWeight(1)
      .width('100%');
    }
    .width('100%').height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'));
  }
}
