import { Resource, Question } from '../services/ShibeiService';
import { I18n } from '../services/I18n';
import { QuestionService } from '../services/QuestionService';
import { router } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';

// Trims https?:// + trailing / from a URL for compact display.
function prettyHost(url: string): string {
  let u = url;
  if (u.startsWith('https://')) u = u.substring(8);
  else if (u.startsWith('http://')) u = u.substring(7);
  const slash = u.indexOf('/');
  if (slash >= 0) u = u.substring(0, slash);
  return u || url;
}

// yyyy-mm-dd from an ISO8601 string. Returns the raw value on parse failure
// so the UI still renders something.
function shortDate(iso: string): string {
  if (!iso || iso.length < 10) return iso;
  return iso.substring(0, 10);
}

@Component
export struct ResourceItem {
  // Caching-badge rendering is owned by ResourceList (via a Stack overlay);
  // this component stays cache-agnostic so its reactivity story is simple.
  @Prop resource: Resource;
  onTap?: (id: string) => void;
  onLongPress?: (id: string) => void;

  /** Reverse-lookup: questions that reference this resource. Loaded lazily
   *  per item; QuestionService caches results so scrolling stays cheap. */
  @State linkedQuestions: Question[] = [];
  private unsubscribeQuestions: (() => void) | null = null;

  aboutToAppear(): void {
    const svc = QuestionService.instance;
    const id = this.resource.id;
    // Seed from cache so we paint immediately if the same resource was
    // shown before, then refresh in the background.
    this.linkedQuestions = svc.getTargetQuestions('resource', id);
    this.unsubscribeQuestions = svc.subscribeTarget('resource', id, (qs: Question[]) => {
      this.linkedQuestions = qs;
    });
    svc.loadTargetQuestions('resource', id).catch((err: Error) => {
      hilog.warn(0x0000, 'shibei', 'ResourceItem loadTargetQuestions fail: %{public}s', err.message);
    });
  }

  aboutToDisappear(): void {
    if (this.unsubscribeQuestions) {
      this.unsubscribeQuestions();
      this.unsubscribeQuestions = null;
    }
  }

  private openQuestion(qId: string): void {
    router.pushUrl({
      url: 'pages/QuestionDetail',
      params: { id: qId },
    }).catch((err: Error) => {
      hilog.warn(0x0000, 'shibei', 'ResourceItem openQuestion fail: %{public}s', err.message);
    });
  }

  build() {
    Column() {
      Row() {
        Text(this.resource.title || I18n.t($r('app.string.common_no_title')))
          .fontSize(15)
          .fontWeight(FontWeight.Medium)
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1);
      }.width('100%');
      Row() {
        Text(prettyHost(this.resource.url))
          .fontSize(12).fontColor($r('app.color.text_secondary')).layoutWeight(1)
          .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis });
        Text(shortDate(this.resource.created_at))
          .fontSize(12).fontColor($r('app.color.text_subtle'));
      }.margin({ top: 4 }).width('100%');
      // Linked-questions chips. Only rendered when the resource is actually
      // attached to one or more questions, so resources outside any question
      // stay visually quiet. Up to 3 visible inline; the rest are summarized
      // as "+N" — tapping that chip opens the resource preview where the
      // (eventually-built) full chip list can live.
      if (this.linkedQuestions.length > 0) {
        Flex({ wrap: FlexWrap.Wrap }) {
          ForEach(this.linkedQuestions.slice(0, 3), (q: Question) => {
            this.QuestionChip(q);
          }, (q: Question) => q.id);
          if (this.linkedQuestions.length > 3) {
            Text(`+${this.linkedQuestions.length - 3}`)
              .fontSize(11)
              .fontColor($r('app.color.text_subtle'))
              .padding({ left: 6, right: 6, top: 2, bottom: 2 })
              .margin({ top: 4, right: 4 });
          }
        }
        .width('100%')
        .margin({ top: 6 });
      }
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%')
    .padding({ left: 16, right: 16, top: 12, bottom: 12 })
    .onClick(() => { if (this.onTap) this.onTap(this.resource.id); })
    .gesture(
      LongPressGesture({ repeat: false, duration: 500 })
        .onAction(() => { if (this.onLongPress) this.onLongPress(this.resource.id); })
    );
  }

  @Builder QuestionChip(q: Question) {
    Row() {
      Circle({ width: 5, height: 5 })
        .fill(q.status === 'archived'
          ? $r('app.color.text_subtle')
          : $r('app.color.accent_primary'))
        .margin({ right: 4 });
      Text(q.title)
        .fontSize(11)
        .fontColor(q.status === 'archived'
          ? $r('app.color.text_subtle')
          : $r('app.color.text_secondary'))
        .fontStyle(q.status === 'archived' ? FontStyle.Italic : FontStyle.Normal)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .constraintSize({ maxWidth: 140 });
    }
    .padding({ left: 6, right: 8, top: 2, bottom: 2 })
    .margin({ top: 4, right: 6 })
    .borderRadius(10)
    .border({ width: 0.5, color: $r('app.color.border_divider') })
    .backgroundColor($r('app.color.bg_secondary'))
    .onClick(() => this.openQuestion(q.id));
  }
}
