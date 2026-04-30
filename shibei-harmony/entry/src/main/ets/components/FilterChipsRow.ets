import { ShibeiService, TagWithCount } from '../services/ShibeiService';
import { I18n } from '../services/I18n';

@Component
export struct FilterChipsRow {
  @Link filterTagIds: string[];
  @Prop folderId: string;
  @Link @Watch('onSheetOpenChange') showSheet: boolean;
  @State allTags: TagWithCount[] = [];
  @State searchText: string = '';
  private unsubDataChanged?: () => void;

  aboutToAppear(): void {
    this.loadTags();
    this.unsubDataChanged = ShibeiService.instance.onDataChanged(() => this.loadTags());
  }

  aboutToDisappear(): void {
    if (this.unsubDataChanged) {
      this.unsubDataChanged();
      this.unsubDataChanged = undefined;
    }
  }

  private loadTags(): void {
    try {
      this.allTags = ShibeiService.instance.listTagsInFolder(this.folderId);
    } catch (_e) {
      this.allTags = [];
    }
  }

  private onSheetOpenChange(): void {
    if (this.showSheet) {
      this.loadTags();
      this.searchText = '';
    }
  }

  private selectedTags(): TagWithCount[] {
    const ids = this.filterTagIds;
    const result: TagWithCount[] = [];
    for (let i = 0; i < this.allTags.length; i++) {
      if (ids.indexOf(this.allTags[i].id) !== -1) {
        result.push(this.allTags[i]);
      }
    }
    return result;
  }

  private toggleTag(tagId: string): void {
    const idx = this.filterTagIds.indexOf(tagId);
    if (idx === -1) {
      this.filterTagIds = [...this.filterTagIds, tagId];
    } else {
      const next = [...this.filterTagIds];
      next.splice(idx, 1);
      this.filterTagIds = next;
    }
  }

  private filteredTags(): TagWithCount[] {
    if (!this.searchText) {
      return this.allTags;
    }
    const q = this.searchText.toLowerCase();
    return this.allTags.filter((t) => t.name.toLowerCase().indexOf(q) !== -1);
  }

  @Builder
  TagSheet() {
    Column() {
      if (this.allTags.length > 8) {
        TextInput({ placeholder: I18n.t($r('app.string.sidebar_search_tags')) })
          .width('100%')
          .onChange((v: string) => { this.searchText = v; })
          .margin({ bottom: 8 });
      }
      List() {
        ForEach(this.filteredTags(), (tag: TagWithCount) => {
          ListItem() {
            Row() {
              Circle({ width: 12, height: 12 })
                .fill(tag.color)
                .margin({ right: 8 });
              Text(tag.name)
                .fontSize(14)
                .layoutWeight(1);
              Text(`${tag.count}`)
                .fontSize(12)
                .fontColor($r('app.color.text_secondary'));
              if (this.filterTagIds.indexOf(tag.id) !== -1) {
                Text(' ✓').fontColor($r('app.color.accent_primary'));
              }
            }
            .width('100%')
            .padding({ left: 16, right: 16, top: 10, bottom: 10 })
            .onClick(() => { this.toggleTag(tag.id); });
          }
        });
      }
      if (this.filteredTags().length === 0) {
        Text(I18n.t($r('app.string.sidebar_no_tags')))
          .fontSize(13)
          .fontColor($r('app.color.text_secondary'))
          .padding(16);
      }
    }.width('100%');
  }

  build() {
    // Empty state: render a zero-size anchor that still owns the bindSheet,
    // so opening the sheet from TopBar works without occupying a row.
    if (this.filterTagIds.length === 0) {
      Row()
        .width(0).height(0)
        .bindSheet($$this.showSheet, this.TagSheet(), {
          preferType: SheetType.BOTTOM,
          detents: [SheetSize.MEDIUM, SheetSize.LARGE],
          showClose: true,
          dragBar: true,
          title: { title: I18n.t($r('app.string.sidebar_filter_tags')) },
        });
    } else {
      Row() {
        ForEach(this.selectedTags(), (tag: TagWithCount) => {
          Row() {
            Circle({ width: 8, height: 8 }).fill(tag.color).margin({ right: 4 });
            Text(tag.name).fontSize(12);
            Text(' ×').fontSize(12).fontColor($r('app.color.text_secondary'))
              .onClick(() => { this.toggleTag(tag.id); });
          }
          .padding({ left: 6, right: 6, top: 2, bottom: 2 })
          .borderRadius(12)
          .border({ width: 1, color: $r('app.color.border_divider') })
          .margin({ right: 4 });
        });
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 4, bottom: 4 })
      .justifyContent(FlexAlign.Start)
      .alignItems(VerticalAlign.Center)
      .bindSheet($$this.showSheet, this.TagSheet(), {
        preferType: SheetType.BOTTOM,
        detents: [SheetSize.MEDIUM, SheetSize.LARGE],
        showClose: true,
        dragBar: true,
        title: { title: I18n.t($r('app.string.sidebar_filter_tags')) },
      });
    }
  }
}
