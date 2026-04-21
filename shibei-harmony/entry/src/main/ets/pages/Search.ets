import { hilog } from '@kit.PerformanceAnalysisKit';
import { router } from '@kit.ArkUI';
import { ShibeiService, ShibeiError, SearchResult } from '../services/ShibeiService';

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
      this.errorMessage = `搜索失败: ${code}`;
      hilog.error(0x0000, 'shibei', 'search fail: %{public}s', code);
      this.results = [];
    }
    this.searching = false;
  }

  private openResource(id: string): void {
    router.pushUrl({
      url: 'pages/Demo11ReaderStub',
      params: { resourceId: id },
    }).catch((err: Error) => {
      hilog.error(0x0000, 'shibei', 'pushUrl fail: %{public}s', err.message);
    });
  }

  private matchLabel(fields: string[]): string {
    if (fields.includes('body')) return '正文匹配';
    if (fields.includes('highlights')) return '标注匹配';
    if (fields.includes('comments')) return '评论匹配';
    if (fields.includes('title')) return '标题匹配';
    if (fields.includes('description')) return '摘要匹配';
    if (fields.includes('url')) return 'URL 匹配';
    return '';
  }

  build() {
    Column() {
      // TopBar: back arrow + search input + clear/cancel
      Row() {
        Text('‹').fontSize(26)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .width(44).height(44).textAlign(TextAlign.Center)
          .onClick(() => router.back());
        TextInput({ placeholder: '搜索资料、标注、正文…', text: this.query })
          .layoutWeight(1)
          .onChange((v: string) => this.onQueryChange(v));
        if (this.query) {
          Text('取消').fontSize(14)
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
          Text('输入关键字搜索').fontSize(14)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ top: 80 });
        }.width('100%').layoutWeight(1).alignItems(HorizontalAlign.Center);
      } else if (this.results.length === 0 && !this.searching) {
        Column() {
          Text('没有匹配项').fontSize(14)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ top: 80 });
        }.width('100%').layoutWeight(1).alignItems(HorizontalAlign.Center);
      } else {
        List() {
          ForEach(this.results, (r: SearchResult) => {
            ListItem() {
              Column() {
                Text(r.title || '(无标题)').fontSize(15).fontWeight(FontWeight.Medium)
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
                Text(this.matchLabel(r.match_fields)).fontSize(10)
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
