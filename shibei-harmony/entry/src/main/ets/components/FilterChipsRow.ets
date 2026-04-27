import { ShibeiService, TagWithCount } from '../services/ShibeiService';
import { I18n } from '../services/I18n';
import { promptAction } from '@kit.ArkUI';

@Component
export struct FilterChipsRow {
  @Link filterTagIds: string[];
  @Prop folderId: string;
  @State allTags: TagWithCount[] = [];
  @State showSheet: boolean = false;
  @State searchText: string = '';
  @State manageMode: boolean = false;
  @State newTagName: string = '';

  aboutToAppear(): void {
    this.loadTags();
  }

  private loadTags(): void {
    try {
      this.allTags = ShibeiService.instance.listTagsInFolder(this.folderId);
    } catch (_e) {
      this.allTags = [];
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

  private async doCreateTag(): Promise<void> {
    const name = this.newTagName.trim();
    if (!name) return;
    try {
      ShibeiService.instance.createTag(name, '#888888');
      this.newTagName = '';
      this.loadTags();
    } catch (_e) {
      /* ignore */
    }
  }

  private async doDeleteTag(tagId: string, tagName: string): Promise<void> {
    promptAction.showDialog({
      title: I18n.t($r('app.string.sidebar_delete_tag')),
      message: I18n.t($r('app.string.sidebar_delete_tag_confirm'), tagName),
      buttons: [
        { text: I18n.t($r('app.string.common_cancel')), color: $r('app.color.text_secondary') },
        { text: I18n.t($r('app.string.common_delete')), color: $r('app.color.accent_danger') },
      ],
    }).then((result) => {
      if (result.index === 1) {
        try {
          ShibeiService.instance.deleteTag(tagId);
          this.loadTags();
        } catch (_e) {
          /* ignore */
        }
      }
    });
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
              if (this.manageMode) {
                Text('  ×').fontSize(14).fontColor($r('app.color.accent_danger'))
                  .onClick(() => { this.doDeleteTag(tag.id, tag.name); });
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

      // Management bar: toggle manage mode + create
      Row() {
        if (this.manageMode) {
          TextInput({ placeholder: I18n.t($r('app.string.sidebar_tag_name')) })
            .height(32)
            .layoutWeight(1)
            .onChange((v: string) => { this.newTagName = v; });
          Button(I18n.t($r('app.string.sidebar_tag_save')))
            .height(32)
            .fontSize(12)
            .onClick(() => { this.doCreateTag(); });
        }
        Button(this.manageMode
          ? I18n.t($r('app.string.common_done'))
          : I18n.t($r('app.string.sidebar_manage_tags')))
          .fontSize(12)
          .height(32)
          .type(ButtonType.Normal)
          .onClick(() => {
            this.manageMode = !this.manageMode;
            this.newTagName = '';
          });
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 8, bottom: 8 })
      .justifyContent(FlexAlign.End);
    }.width('100%');
  }

  build() {
    Row() {
      Row() {
        Text(`+`).fontSize(14).fontWeight(FontWeight.Bold);
      }
      .padding({ left: 8, right: 8, top: 2, bottom: 2 })
      .backgroundColor($r('app.color.bg_secondary'))
      .borderRadius(4)
      .border({ width: 1, color: $r('app.color.border_divider') })
      .margin({ right: 6 })
      .onClick(() => {
        this.loadTags();
        this.searchText = '';
        this.showSheet = true;
      });

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
    .padding({ left: 12, right: 12 })
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
