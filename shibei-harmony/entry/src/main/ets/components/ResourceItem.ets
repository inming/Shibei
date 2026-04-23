import { Resource } from '../services/ShibeiService';
import { I18n } from '../services/I18n';

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
  resource!: Resource;
  onTap?: (id: string) => void;

  build() {
    Column() {
      Text(this.resource.title || I18n.t($r('app.string.common_no_title')))
        .fontSize(15)
        .fontWeight(FontWeight.Medium)
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis });
      Row() {
        Text(prettyHost(this.resource.url))
          .fontSize(12).fontColor($r('app.color.text_secondary')).layoutWeight(1)
          .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis });
        Text(shortDate(this.resource.created_at))
          .fontSize(12).fontColor($r('app.color.text_subtle'));
      }.margin({ top: 4 }).width('100%');
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%')
    .padding({ left: 16, right: 16, top: 12, bottom: 12 })
    .onClick(() => { if (this.onTap) this.onTap(this.resource.id); });
  }
}
