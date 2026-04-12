# UX 体验改进 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实施 UX 评审报告中 P0-P2 优先级的体验改进，提升搜索可用性、信息架构清晰度、阅读沉浸感和浏览效率。

**Architecture:** 改动分为后端（Rust search 返回 snippet）、前端组件（PreviewPanel 重构、ReaderView meta 栏 auto-hide、ResourceList 信息密度）、样式和 i18n 更新。每个 Task 独立可提交，不存在跨 Task 依赖（除 Task 1 的 snippet 被 Task 2 前端消费）。

**Tech Stack:** Rust (rusqlite/FTS5), React + TypeScript, CSS Modules, i18next

**参考文档：** `docs/2026-04-11-ux-review.md`

---

## File Structure

### 后端变更
- **Modify:** `src-tauri/src/db/search.rs` — SearchResult 增加 snippet 字段 + 匹配类型枚举
- **Modify:** `src-tauri/src/db/resources.rs` — 新增 `get_annotation_counts` 批量查询
- **Modify:** `src-tauri/src/db/highlights.rs` — 新增 `count_by_resource_ids` 批量计数
- **Modify:** `src-tauri/src/db/comments.rs` — 新增 `count_by_resource_ids` 批量计数
- **Modify:** `src-tauri/src/commands/mod.rs` — 新增 `cmd_get_annotation_counts` 命令

### 前端变更
- **Modify:** `src/types/index.ts` — SearchResult 类型更新 + AnnotationCounts 类型
- **Modify:** `src/lib/commands.ts` — 新增 `getAnnotationCounts` 命令封装
- **Modify:** `src/components/Sidebar/ResourceList.tsx` — 显示 snippet、匹配类型标签、标签色点、标注数量
- **Modify:** `src/components/Sidebar/ResourceList.module.css` — snippet 和标注数样式
- **Modify:** `src/components/PreviewPanel.tsx` — 重构为概览模式（摘要 + 统计）
- **Modify:** `src/components/PreviewPanel.module.css` — 概览样式
- **Modify:** `src/components/ReaderView.tsx` — meta 栏 auto-hide + 进度条 + 面板折叠
- **Modify:** `src/components/ReaderView.module.css` — auto-hide 动画 + 进度条 + 折叠样式
- **Modify:** `src/components/AnnotationPanel.module.css` — 折叠态窄条样式
- **Modify:** `src/components/TrashList.tsx` — 剩余天数 + 提示文案 + 批量恢复
- **Modify:** `src/hooks/useResources.ts` — 获取标注计数

### i18n 变更
- **Modify:** `src/locales/zh/search.json` + `src/locales/en/search.json`
- **Modify:** `src/locales/zh/sidebar.json` + `src/locales/en/sidebar.json`
- **Modify:** `src/locales/zh/reader.json` + `src/locales/en/reader.json`
- **Modify:** `src/locales/zh/common.json` + `src/locales/en/common.json`
- **Modify:** `src/locales/zh/annotation.json` + `src/locales/en/annotation.json`

---

## Task 1: 搜索结果返回 snippet 和匹配类型 [P0 后端]

**Files:**
- Modify: `src-tauri/src/db/search.rs:6-12` (SearchResult 结构体)
- Modify: `src-tauri/src/db/search.rs:134-283` (search_resources 函数)
- Test: `src-tauri/src/db/search.rs` (模块内测试)

### 设计说明

当前 `SearchResult` 只有 `matched_body: bool`，无法告诉用户"为什么匹配"。改为：
1. 新增 `snippet: Option<String>` — 正文匹配时返回关键词前后各 50 字符的上下文片段
2. 新增 `match_fields: Vec<String>` — 返回所有匹配到的字段名列表（`"title"`, `"url"`, `"description"`, `"highlights"`, `"comments"`, `"body"`）

保留 `matched_body` 字段以保持向后兼容（MCP Server 可能依赖）。

- [ ] **Step 1: 写 snippet 提取的测试**

在 `src-tauri/src/db/search.rs` 的 `#[cfg(test)] mod tests` 中添加测试：

```rust
#[test]
fn test_extract_snippet() {
    let text = "这是一段很长的文本内容，包含了我们要搜索的关键词，关键词出现在文本的中间位置，后面还有一些额外的文字用于测试。";
    let snippet = extract_snippet(text, "关键词", 20);
    assert!(snippet.is_some());
    let s = snippet.unwrap();
    assert!(s.contains("关键词"));
    assert!(s.len() <= 20 * 2 + "关键词".len() + 6); // prefix + keyword + suffix + "..."*2
}

#[test]
fn test_extract_snippet_at_start() {
    let text = "关键词在开头的文本内容还有更多";
    let snippet = extract_snippet(text, "关键词", 20);
    assert!(snippet.is_some());
    let s = snippet.unwrap();
    assert!(s.starts_with("关键词"));
}

#[test]
fn test_extract_snippet_no_match() {
    let text = "这段文本不包含搜索词";
    let snippet = extract_snippet(text, "不存在的词", 20);
    assert!(snippet.is_none());
}

#[test]
fn test_extract_snippet_case_insensitive() {
    let text = "This text contains a Keyword in the middle of a sentence with more words";
    let snippet = extract_snippet(text, "keyword", 15);
    assert!(snippet.is_some());
    assert!(snippet.unwrap().contains("Keyword"));
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /Users/work/workspace/Shibei && cargo test -p shibei --lib db::search::tests::test_extract_snippet -- --nocapture`
Expected: 编译失败，`extract_snippet` 函数不存在

- [ ] **Step 3: 实现 `extract_snippet` 函数**

在 `search.rs` 中（`search_resources` 函数之前）添加：

```rust
/// 从文本中提取包含关键词的上下文片段。
/// `context_chars` 指定关键词前后各取多少个字符。
fn extract_snippet(text: &str, query: &str, context_chars: usize) -> Option<String> {
    let text_lower = text.to_lowercase();
    let query_lower = query.to_lowercase();
    let byte_pos = text_lower.find(&query_lower)?;

    // 将 byte 偏移转为 char 偏移
    let char_pos = text[..byte_pos].chars().count();
    let query_char_len = text[byte_pos..].chars().take_while({
        let mut remaining = query_lower.len();
        move |c| {
            if remaining == 0 {
                return false;
            }
            remaining = remaining.saturating_sub(c.len_utf8());
            true
        }
    }).count();
    let total_chars = text.chars().count();

    let start = char_pos.saturating_sub(context_chars);
    let end = (char_pos + query_char_len + context_chars).min(total_chars);

    let snippet: String = text.chars().skip(start).take(end - start).collect();

    let prefix = if start > 0 { "..." } else { "" };
    let suffix = if end < total_chars { "..." } else { "" };

    Some(format!("{}{}{}", prefix, snippet, suffix))
}
```

- [ ] **Step 4: 运行 snippet 测试确认通过**

Run: `cd /Users/work/workspace/Shibei && cargo test -p shibei --lib db::search::tests::test_extract_snippet -- --nocapture`
Expected: 4 个测试全部 PASS

- [ ] **Step 5: 更新 `SearchResult` 结构体**

修改 `search.rs` 的 `SearchResult`（约第 6-12 行）：

```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    #[serde(flatten)]
    pub resource: super::resources::Resource,
    pub matched_body: bool,
    pub match_fields: Vec<String>,
    pub snippet: Option<String>,
}
```

- [ ] **Step 6: 更新 `search_resources` 函数填充新字段**

在 `search_resources` 函数中，当前 `matched_body` 判断逻辑（约第 247-260 行）改为：

```rust
// 构建 match_fields 和 snippet
let mut match_fields = Vec::new();
let query_lower = query.to_lowercase();

if title.to_lowercase().contains(&query_lower) {
    match_fields.push("title".to_string());
}
if url.to_lowercase().contains(&query_lower) {
    match_fields.push("url".to_string());
}
if description
    .as_deref()
    .map(|d| d.to_lowercase().contains(&query_lower))
    .unwrap_or(false)
{
    match_fields.push("description".to_string());
}
if highlights_text.to_lowercase().contains(&query_lower) {
    match_fields.push("highlights".to_string());
}
if comments_text.to_lowercase().contains(&query_lower) {
    match_fields.push("comments".to_string());
}

// 检查 body_text 匹配并提取 snippet
let body_text: String = row.get(8)?;
let snippet = if body_text.to_lowercase().contains(&query_lower) {
    match_fields.push("body".to_string());
    extract_snippet(&body_text, query, 50)
} else {
    None
};

let matched_body = match_fields.len() == 1 && match_fields[0] == "body"
    || (match_fields.is_empty()); // FTS 可能匹配了 trigram 但逐字比较不匹配

results.push(SearchResult {
    resource,
    matched_body,
    match_fields,
    snippet,
});
```

注意：需要在 SQL 查询的 SELECT 列表中确保 `body_text` 被查询出来。检查当前 SQL 是否已包含 `si.body_text`；如果没有，需要 JOIN `search_index` 并 SELECT `si.body_text`。

当前 FTS5 查询（约第 160-172 行）JOIN 了 `search_index`，但 SELECT 列只取了 `r.*` 和聚合列。需要在 SELECT 中增加 `si.body_text`：

在 FTS 路径的 SQL 中增加 `si.body_text`（SELECT 列表末尾），同时在 LIKE 路径也增加。然后通过 `row.get(N)` 读取（N 为新列的索引）。

具体：找到当前 SELECT 语句中列的数量，body_text 作为最后一列添加。

- [ ] **Step 7: 写 search_resources 返回新字段的集成测试**

```rust
#[test]
fn test_search_returns_match_fields_and_snippet() {
    let conn = setup_test_db();
    // 插入一条资料，body_text 包含 "Rust编程语言"
    insert_test_resource(&conn, "r1", "学习笔记", "https://example.com", None);
    // 手动写 search_index
    conn.execute(
        "INSERT INTO search_index (resource_id, title, url, description, highlights_text, comments_text, body_text)
         VALUES (?1, ?2, ?3, '', '', '', ?4)",
        rusqlite::params!["r1", "学习笔记", "https://example.com", "这是一篇关于Rust编程语言的详细教程，包含了很多示例代码"],
    ).unwrap();

    let results = search_resources(&conn, "Rust编程", None, &[], "created_at", "desc").unwrap();
    assert_eq!(results.len(), 1);
    assert!(results[0].match_fields.contains(&"body".to_string()));
    assert!(results[0].snippet.is_some());
    assert!(results[0].snippet.as_ref().unwrap().contains("Rust编程"));
}

#[test]
fn test_search_match_fields_title() {
    let conn = setup_test_db();
    insert_test_resource(&conn, "r1", "Rust入门指南", "https://example.com", None);
    conn.execute(
        "INSERT INTO search_index (resource_id, title, url, description, highlights_text, comments_text, body_text)
         VALUES (?1, ?2, ?3, '', '', '', '')",
        rusqlite::params!["r1", "Rust入门指南", "https://example.com"],
    ).unwrap();

    let results = search_resources(&conn, "Rust入门", None, &[], "created_at", "desc").unwrap();
    assert_eq!(results.len(), 1);
    assert!(results[0].match_fields.contains(&"title".to_string()));
    assert!(!results[0].matched_body);
    assert!(results[0].snippet.is_none()); // body 没匹配，不返回 snippet
}
```

- [ ] **Step 8: 运行全部搜索测试确认通过**

Run: `cd /Users/work/workspace/Shibei && cargo test -p shibei --lib db::search -- --nocapture`
Expected: 所有测试 PASS

- [ ] **Step 9: `cargo clippy` 检查**

Run: `cd /Users/work/workspace/Shibei && cargo clippy -p shibei -- -D warnings`
Expected: 无 warning

- [ ] **Step 10: Commit**

```bash
git add src-tauri/src/db/search.rs
git commit -m "feat(search): return match_fields and snippet in SearchResult"
```

---

## Task 2: 前端显示搜索 snippet 和匹配类型 [P0 前端]

**Files:**
- Modify: `src/types/index.ts:28-30`
- Modify: `src/components/Sidebar/ResourceList.tsx:43-82,286-294`
- Modify: `src/components/Sidebar/ResourceList.module.css`
- Modify: `src/locales/zh/search.json`
- Modify: `src/locales/en/search.json`

- [ ] **Step 1: 更新 TypeScript 类型**

在 `src/types/index.ts` 中修改 `SearchResult`（约第 28-30 行）：

```typescript
export interface SearchResult extends Resource {
  matchedBody: boolean;
  matchFields: string[];
  snippet: string | null;
}
```

- [ ] **Step 2: 添加 i18n 键**

`src/locales/zh/search.json` 增加：
```json
{
  "placeholder": "搜索...",
  "clearSearch": "清除搜索",
  "bodyMatch": "正文匹配",
  "highlightsMatch": "标注匹配",
  "commentsMatch": "评论匹配"
}
```

`src/locales/en/search.json` 增加：
```json
{
  "placeholder": "Search...",
  "clearSearch": "Clear search",
  "bodyMatch": "Body match",
  "highlightsMatch": "Highlights match",
  "commentsMatch": "Comments match"
}
```

- [ ] **Step 3: 更新 ResourceList 显示 snippet 和匹配标签**

在 `ResourceList.tsx` 的 `DraggableResourceItem` 中（约第 43-82 行）：

1. 从 `useResources` hook 获取 snippet 数据（需要 `useResources` 额外返回 `snippetMap`）
2. 在 `itemTitle` 下方增加 snippet 显示区域
3. 将 `bodyMatchTag` 替换为更细粒度的匹配类型标签

```tsx
// DraggableResourceItem 内部，在 itemMeta 之后添加：
{snippet && (
  <div className={styles.snippet}>
    {highlightMatch(snippet, searchQuery)}
  </div>
)}
// 匹配类型标签区域，替换原来的 bodyMatchTag
<div className={styles.matchTags}>
  {matchFields.includes('body') && <span className={styles.matchTag}>{tSearch('bodyMatch')}</span>}
  {matchFields.includes('highlights') && <span className={styles.matchTag}>{tSearch('highlightsMatch')}</span>}
  {matchFields.includes('comments') && <span className={styles.matchTag}>{tSearch('commentsMatch')}</span>}
</div>
```

- [ ] **Step 4: 添加 snippet CSS 样式**

在 `ResourceList.module.css` 中添加：

```css
.snippet {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.matchTags {
  display: flex;
  gap: 4px;
  margin-top: 2px;
  flex-wrap: wrap;
}

.matchTag {
  display: inline-block;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  background-color: var(--color-accent-light);
  color: var(--color-accent);
  white-space: nowrap;
}
```

- [ ] **Step 5: 更新 `useResources` hook 传递 snippet 和 matchFields**

在 `src/hooks/useResources.ts` 中，`refresh` 函数的搜索分支（约第 33-49 行）增加：

```typescript
const snippetMap: Record<string, string | null> = {};
const matchFieldsMap: Record<string, string[]> = {};

if (searchQuery.length >= 2) {
  const searchResults: SearchResult[] = await cmd.searchResources(...);
  list = searchResults;
  for (const sr of searchResults) {
    bodyMap[sr.id] = sr.matchedBody;
    snippetMap[sr.id] = sr.snippet;
    matchFieldsMap[sr.id] = sr.matchFields;
  }
}

// ... 新增 state
setSnippetMap(snippetMap);
setMatchFieldsMap(matchFieldsMap);
```

返回值增加 `snippetMap` 和 `matchFieldsMap`。

- [ ] **Step 6: TypeScript 编译检查**

Run: `cd /Users/work/workspace/Shibei && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 7: Commit**

```bash
git add src/types/index.ts src/components/Sidebar/ResourceList.tsx src/components/Sidebar/ResourceList.module.css src/hooks/useResources.ts src/locales/
git commit -m "feat(search): display snippet and match type tags in resource list"
```

---

## Task 3: 预览面板重构为概览模式 [P0]

**Files:**
- Modify: `src/components/PreviewPanel.tsx:35-138`
- Modify: `src/components/PreviewPanel.module.css`
- Modify: `src/locales/zh/annotation.json`
- Modify: `src/locales/en/annotation.json`
- Modify: `src/locales/zh/sidebar.json`
- Modify: `src/locales/en/sidebar.json`

### 设计说明

当前 PreviewPanel 显示完整的标注列表（与阅读器 AnnotationPanel 重复）。重构为「概览」模式：
- **摘要区**：显示 `resource.description`（存在时），或 `plain_text` 前 200 字（需新增命令），或不显示
- **统计区**：N 条高亮 · M 条评论 · K 条笔记（一行文字）
- **标签区**：显示资料的所有标签（彩色标签）
- **快速操作**：「在阅读器中打开」按钮更突出

标注列表从 PreviewPanel 移除，只保留统计数字。用户点击统计数字或「打开」按钮进入阅读器查看完整标注。

- [ ] **Step 1: 添加 i18n 键**

`src/locales/zh/sidebar.json` 增加：
```json
"previewSummary": "摘要",
"previewStats": "{{highlights}} 条高亮 · {{comments}} 条评论 · {{notes}} 条笔记",
"previewNoDescription": "暂无摘要",
"previewOpenReader": "在阅读器中打开",
"previewTags": "标签"
```

`src/locales/en/sidebar.json` 增加：
```json
"previewSummary": "Summary",
"previewStats": "{{highlights}} highlights · {{comments}} comments · {{notes}} notes",
"previewNoDescription": "No summary",
"previewOpenReader": "Open in reader",
"previewTags": "Tags"
```

- [ ] **Step 2: 重构 PreviewPanel 组件**

替换 `PreviewPanel.tsx` 的标注列表部分（约第 64-134 行）为概览布局：

```tsx
{/* 摘要区 */}
<div className={styles.summarySection}>
  <div className={styles.sectionLabel}>{t('previewSummary', { ns: 'sidebar' })}</div>
  <p className={styles.summaryText}>
    {resource.description || t('previewNoDescription', { ns: 'sidebar' })}
  </p>
</div>

{/* 统计区 */}
<div className={styles.statsSection}>
  <span className={styles.statsText}>
    {t('previewStats', {
      ns: 'sidebar',
      highlights: highlights.length,
      comments: highlights.reduce((sum, h) => sum + getCommentsForHighlight(h.id).length, 0),
      notes: resourceNotes.length,
    })}
  </span>
</div>

{/* 标签区 */}
{tags.length > 0 && (
  <div className={styles.tagsSection}>
    <div className={styles.sectionLabel}>{t('previewTags', { ns: 'sidebar' })}</div>
    <div className={styles.tagList}>
      {tags.map(tag => (
        <span key={tag.id} className={styles.tag} style={{ backgroundColor: tag.color + '20', color: tag.color }}>
          {tag.name}
        </span>
      ))}
    </div>
  </div>
)}

{/* 打开按钮 */}
<button className={styles.openButton} onClick={() => onOpenInReader()}>
  {t('previewOpenReader', { ns: 'sidebar' })}
</button>
```

需要在组件中通过 props 或 hook 获取 tags 数据。当前 `useResources` 已返回 `resourceTags`，可以从父组件 Layout 传入。

- [ ] **Step 3: 更新 PreviewPanel CSS**

在 `PreviewPanel.module.css` 中替换标注列表相关样式：

```css
.summarySection {
  padding: var(--spacing-md) var(--spacing-lg);
  border-bottom: 1px solid var(--color-border);
}

.summaryText {
  font-size: var(--font-size-base);
  color: var(--color-text-secondary);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 6;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin: var(--spacing-xs) 0 0;
}

.statsSection {
  padding: var(--spacing-sm) var(--spacing-lg);
  border-bottom: 1px solid var(--color-border);
}

.statsText {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}

.tagsSection {
  padding: var(--spacing-sm) var(--spacing-lg);
  border-bottom: 1px solid var(--color-border);
}

.tagList {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: var(--spacing-xs);
}

.tag {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  white-space: nowrap;
}

.openButton {
  margin: var(--spacing-lg);
  padding: var(--spacing-sm) var(--spacing-lg);
  background: var(--color-accent);
  color: white;
  border: none;
  border-radius: 6px;
  font-size: var(--font-size-base);
  cursor: pointer;
  text-align: center;
  width: calc(100% - var(--spacing-lg) * 2);
}

.openButton:hover {
  background: var(--color-accent-hover);
}
```

- [ ] **Step 4: TypeScript 编译检查**

Run: `cd /Users/work/workspace/Shibei && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 5: Commit**

```bash
git add src/components/PreviewPanel.tsx src/components/PreviewPanel.module.css src/locales/
git commit -m "refactor(ui): redesign PreviewPanel as overview mode with summary and stats"
```

---

## Task 4: 阅读器 meta 栏 auto-hide [P1]

**Files:**
- Modify: `src/components/ReaderView.tsx:112-198,361-381`
- Modify: `src/components/ReaderView.module.css`
- Modify: `src/locales/zh/reader.json`
- Modify: `src/locales/en/reader.json`

### 设计说明

iframe 内容滚动时，meta 栏自动隐藏（向上滑出，CSS transform + transition）。iframe 内容滚动到顶部、或用户向上滚动时，meta 栏重新显示。通过现有的 `shibei:scroll` postMessage 事件获取滚动方向。

- [ ] **Step 1: 增强 annotator.js 的 scroll 事件传递滚动方向**

当前 `annotator.js` 发送 `shibei:scroll` 时没有携带滚动位置信息。需要增加 `scrollY` 和 `direction`：

在 `src-tauri/src/annotator.js` 的 scroll 事件处理中，修改 postMessage：

```javascript
let lastScrollY = 0;
window.addEventListener('scroll', () => {
  const currentScrollY = window.scrollY;
  const direction = currentScrollY > lastScrollY ? 'down' : 'up';
  parent.postMessage({
    type: 'shibei:scroll',
    scrollY: currentScrollY,
    direction: direction,
  }, '*');
  lastScrollY = currentScrollY;
}, { passive: true });
```

- [ ] **Step 2: ReaderView 中处理 scroll 方向控制 meta 栏显隐**

在 `ReaderView.tsx` 中：

```typescript
const [metaHidden, setMetaHidden] = useState(false);

// 在 handleMessage 中（约第 112-198 行）的 shibei:scroll case:
case "shibei:scroll": {
  // 现有逻辑：隐藏菜单
  setShowSelectionToolbar(false);
  setShowHlContextMenu(false);
  
  // 新增：根据滚动方向控制 meta 栏
  const { scrollY, direction } = msg;
  if (scrollY <= 10) {
    setMetaHidden(false); // 在顶部时始终显示
  } else if (direction === 'down') {
    setMetaHidden(true);
  } else if (direction === 'up') {
    setMetaHidden(false);
  }
  break;
}
```

在 meta 栏 JSX（约第 361 行）添加动态 className：

```tsx
<div className={`${styles.metaBar} ${metaHidden ? styles.metaBarHidden : ''}`}>
```

- [ ] **Step 3: meta 栏 auto-hide CSS 动画**

在 `ReaderView.module.css` 中修改 `.metaBar` 并添加 `.metaBarHidden`：

```css
.metaBar {
  /* 保留现有样式 */
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: 8px 16px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
  /* 新增过渡动画 */
  transition: transform 0.25s ease, opacity 0.25s ease;
  transform: translateY(0);
  opacity: 1;
}

.metaBarHidden {
  transform: translateY(-100%);
  opacity: 0;
  pointer-events: none;
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 10;
}
```

注意：当 metaBar 隐藏时需要让 iframe 区域占满，因此隐藏态改为 `position: absolute` 避免占据布局空间。需要给父容器加 `position: relative`。

- [ ] **Step 4: TypeScript 编译检查**

Run: `cd /Users/work/workspace/Shibei && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/annotator.js src/components/ReaderView.tsx src/components/ReaderView.module.css
git commit -m "feat(reader): auto-hide meta bar on scroll down, show on scroll up"
```

---

## Task 5: 阅读进度条 [P1]

**Files:**
- Modify: `src-tauri/src/annotator.js` (传递 scrollPercent)
- Modify: `src/components/ReaderView.tsx`
- Modify: `src/components/ReaderView.module.css`

### 设计说明

在阅读器顶部显示一条 2px 高的进度条，颜色使用 accent color，宽度 = 滚动百分比。

- [ ] **Step 1: annotator.js 传递滚动百分比**

在 Task 4 已有的 scroll 事件中增加 `scrollPercent`：

```javascript
window.addEventListener('scroll', () => {
  const currentScrollY = window.scrollY;
  const direction = currentScrollY > lastScrollY ? 'down' : 'up';
  const scrollHeight = document.documentElement.scrollHeight - window.innerHeight;
  const scrollPercent = scrollHeight > 0 ? Math.min(currentScrollY / scrollHeight, 1) : 0;
  parent.postMessage({
    type: 'shibei:scroll',
    scrollY: currentScrollY,
    direction: direction,
    scrollPercent: scrollPercent,
  }, '*');
  lastScrollY = currentScrollY;
}, { passive: true });
```

- [ ] **Step 2: ReaderView 显示进度条**

在 `ReaderView.tsx` 中：

```typescript
const [scrollPercent, setScrollPercent] = useState(0);

// 在 shibei:scroll handler 中增加：
setScrollPercent(msg.scrollPercent ?? 0);
```

在 reader 区域（iframe 上方）添加进度条 JSX：

```tsx
<div className={styles.readerContent}>
  <div className={styles.progressBar} style={{ width: `${scrollPercent * 100}%` }} />
  {/* meta bar */}
  {/* iframe */}
</div>
```

- [ ] **Step 3: 进度条 CSS**

```css
.readerContent {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 400px;
}

.progressBar {
  position: absolute;
  top: 0;
  left: 0;
  height: 2px;
  background: var(--color-accent);
  z-index: 20;
  transition: width 0.1s linear;
  pointer-events: none;
}
```

- [ ] **Step 4: TypeScript 编译检查**

Run: `cd /Users/work/workspace/Shibei && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/annotator.js src/components/ReaderView.tsx src/components/ReaderView.module.css
git commit -m "feat(reader): add reading progress bar at top of reader"
```

---

## Task 6: 标注面板折叠为窄条 [P1]

**Files:**
- Modify: `src/components/ReaderView.tsx`
- Modify: `src/components/ReaderView.module.css`
- Modify: `src/components/AnnotationPanel.module.css`
- Modify: `src/locales/zh/reader.json`
- Modify: `src/locales/en/reader.json`

### 设计说明

标注面板增加折叠态：折叠时只显示一条 32px 宽的窄条，窄条上显示高亮色条（每个高亮一个小色块，竖向排列）和高亮数量。点击窄条或快捷键展开。

- [ ] **Step 1: 添加 i18n 键**

`src/locales/zh/reader.json` 增加：
```json
"collapsePanel": "折叠标注面板",
"expandPanel": "展开标注面板"
```

`src/locales/en/reader.json` 增加：
```json
"collapsePanel": "Collapse annotations",
"expandPanel": "Expand annotations"
```

- [ ] **Step 2: ReaderView 增加折叠状态和切换按钮**

在 `ReaderView.tsx` 中添加：

```typescript
const [panelCollapsed, setPanelCollapsed] = useState(false);
```

在 resize handle 和 AnnotationPanel 之间：

```tsx
{panelCollapsed ? (
  <div
    className={styles.collapsedPanel}
    onClick={() => setPanelCollapsed(false)}
    title={tReader('expandPanel')}
  >
    <div className={styles.collapsedHighlights}>
      {highlights.map(h => (
        <div
          key={h.id}
          className={styles.collapsedDot}
          style={{ backgroundColor: h.color }}
        />
      ))}
    </div>
    <span className={styles.collapsedCount}>{highlights.length}</span>
  </div>
) : (
  <>
    {/* resize handle */}
    <div className={styles.resizeHandle} onMouseDown={handleResizeMouseDown}>
      <button
        className={styles.collapseBtn}
        onClick={(e) => { e.stopPropagation(); setPanelCollapsed(true); }}
        title={tReader('collapsePanel')}
      >
        ›
      </button>
    </div>
    <AnnotationPanel ... style={{ width: panelWidth }} />
  </>
)}
```

- [ ] **Step 3: 折叠态 CSS**

```css
.collapsedPanel {
  width: 32px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 0;
  gap: 4px;
  background: var(--color-bg-secondary);
  border-left: 1px solid var(--color-border);
  cursor: pointer;
  overflow-y: auto;
}

.collapsedPanel:hover {
  background: var(--color-bg-hover);
}

.collapsedHighlights {
  display: flex;
  flex-direction: column;
  gap: 3px;
  align-items: center;
}

.collapsedDot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.collapsedCount {
  font-size: 10px;
  color: var(--color-text-muted);
  margin-top: 4px;
  writing-mode: vertical-rl;
}

.collapseBtn {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  color: var(--color-text-muted);
  font-size: 14px;
  cursor: pointer;
  padding: 4px;
  opacity: 0;
  transition: opacity 0.15s;
}

.resizeHandle:hover .collapseBtn {
  opacity: 1;
}
```

- [ ] **Step 4: TypeScript 编译检查**

Run: `cd /Users/work/workspace/Shibei && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 5: Commit**

```bash
git add src/components/ReaderView.tsx src/components/ReaderView.module.css src/components/AnnotationPanel.module.css src/locales/
git commit -m "feat(reader): collapsible annotation panel with color dot summary"
```

---

## Task 7: 空状态引导设计 [P1]

**Files:**
- Modify: `src/components/Sidebar/ResourceList.tsx:286-294`
- Modify: `src/components/Sidebar/ResourceList.module.css`
- Modify: `src/components/AnnotationPanel.tsx` (标注空状态)
- Modify: `src/locales/zh/sidebar.json`
- Modify: `src/locales/en/sidebar.json`
- Modify: `src/locales/zh/annotation.json`
- Modify: `src/locales/en/annotation.json`

### 设计说明

为四种空状态添加引导文案：
1. 全新用户（无资料）→ 引导安装插件
2. 搜索无结果 → 提示调整关键词
3. 文件夹为空 → 提示拖拽或通过插件保存
4. 标注面板为空 → 提示选中文字右键高亮

- [ ] **Step 1: 添加 i18n 键**

`src/locales/zh/sidebar.json` 增加：
```json
"emptyLibraryTitle": "资料库还是空的",
"emptyLibraryHint": "安装浏览器插件，开始收集网页快照",
"noSearchResultsHint": "试试更短的关键词，或切换到「全部资料」搜索",
"emptyFolderHint": "将资料拖到此文件夹，或通过浏览器插件保存时选择此文件夹"
```

`src/locales/en/sidebar.json` 增加：
```json
"emptyLibraryTitle": "Your library is empty",
"emptyLibraryHint": "Install the browser extension to start collecting web snapshots",
"noSearchResultsHint": "Try shorter keywords, or switch to \"All Resources\" to search everywhere",
"emptyFolderHint": "Drag resources here, or select this folder when saving from the browser extension"
```

`src/locales/zh/annotation.json` 增加：
```json
"emptyAnnotationsHint": "选中文字后右键，即可创建高亮标注"
```

`src/locales/en/annotation.json` 增加：
```json
"emptyAnnotationsHint": "Select text and right-click to create highlights"
```

- [ ] **Step 2: 更新 ResourceList 空状态**

替换 `ResourceList.tsx` 约第 286-294 行的空状态逻辑：

```tsx
{folderId && !loading && filteredResources.length === 0 && (
  <div className={styles.emptyState}>
    {searchQuery.length >= MIN_SEARCH_CHARS ? (
      <>
        <div className={styles.emptyTitle}>{t('noSearchResults')}</div>
        <div className={styles.emptyHint}>{t('noSearchResultsHint')}</div>
      </>
    ) : folderId === ALL_RESOURCES_ID && totalResourceCount === 0 ? (
      <>
        <div className={styles.emptyTitle}>{t('emptyLibraryTitle')}</div>
        <div className={styles.emptyHint}>{t('emptyLibraryHint')}</div>
      </>
    ) : (
      <>
        <div className={styles.emptyTitle}>{t('emptyFolder')}</div>
        <div className={styles.emptyHint}>{t('emptyFolderHint')}</div>
      </>
    )}
  </div>
)}
```

注意：`totalResourceCount` 需要从 `useResources` 或父组件获取。可以简化为：当 `folderId === ALL_RESOURCES_ID` 且列表为空且非搜索时，显示"资料库为空"引导。

- [ ] **Step 3: 空状态 CSS**

```css
.emptyState {
  padding: 32px 24px;
  text-align: center;
}

.emptyTitle {
  font-size: var(--font-size-base);
  color: var(--color-text-secondary);
  margin-bottom: var(--spacing-xs);
}

.emptyHint {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  line-height: 1.5;
}
```

- [ ] **Step 4: 更新 AnnotationPanel 空状态**

在 `AnnotationPanel.tsx` 中，当高亮列表为空时（约第 113 行）：

```tsx
{highlights.length === 0 && !loading && (
  <div className={styles.emptyAnnotations}>
    {tAnnotation('emptyAnnotationsHint')}
  </div>
)}
```

- [ ] **Step 5: TypeScript 编译检查**

Run: `cd /Users/work/workspace/Shibei && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add src/components/Sidebar/ResourceList.tsx src/components/Sidebar/ResourceList.module.css src/components/AnnotationPanel.tsx src/locales/
git commit -m "feat(ui): add contextual empty state guidance for library, search, and annotations"
```

---

## Task 8: 资料列表信息密度提升 [P1]

**Files:**
- Modify: `src-tauri/src/db/highlights.rs` — 新增批量计数
- Modify: `src-tauri/src/db/comments.rs` — 新增批量计数
- Modify: `src-tauri/src/commands/mod.rs` — 新增 `cmd_get_annotation_counts`
- Modify: `src/lib/commands.ts` — 新增封装
- Modify: `src/types/index.ts` — AnnotationCounts 类型
- Modify: `src/hooks/useResources.ts` — 批量获取标注计数
- Modify: `src/components/Sidebar/ResourceList.tsx` — 显示标签色点 + 标注数
- Modify: `src/components/Sidebar/ResourceList.module.css`

### 设计说明

在每条资料的 meta 行中增加：
- 标签色点（资料已有的标签颜色，显示为小圆点，最多 3 个）
- 标注数量（如 "3 条高亮"），用半透明文字显示

数据获取：资料列表加载时批量查询所有可见资料的标注数，避免 N+1 问题。

- [ ] **Step 1: 后端批量计数函数**

在 `src-tauri/src/db/highlights.rs` 中添加：

```rust
/// 批量获取多个资料的高亮数量
pub fn count_by_resource_ids(
    conn: &Connection,
    resource_ids: &[String],
) -> Result<std::collections::HashMap<String, i64>, DbError> {
    if resource_ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let placeholders: Vec<String> = resource_ids.iter().enumerate().map(|(i, _)| format!("?{}", i + 1)).collect();
    let sql = format!(
        "SELECT resource_id, COUNT(*) as cnt FROM highlights WHERE resource_id IN ({}) AND deleted_at IS NULL GROUP BY resource_id",
        placeholders.join(", ")
    );
    let mut stmt = conn.prepare(&sql)?;
    let params: Vec<&dyn rusqlite::types::ToSql> = resource_ids.iter().map(|id| id as &dyn rusqlite::types::ToSql).collect();
    let rows = stmt.query_map(params.as_slice(), |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    let mut map = std::collections::HashMap::new();
    for row in rows {
        let (id, count) = row?;
        map.insert(id, count);
    }
    Ok(map)
}
```

在 `src-tauri/src/db/comments.rs` 中添加类似的 `count_by_resource_ids`。

- [ ] **Step 2: 后端命令**

在 `src-tauri/src/commands/mod.rs` 中添加：

```rust
#[tauri::command]
pub async fn cmd_get_annotation_counts(
    state: tauri::State<'_, Arc<AppState>>,
    resource_ids: Vec<String>,
) -> Result<std::collections::HashMap<String, AnnotationCount>, CommandError> {
    let conn = state.db_pool.get()?;
    let hl_counts = highlights::count_by_resource_ids(&conn, &resource_ids)?;
    let cm_counts = comments::count_by_resource_ids(&conn, &resource_ids)?;

    let mut result = std::collections::HashMap::new();
    for id in &resource_ids {
        result.insert(id.clone(), AnnotationCount {
            highlights: *hl_counts.get(id).unwrap_or(&0),
            comments: *cm_counts.get(id).unwrap_or(&0),
        });
    }
    Ok(result)
}
```

定义 `AnnotationCount`（在 commands/mod.rs 或新建类型文件）：

```rust
#[derive(Debug, Serialize)]
pub struct AnnotationCount {
    pub highlights: i64,
    pub comments: i64,
}
```

注意：需要在 `tauri::generate_handler![]` 中注册此命令。

- [ ] **Step 3: 后端测试**

```rust
#[test]
fn test_count_by_resource_ids() {
    let conn = setup_test_db();
    // 插入 2 个资料和若干高亮
    // ...
    let counts = count_by_resource_ids(&conn, &["r1".to_string(), "r2".to_string()]).unwrap();
    assert_eq!(*counts.get("r1").unwrap_or(&0), 2);
    assert_eq!(*counts.get("r2").unwrap_or(&0), 0);
}
```

- [ ] **Step 4: 运行后端测试**

Run: `cd /Users/work/workspace/Shibei && cargo test -p shibei -- --nocapture`
Expected: PASS

- [ ] **Step 5: 前端类型和命令封装**

`src/types/index.ts` 增加：

```typescript
export interface AnnotationCounts {
  highlights: number;
  comments: number;
}
```

`src/lib/commands.ts` 增加：

```typescript
export function getAnnotationCounts(resourceIds: string[]): Promise<Record<string, AnnotationCounts>> {
  return invoke("cmd_get_annotation_counts", { resourceIds });
}
```

- [ ] **Step 6: `useResources` hook 获取标注计数**

在 `src/hooks/useResources.ts` 的 `refresh` 函数中，加载资料列表后批量获取计数：

```typescript
const [annotationCounts, setAnnotationCounts] = useState<Record<string, AnnotationCounts>>({});

// 在获取 list 之后：
if (list.length > 0) {
  const counts = await cmd.getAnnotationCounts(list.map(r => r.id));
  setAnnotationCounts(counts);
} else {
  setAnnotationCounts({});
}
```

返回值增加 `annotationCounts`。

- [ ] **Step 7: ResourceList 显示标签色点和标注数**

在 `DraggableResourceItem` 的 `itemMeta` 区域中：

```tsx
<div className={styles.itemMeta}>
  <span className={styles.metaLeft}>
    {/* 标签色点 */}
    {tags.slice(0, 3).map(tag => (
      <span key={tag.id} className={styles.tagDot} style={{ backgroundColor: tag.color }} />
    ))}
    <span>{domain}</span>
  </span>
  <span className={styles.metaRight}>
    {annotationCount > 0 && (
      <span className={styles.annotationCount}>{annotationCount}</span>
    )}
    <span>{date}</span>
  </span>
</div>
```

其中 `tags` 来自 `resourceTags[resource.id]`，`annotationCount` 来自 `annotationCounts[resource.id]?.highlights`。

- [ ] **Step 8: 标签色点和标注数 CSS**

```css
.tagDot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin-right: 3px;
  vertical-align: middle;
  flex-shrink: 0;
}

.metaLeft {
  display: flex;
  align-items: center;
  gap: 2px;
  overflow: hidden;
}

.metaRight {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.annotationCount {
  font-size: 10px;
  color: var(--color-text-muted);
  background: var(--color-bg-tertiary);
  padding: 0 4px;
  border-radius: 3px;
}
```

- [ ] **Step 9: TypeScript 编译检查**

Run: `cd /Users/work/workspace/Shibei && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 10: Commit**

```bash
git add src-tauri/src/db/highlights.rs src-tauri/src/db/comments.rs src-tauri/src/commands/mod.rs src/types/index.ts src/lib/commands.ts src/hooks/useResources.ts src/components/Sidebar/ResourceList.tsx src/components/Sidebar/ResourceList.module.css
git commit -m "feat(ui): show tag dots and annotation count in resource list items"
```

---

## Task 9: 回收站体验增强 [P2]

**Files:**
- Modify: `src/components/TrashList.tsx`
- Modify: `src/components/TrashList.module.css` (如果存在，否则内联样式)
- Modify: `src/locales/zh/common.json`
- Modify: `src/locales/en/common.json`

### 设计说明

1. 回收站顶部增加提示文案「删除的资料将在 90 天后永久移除」
2. 每条删除项显示「剩余 N 天」
3. 支持多选 + 批量恢复

- [ ] **Step 1: 添加 i18n 键**

`src/locales/zh/common.json` 增加：
```json
"trashRetentionHint": "删除的资料将在 90 天后永久移除",
"trashDaysRemaining": "剩余 {{days}} 天",
"trashExpiringSoon": "即将过期",
"restoreSelected": "恢复选中 ({{count}})",
"selectAll": "全选"
```

`src/locales/en/common.json` 增加：
```json
"trashRetentionHint": "Deleted items are permanently removed after 90 days",
"trashDaysRemaining": "{{days}} days left",
"trashExpiringSoon": "Expiring soon",
"restoreSelected": "Restore selected ({{count}})",
"selectAll": "Select all"
```

- [ ] **Step 2: 计算剩余天数的工具函数**

在 `TrashList.tsx` 中添加：

```typescript
function daysRemaining(deletedAt: string): number {
  const deleted = new Date(deletedAt);
  const expiry = new Date(deleted.getTime() + 90 * 24 * 60 * 60 * 1000);
  const now = new Date();
  return Math.max(0, Math.ceil((expiry.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
}
```

- [ ] **Step 3: 更新 TrashList 显示剩余天数和提示文案**

在组件顶部添加提示横幅：

```tsx
<div className={styles.retentionHint}>
  {t('trashRetentionHint')}
</div>
```

每条删除项的日期部分改为：

```tsx
const days = daysRemaining(item.deleted_at);
<span className={days <= 7 ? styles.expiringSoon : styles.daysLeft}>
  {days <= 0 ? t('trashExpiringSoon') : t('trashDaysRemaining', { days })}
</span>
```

- [ ] **Step 4: 添加多选和批量恢复**

增加 `selectedIds` state 和全选/批量恢复按钮：

```typescript
const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

const toggleSelect = (id: string) => {
  setSelectedIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
};

const handleBatchRestore = async () => {
  for (const id of selectedIds) {
    await cmd.restoreResource(id);
  }
  setSelectedIds(new Set());
  toast.success(t('restoreSuccess'));
};
```

在列表头部添加操作栏：

```tsx
{deletedResources.length > 0 && (
  <div className={styles.batchActions}>
    <label className={styles.selectAll}>
      <input type="checkbox"
        checked={selectedIds.size === deletedResources.length}
        onChange={() => {
          if (selectedIds.size === deletedResources.length) {
            setSelectedIds(new Set());
          } else {
            setSelectedIds(new Set(deletedResources.map(r => r.id)));
          }
        }}
      />
      {t('selectAll')}
    </label>
    {selectedIds.size > 0 && (
      <button className={styles.restoreBtn} onClick={handleBatchRestore}>
        {t('restoreSelected', { count: selectedIds.size })}
      </button>
    )}
  </div>
)}
```

- [ ] **Step 5: 回收站增强 CSS**

```css
.retentionHint {
  padding: 8px 12px;
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  background: var(--color-bg-tertiary);
  border-bottom: 1px solid var(--color-border);
  text-align: center;
}

.daysLeft {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}

.expiringSoon {
  font-size: var(--font-size-sm);
  color: var(--color-danger);
}

.batchActions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  border-bottom: 1px solid var(--color-border);
}

.selectAll {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  cursor: pointer;
}

.restoreBtn {
  font-size: var(--font-size-sm);
  color: var(--color-accent);
  background: none;
  border: none;
  cursor: pointer;
  padding: 2px 8px;
}

.restoreBtn:hover {
  background: var(--color-bg-hover);
  border-radius: 4px;
}
```

- [ ] **Step 6: TypeScript 编译检查**

Run: `cd /Users/work/workspace/Shibei && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 7: Commit**

```bash
git add src/components/TrashList.tsx src/components/TrashList.module.css src/locales/
git commit -m "feat(trash): show retention days, hint banner, and batch restore"
```

---

## Task 10: Sidebar 文件夹/标签视觉区分 [P2]

**Files:**
- Modify: `src/components/Sidebar/FolderTree.tsx` (或 Sidebar 父组件)
- Modify: `src/components/Sidebar/FolderTree.module.css`
- Modify: `src/components/Sidebar/TagFilter.tsx`
- Modify: `src/components/Sidebar/TagFilter.module.css`
- Modify: `src/locales/zh/sidebar.json`
- Modify: `src/locales/en/sidebar.json`

### 设计说明

目前文件夹和标签在 Sidebar 中视觉层次相同。增加：
1. Section header 增加说明文字：文件夹 = 「位置」，标签 = 「筛选」
2. 两个 section 之间增加 16px 间距
3. 标签 section header 使用不同的图标风格（圆形 tag vs 文件夹图标）

- [ ] **Step 1: 更新 i18n 键**

`src/locales/zh/sidebar.json` 增加：
```json
"foldersSubtitle": "按位置浏览",
"tagsSubtitle": "按属性筛选"
```

`src/locales/en/sidebar.json` 增加：
```json
"foldersSubtitle": "Browse by location",
"tagsSubtitle": "Filter by attribute"
```

- [ ] **Step 2: 更新 Sidebar section header**

在文件夹 section 和标签 section 的 header 下方分别添加 subtitle：

文件夹 section（FolderTree 的 header 区域）：

```tsx
<div className={styles.sectionHeader}>
  <span className={styles.sectionTitle}>{t('folders')}</span>
  <span className={styles.sectionSubtitle}>{t('foldersSubtitle')}</span>
</div>
```

标签 section（TagFilter 的 header 区域）：

```tsx
<div className={styles.sectionHeader}>
  <span className={styles.sectionTitle}>{t('tags')}</span>
  <span className={styles.sectionSubtitle}>{t('tagsSubtitle')}</span>
</div>
```

- [ ] **Step 3: Section header CSS**

```css
.sectionHeader {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 8px 12px 4px;
}

.sectionSubtitle {
  font-size: 10px;
  color: var(--color-text-muted);
  font-weight: normal;
}
```

确保两个 section 之间有足够间距（标签 section 的 `margin-top: 16px`）。

- [ ] **Step 4: TypeScript 编译检查**

Run: `cd /Users/work/workspace/Shibei && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 5: Commit**

```bash
git add src/components/Sidebar/ src/locales/
git commit -m "feat(sidebar): add subtitles to distinguish folders and tags sections"
```

---

## 验证清单

实施完所有 Task 后：

- [ ] `cargo check` 和 `cargo clippy` 无错误无警告
- [ ] `npx tsc --noEmit` 无错误
- [ ] `cargo test -p shibei` 全部通过
- [ ] 手动验证：搜索结果显示 snippet 和匹配类型标签
- [ ] 手动验证：预览面板显示摘要 + 统计 + 标签 + 打开按钮
- [ ] 手动验证：阅读器向下滚动 meta 栏隐藏，向上滚动显示
- [ ] 手动验证：阅读进度条跟随滚动
- [ ] 手动验证：标注面板可折叠为窄条
- [ ] 手动验证：空状态引导文案正确显示（新用户、搜索无结果、空文件夹、空标注）
- [ ] 手动验证：资料列表显示标签色点和标注数量
- [ ] 手动验证：回收站显示剩余天数和提示文案，批量恢复可用
- [ ] 手动验证：深色模式下所有新增样式正常
- [ ] 手动验证：中英文切换所有新增文案正确
