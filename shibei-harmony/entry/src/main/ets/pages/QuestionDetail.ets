// Question detail page (Phase H4). Shows the question's metadata + all
// alive links grouped by target type. Tapping a resource link routes to
// Reader; tapping a highlight / comment link does the same (and the
// highlight id is passed so the reader scrolls to it).

import { router, promptAction } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { pasteboard } from '@kit.BasicServicesKit';
import {
  ShibeiService,
  ShibeiError,
  Question,
  QuestionLink,
  QuestionTargetType,
  Resource,
  Highlight,
  Comment,
} from '../services/ShibeiService';
import { QuestionService } from '../services/QuestionService';
import { I18n } from '../services/I18n';
import { MarkdownText } from '../components/MarkdownText';

interface QuestionDetailParams {
  id: string;
}

interface ResolvedLink {
  link: QuestionLink;
  resourceTitle: string | null;
  /** When the link targets a highlight / comment, snippet shown below the title. */
  snippet: string | null;
  /** highlight id to pass when opening Reader so it scrolls there. */
  highlightId: string | null;
  /** resource id used to navigate. */
  resourceId: string | null;
}

@Entry
@Component
struct QuestionDetail {
  @State question: Question | null = null;
  @State links: QuestionLink[] = [];
  @State resolved: Map<string, ResolvedLink> = new Map();
  @State loading: boolean = true;
  @State error: string = '';
  private questionId: string = '';
  private unsubLinks?: () => void;
  private unsubList?: () => void;

  aboutToAppear(): void {
    const params = router.getParams() as QuestionDetailParams;
    if (!params || !params.id) {
      this.error = 'missing question id';
      this.loading = false;
      return;
    }
    this.questionId = params.id;
    this.loadAll();
    this.unsubLinks = QuestionService.instance.subscribeLinks(
      this.questionId,
      (links: QuestionLink[]) => {
        this.links = links;
        this.resolveAll();
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
  }

  onPageShow(): void {
    this.loadAll();
  }

  aboutToDisappear(): void {
    if (this.unsubLinks) this.unsubLinks();
    if (this.unsubList) this.unsubList();
  }

  private async loadAll(): Promise<void> {
    if (!this.questionId) return;
    try {
      this.loading = true;
      this.question = ShibeiService.instance.getQuestion(this.questionId);
      const links = await QuestionService.instance.loadLinks(this.questionId);
      this.links = links;
      await this.resolveAll();
      this.error = '';
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
      this.error = code;
      hilog.error(0x0000, 'shibei', 'QuestionDetail load fail: %{public}s', code);
    } finally {
      this.loading = false;
    }
  }

  /** Walk every link and resolve the target row so the UI can show a real
   *  title / snippet. Failures collapse to a "(source unavailable)" line. */
  private async resolveAll(): Promise<void> {
    const next = new Map<string, ResolvedLink>();
    for (const link of this.links) {
      next.set(link.id, this.resolveOne(link));
    }
    this.resolved = next;
  }

  private resolveOne(link: QuestionLink): ResolvedLink {
    try {
      if (link.target_type === 'resource') {
        const r: Resource = ShibeiService.instance.getResource(link.target_id);
        return {
          link,
          resourceTitle: r.title,
          snippet: null,
          highlightId: null,
          resourceId: r.id,
        };
      }
      if (link.target_type === 'highlight') {
        // No standalone getHighlight on mobile (yet); look it up via the
        // resource's annotations. We don't know the resource_id ahead of
        // time, so we walk question-target reverse-lookups via the link's
        // own target_id by scanning resources lazily. For Phase 1 we
        // accept the limitation and show the link with no snippet — the
        // user can still tap to open the parent resource via question
        // detail's reverse pathway. As a fallback we read the highlight
        // from the DB by searching its parent.
        // Cheaper fallback: use ShibeiService.listAnnotations on each
        // candidate resource is O(N); instead, just attempt to resolve
        // via list_annotations once we know the resource. Since we don't
        // know it, we surface the link id and let the user navigate.
        return this.resolveHighlightFallback(link);
      }
      if (link.target_type === 'comment') {
        return this.resolveCommentFallback(link);
      }
    } catch {
      // fall through
    }
    return {
      link,
      resourceTitle: null,
      snippet: null,
      highlightId: null,
      resourceId: null,
    };
  }

  /** Walk every alive resource to find which one owns this highlight.
   *  Mobile datasets are small enough that an O(N) scan is acceptable; if
   *  it gets slow we can add a dedicated NAPI command later. */
  private resolveHighlightFallback(link: QuestionLink): ResolvedLink {
    try {
      // Use listResources on __all__ then check annotations per resource.
      // Optimized: only check resources whose annotation set contains the
      // target highlight id. We bail at the first match.
      const resources = ShibeiService.instance.listResources('__all__');
      for (const r of resources) {
        const bundle = ShibeiService.instance.listAnnotations(r.id);
        const hl: Highlight | undefined = bundle.highlights.find(
          (h: Highlight) => h.id === link.target_id,
        );
        if (hl) {
          return {
            link,
            resourceTitle: r.title,
            snippet: hl.text_content,
            highlightId: hl.id,
            resourceId: r.id,
          };
        }
      }
    } catch {
      // ignore
    }
    return {
      link,
      resourceTitle: null,
      snippet: null,
      highlightId: null,
      resourceId: null,
    };
  }

  private resolveCommentFallback(link: QuestionLink): ResolvedLink {
    try {
      const resources = ShibeiService.instance.listResources('__all__');
      for (const r of resources) {
        const bundle = ShibeiService.instance.listAnnotations(r.id);
        const cm: Comment | undefined = bundle.comments.find(
          (c: Comment) => c.id === link.target_id,
        );
        if (cm) {
          return {
            link,
            resourceTitle: r.title,
            snippet: cm.content,
            highlightId: cm.highlight_id,
            resourceId: r.id,
          };
        }
      }
    } catch {
      // ignore
    }
    return {
      link,
      resourceTitle: null,
      snippet: null,
      highlightId: null,
      resourceId: null,
    };
  }

  private openLink(r: ResolvedLink): void {
    if (!r.resourceId) {
      promptAction.showToast({ message: I18n.t($r('app.string.question_unknown_target')) });
      return;
    }
    interface ReaderParams {
      resourceId: string;
      highlightId?: string;
    }
    const params: ReaderParams = { resourceId: r.resourceId };
    if (r.highlightId) params.highlightId = r.highlightId;
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
    const linkCount = this.links.length;
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

  @Builder
  TargetGroup(targetType: QuestionTargetType, label: string) {
    const group = this.links.filter((l: QuestionLink) => l.target_type === targetType);
    if (group.length === 0) return;
    Column() {
      Text(`${label} (${group.length})`).fontSize(12)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .fontWeight(FontWeight.Medium)
        .padding({ left: 16, right: 16, top: 12, bottom: 6 });
      ForEach(group, (link: QuestionLink) => {
        this.LinkRow(link);
      }, (link: QuestionLink) => link.id);
    }.alignItems(HorizontalAlign.Start).width('100%');
  }

  @Builder
  LinkRow(link: QuestionLink) {
    const r = this.resolved.get(link.id);
    Row() {
      Column() {
        if (r && r.resourceTitle) {
          Text(r.resourceTitle).fontSize(14)
            .fontColor($r('sys.color.ohos_id_color_text_primary'))
            .maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis });
        } else {
          Text(I18n.t($r('app.string.question_unknown_target')))
            .fontSize(14).fontStyle(FontStyle.Italic)
            .fontColor($r('sys.color.ohos_id_color_text_tertiary'));
        }
        if (r && r.snippet) {
          Text(r.snippet).fontSize(12)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis })
            .padding({ top: 4, bottom: 4, left: 6, right: 6 })
            .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
            .borderRadius(4)
            .margin({ top: 4 });
        }
        if (link.reason) {
          Text(link.reason).fontSize(12)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .maxLines(3).textOverflow({ overflow: TextOverflow.Ellipsis })
            .margin({ top: 4 });
        }
      }.alignItems(HorizontalAlign.Start).layoutWeight(1);
      Text('×').fontSize(18)
        .fontColor($r('sys.color.ohos_id_color_text_tertiary'))
        .width(32).height(32).textAlign(TextAlign.Center)
        .onClick(() => this.confirmUnlink(link));
    }
    .width('100%').padding({ left: 16, right: 8, top: 10, bottom: 10 })
    .onClick(() => {
      const cur = this.resolved.get(link.id);
      if (cur) this.openLink(cur);
    });
    Divider().color($r('sys.color.ohos_id_color_list_separator'));
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

          // Links section
          Text(`${I18n.t($r('app.string.question_links_header'))} (${this.links.length})`)
            .fontSize(14).fontWeight(FontWeight.Medium)
            .fontColor($r('sys.color.ohos_id_color_text_primary'))
            .padding({ left: 16, right: 16, top: 20, bottom: 8 });
          Divider().color($r('sys.color.ohos_id_color_list_separator'));

          if (this.links.length === 0) {
            Text(this.loading ? '' : I18n.t($r('app.string.question_empty_links')))
              .fontSize(13).fontStyle(FontStyle.Italic)
              .fontColor($r('sys.color.ohos_id_color_text_tertiary'))
              .padding({ left: 16, right: 16, top: 24, bottom: 24 })
              .textAlign(TextAlign.Center).width('100%');
          } else {
            this.TargetGroup('resource', I18n.t($r('app.string.question_links_resource')));
            this.TargetGroup('highlight', I18n.t($r('app.string.question_links_highlight')));
            this.TargetGroup('comment', I18n.t($r('app.string.question_links_comment')));
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
