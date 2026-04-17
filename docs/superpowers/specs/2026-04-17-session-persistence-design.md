# Session Persistence 设计文档

**日期**：2026-04-17
**范围**：前端会话状态持久化（Tab、滚动、资料库选中）+ 启动时 Reader Tab 懒挂载

## 背景

当前 Shibei 每次关闭后，`App.tsx` 的 `readerTabs`、`activeTabId`，`Layout.tsx` 的
`selectedFolderId` / `selectedTagIds` / `selectedResource` 等 UI 状态都存在 React
useState 中，关闭即丢。用户希望"重新打开能回到上次的现场"：哪些 Tab 开着、哪个
Tab 激活、每个 Reader Tab 滚到哪里、资料库选的文件夹和标签、预览面板选的资料。

同时，一次性挂载全部 Reader Tab 的 iframe（[src/App.tsx:253-260](../../../src/App.tsx#L253-L260)
目前就是全部挂载、用 CSS 隐藏）在 Tab 很多时会明显拖慢启动。本次顺带把这里改成
懒挂载。

## 目标与非目标

### 目标

- 启动时恢复：打开的 Reader Tab 列表（含顺序）、激活的 Tab、每个 Reader Tab 的
  滚动位置、资料库的 `selectedFolderId` / `selectedTagIds` / `selectedResourceId`
- 状态变化时**实时节流保存**到 `localStorage`（不依赖"退出前保存"这类不可靠机制）
- 失效 Tab（资料被删）静默丢弃；其他情况（标题改、被移文件夹）用当前最新数据渲染
- 锁屏开启时先锁住 UI，用户解锁后再恢复 Tab 内容
- Reader Tab 懒挂载：首次被激活时才渲染 `<ReaderView>`，之后保留在 DOM 中（沿用
  现有"CSS 隐藏式 Tab 切换"保状态的思路）

### 非目标

- 不恢复 `settingsOpen`（Settings 是任务性 Tab，下次启动不需要自动回到）
- 不恢复搜索框文字（一次性输入，恢复反而令人困惑）
- 不恢复锁屏状态（启动一律按配置锁回去）
- 不持久化 Tab 数量上限（个人工具场景无需）
- 不做 Tab 上的滚动进度条、不做资料列表的"上次离开处"锚点（用户明确不要，反复
  阅读场景下是干扰）
- 不做"最近关闭的 Tab"恢复（本次不做，未来可加）

## 存储方案

### 单一 localStorage key

**key**：`shibei-session-state`
（与既有 `shibei-sidebar-width`、`shibei-list-width`、`shibei-annotation-width`、
`shibei-theme`、`shibei-language` 命名风格一致）

**结构**：

```ts
interface SessionState {
  version: 1;
  activeTabId: string;                         // resource_id | "__library__" | "__settings__"
  readerTabs: ReaderTabState[];                // 顺序即 Tab 顺序
  library: LibraryState;
}

interface ReaderTabState {
  resourceId: string;
  scrollY?: number;                            // HTML 资料
  pdfPage?: number;                            // PDF 资料（页码 1-based）
  pdfScrollFraction?: number;                  // PDF 当前页内的滚动分数 0..1
}

interface LibraryState {
  selectedFolderId: string | null;             // ALL_RESOURCES_ID / INBOX_FOLDER_ID / folder_id
  selectedTagIds: string[];
  selectedResourceId: string | null;           // 预览面板上次选中的资料
}
```

`scrollY` vs `pdfPage+pdfScrollFraction` 二选一：根据 `Resource.resource_type`
决定读写哪个字段，类型上都是可选。

### 写入时机

- **立即写**（未经 debounce）：Tab 增/删/切换、文件夹切换、标签选择变化、预览面板
  选中变化
- **500ms debounce**：HTML iframe 和 PDF 的滚动事件
- 模块内维护一份内存 mirror，每次 patch 先改 mirror 再整体 `JSON.stringify` +
  `localStorage.setItem`，避免多模块并发 patch 互相覆盖。对外暴露三种细粒度 API：
  - `saveSessionState(patch: Partial<SessionState>)`：顶层字段浅合并（例如
    `{ activeTabId }` 不会覆盖 `readerTabs`）
  - `updateReaderTab(resourceId, patch: Partial<ReaderTabState>)`：按 id 定位
    tab，只改指定字段，tab 不存在则追加到末尾
  - `removeReaderTab(resourceId)`：从数组中删除
  Reader tab 的数组顺序（如打开新 Tab 的插入位置、未来的拖拽重排）通过
  `saveSessionState({ readerTabs })` 整体覆写

### 读取时机

- 只在 App/Layout mount 时各读一次（Layout 读 `library` 部分，App 读 Tab 部分）
- 后续运行时不再读——以内存 state 为真相源

### 失败与版本处理

- 解析 JSON 失败、或 `version` 不匹配 → 丢弃整个 state 回到默认；不抛异常
- `localStorage.setItem` 抛异常（配额等）→ 静默吞掉，不打断用户操作

## 恢复流程

### App 启动

[src/App.tsx](../../../src/App.tsx) 启动时：

1. 读 `shibei-session-state`；失败/缺失 → 用默认初值（`activeTabId = __library__`、
   空 `readerTabs`）
2. 对每个 `readerTabs[i].resourceId` 调 `cmd.getResource(id)`（并发 `Promise.all`）
   - 返回 null / 抛错 → 跳过这个 Tab（失效）
   - 返回 Resource → 保留，填入 `readerTabs` Map，记录初始 `scrollY` /
     `pdfPage` / `pdfScrollFraction` 作为"首次挂载后要应用的滚动请求"
3. 计算最终 `activeTabId`：
   - 若是 `__settings__` → 回落到 `__library__`（我们不恢复 Settings）
   - 若是一个被丢弃的 resource_id → 回落到 `__library__`
   - 否则保持原值
4. **锁屏场景**：如果 `lockEnabled && locked`，上述恢复照常发生，但由于
   `<LockScreen />` 覆盖在最上层，用户看不到内容。解锁后 UI 自然显露即可，无需
   额外处理

### Library 启动

[src/components/Layout.tsx](../../../src/components/Layout.tsx) mount 时：

1. 读 `shibei-session-state.library`；失败/缺失 → 默认（`ALL_RESOURCES_ID`、空标签
   集、无预览选中）
2. `selectedFolderId`：如果不是 `ALL_RESOURCES_ID` / `INBOX_FOLDER_ID`，校验对应
   folder 是否存在；不存在 → 回落到 `INBOX_FOLDER_ID`
3. `selectedTagIds`：不校验；如果某个 tag 被删了，后端 SQL 查不到就自然不匹配，
   不影响功能（等用户自己去掉或者后续清理）
4. `selectedResourceId`：启动时不主动校验；若已被删，`ResourceList` 正常不显示即
   失焦，预览面板显示空状态

### 滚动位置恢复

**HTML 资料**（iframe + annotator.js）：

现状：[src-tauri/src/annotator.js:651](../../../src-tauri/src/annotator.js#L651)
在就绪后 postMessage `shibei:annotator-ready`。

扩展：在 annotator.js 的 message listener 中新增一个入站消息类型
`shibei:restore-scroll`（payload: `{ scrollY: number }`），收到后调
`window.scrollTo(0, scrollY)`（不要 smooth）。

React 侧 [src/components/ReaderView.tsx](../../../src/components/ReaderView.tsx)：
- 新增 prop `initialScrollY?: number`（由 App.tsx 透传）
- 收到 `shibei:annotator-ready` 时，如果有 `initialScrollY` 且未应用过，立刻
  postMessage `shibei:restore-scroll` 给 iframe
- iframe 内每次滚动通过现有 `shibei:scroll` 消息上报 `scrollY`，ReaderView 里
  debounce 500ms 调 `sessionState.updateReaderTab(resourceId, { scrollY })`

**PDF 资料**（PDFReader）：

现状：[src/components/ReaderView.tsx:54](../../../src/components/ReaderView.tsx#L54)
已有 `pdfScrollRequest` 机制用于高亮跳转。

扩展：把 `pdfScrollRequest` 的 payload 从"只携带高亮 id"扩展为联合类型：

```ts
type PdfScrollRequest =
  | { kind: "highlight"; id: string; ts: number }
  | { kind: "position"; page: number; fraction: number; ts: number };
```

- 初次 mount 时：若有 `initialPdfPage`（prop），`PDFReader.onReady` 后设置
  `pdfScrollRequest = { kind: "position", page, fraction, ts: Date.now() }`
- PDFReader 在收到 `kind: "position"` 请求时：滚到对应 page 的顶部 + 加上
  `fraction * pageHeight` 的偏移
- 现有高亮跳转路径继续走 `kind: "highlight"`，不受影响
- PDFReader 在滚动过程中用现有的跨页滚动监听上报 "当前 page + 页内 fraction"，
  ReaderView 里 debounce 500ms 写回 session state

### Tab 懒挂载

当前 [src/App.tsx:253-260](../../../src/App.tsx#L253-L260) 一次性渲染所有
`readerTabs`。改成：

- 用 `useState<Set<string>>` 维护 `mountedTabIds`（需要触发重渲染），初值包含
  当前激活的 resource tab（如果激活的是 Library/Settings 则为空集）
- `setActiveTabId(id)` 前或同时：如果 `id` 对应 reader tab 且不在 `mountedTabIds`
  → 先加进集合触发挂载，再切换 active
- JSX 里只渲染 `mountedTabIds` 里的 tab `<div>`；关闭 Tab 时从集合中移除
- Tab 关闭后应当卸载（移除 DOM），因为我们已经把滚动位置写回 localStorage，
  状态不会丢

这样 10 个 Tab 的 session，启动时只挂载 1 个 iframe，其余按需挂载。

## 组件与文件变更

新增：

- [src/lib/sessionState.ts](../../../src/lib/sessionState.ts)：纯函数 + 类型。
  `loadSessionState()`、`saveSessionState(patch)` 内部节流、`updateReaderTab(id, patch)`、
  `removeReaderTab(id)`、`clearSessionState()`
- [src/lib/sessionState.test.ts](../../../src/lib/sessionState.test.ts)：版本校验、
  坏数据兜底、节流合并、patch 不覆盖其它字段

修改：

- [src/App.tsx](../../../src/App.tsx)：启动读 session 并恢复 readerTabs/activeTabId；
  `openResource` / `closeTab` / `setActiveTabId` 中同步写 session；`mountedTabIds`
  懒挂载逻辑；监听 `data:resource-changed deleted` 时额外调 `removeReaderTab`
- [src/components/Layout.tsx](../../../src/components/Layout.tsx)：启动读
  `session.library`；`selectedFolderId` / `selectedTagIds` / `selectedResource`
  变化时写回。校验 folder 存在性
- [src/components/ReaderView.tsx](../../../src/components/ReaderView.tsx)：新增
  `initialScrollY?`、`initialPdfPage?`、`initialPdfScrollFraction?` prop；扩展
  `pdfScrollRequest` 联合类型；滚动上报处 debounce 写 session
- [src/components/PDFReader.tsx](../../../src/components/PDFReader.tsx)：支持
  `kind: "position"` 滚动请求；持续上报"当前 page + 页内 fraction"回调
- [src-tauri/src/annotator.js](../../../src-tauri/src/annotator.js)：新增入站
  `shibei:restore-scroll` 消息处理

## 数据事件联动

- `data:resource-changed action=deleted` → 从 `readerTabs` 移除 + `removeReaderTab`
  清理 localStorage 中对应条目（App.tsx 已有监听，扩展即可）
- `data:folder-changed action=deleted` → 如果 `library.selectedFolderId` 是被删
  folder，内存 state 回落到 `INBOX_FOLDER_ID`，同时写回 session
- `data:tag-changed action=deleted` → 从 `library.selectedTagIds` 里移除对应 id

## 错误处理

- localStorage 读失败（被清、私密模式、配额损坏）→ 按首次启动处理
- localStorage 写失败（超配额）→ 静默（本次数据极小，几乎不会触发）
- 资料加载失败 → 静默丢弃 Tab，不弹 toast（避免每次启动打扰）
- iframe/PDF 挂载失败 → 保留滚动位置条目，下次重试可用

## 测试

### 单元测试（Vitest）

`sessionState.test.ts`：

- `loadSessionState`：空/坏 JSON/旧 version → 返回默认
- `loadSessionState`：合法 v1 → 原样返回
- `saveSessionState` 浅合并：只给 `activeTabId` 不覆盖 `readerTabs`
- `updateReaderTab`：更新已有 tab 的 scrollY 保持其它字段
- `removeReaderTab`：移除后 activeTabId 对应已删 tab 时回落逻辑

### React 测试（Vitest + RTL）

- App.tsx：mock localStorage + `cmd.getResource`，断言失效 Tab 被丢弃，合法 Tab
  被挂载
- App.tsx：懒挂载——session 含 3 个 tab 时只渲染 active 那个的 `<ReaderView>`

### 手动验证清单

- [ ] 开 3 个 HTML Tab + 1 个 PDF Tab，滚到不同位置 → 关开 App → 全部恢复、
      滚动位置一致、激活 Tab 一致
- [ ] 关 App 前激活 Settings → 重开后 Settings 不出现，激活回落 Library
- [ ] 关 App → 从另一端（或手动 SQL）删掉一个已开 Tab 的资料 → 重开 App →
      该 Tab 消失，不报错，其他 Tab 正常
- [ ] 锁屏开启时关开 App → 启动显示锁屏 → 解锁后看到恢复的 Tab 状态
- [ ] 资料库选中某 folder + 2 个 tag + 某预览资料 → 关开 App → 全部恢复
- [ ] 上次选中的 folder 被删 → 重开 App → 回落到收件箱，不报错
- [ ] 10 个 Tab 的 session 冷启动 → 只有 active Tab 的 iframe 被挂载（通过
      DevTools 检查 DOM 和网络请求）

## 文件体量预估

全部前端改动。主要的文件：

- `sessionState.ts` 约 120 行（含类型）
- `App.tsx` +60 行
- `Layout.tsx` +30 行
- `ReaderView.tsx` +40 行
- `PDFReader.tsx` +20 行
- `annotator.js` +8 行

没有任何 Rust 后端改动，没有 DB schema 变化，没有新依赖。
