// Bottom sheet that lets the user link a target (resource / highlight /
// comment) to one or more active questions. Mirrors TagAssignSheet's
// open/resourceId @Link+@Prop pattern so parents own the open flag and can
// re-trigger a reload by flipping target between opens.
//
// On tap: toggles the link (idempotent server-side). On「+ 新建问题」: pops
// QuestionEdit and waits for the user to come back — the sync onDataChanged
// notification refreshes our list automatically.

import {
  ShibeiService,
  ShibeiError,
  Question,
  QuestionLink,
  QuestionTargetType,
} from '../services/ShibeiService';
import { QuestionService } from '../services/QuestionService';
import { I18n } from '../services/I18n';
import { promptAction, router } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';

// Press-feedback styles for tappable rows. ArkUI requires @Styles fns to be
// top-level (or members) so stateStyles can reference them; we keep them
// here to share between the question rows and the "+ 新建问题" entry.
@Styles function pressedRowStyle() {
  .backgroundColor($r('app.color.bg_secondary'))
}

@Styles function normalRowStyle() {
  .backgroundColor(Color.Transparent)
}

@Component
export struct QuestionLinkSheet {
  @Link @Watch('onOpenChanged') open: boolean;
  /** Re-bound by the parent before flipping `open` to true. */
  @Prop @Watch('onOpenChanged') targetType: QuestionTargetType;
  @Prop @Watch('onOpenChanged') targetId: string;

  @State active: Question[] = [];
  /** Pre-computed link id for each question_id that's already linked to
   *  this target — drives both the ✓ rendering and the unlink path. */
  @State linkedMap: Map<string, string> = new Map();
  @State linkedKey: string = '';

  private onOpenChanged(): void {
    if (this.open && this.targetId) {
      this.reload();
    }
  }

  aboutToAppear(): void {
    if (this.open && this.targetId) {
      this.reload();
    }
  }

  private reload(): void {
    try {
      this.active = ShibeiService.instance.listQuestions('active');
    } catch (_e) {
      this.active = [];
    }
    // Reverse-lookup: which active questions already reference this target.
    // Then, for each such question, find the alive link's id by scanning its
    // links — small N, acceptable cost on mobile.
    try {
      const referencing = ShibeiService.instance.listQuestionsForTarget(
        this.targetType,
        this.targetId,
      );
      const map = new Map<string, string>();
      for (const q of referencing) {
        const links = ShibeiService.instance.listQuestionLinks(q.id);
        const match = links.find(
          (l: QuestionLink) => l.target_type === this.targetType && l.target_id === this.targetId,
        );
        if (match) map.set(q.id, match.id);
      }
      this.linkedMap = map;
      this.linkedKey = Array.from(map.keys()).join(',');
    } catch (_e) {
      this.linkedMap = new Map();
      this.linkedKey = '';
    }
  }

  private toggle(q: Question): void {
    const existingLinkId = this.linkedMap.get(q.id);
    try {
      if (existingLinkId) {
        QuestionService.instance.unlinkQuestion(q.id, existingLinkId);
      } else {
        QuestionService.instance.linkToQuestion(q.id, this.targetType, this.targetId);
      }
      // Mirror desktop's LinkToQuestionSubMenu: any toggle dismisses the
      // sheet. The 1:1 link-one-question case is overwhelmingly the common
      // path; multi-link can be redone via another long-press in seconds.
      this.open = false;
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
      hilog.warn(0x0000, 'shibei', 'question link toggle fail: %{public}s', code);
      promptAction.showToast({ message: I18n.t($r('app.string.question_operation_failed')) });
    }
  }

  private gotoCreate(): void {
    // Closing the sheet first prevents ArkUI from stacking two modals.
    this.open = false;
    router.pushUrl({ url: 'pages/QuestionEdit' }).catch((err: Error) => {
      hilog.warn(0x0000, 'shibei', 'QuestionEdit push fail: %{public}s', err.message);
    });
  }

  @Builder
  QuestionRow(q: Question) {
    Row() {
      Circle({ width: 8, height: 8 })
        .fill($r('app.color.accent_primary'))
        .margin({ right: 10 });
      Text(q.title).fontSize(15)
        .fontColor($r('app.color.text_primary'))
        .layoutWeight(1)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis });
      // Read linkedKey so ArkUI tracks Map mutations.
      if (this.linkedKey.length >= 0 && this.linkedMap.has(q.id)) {
        Text('✓').fontSize(16).fontColor($r('app.color.accent_primary'));
      }
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 12, bottom: 12 })
    // Tap feedback: highlight the row while pressed so users see exactly
    // which option they're committing to (the sheet auto-dismisses on
    // release, so without this you can't tell which question you tapped).
    .stateStyles({
      pressed: pressedRowStyle,
      normal: normalRowStyle,
    })
    .onClick(() => this.toggle(q));
  }

  @Builder
  SheetContent() {
    Column() {
      Text(I18n.t($r('app.string.question_link_to')))
        .fontSize(17)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))
        .padding({ left: 16, right: 16, top: 16, bottom: 8 });
      Divider().color($r('app.color.border_divider'));
      if (this.active.length === 0) {
        Column() {
          Text(I18n.t($r('app.string.question_no_questions_to_link')))
            .fontSize(13)
            .fontColor($r('app.color.text_secondary'));
        }
        .padding(24)
        .width('100%')
        .alignItems(HorizontalAlign.Center);
      } else {
        List() {
          ForEach(this.active, (q: Question) => {
            ListItem() {
              this.QuestionRow(q);
            }
          }, (q: Question) => q.id);
        }
        .layoutWeight(1)
        .divider({
          strokeWidth: 0.5,
          color: $r('app.color.border_divider'),
          startMargin: 16,
          endMargin: 16,
        });
      }
      Divider().color($r('app.color.border_divider'));
      Row() {
        Text(I18n.t($r('app.string.question_create_inline')))
          .fontSize(14)
          .fontColor($r('app.color.accent_primary'));
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 12, bottom: 12 })
      .stateStyles({
        pressed: pressedRowStyle,
        normal: normalRowStyle,
      })
      .onClick(() => this.gotoCreate());
    }
    .width('100%')
    .height('100%');
  }

  build() {
    Stack().width(0).height(0)
      .bindSheet($$this.open, this.SheetContent(), {
        preferType: SheetType.BOTTOM,
        detents: [SheetSize.MEDIUM, SheetSize.LARGE],
        showClose: true,
        dragBar: true,
      });
  }
}
