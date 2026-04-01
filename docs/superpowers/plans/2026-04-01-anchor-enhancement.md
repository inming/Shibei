# Anchor 系统增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增强 annotator anchor 系统的健壮性——失败可视化、文本节点过滤加固、模糊匹配 fallback。

**Architecture:** annotator.ts 是独立 IIFE 脚本（无 import），通过 `tsc -p src/annotator/tsconfig.json` 编译为 `src-tauri/src/annotator.js`，由 Rust `include_str!` 嵌入 HTML。改动集中在 annotator.ts（iframe 内锚点逻辑）、ReaderView.tsx（消息中转）、AnnotationPanel.tsx（UI 展示）。三个层次互相独立，逐步交付。

**Tech Stack:** TypeScript（annotator IIFE, ES2020 target）, React, CSS Modules

**设计文档:** `docs/superpowers/specs/2026-04-01-anchor-enhancement-design.md`

---

## Task 1: Annotator 回传 anchor 解析结果

**Files:**
- Modify: `src/annotator/annotator.ts:396-411` (render-highlights handler)

- [ ] **Step 1: 在 render-highlights handler 中收集 failedIds 并回传**

在 `shibei:render-highlights` 的 case 块中，收集失败的 highlight ID，渲染完成后 postMessage 回 parent：

```typescript
// 修改 annotator.ts 的 shibei:render-highlights case 块
case "shibei:render-highlights":
  // Batch render highlights on page load
  if (Array.isArray(msg.highlights)) {
    const failedIds: string[] = [];
    for (const hl of msg.highlights) {
      try {
        const range = resolveAnchor(hl.anchor);
        if (range) {
          wrapRange(range, hl.id, hl.color);
        } else {
          console.warn("[shibei] Could not resolve anchor for:", hl.id);
          failedIds.push(hl.id);
        }
      } catch (e) {
        console.warn("[shibei] Failed to render highlight:", hl.id, e);
        failedIds.push(hl.id);
      }
    }
    // Report resolution results back to parent
    window.parent.postMessage(
      { type: "shibei:render-result", failedIds },
      "*",
    );
  }
  break;
```

- [ ] **Step 2: 添加 RenderResultMsg 类型定义**

在 annotator.ts 的 outbound message types 区域（约第 60 行之后）添加：

```typescript
interface RenderResultMsg {
  type: "shibei:render-result";
  failedIds: string[];
}
```

- [ ] **Step 3: 编译验证**

```bash
npm run build:annotator
```

Expected: 编译成功，无类型错误。

- [ ] **Step 4: Commit**

```bash
git add src/annotator/annotator.ts src-tauri/src/annotator.js
git commit -m "feat: annotator reports anchor resolution failures back to parent"
```

---

## Task 2: ReaderView 接收失败状态并传递给 AnnotationPanel

**Files:**
- Modify: `src/components/ReaderView.tsx:32-34` (state), `src/components/ReaderView.tsx:54-93` (message handler), `src/components/ReaderView.tsx:239-250` (AnnotationPanel props)

- [ ] **Step 1: 添加 failedHighlightIds state**

在 ReaderView 组件中 `useState` 声明区域（第 34 行之后）添加：

```typescript
const [failedHighlightIds, setFailedHighlightIds] = useState<Set<string>>(new Set());
```

- [ ] **Step 2: 在 message handler 中处理 shibei:render-result**

在 `handleMessage` 的 switch 语句中，`shibei:link-clicked` case 之后添加：

```typescript
case "shibei:render-result":
  if (Array.isArray(msg.failedIds)) {
    setFailedHighlightIds(new Set(msg.failedIds as string[]));
  }
  break;
```

- [ ] **Step 3: 将 failedHighlightIds 传递给 AnnotationPanel**

在 AnnotationPanel 组件调用处添加 prop：

```tsx
<AnnotationPanel
  style={{ width: panelWidth }}
  highlights={highlights}
  failedHighlightIds={failedHighlightIds}
  getCommentsForHighlight={getCommentsForHighlight}
  resourceNotes={resourceNotes}
  activeHighlightId={activeHighlightId}
  onClickHighlight={handlePanelClickHighlight}
  onDeleteHighlight={handleDeleteHighlight}
  onAddComment={(hlId, content) => addComment(hlId, content)}
  onDeleteComment={removeComment}
  onEditComment={editComment}
/>
```

- [ ] **Step 4: 修改 handlePanelClickHighlight 跳过失败的 highlight**

```typescript
const handlePanelClickHighlight = useCallback((id: string) => {
  setActiveHighlightId(id);
  // Don't scroll to highlight if it failed to anchor in the DOM
  if (!failedHighlightIds.has(id)) {
    iframeRef.current?.contentWindow?.postMessage(
      { type: "shibei:scroll-to-highlight", id },
      "*",
    );
  }
}, [failedHighlightIds]);
```

- [ ] **Step 5: 编译验证**

```bash
npx tsc --noEmit
```

Expected: 暂时会报 AnnotationPanel 的 prop 类型错误（`failedHighlightIds` 尚未在 AnnotationPanel 中声明），这是预期内的，下一个 Task 修复。

- [ ] **Step 6: Commit**

```bash
git add src/components/ReaderView.tsx
git commit -m "feat: ReaderView receives and forwards anchor failure state"
```

---

## Task 3: AnnotationPanel 展示失败标记

**Files:**
- Modify: `src/components/AnnotationPanel.tsx:6-17` (props interface), `src/components/AnnotationPanel.tsx:96-114` (HighlightEntry 渲染), `src/components/AnnotationPanel.tsx:192-198` (HighlightEntry 样式逻辑)
- Modify: `src/components/AnnotationPanel.module.css` (新增失败状态样式)

- [ ] **Step 1: AnnotationPanelProps 添加 failedHighlightIds**

```typescript
interface AnnotationPanelProps {
  highlights: Highlight[];
  failedHighlightIds: Set<string>;
  getCommentsForHighlight: (highlightId: string) => Comment[];
  activeHighlightId: string | null;
  onClickHighlight: (id: string) => void;
  onDeleteHighlight: (id: string) => void;
  onAddComment: (highlightId: string | null, content: string) => void;
  onDeleteComment: (id: string) => void;
  onEditComment: (id: string, content: string) => void;
  resourceNotes: Comment[];
  style?: React.CSSProperties;
}
```

在解构参数中也添加 `failedHighlightIds`。

- [ ] **Step 2: 传递 isFailed 给 HighlightEntry**

在 HighlightEntry 调用处添加 `isFailed` prop：

```tsx
{highlights.map((hl) => (
  <HighlightEntry
    key={hl.id}
    highlight={hl}
    comments={getCommentsForHighlight(hl.id)}
    isActive={activeHighlightId === hl.id}
    isFailed={failedHighlightIds.has(hl.id)}
    ref={activeHighlightId === hl.id ? activeRef : null}
    onClick={() => onClickHighlight(hl.id)}
    onDelete={() =>
      setDeleteConfirm({
        type: "highlight",
        id: hl.id,
        commentCount: getCommentsForHighlight(hl.id).length,
      })
    }
    onAddComment={(content) => onAddComment(hl.id, content)}
    onDeleteComment={(id) => setDeleteConfirm({ type: "comment", id })}
    onEditComment={onEditComment}
  />
))}
```

- [ ] **Step 3: HighlightEntry 接收并展示 isFailed**

HighlightEntryProps 添加：

```typescript
interface HighlightEntryProps {
  highlight: Highlight;
  comments: Comment[];
  isActive: boolean;
  isFailed: boolean;
  onClick: () => void;
  onDelete: () => void;
  onAddComment: (content: string) => void;
  onDeleteComment: (id: string) => void;
  onEditComment: (id: string, content: string) => void;
}
```

在 HighlightEntry 组件中解构 `isFailed`，修改渲染逻辑：

```tsx
const HighlightEntry = forwardRef<HTMLDivElement, HighlightEntryProps>(
  function HighlightEntry(
    { highlight, comments, isActive, isFailed, onClick, onDelete, onAddComment, onDeleteComment, onEditComment },
    ref,
  ) {
    // ... existing state ...

    return (
      <div
        ref={ref}
        className={`${styles.highlightItem} ${isActive ? styles.highlightItemActive : ""} ${isFailed ? styles.highlightItemFailed : ""}`}
        style={{ borderLeftColor: isFailed ? "#ccc" : highlight.color }}
        onClick={onClick}
      >
        <div className={styles.highlightText}>
          {highlight.text_content}
        </div>
        <div className={styles.highlightMeta}>
          <span>
            {isFailed && <span className={styles.failedBadge}>定位失败</span>}
            {new Date(highlight.created_at).toLocaleDateString()}
          </span>
          <button
            className={styles.deleteBtn}
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            删除
          </button>
        </div>
        {/* ... rest of comments/add-comment unchanged ... */}
```

- [ ] **Step 4: 添加失败状态的 CSS 样式**

在 `AnnotationPanel.module.css` 末尾添加：

```css
.highlightItemFailed {
  opacity: 0.6;
}

.failedBadge {
  display: inline-block;
  padding: 1px 4px;
  margin-right: var(--spacing-xs);
  border-radius: 3px;
  font-size: 10px;
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
}
```

- [ ] **Step 5: 编译验证**

```bash
npx tsc --noEmit && npm run build:annotator
```

Expected: 编译成功，无类型错误。

- [ ] **Step 6: 手动测试**

1. 打开一个有高亮的资料
2. 在数据库中手动修改某条 highlight 的 anchor.text_position.start 为一个错误值（如 999999），同时修改 anchor.text_quote.exact 为一段不存在的文本
3. 重新打开该资料，确认：
   - 正常高亮仍然显示
   - 被修改的高亮在 AnnotationPanel 中显示灰色 + "定位失败"标签
   - 点击失败的高亮不会触发 scroll-to-highlight

- [ ] **Step 7: Commit**

```bash
git add src/components/AnnotationPanel.tsx src/components/AnnotationPanel.module.css
git commit -m "feat: show 'anchor failed' badge for unresolvable highlights"
```

---

## Task 4: getTextNodes 过滤不可见文本节点

**Files:**
- Modify: `src/annotator/annotator.ts:116-124` (getTextNodes function)

- [ ] **Step 1: 定义 EXCLUDED_TAGS 常量**

在 annotator.ts 的 styles 区域之后、`getTextNodes` 之前添加：

```typescript
const EXCLUDED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
```

- [ ] **Step 2: 改造 getTextNodes 添加 NodeFilter**

替换现有 `getTextNodes` 函数：

```typescript
function getTextNodes(root: Node): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_ACCEPT;
      // Skip text inside script/style/noscript/template
      if (EXCLUDED_TAGS.has(parent.tagName)) {
        return NodeFilter.FILTER_REJECT;
      }
      // Skip text inside hidden elements
      const style = getComputedStyle(parent);
      if (style.display === "none" || style.visibility === "hidden") {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node: Node | null;
  while ((node = walker.nextNode())) {
    nodes.push(node as Text);
  }
  return nodes;
}
```

- [ ] **Step 3: 编译验证**

```bash
npm run build:annotator
```

Expected: 编译成功。

- [ ] **Step 4: 手动测试兼容性**

1. 打开一个已有高亮的资料 → 确认旧高亮仍能正确渲染（position fallback 到 quote 匹配）
2. 在该资料上新建高亮 → 关闭并重新打开 → 确认新高亮正确渲染
3. 测试一个包含 `<script>` 标签或隐藏元素的页面 → 确认高亮不会偏移

- [ ] **Step 5: Commit**

```bash
git add src/annotator/annotator.ts src-tauri/src/annotator.js
git commit -m "fix: filter invisible text nodes from anchor offset calculation"
```

---

## Task 5: 零宽字符标准化

**Files:**
- Modify: `src/annotator/annotator.ts:156-160` (getBodyText), `src/annotator/annotator.ts:190-227` (resolveByPosition)

- [ ] **Step 1: 定义零宽字符正则**

在 `EXCLUDED_TAGS` 之后添加：

```typescript
const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\uFEFF]/g;
```

- [ ] **Step 2: 添加标准化文本长度的辅助函数**

在 `getBodyText` 之前添加：

```typescript
function normalizedLength(text: string): number {
  return text.replace(ZERO_WIDTH_RE, "").length;
}

function normalizedText(text: string): string {
  return text.replace(ZERO_WIDTH_RE, "");
}
```

- [ ] **Step 3: 修改 getBodyText 标准化零宽字符**

```typescript
function getBodyText(): string {
  return getTextNodes(document.body)
    .map((n) => normalizedText(n.textContent ?? ""))
    .join("");
}
```

- [ ] **Step 4: 修改 computeTextOffset 使用标准化长度**

```typescript
function computeTextOffset(container: Node, offset: number): number {
  const textNodes = getTextNodes(document.body);
  let total = 0;
  for (const tn of textNodes) {
    if (tn === container) {
      return total + normalizedLength((tn.textContent ?? "").slice(0, offset));
    }
    total += normalizedLength(tn.textContent ?? "");
  }
  // If container is an element, find the offset-th child's text position
  if (container.nodeType === Node.ELEMENT_NODE) {
    let childIndex = 0;
    total = 0;
    for (const tn of textNodes) {
      if ((container as Element).contains(tn)) {
        if (childIndex >= offset) return total;
        childIndex++;
      }
      total += normalizedLength(tn.textContent ?? "");
    }
  }
  return total;
}
```

- [ ] **Step 5: 修改 resolveByPosition 使用标准化长度**

```typescript
function resolveByPosition(anchor: Anchor): Range | null {
  const textNodes = getTextNodes(document.body);
  const { start, end } = anchor.text_position;
  let offset = 0;
  let startNode: Text | null = null;
  let startOff = 0;
  let endNode: Text | null = null;
  let endOff = 0;

  for (const tn of textNodes) {
    const raw = tn.textContent ?? "";
    const len = normalizedLength(raw);
    if (!startNode && offset + len > start) {
      startNode = tn;
      // Map normalized offset back to raw offset
      startOff = rawOffset(raw, start - offset);
    }
    if (!endNode && offset + len >= end) {
      endNode = tn;
      endOff = rawOffset(raw, end - offset);
      break;
    }
    offset += len;
  }

  if (!startNode || !endNode) return null;

  try {
    const range = document.createRange();
    range.setStart(startNode, startOff);
    range.setEnd(endNode, endOff);
    // Verify the text matches (compare normalized)
    if (normalizedText(range.toString()) === normalizedText(anchor.text_quote.exact)) {
      return range;
    }
  } catch (_e) {
    // Fall through to null
  }
  return null;
}
```

- [ ] **Step 6: 添加 rawOffset 辅助函数**

在 `normalizedText` 之后添加：

```typescript
/**
 * Given a raw string and a target offset in the normalized (zero-width-free) version,
 * return the corresponding offset in the raw string.
 */
function rawOffset(raw: string, normalizedOff: number): number {
  let norm = 0;
  for (let i = 0; i < raw.length; i++) {
    if (norm >= normalizedOff) return i;
    if (!ZERO_WIDTH_RE.test(raw[i])) {
      norm++;
    }
    // Reset lastIndex since we use global regex for single char test
    ZERO_WIDTH_RE.lastIndex = 0;
  }
  return raw.length;
}
```

- [ ] **Step 7: 同步修改 wrapRange 中的偏移量计算**

`wrapRange` 函数的多节点路径中也用 `normalizedLength`：

```typescript
function wrapRange(range: Range, highlightId: string, color: string): void {
  // Single text node case — unchanged
  if (
    range.startContainer === range.endContainer &&
    range.startContainer.nodeType === Node.TEXT_NODE
  ) {
    const hl = createHlElement(highlightId, color);
    range.surroundContents(hl);
    return;
  }

  // Multi-node range: wrap each text node segment
  const textNodes = getTextNodes(document.body);
  const startOff = computeTextOffset(range.startContainer, range.startOffset);
  const endOff = computeTextOffset(range.endContainer, range.endOffset);
  let offset = 0;
  const nodesToWrap: NodeWrapSpec[] = [];

  for (const tn of textNodes) {
    const raw = tn.textContent ?? "";
    const len = normalizedLength(raw);
    const nodeStart = offset;
    const nodeEnd = offset + len;

    if (nodeEnd > startOff && nodeStart < endOff) {
      const wrapStartNorm = Math.max(0, startOff - nodeStart);
      const wrapEndNorm = Math.min(len, endOff - nodeStart);
      nodesToWrap.push({
        node: tn,
        start: rawOffset(raw, wrapStartNorm),
        end: rawOffset(raw, wrapEndNorm),
      });
    }
    offset += len;
  }

  // Wrap in reverse order to not invalidate offsets
  for (let i = nodesToWrap.length - 1; i >= 0; i--) {
    const { node, start, end } = nodesToWrap[i];
    const r = document.createRange();
    r.setStart(node, start);
    r.setEnd(node, end);
    const hl = createHlElement(highlightId, color);
    r.surroundContents(hl);
  }
}
```

- [ ] **Step 8: 编译验证**

```bash
npm run build:annotator
```

Expected: 编译成功。

- [ ] **Step 9: 手动测试**

1. 旧高亮兼容性：打开已有高亮的资料 → 确认渲染正确
2. 新高亮：创建高亮 → 关闭 → 重新打开 → 确认渲染正确
3. 如果能找到含零宽字符的页面，验证高亮不会偏移

- [ ] **Step 10: Commit**

```bash
git add src/annotator/annotator.ts src-tauri/src/annotator.js
git commit -m "fix: normalize zero-width characters in anchor offset calculation"
```

---

## Task 6: 模糊匹配 — Bitap 算法实现

**Files:**
- Modify: `src/annotator/annotator.ts` (新增 fuzzySearch 函数，约 80 行)

- [ ] **Step 1: 添加 FuzzyMatch 接口和 fuzzySearch 函数**

在 `resolveByQuote` 之前添加：

```typescript
interface FuzzyMatch {
  start: number;
  end: number;
  errors: number;
}

/**
 * Bitap approximate string search.
 * Finds the best match of `pattern` in `text` within `maxErrors` edit distance.
 * Uses position hint for tie-breaking when multiple matches have the same error count.
 *
 * Pattern length is limited to 32 characters (JavaScript bitwise limit).
 * For longer patterns, the first 32 chars are used to locate candidates,
 * then full text comparison validates.
 */
function fuzzySearch(
  text: string,
  pattern: string,
  maxErrors: number,
  positionHint: number,
): FuzzyMatch | null {
  if (pattern.length === 0) return null;

  // For patterns > 32 chars, use prefix to locate, then validate full match
  const searchPattern = pattern.length > 32 ? pattern.slice(0, 32) : pattern;
  const m = searchPattern.length;
  const k = Math.min(maxErrors, m - 1);

  // Build character masks
  const charMask: Record<string, number> = {};
  for (let i = 0; i < m; i++) {
    const c = searchPattern[i];
    charMask[c] = (charMask[c] ?? ~0) & ~(1 << i);
  }

  // State arrays for each error level
  const state: number[] = new Array(k + 1).fill(~0);

  let bestMatch: FuzzyMatch | null = null;

  for (let i = 0; i < text.length; i++) {
    const charBit = charMask[text[i]] ?? ~0;

    // Update states from highest error count down
    let oldState = state[0];
    state[0] = (state[0] << 1) | charBit;

    for (let d = 1; d <= k; d++) {
      const prevState = oldState;
      oldState = state[d];
      // Shift + char match OR insertion OR deletion OR substitution
      state[d] = ((state[d] << 1) | charBit) & (prevState << 1) & ((oldState | prevState) << 1) & prevState;
    }

    // Check for matches at each error level (prefer fewer errors)
    for (let d = 0; d <= k; d++) {
      if ((state[d] & (1 << (m - 1))) === 0) {
        const matchEnd = i + 1;
        let matchStart: number;
        let errors: number;

        if (pattern.length > 32) {
          // Validate full pattern at this position
          matchStart = matchEnd - m;
          if (matchStart < 0) continue;
          // Extend to full pattern length
          const candidateEnd = matchStart + pattern.length;
          if (candidateEnd > text.length) continue;
          const candidate = text.slice(matchStart, candidateEnd);
          errors = levenshteinDistance(candidate, pattern);
          if (errors > maxErrors) continue;
        } else {
          matchStart = matchEnd - m;
          errors = d;
        }

        // Score: fewer errors better, closer to position hint better
        if (
          !bestMatch ||
          errors < bestMatch.errors ||
          (errors === bestMatch.errors &&
            Math.abs(matchStart - positionHint) < Math.abs(bestMatch.start - positionHint))
        ) {
          bestMatch = {
            start: matchStart,
            end: pattern.length > 32 ? matchStart + pattern.length : matchEnd,
            errors,
          };
        }
        break; // Found match at this error level, don't check higher
      }
    }
  }

  return bestMatch;
}

/**
 * Simple Levenshtein distance for validating long pattern matches.
 * Only used for patterns > 32 chars where Bitap searched by prefix.
 */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);

  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[n];
}
```

- [ ] **Step 2: 编译验证**

```bash
npm run build:annotator
```

Expected: 编译成功（fuzzySearch 和 levenshteinDistance 暂未被调用，但类型正确即可）。

- [ ] **Step 3: Commit**

```bash
git add src/annotator/annotator.ts src-tauri/src/annotator.js
git commit -m "feat: add Bitap fuzzy search algorithm for anchor resolution"
```

---

## Task 7: 集成模糊匹配到 resolveByQuote

**Files:**
- Modify: `src/annotator/annotator.ts:232-255` (resolveByQuote function)

- [ ] **Step 1: 添加字符串相似度辅助函数**

在 `levenshteinDistance` 之后添加：

```typescript
/**
 * Normalized string similarity (0.0 = completely different, 1.0 = identical).
 */
function similarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}
```

- [ ] **Step 2: 改造 resolveByQuote 加入模糊匹配 fallback**

替换整个 `resolveByQuote` 函数：

```typescript
function resolveByQuote(anchor: Anchor): Range | null {
  const bodyText = getBodyText();
  const { exact, prefix, suffix } = anchor.text_quote;

  // Step 1: Exact match with full context (prefix + exact + suffix)
  const contextStr = prefix + exact + suffix;
  const idx = bodyText.indexOf(contextStr);
  if (idx !== -1) {
    const start = idx + prefix.length;
    const end = start + exact.length;
    return resolveByPosition({
      text_position: { start, end },
      text_quote: anchor.text_quote,
    });
  }

  // Step 2: Exact match on just the quote text
  const simpleIdx = bodyText.indexOf(exact);
  if (simpleIdx !== -1) {
    return resolveByPosition({
      text_position: { start: simpleIdx, end: simpleIdx + exact.length },
      text_quote: anchor.text_quote,
    });
  }

  // Step 3: Fuzzy match on exact text (tolerant of minor differences)
  const maxErrors = Math.min(32, Math.floor(exact.length / 5));
  if (maxErrors < 1) return null;

  const match = fuzzySearch(bodyText, exact, maxErrors, anchor.text_position.start);
  if (!match) return null;

  // Validate with context: at least one of prefix/suffix should roughly match
  const candidatePrefix = bodyText.slice(
    Math.max(0, match.start - prefix.length),
    match.start,
  );
  const candidateSuffix = bodyText.slice(
    match.end,
    Math.min(bodyText.length, match.end + suffix.length),
  );
  const prefixSim = prefix.length > 0 ? similarity(candidatePrefix, prefix) : 1;
  const suffixSim = suffix.length > 0 ? similarity(candidateSuffix, suffix) : 1;

  // Require at least one context side to be a reasonable match
  if (prefixSim < 0.5 && suffixSim < 0.5) return null;

  // Build a new position-based anchor from the fuzzy match
  return resolveByPosition({
    text_position: { start: match.start, end: match.end },
    text_quote: {
      exact: bodyText.slice(match.start, match.end),
      prefix: anchor.text_quote.prefix,
      suffix: anchor.text_quote.suffix,
    },
  });
}
```

- [ ] **Step 3: 编译验证**

```bash
npm run build:annotator
```

Expected: 编译成功。

- [ ] **Step 4: 手动测试**

1. 正常高亮：打开已有高亮的资料 → 确认正常渲染（精确匹配路径仍然优先）
2. 模糊匹配测试：在数据库中找一条 highlight，轻微修改 `anchor.text_quote.exact`（比如增加一个空格），确认高亮仍能通过模糊匹配渲染
3. 误匹配防护：将 `anchor.text_quote.exact` 改为完全不同的文本，确认不会错误匹配

- [ ] **Step 5: Commit**

```bash
git add src/annotator/annotator.ts src-tauri/src/annotator.js
git commit -m "feat: integrate fuzzy matching fallback into anchor resolution"
```

---

## Task 8: 更新 roadmap

**Files:**
- Modify: `docs/superpowers/specs/2026-03-31-shibei-roadmap.md:55-58`

- [ ] **Step 1: 标记完成的 roadmap 项目**

将 v1.1.1 中已完成的项目打勾：

```markdown
- [x] **失败可视化** — 短期改进：anchor 解析失败时在 AnnotationPanel 标记"定位失败"而非静默丢失
```

（其他调研项根据实际完成情况标记）

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-03-31-shibei-roadmap.md
git commit -m "docs: update v1.1.1 roadmap with anchor enhancement progress"
```
