// Question detail page (Phase H4 → resource-grouped). Shows the question's
// metadata + all alive links grouped by their parent resource: each source
// appears once, with its highlights / notes nested underneath (mirrors the
// desktop ResourceLinkGroup). Links arrive pre-resolved from the backend
// (`listResolvedQuestionLinks`) — no more O(N) resource scan to find snippets.

import { router, promptAction } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { pasteboard } from '@kit.BasicServicesKit';
import {
  ShibeiService,
  ShibeiError,
  Question,
  QuestionLink,
  QuestionNote,
  ResolvedQuestionLink,
} from '../services/ShibeiService';
import { QuestionService } from '../services/QuestionService';
import { I18n } from '../services/I18n';
import { MarkdownText } from '../components/MarkdownText';

interface QuestionDetailParams {
  id: string;
}

interface ReaderParams {
  resourceId: string;
  highlightId?: string;
}

/** One resource and every link that points into it. */
interface ResourceGroup {
  key: string;
  resourceId: string | null;
  resourceTitle: string | null;
  /** The whole-article link, when the resource itself was linked. */
  resourceLink: ResolvedQuestionLink | null;
  /** highlight + comment links, sorted by document position. */
  evidence: ResolvedQuestionLink[];
}

interface GroupIdx {
  g: ResourceGroup;
  i: number;
}

/** Loose view over a highlight anchor for ordering evidence by position. */
interface AnchorLite {
  type?: string;
  page?: number;
  charIndex?: number;
  start?: number;
  text_position?: AnchorPos;
}
interface AnchorPos {
  start?: number;
}

// Press-feedback styles for tappable rows (mirrors QuestionLinkSheet).
@Styles function pressedRowStyle() {
  .backgroundColor($r('app.color.bg_secondary'))
}
@Styles function normalRowStyle() {
  .backgroundColor(Color.Transparent)
}

@Entry
@Component
struct QuestionDetail {
  @State question: Question | null = null;
  @State resolved: ResolvedQuestionLink[] = [];
  @State groups: ResourceGroup[] = [];
  @State totalLinks: number = 0;
  @State expandedNotes: string[] = [];
  @State notes: QuestionNote[] = [];
  @State loading: boolean = true;
  @State error: string = '';
  private questionId: string = '';
  private unsubLinks?: () => void;
  private unsubList?: () => void;
  private unsubNotes?: () => void;

  aboutToAppear(): void {
    const params = router.getParams() as QuestionDetailParams;
    if (!params || !params.id) {
      this.error = 'missing question id';
      this.loading = false;
      return;
    }
    this.questionId = params.id;
    this.loadAll();
    this.unsubLinks = QuestionService.instance.subscribeResolvedLinks(
      this.questionId,
      (links: ResolvedQuestionLink[]) => {
        this.resolved = links;
        this.rebuild();
      },
    );
    // Listen to list-level snapshot so archive/unarchive/title edits on the
    // current question reflect in the header without manual reload.
    this.unsubList = QuestionService.instance.subscribeList(() => {
      try {
        this.question = ShibeiService.instance.getQuestion(this.questionId);
      } catch {
        // Question may have been deleted from another surface — pop back.
        router.back();
      }
    });
    this.unsubNotes = QuestionService.instance.subscribeNotes(
      this.questionId,
      (notes: QuestionNote[]) => {
        this.notes = notes;
      },
    );
  }

  onPageShow(): void {
    this.loadAll();
  }

  aboutToDisappear(): void {
    if (this.unsubLinks) this.unsubLinks();
    if (this.unsubList) this.unsubList();
    if (this.unsubNotes) this.unsubNotes();
  }

  private async loadAll(): Promise<void> {
    if (!this.questionId) return;
    try {
      this.loading = true;
      this.question = ShibeiService.instance.getQuestion(this.questionId);
      const links = await QuestionService.instance.loadResolvedLinks(this.questionId);
      this.resolved = links;
      this.rebuild();
      this.notes = await QuestionService.instance.loadNotes(this.questionId);
      this.error = '';
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
      this.error = code;
      hilog.error(0x0000, 'shibei', 'QuestionDetail load fail: %{public}s', code);
    } finally {
      this.loading = false;
    }
  }

  // ── grouping (port of desktop groupResolvedLinks) ──

  private rebuild(): void {
    this.totalLinks = this.resolved.length;
    const map = new Map<string, ResourceGroup>();
    const order: string[] = [];
    for (const r of this.resolved) {
      const rid: string | null = r.resource ? r.resource.id : null;
      const key: string = rid ? rid : `__unresolved__:${r.link.id}`;
      let g = map.get(key);
      if (!g) {
        g = {
          key,
          resourceId: rid,
          resourceTitle: r.resource ? r.resource.title : null,
          resourceLink: null,
          evidence: [],
        };
        map.set(key, g);
        order.push(key);
      }
      if (!g.resourceTitle && r.resource) {
        g.resourceTitle = r.resource.title;
        g.resourceId = r.resource.id;
      }
      if (r.link.target_type === 'resource') {
        g.resourceLink = r;
      } else {
        g.evidence.push(r);
      }
    }
    const groups: ResourceGroup[] = order.map((k: string) => map.get(k) as ResourceGroup);
    for (const g of groups) {
      g.evidence.sort((a: ResolvedQuestionLink, b: ResolvedQuestionLink) =>
        this.sortKey(a) - this.sortKey(b));
    }
    // Directly-linked resources first, then original first-seen order.
    const indexed: GroupIdx[] = groups.map((g: ResourceGroup, i: number) => {
      const x: GroupIdx = { g, i };
      return x;
    });
    indexed.sort((a: GroupIdx, b: GroupIdx) => {
      const ad: number = a.g.resourceLink ? 0 : 1;
      const bd: number = b.g.resourceLink ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.i - b.i;
    });
    this.groups = indexed.map((x: GroupIdx) => x.g);
  }

  private sortKey(r: ResolvedQuestionLink): number {
    if (r.link.target_type === 'comment') return Number.MAX_SAFE_INTEGER;
    if (r.link.target_type !== 'highlight') return -1;
    return this.anchorSortKey(r.anchor);
  }

  private anchorSortKey(anchor: Object | null): number {
    if (!anchor) return 0;
    const a = anchor as AnchorLite;
    if (a.type === 'pdf') {
      const page: number = typeof a.page === 'number' ? a.page : 0;
      const ci: number = typeof a.charIndex === 'number' ? a.charIndex : 0;
      return page * 10000000 + ci;
    }
    if (a.type === 'audio') {
      return typeof a.start === 'number' ? a.start : 0;
    }
    if (a.text_position && typeof a.text_position.start === 'number') {
      return a.text_position.start;
    }
    return 0;
  }

  // ── @Builder accessors (no const / return allowed in builder bodies) ──

  private groupBadge(g: ResourceGroup): string {
    const parts: string[] = [];
    const h: number = g.evidence.filter((e: ResolvedQuestionLink) =>
      e.link.target_type === 'highlight').length;
    const c: number = g.evidence.filter((e: ResolvedQuestionLink) =>
      e.link.target_type === 'comment').length;
    if (h > 0) parts.push(`${h} ${I18n.t($r('app.string.question_links_highlight'))}`);
    if (c > 0) parts.push(`${c} ${I18n.t($r('app.string.question_links_comment'))}`);
    return parts.join(' · ');
  }

  private noteNeedsFold(e: ResolvedQuestionLink): boolean {
    return !!e.snippet && e.snippet.length > 140;
  }
  private isNoteExpanded(linkId: string): boolean {
    return this.expandedNotes.includes(linkId);
  }
  private toggleNote(linkId: string): void {
    this.expandedNotes = this.isNoteExpanded(linkId)
      ? this.expandedNotes.filter((x: string) => x !== linkId)
      : this.expandedNotes.concat([linkId]);
  }

  // ── navigation / mutations ──

  private openResolved(r: ResolvedQuestionLink): void {
    const rid: string | null = r.resource ? r.resource.id : null;
    this.openResource(rid, r.highlight_id);
  }

  private openResource(resourceId: string | null, highlightId: string | null): void {
    if (!resourceId) {
      promptAction.showToast({ message: I18n.t($r('app.string.question_unknown_target')) });
      return;
    }
    const params: ReaderParams = { resourceId };
    if (highlightId) params.highlightId = highlightId;
    router.pushUrl({ url: 'pages/Reader', params }).catch((err: Error) => {
      hilog.error(0x0000, 'shibei', 'Reader push fail: %{public}s', err.message);
    });
  }

  private toggleArchive(): void {
    if (!this.question) return;
    const q = this.question;
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

  private gotoEdit(): void {
    if (!this.question) return;
    router.pushUrl({ url: 'pages/QuestionEdit', params: { id: this.question.id } }).catch((err: Error) => {
      hilog.error(0x0000, 'shibei', 'QuestionEdit push fail: %{public}s', err.message);
    });
  }

  private copyLink(): void {
    if (!this.question) return;
    try {
      const data = pasteboard.createData(
        pasteboard.MIMETYPE_TEXT_PLAIN,
        `shibei://open/question/${encodeURIComponent(this.question.id)}`,
      );
      pasteboard.getSystemPasteboard().setData(data).then(() => {
        promptAction.showToast({ message: I18n.t($r('app.string.common_copy_success')) });
      }).catch((err: Error) => {
        hilog.warn(0x0000, 'shibei', 'question link copy fail: %{public}s', err.message);
      });
    } catch (err) {
      hilog.warn(0x0000, 'shibei', 'copy link fail: %{public}s', (err as Error).message);
    }
  }

  private confirmDelete(): void {
    if (!this.question) return;
    const q = this.question;
    const linkCount = this.totalLinks;
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
        router.back();
      } catch (err) {
        const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
        hilog.warn(0x0000, 'shibei', 'deleteQuestion fail: %{public}s', code);
        promptAction.showToast({ message: I18n.t($r('app.string.question_operation_failed')) });
      }
    }).catch((err: Error) => {
      hilog.warn(0x0000, 'shibei', 'delete dialog dismissed: %{public}s', err.message);
    });
  }

  private confirmUnlink(link: QuestionLink): void {
    promptAction.showDialog({
      title: I18n.t($r('app.string.question_remove_link')),
      message: I18n.t($r('app.string.question_unlink_confirm')),
      buttons: [
        { text: I18n.t($r('app.string.common_cancel')), color: $r('app.color.text_secondary') },
        { text: I18n.t($r('app.string.question_remove_link')), color: $r('app.color.accent_danger') },
      ],
    }).then((r) => {
      if (r.index !== 1) return;
      try {
        QuestionService.instance.unlinkQuestion(this.questionId, link.id);
      } catch (err) {
        const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
        hilog.warn(0x0000, 'shibei', 'unlink fail: %{public}s', code);
        promptAction.showToast({ message: I18n.t($r('app.string.question_operation_failed')) });
      }
    }).catch((err: Error) => {
      hilog.warn(0x0000, 'shibei', 'unlink dialog dismissed: %{public}s', err.message);
    });
  }

  // ── research notes ──

  /** "2026-06-02 14:30" from an RFC3339 created_at, no Date/locale dependency. */
  private noteTs(note: QuestionNote): string {
    const s = note.created_at;
    if (s.length >= 16) return `${s.slice(0, 10)} ${s.slice(11, 16)}`;
    return s;
  }

  private gotoNoteCreate(): void {
    router.pushUrl({
      url: 'pages/QuestionNoteEdit',
      params: { questionId: this.questionId },
    }).catch((err: Error) => {
      hilog.error(0x0000, 'shibei', 'QuestionNoteEdit push fail: %{public}s', err.message);
    });
  }

  private gotoNoteEdit(note: QuestionNote): void {
    router.pushUrl({
      url: 'pages/QuestionNoteEdit',
      params: { questionId: this.questionId, noteId: note.id, content: note.content },
    }).catch((err: Error) => {
      hilog.error(0x0000, 'shibei', 'QuestionNoteEdit push fail: %{public}s', err.message);
    });
  }

  private confirmDeleteNote(note: QuestionNote): void {
    promptAction.showDialog({
      title: I18n.t($r('app.string.question_delete_note')),
      message: I18n.t($r('app.string.question_delete_note_confirm')),
      buttons: [
        { text: I18n.t($r('app.string.common_cancel')), color: $r('app.color.text_secondary') },
        { text: I18n.t($r('app.string.question_delete_note')), color: $r('app.color.accent_danger') },
      ],
    }).then((r) => {
      if (r.index !== 1) return;
      try {
        QuestionService.instance.deleteQuestionNote(this.questionId, note.id);
      } catch (err) {
        const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
        hilog.warn(0x0000, 'shibei', 'deleteQuestionNote fail: %{public}s', code);
        promptAction.showToast({ message: I18n.t($r('app.string.question_operation_failed')) });
      }
    }).catch((err: Error) => {
      hilog.warn(0x0000, 'shibei', 'delete note dialog dismissed: %{public}s', err.message);
    });
  }

  private showNoteActions(note: QuestionNote): void {
    interface ActionButton { text: string; color: ResourceStr; }
    const buttons: ActionButton[] = [
      { text: I18n.t($r('app.string.question_edit_note')), color: $r('app.color.accent_primary') },
      { text: I18n.t($r('app.string.question_delete_note')), color: $r('app.color.accent_danger') },
      { text: I18n.t($r('app.string.common_cancel')), color: $r('app.color.text_secondary') },
    ];
    promptAction.showDialog({
      title: this.noteTs(note),
      buttons,
    }).then((r) => {
      if (r.index === 0) this.gotoNoteEdit(note);
      else if (r.index === 1) this.confirmDeleteNote(note);
    }).catch((err: Error) => {
      hilog.warn(0x0000, 'shibei', 'note action dialog dismissed: %{public}s', err.message);
    });
  }

  // ── builders ──

  @Builder
  GroupCard(g: ResourceGroup) {
    Column() {
      // Header: resource title + counts (tap → open the resource at the top).
      Column() {
        Text(g.resourceTitle ? g.resourceTitle : I18n.t($r('app.string.question_unknown_target')))
          .fontSize(15).fontWeight(FontWeight.Medium)
          .fontColor(g.resourceTitle
            ? $r('sys.color.ohos_id_color_text_primary')
            : $r('sys.color.ohos_id_color_text_tertiary'))
          .fontStyle(g.resourceTitle ? FontStyle.Normal : FontStyle.Italic)
          .maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%');
        Row() {
          if (!g.resourceLink && g.resourceTitle) {
            Text(I18n.t($r('app.string.question_via_annotations')))
              .fontSize(11).fontStyle(FontStyle.Italic)
              .fontColor($r('sys.color.ohos_id_color_text_secondary'))
              .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
              .borderRadius(9).padding({ left: 7, right: 7, top: 1, bottom: 1 })
              .margin({ right: 6 });
          }
          if (this.groupBadge(g)) {
            Text(this.groupBadge(g))
              .fontSize(11)
              .fontColor($r('sys.color.ohos_id_color_text_secondary'))
              .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
              .borderRadius(9).padding({ left: 7, right: 7, top: 1, bottom: 1 });
          }
        }.margin({ top: 4 });
      }
      .alignItems(HorizontalAlign.Start).width('100%')
      .padding({ left: 12, right: 12, top: 10, bottom: 6 })
      .onClick(() => this.openResource(g.resourceId, null))
      .stateStyles({ pressed: pressedRowStyle, normal: normalRowStyle });

      // Whole-article relevance note.
      if (g.resourceLink && g.resourceLink.link.reason) {
        Text(g.resourceLink.link.reason).fontSize(12)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .maxLines(4).textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%').padding({ left: 12, right: 12, bottom: 8 });
      }

      // Evidence (highlights + notes).
      ForEach(g.evidence, (e: ResolvedQuestionLink) => {
        this.EvidenceRow(e);
      }, (e: ResolvedQuestionLink) => e.link.id);
    }
    // NOTE: width('100%') + horizontal margin overflows in ArkUI (margin is
    // added outside the 100% box). Horizontal inset is the wrapper's padding;
    // here we only add the inter-card top gap.
    .alignItems(HorizontalAlign.Start).width('100%')
    .margin({ top: 10 })
    .backgroundColor($r('sys.color.ohos_id_color_background'))
    .borderRadius(8)
    .borderWidth(1)
    .borderColor($r('sys.color.ohos_id_color_list_separator'));
  }

  @Builder
  EvidenceRow(e: ResolvedQuestionLink) {
    Column() {
      Row() {
        Column() {
          if (e.link.target_type === 'comment') {
            // Note: render Markdown, collapse long bodies behind a toggle.
            if (this.isNoteExpanded(e.link.id) || !this.noteNeedsFold(e)) {
              MarkdownText({ content: e.snippet ? e.snippet : '', baseFontSize: 13 });
            } else {
              Column() {
                MarkdownText({ content: e.snippet ? e.snippet : '', baseFontSize: 13 });
              }.width('100%').constraintSize({ maxHeight: 92 }).clip(true);
            }
            if (this.noteNeedsFold(e)) {
              Text(this.isNoteExpanded(e.link.id)
                ? I18n.t($r('app.string.question_collapse'))
                : I18n.t($r('app.string.question_expand')))
                .fontSize(12).fontColor($r('app.color.accent_primary'))
                .margin({ top: 2 })
                .onClick(() => this.toggleNote(e.link.id));
            }
          } else {
            // Highlight: text with a left accent bar in the highlight's color.
            Text(e.snippet ? e.snippet : I18n.t($r('app.string.question_unknown_target')))
              .fontSize(13)
              .fontColor(e.snippet
                ? $r('sys.color.ohos_id_color_text_primary')
                : $r('sys.color.ohos_id_color_text_tertiary'))
              .fontStyle(e.snippet ? FontStyle.Normal : FontStyle.Italic)
              .maxLines(3).textOverflow({ overflow: TextOverflow.Ellipsis })
              .width('100%')
              .padding({ left: 8, right: 6, top: 4, bottom: 4 })
              .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
              .borderRadius(4)
              .borderWidth({ left: 3 })
              .borderColor({ left: e.highlight_color ? e.highlight_color : '#cccccc' });
          }
          if (e.link.reason) {
            Text(e.link.reason).fontSize(12)
              .fontColor($r('sys.color.ohos_id_color_text_secondary'))
              .maxLines(3).textOverflow({ overflow: TextOverflow.Ellipsis })
              .width('100%').margin({ top: 4 });
          }
        }.alignItems(HorizontalAlign.Start).layoutWeight(1);

        Text('×').fontSize(18)
          .fontColor($r('sys.color.ohos_id_color_text_tertiary'))
          .width(32).height(32).textAlign(TextAlign.Center)
          .onClick(() => this.confirmUnlink(e.link));
      }
      .width('100%').alignItems(VerticalAlign.Top)
      .padding({ left: 12, right: 4, top: 8, bottom: 8 })
      .onClick(() => this.openResolved(e))
      .stateStyles({ pressed: pressedRowStyle, normal: normalRowStyle });
    }
    .alignItems(HorizontalAlign.Start).width('100%');
  }

  @Builder
  NoteCard(note: QuestionNote) {
    Column() {
      Row() {
        Text(this.noteTs(note))
          .fontSize(11)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .layoutWeight(1);
        Text('⋯').fontSize(18)
          .fontColor($r('sys.color.ohos_id_color_text_tertiary'))
          .width(32).height(28).textAlign(TextAlign.Center)
          .onClick(() => this.showNoteActions(note));
      }.width('100%').alignItems(VerticalAlign.Center);
      Column() {
        MarkdownText({ content: note.content, baseFontSize: 13 });
      }.width('100%').margin({ top: 2 });
    }
    .alignItems(HorizontalAlign.Start).width('100%')
    .padding({ left: 12, right: 4, top: 8, bottom: 10 })
    .margin({ top: 8 })
    .backgroundColor($r('sys.color.ohos_id_color_background'))
    .borderRadius(8)
    .borderWidth(1)
    .borderColor($r('sys.color.ohos_id_color_list_separator'))
    .onClick(() => this.gotoNoteEdit(note))
    .stateStyles({ pressed: pressedRowStyle, normal: normalRowStyle });
  }

  build() {
    Column() {
      // Top bar
      Row() {
        Text('‹').fontSize(26)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .width(44).height(44).textAlign(TextAlign.Center)
          .onClick(() => router.back());
        Text(this.question ? this.question.title : '…')
          .fontSize(17).fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .layoutWeight(1).textAlign(TextAlign.Center)
          .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis });
        Text('⋯').fontSize(22)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .width(44).height(44).textAlign(TextAlign.Center)
          .onClick(() => this.showActions());
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
          // Status pill
          if (this.question) {
            Row() {
              Text(this.question.status === 'archived'
                ? I18n.t($r('app.string.question_archived'))
                : I18n.t($r('app.string.question_active')))
                .fontSize(11)
                .fontColor(this.question.status === 'archived'
                  ? $r('sys.color.ohos_id_color_text_secondary')
                  : $r('app.color.accent_primary'))
                .padding({ left: 8, right: 8, top: 2, bottom: 2 })
                .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
                .borderRadius(10);
            }.padding({ left: 16, right: 16, top: 16 });
          }

          // Description (Markdown)
          if (this.question && this.question.description) {
            Column() {
              MarkdownText({ content: this.question.description });
            }
            .width('100%')
            .padding({ left: 16, right: 16, top: 12 });
          } else if (this.question) {
            Text(I18n.t($r('app.string.question_no_description')))
              .fontSize(13).fontStyle(FontStyle.Italic)
              .fontColor($r('sys.color.ohos_id_color_text_tertiary'))
              .padding({ left: 16, right: 16, top: 12 });
          }

          // Research notes section: synthesized thinking / stage summaries,
          // newest first. Tap a card to edit; ⋯ for edit/delete; + to add.
          if (this.question) {
            Row() {
              Text(`${I18n.t($r('app.string.question_notes_header'))} (${this.notes.length})`)
                .fontSize(14).fontWeight(FontWeight.Medium)
                .fontColor($r('sys.color.ohos_id_color_text_primary'))
                .layoutWeight(1);
              Text('+').fontSize(22)
                .fontColor($r('app.color.accent_primary'))
                .width(36).height(36).textAlign(TextAlign.Center)
                .onClick(() => this.gotoNoteCreate());
            }
            .width('100%').alignItems(VerticalAlign.Center)
            .padding({ left: 16, right: 8, top: 20, bottom: 4 });
            Divider().color($r('sys.color.ohos_id_color_list_separator'));

            if (this.notes.length === 0) {
              Text(this.loading ? '' : I18n.t($r('app.string.question_empty_notes')))
                .fontSize(13).fontStyle(FontStyle.Italic)
                .fontColor($r('sys.color.ohos_id_color_text_tertiary'))
                .padding({ left: 16, right: 16, top: 16, bottom: 16 })
                .width('100%');
            } else {
              Column() {
                ForEach(this.notes, (n: QuestionNote) => {
                  this.NoteCard(n);
                }, (n: QuestionNote) => n.id);
              }.width('100%').padding({ left: 12, right: 12 });
            }
          }

          // Links section
          Text(`${I18n.t($r('app.string.question_links_header'))} (${this.totalLinks})`)
            .fontSize(14).fontWeight(FontWeight.Medium)
            .fontColor($r('sys.color.ohos_id_color_text_primary'))
            .padding({ left: 16, right: 16, top: 20, bottom: 8 });
          Divider().color($r('sys.color.ohos_id_color_list_separator'));

          if (this.totalLinks === 0) {
            Text(this.loading ? '' : I18n.t($r('app.string.question_empty_links')))
              .fontSize(13).fontStyle(FontStyle.Italic)
              .fontColor($r('sys.color.ohos_id_color_text_tertiary'))
              .padding({ left: 16, right: 16, top: 24, bottom: 24 })
              .textAlign(TextAlign.Center).width('100%');
          } else {
            // Horizontal inset lives here (padding), not on the cards — a card
            // with width('100%') + horizontal margin would overflow the right edge.
            Column() {
              ForEach(this.groups, (g: ResourceGroup) => {
                this.GroupCard(g);
              }, (g: ResourceGroup) => g.key);
            }.width('100%').padding({ left: 12, right: 12 });
            // Bottom breathing room below the last card.
            Row().height(16);
          }
        }.alignItems(HorizontalAlign.Start).width('100%');
      }
      .align(Alignment.Top).layoutWeight(1).width('100%');
    }
    .width('100%').height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'));
  }

  private showActions(): void {
    if (!this.question) return;
    const q = this.question;
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
    promptAction.showDialog({ title: q.title, buttons }).then((r) => {
      if (r.index === 0) this.gotoEdit();
      else if (r.index === 1) this.copyLink();
      else if (r.index === 2) this.toggleArchive();
      else if (r.index === 3) this.confirmDelete();
    }).catch((err: Error) => {
      hilog.warn(0x0000, 'shibei', 'detail action dialog dismissed: %{public}s', err.message);
    });
  }
}
