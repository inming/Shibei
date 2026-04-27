import { ShibeiService, ShibeiError, Tag } from '../services/ShibeiService';
import { I18n } from '../services/I18n';
import { promptAction } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';

@Component
export struct TagAssignSheet {
  // Two-way bound from parent (ResourceList): the parent owns the open flag
  // so the long-press menu can flip it on. Closing from inside this sheet
  // (drag-down / scrim) writes false back via the bound link. @Watch is
  // load-bearing — `aboutToAppear` only fires once because the host Stack
  // stays mounted; without the watch the sheet shows stale data on its
  // second open (e.g. count=0 when a tag was assigned in a prior session).
  @Link @Watch('onOpenChanged') open: boolean;
  // Set by the parent right before flipping `open` to true. We re-read tags
  // and current assignments every time `open` flips on so stale data from a
  // previous sheet session doesn't carry over.
  @Prop @Watch('onOpenChanged') resourceId: string;
  @State allTags: Tag[] = [];
  @State assignedIds: Set<string> = new Set<string>();
  @State assignedKey: string = '';
  // Fired when the user taps the「管理标签…」footer. Parent (ResourceList)
  // closes this sheet and opens TagManageSheet — mirrors desktop's
  // TagSubMenu → FilterManagePanel handoff.
  onOpenManage?: () => void;

  private onOpenChanged(): void {
    if (this.open && this.resourceId) {
      this.reload();
    }
  }

  aboutToAppear(): void {
    if (this.open && this.resourceId) {
      this.reload();
    }
  }

  // Refresh tag list + currently-assigned set. Cheap (synchronous NAPI),
  // called on sheet-open and after every mutation so the checkmarks stay
  // in lockstep with the DB.
  private reload(): void {
    try {
      this.allTags = ShibeiService.instance.listTags();
    } catch (_e) {
      this.allTags = [];
    }
    try {
      const assigned = ShibeiService.instance.getTagsForResource(this.resourceId);
      const next = new Set<string>();
      for (let i = 0; i < assigned.length; i++) next.add(assigned[i].id);
      this.assignedIds = next;
      this.assignedKey = assigned.map((t) => t.id).join(',');
    } catch (_e) {
      this.assignedIds = new Set<string>();
      this.assignedKey = '';
    }
  }

  private toggle(tagId: string): void {
    const isAssigned = this.assignedIds.has(tagId);
    try {
      if (isAssigned) {
        ShibeiService.instance.removeTagFromResource(this.resourceId, tagId);
      } else {
        ShibeiService.instance.addTagToResource(this.resourceId, tagId);
      }
      this.reload();
    } catch (err) {
      const code = err instanceof ShibeiError ? err.code : (err as Error).message;
      hilog.warn(0x0000, 'shibei', 'tag toggle fail: %{public}s', code);
      promptAction.showToast({ message: I18n.t($r('app.string.tag_assign_failed')) });
    }
  }

  @Builder
  TagRow(tag: Tag) {
    Row() {
      Circle({ width: 12, height: 12 })
        .fill(tag.color)
        .margin({ right: 10 });
      Text(tag.name)
        .fontSize(15)
        .fontColor($r('app.color.text_primary'))
        .layoutWeight(1);
      // Read assignedKey so ArkUI tracks Set mutations (the Set itself is
      // a plain field — same trick as ResourceList.cachedKey).
      if (this.assignedKey.length >= 0 && this.assignedIds.has(tag.id)) {
        Text('✓').fontSize(16).fontColor($r('app.color.accent_primary'));
      }
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 12, bottom: 12 })
    .onClick(() => this.toggle(tag.id));
  }

  @Builder
  SheetContent() {
    Column() {
      Text(I18n.t($r('app.string.tag_assign_title')))
        .fontSize(17)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))
        .padding({ left: 16, right: 16, top: 16, bottom: 8 });
      Divider().color($r('app.color.border_divider'));
      if (this.allTags.length === 0) {
        Column() {
          Text(I18n.t($r('app.string.tag_no_tags_hint')))
            .fontSize(13)
            .fontColor($r('app.color.text_secondary'));
        }
        .padding(24)
        .width('100%')
        .alignItems(HorizontalAlign.Center);
      } else {
        List() {
          ForEach(this.allTags, (tag: Tag) => {
            ListItem() {
              this.TagRow(tag);
            }
          }, (tag: Tag) => tag.id);
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
      // Hand-off to manage sheet — desktop has the same entry at the bottom
      // of TagSubMenu. Parent owns the open-flag dance so the sheet
      // transition can be coordinated (assign closes → manage opens).
      Row() {
        Text(I18n.t($r('app.string.manage_tags_entry')))
          .fontSize(14)
          .fontColor($r('app.color.accent_primary'));
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 12, bottom: 12 })
      .onClick(() => {
        if (this.onOpenManage) this.onOpenManage();
      });
    }
    .width('100%')
    .height('100%');
  }

  build() {
    // Zero-size host: the sheet is a universal modifier on this Stack and
    // the parent only mounts TagAssignSheet to drive the sheet — the
    // component itself draws nothing in the layout flow.
    Stack().width(0).height(0)
      .bindSheet($$this.open, this.SheetContent(), {
        preferType: SheetType.BOTTOM,
        detents: [SheetSize.MEDIUM, SheetSize.LARGE],
        showClose: true,
        dragBar: true,
      });
  }
}
