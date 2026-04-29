import { hilog } from '@kit.PerformanceAnalysisKit';
import { promptAction } from '@kit.ArkUI';
import {
  ShibeiService, ShibeiError, DeletedResource, DeletedFolder,
} from '../../services/ShibeiService';
import { I18n } from '../../services/I18n';
import { SettingsTopBar } from '../../components/SettingsTopBar';

// Recycle bin sub-page. Two stacked sections (folders first because
// restoring a folder may bring back resources the user expects to find
// before drilling into individual rows). Each row exposes 恢复 + 永久删除;
// a footer button purges everything in trash.
//
// Soft-deleted entries here are mirrored across devices via sync_log —
// what desktop deletes also lands on this page after a sync.

@Entry
@Component
struct TrashSettings {
  @State folders: DeletedFolder[] = [];
  @State resources: DeletedResource[] = [];
  @State loading: boolean = false;
  @State error: string = '';

  aboutToAppear(): void {
    this.reload();
  }

  // Re-pull on page show so a sync that completed while the user was on
  // another page surfaces here without manual refresh.
  onPageShow(): void {
    this.reload();
  }

  private reload(): void {
    this.loading = true;
    this.error = '';
    try {
      this.folders = ShibeiService.instance.listDeletedFolders();
      this.resources = ShibeiService.instance.listDeletedResources();
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
      this.error = code;
      hilog.warn(0x0000, 'shibei', 'TrashSettings load fail: %{public}s', code);
    }
    this.loading = false;
  }

  private async restoreResource(id: string): Promise<void> {
    try {
      ShibeiService.instance.restoreResource(id);
      promptAction.showToast({ message: I18n.t($r('app.string.trash_restored_toast')) });
      this.reload();
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
      promptAction.showToast({
        message: I18n.t($r('app.string.trash_restore_failed'), I18n.translateError(code)),
      });
    }
  }

  private async restoreFolder(id: string): Promise<void> {
    try {
      ShibeiService.instance.restoreFolder(id);
      promptAction.showToast({ message: I18n.t($r('app.string.trash_restored_toast')) });
      this.reload();
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
      promptAction.showToast({
        message: I18n.t($r('app.string.trash_restore_failed'), I18n.translateError(code)),
      });
    }
  }

  // Permanent delete — single row. PURGE goes to sync_log so peers also
  // hard-delete on next sync.
  private async purgeResource(id: string, title: string): Promise<void> {
    let confirmed = false;
    try {
      const r = await promptAction.showDialog({
        title: I18n.t($r('app.string.trash_purge_confirm_title')),
        message: I18n.t($r('app.string.trash_purge_confirm_body'), title),
        buttons: [
          { text: I18n.t($r('app.string.common_cancel')), color: $r('app.color.text_secondary') },
          { text: I18n.t($r('app.string.trash_purge_action')), color: $r('app.color.accent_danger') },
        ],
      });
      confirmed = r.index === 1;
    } catch (err) {
      return;
    }
    if (!confirmed) return;
    try {
      ShibeiService.instance.purgeResource(id);
      promptAction.showToast({ message: I18n.t($r('app.string.trash_purged_toast')) });
      this.reload();
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
      promptAction.showToast({
        message: I18n.t($r('app.string.trash_purge_failed'), I18n.translateError(code)),
      });
    }
  }

  private async purgeFolder(id: string, name: string): Promise<void> {
    let confirmed = false;
    try {
      const r = await promptAction.showDialog({
        title: I18n.t($r('app.string.trash_purge_confirm_title')),
        message: I18n.t($r('app.string.trash_purge_folder_confirm_body'), name),
        buttons: [
          { text: I18n.t($r('app.string.common_cancel')), color: $r('app.color.text_secondary') },
          { text: I18n.t($r('app.string.trash_purge_action')), color: $r('app.color.accent_danger') },
        ],
      });
      confirmed = r.index === 1;
    } catch (err) {
      return;
    }
    if (!confirmed) return;
    try {
      ShibeiService.instance.purgeFolder(id);
      promptAction.showToast({ message: I18n.t($r('app.string.trash_purged_toast')) });
      this.reload();
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
      promptAction.showToast({
        message: I18n.t($r('app.string.trash_purge_failed'), I18n.translateError(code)),
      });
    }
  }

  private async clearAll(): Promise<void> {
    let confirmed = false;
    try {
      const r = await promptAction.showDialog({
        title: I18n.t($r('app.string.trash_clear_confirm_title')),
        message: I18n.t($r('app.string.trash_clear_confirm_body')),
        buttons: [
          { text: I18n.t($r('app.string.common_cancel')), color: $r('app.color.text_secondary') },
          { text: I18n.t($r('app.string.trash_clear_action')), color: $r('app.color.accent_danger') },
        ],
      });
      confirmed = r.index === 1;
    } catch (err) {
      return;
    }
    if (!confirmed) return;
    try {
      ShibeiService.instance.purgeAllDeleted();
      promptAction.showToast({ message: I18n.t($r('app.string.trash_cleared_toast')) });
      this.reload();
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
      promptAction.showToast({
        message: I18n.t($r('app.string.trash_clear_failed'), I18n.translateError(code)),
      });
    }
  }

  @Builder
  EmptyState() {
    Column() {
      Text(I18n.t($r('app.string.trash_empty_title'))).fontSize(15)
        .fontColor($r('app.color.text_secondary'));
      Text(I18n.t($r('app.string.trash_empty_hint'))).fontSize(12)
        .fontColor($r('app.color.text_subtle'))
        .margin({ top: 6 });
    }
    .alignItems(HorizontalAlign.Center).width('100%')
    .padding({ top: 48, bottom: 48 });
  }

  @Builder
  FolderRow(item: DeletedFolder) {
    Column() {
      Row() {
        Column() {
          Text(item.name).fontSize(14)
            .fontColor($r('app.color.text_primary'))
            .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis });
          Text(I18n.t($r('app.string.trash_folder_subtitle'), item.deleted_at))
            .fontSize(11).fontColor($r('app.color.text_subtle'))
            .margin({ top: 2 });
        }.alignItems(HorizontalAlign.Start).layoutWeight(1);
      }
      .width('100%');
      Row() {
        Text(I18n.t($r('app.string.trash_restore_action'))).fontSize(13)
          .fontColor($r('app.color.accent_primary'))
          .padding({ top: 6, bottom: 6, left: 10, right: 10 })
          .onClick(() => this.restoreFolder(item.id));
        Text(I18n.t($r('app.string.trash_purge_action'))).fontSize(13)
          .fontColor($r('app.color.accent_danger'))
          .padding({ top: 6, bottom: 6, left: 10, right: 10 })
          .margin({ left: 8 })
          .onClick(() => this.purgeFolder(item.id, item.name));
      }.width('100%').justifyContent(FlexAlign.End)
        .margin({ top: 6 });
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%')
    .padding({ top: 10, bottom: 10, left: 12, right: 12 });
  }

  @Builder
  ResourceRow(item: DeletedResource) {
    Column() {
      Text(item.title || I18n.t($r('app.string.common_no_title'))).fontSize(14)
        .fontColor($r('app.color.text_primary'))
        .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis });
      if (item.url) {
        Text(item.url).fontSize(11)
          .fontColor($r('app.color.text_subtle'))
          .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
          .margin({ top: 2 });
      }
      Text(I18n.t($r('app.string.trash_resource_subtitle'), item.deleted_at))
        .fontSize(11).fontColor($r('app.color.text_subtle'))
        .margin({ top: 2 });
      Row() {
        Text(I18n.t($r('app.string.trash_restore_action'))).fontSize(13)
          .fontColor($r('app.color.accent_primary'))
          .padding({ top: 6, bottom: 6, left: 10, right: 10 })
          .onClick(() => this.restoreResource(item.id));
        Text(I18n.t($r('app.string.trash_purge_action'))).fontSize(13)
          .fontColor($r('app.color.accent_danger'))
          .padding({ top: 6, bottom: 6, left: 10, right: 10 })
          .margin({ left: 8 })
          .onClick(() => this.purgeResource(item.id, item.title));
      }.width('100%').justifyContent(FlexAlign.End)
        .margin({ top: 6 });
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%')
    .padding({ top: 10, bottom: 10, left: 12, right: 12 });
  }

  build() {
    Column() {
      SettingsTopBar({ title: I18n.t($r('app.string.settings_section_trash')) });
      Scroll() {
        Column() {
          // 90-day auto-purge runs on desktop compaction; mobile shows
          // the same retention disclaimer for consistency.
          Text(I18n.t($r('app.string.trash_retention_hint'))).fontSize(11)
            .fontColor($r('app.color.text_subtle'))
            .margin({ top: 12, left: 16, right: 16 });

          if (this.error) {
            Text(I18n.t($r('app.string.resource_list_error'),
              I18n.translateError(this.error)))
              .fontSize(13).fontColor($r('app.color.accent_error_strong'))
              .margin({ top: 16, left: 16, right: 16 });
          } else if (this.folders.length === 0 && this.resources.length === 0 && !this.loading) {
            this.EmptyState();
          } else {
            // Folders block
            if (this.folders.length > 0) {
              Text(I18n.t($r('app.string.trash_folders_section'), this.folders.length))
                .fontSize(12).fontColor($r('app.color.text_secondary'))
                .margin({ top: 16, left: 16, right: 16, bottom: 6 });
              Column() {
                ForEach(this.folders, (item: DeletedFolder, idx: number) => {
                  this.FolderRow(item);
                  if (idx < this.folders.length - 1) {
                    Divider().strokeWidth(0.5)
                      .color($r('app.color.border_divider'))
                      .margin({ left: 12, right: 12 });
                  }
                }, (item: DeletedFolder) => item.id);
              }
              .backgroundColor($r('app.color.bg_secondary')).borderRadius(8)
              .margin({ left: 12, right: 12 });
            }

            // Resources block
            if (this.resources.length > 0) {
              Text(I18n.t($r('app.string.trash_resources_section'), this.resources.length))
                .fontSize(12).fontColor($r('app.color.text_secondary'))
                .margin({ top: 16, left: 16, right: 16, bottom: 6 });
              Column() {
                ForEach(this.resources, (item: DeletedResource, idx: number) => {
                  this.ResourceRow(item);
                  if (idx < this.resources.length - 1) {
                    Divider().strokeWidth(0.5)
                      .color($r('app.color.border_divider'))
                      .margin({ left: 12, right: 12 });
                  }
                }, (item: DeletedResource) => item.id);
              }
              .backgroundColor($r('app.color.bg_secondary')).borderRadius(8)
              .margin({ left: 12, right: 12 });
            }

            // Clear-all footer
            Column() {
              Row() {
                Text(I18n.t($r('app.string.trash_clear_action'))).fontSize(15)
                  .fontColor($r('app.color.accent_danger'))
                  .layoutWeight(1);
                Text('›').fontSize(18)
                  .fontColor($r('app.color.text_disabled'));
              }
              .width('100%').padding({ top: 12, bottom: 12, left: 12, right: 12 })
              .onClick(() => this.clearAll());
            }
            .backgroundColor($r('app.color.bg_secondary')).borderRadius(8)
            .margin({ top: 16, left: 12, right: 12, bottom: 32 });
          }
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%');
      }
      .align(Alignment.Top)
      .layoutWeight(1)
      .width('100%');
    }
    .width('100%').height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'));
  }
}
