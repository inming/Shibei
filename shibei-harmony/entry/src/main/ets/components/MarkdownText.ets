// Native markdown renderer for AnnotationPanel. No WebView: we tokenize
// markdown into block + span trees and render with ArkUI Text/Span so
// layout height is a natural by-product of the text itself — no measure
// round-trips, no ArkWeb paint-grow bugs.


class MdBlock {
  type: string = 'p';                  // p | h | ul | ol | code | quote | hr | table
  level: number = 0;                   // heading level 1-6
  text: string = '';                   // raw text for p / code / quote
  items: string[] = [];                // list item raw text (inline-parsed on render)
  tableRows: string[][] = [];          // rows of raw cell strings; index 0 = header
  tableAligns: string[] = [];          // per column: 'l' | 'c' | 'r'
  tableColWidths: number[] = [];       // per column pixel width, computed at parse time
  tableTotalWidth: number = 0;         // sum of tableColWidths (Column width inside Scroll)
}

class MdSpan {
  text: string = '';
  bold: boolean = false;
  italic: boolean = false;
  code: boolean = false;
  strike: boolean = false;
  link: string = '';                   // empty = no link
}

function splitTableRow(s: string): string[] {
  let t = s;
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c: string) => c.trim());
}

// Strip inline markdown markers for column-width estimation.
function plainLength(s: string): number {
  return s.replace(/\*\*/g, '').replace(/[*`_~]/g, '').length;
}

// Per-column pixel width, driven purely by content. Min 64 so empty /
// single-char header cells (GFM tables often have a blank top-left corner)
// stay visibly bordered. No hard upper cap: if one cell is genuinely long
// the column grows to match and horizontal Scroll handles it — better than
// truncating via an arbitrary constant. The +18 buffer absorbs small
// estimation drift (inline code uses monospace, bold glyphs are slightly
// wider) so ellipsis only fires for truly pathological content.
function estimateColWidths(rows: string[][], fontSize: number): number[] {
  const cols = rows.length > 0 ? rows[0].length : 0;
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    let maxChars = 1;
    for (let r = 0; r < rows.length; r++) {
      const cell = rows[r][c] || '';
      const L = plainLength(cell);
      if (L > maxChars) maxChars = L;
    }
    widths.push(Math.max(64, Math.ceil(maxChars * fontSize + 18)));
  }
  return widths;
}

function parseBlocks(raw: string, fontSize: number): MdBlock[] {
  const text = raw.replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) { i++; continue; }

    // Horizontal rule.
    if (/^(-{3,}|_{3,}|\*{3,})$/.test(trimmed)) {
      const b = new MdBlock(); b.type = 'hr';
      blocks.push(b); i++; continue;
    }

    // ATX heading.
    const hm = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (hm) {
      const b = new MdBlock(); b.type = 'h'; b.level = hm[1].length; b.text = hm[2];
      blocks.push(b); i++; continue;
    }

    // Fenced code block.
    if (trimmed.startsWith('```')) {
      const b = new MdBlock(); b.type = 'code';
      i++;
      const codeLines: string[] = [];
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]); i++;
      }
      if (i < lines.length) i++;
      b.text = codeLines.join('\n');
      blocks.push(b); continue;
    }

    // GFM table: header row followed by |---|---| separator.
    if (trimmed.includes('|') && i + 1 < lines.length) {
      const sepLine = lines[i + 1].trim();
      if (sepLine.includes('-') && /^[\s|:\-]+$/.test(sepLine)) {
        const b = new MdBlock(); b.type = 'table';
        b.tableRows.push(splitTableRow(trimmed));
        const sepCells = splitTableRow(sepLine);
        b.tableAligns = sepCells.map((s: string) => {
          const left = s.startsWith(':');
          const right = s.endsWith(':');
          if (left && right) return 'c';
          if (right) return 'r';
          return 'l';
        });
        i += 2;
        while (i < lines.length && lines[i].trim().includes('|')) {
          b.tableRows.push(splitTableRow(lines[i].trim()));
          i++;
        }
        b.tableColWidths = estimateColWidths(b.tableRows, fontSize);
        b.tableTotalWidth = b.tableColWidths.reduce(
          (a: number, v: number) => a + v, 0);
        blocks.push(b); continue;
      }
    }

    // Blockquote (> ...).
    if (trimmed.startsWith('>')) {
      const b = new MdBlock(); b.type = 'quote';
      const parts: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        parts.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      b.text = parts.join('\n');
      blocks.push(b); continue;
    }

    // Unordered list.
    if (/^\s*[-*+]\s+/.test(line)) {
      const b = new MdBlock(); b.type = 'ul';
      while (i < lines.length) {
        const m = lines[i].match(/^\s*[-*+]\s+(.+)$/);
        if (!m) break;
        b.items.push(m[1]);
        i++;
      }
      blocks.push(b); continue;
    }

    // Ordered list.
    if (/^\s*\d+\.\s+/.test(line)) {
      const b = new MdBlock(); b.type = 'ol';
      while (i < lines.length) {
        const m = lines[i].match(/^\s*\d+\.\s+(.+)$/);
        if (!m) break;
        b.items.push(m[1]);
        i++;
      }
      blocks.push(b); continue;
    }

    // Default: paragraph (accumulate until blank line or new block marker).
    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== '') {
      const nt = lines[i].trim();
      if (paraLines.length > 0 && (
        /^#{1,6}\s+/.test(nt) ||
        /^\s*[-*+]\s+/.test(lines[i]) ||
        /^\s*\d+\.\s+/.test(lines[i]) ||
        nt.startsWith('```') ||
        nt.startsWith('>') ||
        /^(-{3,}|_{3,}|\*{3,})$/.test(nt)
      )) break;
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      const b = new MdBlock(); b.type = 'p'; b.text = paraLines.join(' ');
      blocks.push(b);
    }
  }
  return blocks;
}

// Inline parser: walks char-by-char, emitting Spans with current formatting
// state. Supports **bold**, *italic*, `code`, ~~strike~~, [text](url),
// ![alt](url) (rendered as "[图片]"). Not trying to be CommonMark-perfect;
// covers the formatting users actually write in annotation comments.
function parseInline(text: string): MdSpan[] {
  const spans: MdSpan[] = [];
  let buf = '';
  let bold = false;
  let italic = false;
  let strike = false;
  let link = '';

  const flush = () => {
    if (buf.length === 0) return;
    const s = new MdSpan();
    s.text = buf; s.bold = bold; s.italic = italic; s.strike = strike; s.link = link;
    spans.push(s);
    buf = '';
  };

  const N = text.length;
  let i = 0;
  while (i < N) {
    const c = text[i];

    // Inline code — content is literal, skip other markers inside.
    if (c === '`') {
      flush();
      i++;
      let codeBuf = '';
      while (i < N && text[i] !== '`') { codeBuf += text[i]; i++; }
      if (codeBuf.length > 0) {
        const s = new MdSpan(); s.text = codeBuf; s.code = true;
        spans.push(s);
      }
      if (i < N) i++;
      continue;
    }

    // Image ![alt](url) — render as italic placeholder.
    if (c === '!' && i + 1 < N && text[i + 1] === '[') {
      const close = text.indexOf(']', i + 2);
      if (close > i && close + 1 < N && text[close + 1] === '(') {
        const paren = text.indexOf(')', close + 2);
        if (paren > close) {
          flush();
          const prevItalic: boolean = italic;
          italic = true;
          buf = '[图片]';
          flush();
          italic = prevItalic;
          i = paren + 1;
          continue;
        }
      }
    }

    // Link [text](url).
    if (c === '[') {
      const close = text.indexOf(']', i + 1);
      if (close > i && close + 1 < N && text[close + 1] === '(') {
        const paren = text.indexOf(')', close + 2);
        if (paren > close) {
          flush();
          const linkText = text.slice(i + 1, close);
          const url = text.slice(close + 2, paren);
          link = url;
          buf = linkText;
          flush();
          link = '';
          i = paren + 1;
          continue;
        }
      }
    }

    // Bold **...**.
    if (c === '*' && i + 1 < N && text[i + 1] === '*') {
      flush();
      bold = !bold;
      i += 2;
      continue;
    }

    // Italic *...* (single asterisk).
    if (c === '*') {
      flush();
      italic = !italic;
      i++;
      continue;
    }

    // Strikethrough ~~...~~.
    if (c === '~' && i + 1 < N && text[i + 1] === '~') {
      flush();
      strike = !strike;
      i += 2;
      continue;
    }

    buf += c;
    i++;
  }
  flush();
  return spans;
}

@Component
export struct MarkdownText {
  @Prop @Watch('reparse') content: string = '';
  @Prop @Watch('reparse') baseFontSize: number = 13;
  @State blocks: MdBlock[] = [];

  aboutToAppear(): void {
    this.reparse();
  }

  reparse(): void {
    this.blocks = parseBlocks(this.content, this.baseFontSize);
  }

  private headingSize(_level: number): number {
    return this.baseFontSize;
  }

  private textAlignFor(a: string): TextAlign {
    if (a === 'r') return TextAlign.End;
    if (a === 'c') return TextAlign.Center;
    return TextAlign.Start;
  }

  build() {
    Column() {
      ForEach(this.blocks, (b: MdBlock, idx: number) => {
        this.Block(b);
      }, (b: MdBlock, idx: number) => `${idx}:${b.type}`);
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start);
  }

  @Builder Block(b: MdBlock) {
    if (b.type === 'h') {
      this.HeadingBlock(b);
    } else if (b.type === 'ul' || b.type === 'ol') {
      this.ListBlock(b);
    } else if (b.type === 'code') {
      this.CodeBlock(b);
    } else if (b.type === 'quote') {
      this.QuoteBlock(b);
    } else if (b.type === 'hr') {
      this.HrBlock();
    } else if (b.type === 'table') {
      this.TableBlock(b);
    } else {
      this.ParagraphBlock(b);
    }
  }

  @Builder ParagraphBlock(b: MdBlock) {
    Text() {
      this.InlineSpans(b.text, this.baseFontSize);
    }
    .fontSize(this.baseFontSize)
    .fontColor($r('sys.color.ohos_id_color_text_primary'))
    .margin({ top: 4, bottom: 4 });
  }

  @Builder HeadingBlock(b: MdBlock) {
    Text() {
      this.InlineSpans(b.text, this.headingSize(b.level));
    }
    .fontSize(this.headingSize(b.level))
    .fontWeight(FontWeight.Bold)
    .fontColor($r('sys.color.ohos_id_color_text_primary'))
    .margin({ top: 8, bottom: 4 });
  }

  @Builder ListBlock(b: MdBlock) {
    Column() {
      ForEach(b.items, (item: string, idx: number) => {
        Row() {
          Text(b.type === 'ol' ? `${idx + 1}.` : '•')
            .fontSize(this.baseFontSize)
            .fontColor($r('sys.color.ohos_id_color_text_primary'))
            .width(b.type === 'ol' ? 22 : 14)
            .margin({ right: 4, top: 2 })
            .textAlign(TextAlign.End);
          Text() {
            this.InlineSpans(item, this.baseFontSize);
          }
          .fontSize(this.baseFontSize)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .layoutWeight(1);
        }
        .alignItems(VerticalAlign.Top)
        .margin({ top: 2, bottom: 2 })
        .width('100%');
      }, (item: string, idx: number) => `${idx}`);
    }
    .margin({ top: 4, bottom: 4 })
    .width('100%')
    .alignItems(HorizontalAlign.Start);
  }

  @Builder CodeBlock(b: MdBlock) {
    Text(b.text)
      .fontSize(this.baseFontSize)
      .fontFamily('HarmonyOS Sans Mono, monospace')
      .fontColor($r('sys.color.ohos_id_color_text_primary'))
      .padding({ left: 10, right: 10, top: 8, bottom: 8 })
      .backgroundColor($r('sys.color.ohos_id_color_button_normal'))
      .borderRadius(4)
      .width('100%')
      .margin({ top: 4, bottom: 4 });
  }

  @Builder QuoteBlock(b: MdBlock) {
    Row() {
      Column()
        .width(3)
        .backgroundColor($r('sys.color.ohos_id_color_component_normal'));
      Text() {
        this.InlineSpans(b.text, this.baseFontSize);
      }
      .fontSize(this.baseFontSize)
      .fontColor($r('sys.color.ohos_id_color_text_tertiary'))
      .padding({ left: 10, top: 2, bottom: 2 })
      .layoutWeight(1);
    }
    .alignItems(VerticalAlign.Top)
    .margin({ top: 4, bottom: 4 })
    .width('100%');
  }

  @Builder HrBlock() {
    Divider()
      .strokeWidth(1)
      .color($r('sys.color.ohos_id_color_component_normal'))
      .margin({ top: 8, bottom: 8 });
  }

  @Builder TableBlock(b: MdBlock) {
    // Structure: ArkUI horizontal Scroll clamps its direct Column child to
    // viewport width regardless of .width()/.constraintSize hints. The
    // workaround is to render table *columns* (not rows) as the top-level
    // content inside Scroll — an outer Row holds one Column per table
    // column, each Column has an explicit fixed width and stacks its cells
    // vertically. A horizontally-arranged Row of fixed-width Columns
    // naturally extends beyond the Scroll viewport and triggers horizontal
    // scroll cleanly; cells keep the widths we computed at parse time.
    Scroll() {
      Row() {
        ForEach(b.tableColWidths, (colW: number, cIdx: number) => {
          Column() {
            ForEach(b.tableRows, (row: string[], rIdx: number) => {
              Row() {
                Text() {
                  this.InlineSpans(
                    (row[cIdx] && row[cIdx].length > 0) ? row[cIdx] : ' ',
                    this.baseFontSize);
                }
                .fontSize(this.baseFontSize)
                .fontWeight(rIdx === 0 ? FontWeight.Bold : FontWeight.Regular)
                .fontColor($r('sys.color.ohos_id_color_text_primary'))
                .textAlign(this.textAlignFor(b.tableAligns[cIdx] || 'l'))
                // Forbid wrapping inside a cell: different columns stack
                // independently, so a wrapped cell here would make this
                // column's row taller than the same row in sibling columns
                // and rows would fall out of horizontal alignment. Columns
                // are width-capped at parse time so content overflow is the
                // expected corner case; truncate with ellipsis rather than
                // silently wrap.
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .width('100%');
              }
              .width('100%')
              .padding({ left: 8, right: 8, top: 4, bottom: 4 })
              .backgroundColor(rIdx === 0
                ? $r('sys.color.ohos_id_color_button_normal')
                : Color.Transparent)
              .border({
                width: 1,
                color: $r('sys.color.ohos_id_color_component_normal'),
              });
            }, (row: string[], rIdx: number) => `${rIdx}`);
          }
          .width(colW)
          .flexShrink(0)
          .flexGrow(0)
          .alignSelf(ItemAlign.Start)
          .alignItems(HorizontalAlign.Start);
        }, (colW: number, cIdx: number) => `${cIdx}`);
      }
      .alignItems(VerticalAlign.Top)
      .justifyContent(FlexAlign.Start);
    }
    .scrollable(ScrollDirection.Horizontal)
    .scrollBar(BarState.Off)
    .margin({ top: 4, bottom: 4 })
    .width('100%');
  }

  @Builder InlineSpans(text: string, sizeHint: number) {
    ForEach(parseInline(text), (s: MdSpan, idx: number) => {
      Span(s.text)
        .fontWeight(s.bold ? FontWeight.Bold : FontWeight.Regular)
        .fontStyle(s.italic ? FontStyle.Italic : FontStyle.Normal)
        .decoration({
          type: s.strike
            ? TextDecorationType.LineThrough
            : (s.link.length > 0 ? TextDecorationType.Underline : TextDecorationType.None),
        })
        .fontFamily(s.code ? 'HarmonyOS Sans Mono, monospace' : '')
        .fontColor(s.link.length > 0
          ? $r('sys.color.ohos_id_color_emphasize')
          : (s.code
            ? $r('sys.color.ohos_id_color_text_primary')
            : $r('sys.color.ohos_id_color_text_primary')));
    }, (s: MdSpan, idx: number) => `${idx}:${s.text.slice(0, 8)}`);
  }
}
