import { hilog } from '@kit.PerformanceAnalysisKit';
import { router } from '@kit.ArkUI';
import { ShibeiService, ShibeiError, SearchResult } from '../services/ShibeiService';
import { I18n } from '../services/I18n';

// Track E — full-text search over resources (title / url / description /
// highlights / comments / body). Runs against the local FTS5 virtual
// table via the searchResources NAPI command. 300ms debounce on typing.
//
// Phase 2 skips tag filters + sort controls (desktop has both); mobile
// gets the bare list.

// `Search` is a built-in ArkTS component name — using it for the struct
// trips the compiler (`reserved tag name`). The file path / route can
// still be `pages/Search`; only the @Entry identifier needs to differ.
@Entry
@Component
struct SearchPage {
  @State query: string = '';
  @State results: SearchResult[] = [];
  @State searching: boolean = false;
  @State errorMessage: string = '';

  private debounceTimer: number = -1;

  aboutToDisappear(): void {
    if (this.debounceTimer >= 0) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = -1;
    }
  }

  private onQueryChange(v: string): void {
    this.query = v;
    // Cancel any pending lookup, schedule a new one 300ms out.
    if (this.debounceTimer >= 0) {
      clearTimeout(this.debounceTimer);
    }
    if (!v.trim()) {
      this.results = [];
      this.errorMessage = '';
      this.debounceTimer = -1;
      return;
    }
    this.debounceTimer = setTimeout(() => {
      this.runSearch();
      this.debounceTimer = -1;
    }, 300);
  }

  private runSearch(): void {
    this.searching = true;
    this.errorMessage = '';
    try {
      this.results = ShibeiService.instance.searchResources(this.query.trim());
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : err.message;
      this.errorMessage = I18n.t($r('app.string.search_failed'), I18n.translateError(code));
      hilog.error(0x0000, 'shibei', 'search fail: %{public}s', code);
      this.results = [];
    }
    this.searching = false;
  }

  private openResource(id: string): void {
    router.pushUrl({
      url: 'pages/Reader',
      params: { resourceId: id },
    }).catch((err: Error) => {
      hilog.error(0x0000, 'shibei', 'pushUrl fail: %{public}s', err.message);
    });
  }

  // Render every matched field, not just the first. Ordering puts the
  // "more specific" matches (highlights / comments / title) ahead of body,
  // because body almost always matches any query the user types and would
  // otherwise hide the signal that e.g. an annotation also matched.
  // Capped at 3 labels to keep the row short on narrow screens.
  private matchLabel(fields: string[]): string {
    if (!fields || fields.length === 0) return '';
    interface FieldPair { key: string; label: string; }
    const order: FieldPair[] = [
      { key: 'highlights', label: I18n.t($r('app.string.search_match_label_highlights')) },
      { key: 'comments',   label: I18n.t($r('app.string.search_match_label_comments')) },
      { key: 'title',      label: I18n.t($r('app.string.search_match_label_title')) },
      { key: 'description',label: I18n.t($r('app.string.search_match_label_description')) },
      { key: 'url',        label: 'URL' },
      { key: 'body',       label: I18n.t($r('app.string.search_match_label_body')) },
    ];
    const hits: string[] = [];
    for (const pair of order) {
      if (fields.includes(pair.key)) hits.push(pair.label);
    }
    if (hits.length === 0) return '';
    const shown = hits.length > 3 ? hits.slice(0, 3) : hits;
    return I18n.t($r('app.string.search_match_suffix'), shown.join(' · '));
  }

  build() {
    Column() {
      // TopBar: back arrow + search input + clear/cancel
      Row() {
        Text('‹').fontSize(26)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .width(44).height(44).textAlign(TextAlign.Center)
          .onClick(() => router.back());
        TextInput({
          placeholder: I18n.t($r('app.string.search_placeholder')),
          text: this.query,
        })
          .layoutWeight(1)
          .onChange((v: string) => this.onQueryChange(v));
        if (this.query) {
          Text(I18n.t($r('app.string.common_cancel'))).fontSize(14)
            .fontColor($r('sys.color.ohos_id_color_emphasize'))
            .width(50).height(44).textAlign(TextAlign.Center)
            .onClick(() => {
              this.query = '';
              this.results = [];
            });
        }
      }
      .width('100%').padding({ left: 4, right: 8, top: 4, bottom: 4 })
      .backgroundColor($r('sys.color.ohos_id_color_background'));

      if (this.errorMessage) {
        Text(this.errorMessage).fontSize(12)
          .fontColor($r('sys.color.ohos_id_color_warning'))
          .margin({ left: 16, right: 16, top: 12 });
      }

      if (!this.query.trim()) {
        Column() {
          Text(I18n.t($r('app.string.search_empty_prompt'))).fontSize(14)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ top: 80 });
        }.width('100%').layoutWeight(1).alignItems(HorizontalAlign.Center);
      } else if (this.results.length === 0 && !this.searching) {
        Column() {
          Text(I18n.t($r('app.string.search_no_match'))).fontSize(14)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ top: 80 });
        }.width('100%').layoutWeight(1).alignItems(HorizontalAlign.Center);
      } else {
        List() {
          ForEach(this.results, (r: SearchResult) => {
            ListItem() {
              Column() {
                Text(r.title || I18n.t($r('app.string.common_no_title')))
                  .fontSize(15).fontWeight(FontWeight.Medium)
                  .fontColor($r('sys.color.ohos_id_color_text_primary'))
                  .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis });
                Text(r.url).fontSize(11)
                  .fontColor($r('sys.color.ohos_id_color_text_tertiary'))
                  .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
                  .margin({ top: 2 });
                if (r.snippet) {
                  Text(r.snippet).fontSize(12)
                    .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                    .maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis })
                    .margin({ top: 4 });
                }
                Text(this.matchLabel(r.matchFields)).fontSize(10)
                  .fontColor($r('sys.color.ohos_id_color_emphasize'))
                  .margin({ top: 4 });
              }
              .width('100%').alignItems(HorizontalAlign.Start)
              .padding({ left: 16, right: 16, top: 10, bottom: 10 })
              .onClick(() => this.openResource(r.id));
            }
          }, (r: SearchResult) => r.id);
        }
        .width('100%').layoutWeight(1)
        .divider({ strokeWidth: 0.5, color: $r('sys.color.ohos_id_color_list_separator') });
      }
    }
    .width('100%').height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'));
  }
}
