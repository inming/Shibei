import { ShibeiService, ShibeiError, Tag, TagWithCount } from '../services/ShibeiService';
import { I18n } from '../services/I18n';
import { promptAction } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';

const TAG_PALETTE: string[] = [
  '#EF4444', '#F97316', '#EAB308', '#22C55E',
  '#14B8A6', '#3B82F6', '#8B5CF6', '#EC4899',
];

interface TagRowVM {
  id: string;
  name: string;
  color: string;
  count: number;
}

@Component
export struct TagManageSheet {
  // @Watch is load-bearing — host Stack stays mounted across open/close
  // cycles, so `aboutToAppear` only fires the first time. Without the watch,
  // counts and edit state would freeze at the values from the first open.
  @Link @Watch('onOpenChanged') open: boolean;
  @State rows: TagRowVM[] = [];
  // Inline create form (top of sheet).
  @State createOpen: boolean = false;
  @State newName: string = '';
  @State newColor: string = TAG_PALETTE[5];
  // Inline edit state — only one tag is editable at a time.
  @State editingId: string = '';
  @State editName: string = '';
  @State editColor: string = TAG_PALETTE[5];

  private onOpenChanged(): void {
    if (this.open) {
      this.reload();
      // Reset transient form state from a prior session — otherwise the
      // sheet pops back open mid-edit on the row the user touched last.
      this.createOpen = false;
      this.newName = '';
      this.newColor = TAG_PALETTE[5];
      this.editingId = '';
      this.editName = '';
      this.editColor = TAG_PALETTE[5];
    }
  }

  aboutToAppear(): void {
    if (this.open) this.reload();
  }

  // Pull both lists: list_tags gives names+colors and the canonical order;
  // list_tags_in_folder(null) gives counts across the full library. We
  // merge them so zero-count tags still show up — same shape as desktop's
  // FilterManagePanel.
  private reload(): void {
    try {
      const allTags = ShibeiService.instance.listTags();
      let counts: TagWithCount[] = [];
      try {
        counts = ShibeiService.instance.listTagsInFolder('');
      } catch (_e) {
        counts = [];
      }
      const countMap = new Map<string, number>();
      for (let i = 0; i < counts.length; i++) {
        countMap.set(counts[i].id, counts[i].count);
      }
      const next: TagRowVM[] = [];
      for (let i = 0; i < allTags.length; i++) {
        const t = allTags[i];
        next.push({
          id: t.id,
          name: t.name,
          color: t.color,
          count: countMap.get(t.id) ?? 0,
        });
      }
      this.rows = next;
    } catch (_e) {
      this.rows = [];
    }
  }

  private create(): void {
    const name = this.newName.trim();
    if (!name) return;
    try {
      ShibeiService.instance.createTag(name, this.newColor);
      this.newName = '';
      this.newColor = TAG_PALETTE[5];
      this.createOpen = false;
      this.reload();
    } catch (err) {
      const code = err instanceof ShibeiError ? err.code : (err as Error).message;
      hilog.warn(0x0000, 'shibei', 'tag create fail: %{public}s', code);
      promptAction.showToast({ message: I18n.t($r('app.string.tag_create_failed')) });
    }
  }

  private startEdit(row: TagRowVM): void {
    this.editingId = row.id;
    this.editName = row.name;
    this.editColor = row.color;
  }

  private saveEdit(): void {
    const name = this.editName.trim();
    if (!name || !this.editingId) return;
    try {
      ShibeiService.instance.updateTag(this.editingId, name, this.editColor);
      this.editingId = '';
      this.editName = '';
      this.reload();
    } catch (err) {
      const code = err instanceof ShibeiError ? err.code : (err as Error).message;
      hilog.warn(0x0000, 'shibei', 'tag update fail: %{public}s', code);
      promptAction.showToast({ message: I18n.t($r('app.string.tag_update_failed')) });
    }
  }

  private confirmDelete(row: TagRowVM): void {
    promptAction.showDialog({
      title: I18n.t($r('app.string.sidebar_delete_tag')),
      message: I18n.t($r('app.string.sidebar_delete_tag_confirm'), row.name),
      buttons: [
        { text: I18n.t($r('app.string.common_cancel')), color: $r('app.color.text_secondary') },
        { text: I18n.t($r('app.string.common_delete')), color: $r('app.color.accent_danger') },
      ],
    }).then((r) => {
      if (r.index === 1) this.doDelete(row);
    }).catch((_e: Error) => { /* dialog dismissed */ });
  }

  private doDelete(row: TagRowVM): void {
    try {
      ShibeiService.instance.deleteTag(row.id);
      if (this.editingId === row.id) {
        this.editingId = '';
        this.editName = '';
      }
      this.reload();
    } catch (err) {
      const code = err instanceof ShibeiError ? err.code : (err as Error).message;
      hilog.warn(0x0000, 'shibei', 'tag delete fail: %{public}s', code);
      promptAction.showToast({ message: I18n.t($r('app.string.tag_delete_failed')) });
    }
  }

  @Builder
  ColorPicker(selected: string, onPick: (c: string) => void) {
    Row() {
      ForEach(TAG_PALETTE, (c: string) => {
        Stack() {
          Circle({ width: 22, height: 22 }).fill(c);
          if (c === selected) {
            Circle({ width: 28, height: 28 })
              .fill(Color.Transparent)
              .stroke($r('app.color.text_primary'))
              .strokeWidth(2);
          }
        }
        .margin({ right: 8 })
        .onClick(() => onPick(c));
      });
    }
    .margin({ top: 8, bottom: 8 })
    .width('100%');
  }

  @Builder
  CreateForm() {
    Column() {
      TextInput({ placeholder: I18n.t($r('app.string.tag_new_placeholder')), text: this.newName })
        .width('100%')
        .height(40)
        .fontSize(14)
        .onChange((v: string) => { this.newName = v; });
      this.ColorPicker(this.newColor, (c: string) => { this.newColor = c; });
      Row() {
        Button(I18n.t($r('app.string.common_cancel')))
          .backgroundColor($r('app.color.surface_tap_invisible'))
          .fontColor($r('app.color.text_secondary'))
          .onClick(() => {
            this.createOpen = false;
            this.newName = '';
          });
        Blank();
        Button(I18n.t($r('app.string.tag_create_button')))
          .backgroundColor($r('app.color.accent_primary'))
          .enabled(this.newName.trim().length > 0)
          .onClick(() => this.create());
      }
      .width('100%');
    }
    .width('100%')
    .padding(16);
  }

  @Builder
  EditRow(row: TagRowVM) {
    Column() {
      TextInput({ text: this.editName })
        .width('100%')
        .height(40)
        .fontSize(14)
        .onChange((v: string) => { this.editName = v; });
      this.ColorPicker(this.editColor, (c: string) => { this.editColor = c; });
      Row() {
        Button(I18n.t($r('app.string.common_cancel')))
          .backgroundColor($r('app.color.surface_tap_invisible'))
          .fontColor($r('app.color.text_secondary'))
          .onClick(() => {
            this.editingId = '';
            this.editName = '';
          });
        Blank();
        Button(I18n.t($r('app.string.common_delete')))
          .backgroundColor($r('app.color.surface_tap_invisible'))
          .fontColor($r('app.color.accent_danger'))
          .margin({ right: 8 })
          .onClick(() => this.confirmDelete(row));
        Button(I18n.t($r('app.string.common_save')))
          .backgroundColor($r('app.color.accent_primary'))
          .enabled(this.editName.trim().length > 0)
          .onClick(() => this.saveEdit());
      }
      .width('100%');
    }
    .width('100%')
    .padding(16)
    .backgroundColor($r('app.color.bg_secondary'));
  }

  @Builder
  TagRow(row: TagRowVM) {
    Row() {
      Circle({ width: 12, height: 12 }).fill(row.color).margin({ right: 10 });
      Text(row.name)
        .fontSize(15)
        .fontColor($r('app.color.text_primary'))
        .layoutWeight(1);
      Text(I18n.t($r('app.string.tag_count_suffix'), row.count))
        .fontSize(12)
        .fontColor($r('app.color.text_secondary'))
        .margin({ right: 12 });
      Text(I18n.t($r('app.string.common_edit')))
        .fontSize(13)
        .fontColor($r('app.color.accent_primary'))
        .onClick(() => this.startEdit(row));
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 12, bottom: 12 });
  }

  @Builder
  SheetContent() {
    Column() {
      Text(I18n.t($r('app.string.tag_manage_title')))
        .fontSize(17)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))
        .padding({ left: 16, right: 16, top: 16, bottom: 8 });
      Divider().color($r('app.color.border_divider'));
      if (this.createOpen) {
        this.CreateForm();
      } else {
        Row() {
          Text('+ ' + I18n.t($r('app.string.tag_create_button')))
            .fontSize(14)
            .fontColor($r('app.color.accent_primary'));
        }
        .width('100%')
        .padding({ left: 16, right: 16, top: 12, bottom: 12 })
        .onClick(() => { this.createOpen = true; });
      }
      Divider().color($r('app.color.border_divider'));
      if (this.rows.length === 0) {
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
          ForEach(this.rows, (row: TagRowVM) => {
            ListItem() {
              if (this.editingId === row.id) {
                this.EditRow(row);
              } else {
                this.TagRow(row);
              }
            }
          }, (row: TagRowVM) => row.id);
        }
        .layoutWeight(1)
        .divider({
          strokeWidth: 0.5,
          color: $r('app.color.border_divider'),
          startMargin: 16,
          endMargin: 16,
        });
      }
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
