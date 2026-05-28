# 问题（Questions）导航重设计 — 设计文档

**日期**：2026-05-28
**范围**：把"问题"从 Sidebar 子分区提升为与文件夹平级的**库模式（library mode）**，桌面端中间栏承载问题列表、第三栏承载问题详情预览；移动端把问题作为 Library 页面的第二种列表视图、保留抽屉入口不变。
**关联文档**：
- 问题系统数据模型：`docs/superpowers/specs/2026-05-27-questions-system-design.md`
- 会话持久化：`docs/superpowers/specs/2026-04-17-session-persistence-design.md`
- 数据事件机制：`docs/superpowers/specs/2026-04-03-unified-data-events-design.md`

## 背景与动机

问题系统 Phase 1 上线后，UI 形态是：
- 桌面端 `Sidebar` 下方一个 `QuestionSection`，直接铺开 active + archived 两个折叠组的完整列表
- 单击问题 → 直接 `openQuestion()` 新开/激活 `q:<id>` Tab
- 移动端 `pages/Questions.ets` 是独立全屏页（从 FolderDrawer 底部跳入）

两个体验问题：

1. **Sidebar 信息密度过高**：当问题数 > ~15 时，问题列表占据大半 Sidebar 高度，挤压文件夹树；用户每次想浏览问题都要先滚动找到位置
2. **单击即开 Tab 太重**：用户经常想"扫一眼这个问题里关联了啥"，没必要每次都污染 Tab 栏。资料的浏览模型是"中栏列表 + 第三栏预览"，问题没有对应的轻量浏览路径
3. **问题列表 UX 跟资料列表割裂**：资料用顶部搜索框 + 标签筛选 + 扁平列表；问题用嵌套折叠组。两套模式增加用户认知负担

本次重设计目标：让"问题"和"文件夹"成为 Sidebar 的两类等价**导航源**，中间栏内容随选中的导航源切换；问题列表的 UX 向资料列表对齐（顶部 chip 筛选、扁平列表、单击预览 / 双击进 Tab）。

## 目标与非目标

### 目标

- 桌面端：Sidebar 下移一个**单行入口**"问题"，与文件夹平级；点击切换中间栏到"问题列表"
- 桌面端：新增 `QuestionList` 组件，**顶部 chip 筛选**（进行中 / 已归档 / 全部）+ 搜索 + 创建按钮 + 扁平列表
- 桌面端：**单击问题 → 在 PreviewPanel 显示详情**；**双击 → 开 Tab**（保留现有 Tab 机制）
- 桌面端：搜索受 chip 约束（在当前筛选范围内搜）
- 桌面端：保留并改造 Library 模式下的"问题命中 chip"：单击切到 questions 模式 + select，双击开 Tab
- 桌面端：创建新问题后落到 questions 模式 + select + preview（不再默认开 Tab）
- 桌面端：PreviewPanel 复用 `QuestionDetailView` 加 `variant: "tab" | "preview"`，preview 全功能可编辑
- 桌面端：session 持久化新增 `library.mode` / `library.questionFilter` / `library.selectedQuestionId` / `library.questionListScrollTop`
- 移动端：删除 `pages/Questions.ets`，问题列表下沉为 Library 页的第二种 view；`FolderDrawer` 底部"问题"行**保留原位**，点击改为 `closeDrawer() + setMode('questions')`
- 移动端：问题列表 UX 与桌面对齐（顶部 chip 筛选 + 搜索 + FAB + 扁平列表）；**单击仍 push QuestionDetail**（移动端无 preview）

### 非目标

- 问题排序 UI（按更新时间倒序硬编码，未来再加）
- 问题列表的多选 / 批量操作
- Sidebar 入口右键菜单（"新建问题"等便捷动作）—— 改用进入模式后的 + 按钮
- 问题置顶 / 收藏（Phase 1 没有 pinned 概念，不引入）
- 修改 Tab 行为：双击开 Tab / `q:<id>` 前缀 / `mountedTabIds` 懒挂载 / `questionTabs[]` session 持久化等机制完全不动
- 修改 Phase 1 的数据模型 / 后端 / 事件 / NAPI / MCP —— 这是纯前端 UI 重组

## 桌面端设计

### 模式（mode）模型

在 `Layout` 层引入 `libraryMode: "resources" | "questions"`，决定中间栏渲染哪个组件。**Sidebar 的当前选中项决定 mode**：

- 用户点 Sidebar 文件夹 → `mode = "resources"`，记录 `selectedFolderId`
- 用户点 Sidebar "问题"入口 → `mode = "questions"`
- mode 与各自的选中状态在 session 里独立持久化，切回去能恢复

不引入"标签页式 mode 切换器"——本质就是导航源选谁、中间栏看谁，跟今天点不同 folder 切列表是同一个心智模型。

### Sidebar 入口

在 FolderTree 区块与 Trash 之间插入单行：

```
┌───────────────────────┐
│ 📁 文件夹              │
│   收件箱              │
│   Folder A            │
│   Folder B            │
│ ────────────          │  separator
│ ❓ 问题   12          │  ← 单击切到 questions 模式
│ 🗑 回收站              │
└───────────────────────┘
```

- 计数：active 问题数量（沿用 `useQuestions().active.length`）
- 选中样式：当 `libraryMode === "questions"` 时高亮（沿用 folder 选中样式 token，保持视觉一致）
- 无展开 / 折叠 / 嵌套
- 不放右键菜单（Phase 1 的右键"在 Sidebar 内创建问题"功能放到中间栏头部 + 按钮）
- 现有 `QuestionSection.tsx` 删除；`QuestionItem.tsx` 搬到 `src/components/QuestionList/` 复用作为列表行

### 中间栏 `QuestionList`（新组件）

镜像 `ResourceList` 的结构：

```
┌────────────────────────────────────┐
│ [🔍 搜索问题...]            [ + ]   │  sticky 顶部
│ [ 进行中 12 ] [ 已归档 4 ] [ 全部 ]  │  sticky filter chip 行（单选）
├────────────────────────────────────┤
│ ● Question 1                        │
│ ● Question 2  ← selected            │
│ ● Question 3                        │
│ ● Question 4                        │
└────────────────────────────────────┘
```

#### 筛选 chip

- 单选语义（三选一），默认 "进行中"
- 数量 badge：
  - 进行中 → `useQuestions().active.length`
  - 已归档 → `useQuestions().archived.length`
  - 全部 → `active.length + archived.length`
- 当前 chip 选择持久化进 session：`library.questionFilter: "active" | "archived" | "all"`

#### 搜索框

- 与 `ResourceList` 搜索框样式 / debounce 一致（300ms）
- ≥ 2 字符走 `cmd_search_questions`
- **搜索受 chip 约束**：搜索命中结果按当前 chip 二次过滤（"在当前筛选范围内搜"），UX 上等价于"在当前列表里找"，跟资料的"在当前 folder 里搜"心智一致
- 搜索时列表替换为命中结果；不再分组、不再额外渲染"搜索结果"标头（沿用 `ResourceList` 行为）

#### + 创建按钮

- 头部右上角，与搜索框同行
- 打开既有 `QuestionEditDialog`
- 创建成功 →
  1. 自动切到 chip "进行中"（如果当前在"已归档"/"全部"，避免新创建的问题在用户视线外）
  2. 自动 `setSelectedQuestionId(newId)`，第三栏 PreviewPanel 立即显示
  3. **不再自动开 Tab**（与原 `QuestionSection` 行为不同；用户要进 Tab 再双击或在 preview 里点"在 Tab 中打开"）

#### 列表行

复用现有 `QuestionItem.tsx`，新增 `selected: boolean` prop 控制高亮（沿用 `ResourceList` 选中行样式）。事件：

```ts
onClick(question)         // 单击 → setSelectedQuestionId
onDoubleClick(question)   // 双击 → openQuestion (开 Tab)
onContextMenu(question)   // 右键 → 既有 context menu
```

右键菜单复用现有项："在新 Tab 打开" / 编辑 / 复制链接 / 归档/取消归档 / 删除。

#### 滚动 / 持久化

- 列表容器 `overflow-y: auto`；scrollTop 写 `library.questionListScrollTop`，300ms debounce
- 列宽继续吃 `shibei-sidebar-width` localStorage 旁边的 `shibei-list-width`（同一 key，mode 无关——用户对"中间栏宽度"有肌肉记忆）

### 第三栏 PreviewPanel — 问题预览

`PreviewPanel.tsx` 在 mode 切换时分支渲染：

- `mode === "resources"` && `selectedResource` → 现有资料预览（不变）
- `mode === "questions"` && `selectedQuestion` → 渲染 `QuestionDetailView` with `variant="preview"`
- 否则空态 placeholder（"选择问题以查看详情" / "选择资料以查看摘要"）

#### `QuestionDetailView` 的 `variant` prop

新增 `variant: "tab" | "preview"`，默认 `"tab"`（不破坏既有 Tab 渲染路径）。差异：

| 属性 | `"tab"` | `"preview"` |
|---|---|---|
| 关闭按钮 | 显示（关 Tab） | 不显示 |
| "在 Tab 中打开 ↗" 按钮 | 不显示 | 显示在标题栏右侧 |
| 内边距 | 现状 | 稍紧 |
| 编辑 / 解除链接 / 编辑 reason | 可用 | 可用（**全功能**） |
| 点击 link 跳资料 | 走 `onOpenResource` | 走 `onOpenResource`（同行为） |

"在 Tab 中打开 ↗" 按钮调用 `openQuestion(currentQuestion)`，跟双击列表行等价。

### 搜索行为详解

#### Library 模式（resources）

- 中间栏搜索框搜资料（保持现状）
- 搜索结果顶部仍渲染"问题命中 chip 行"
- **chip 单击行为变更**：从"开问题 Tab"改为 `setMode("questions") + setSelectedQuestionId(q.id)`（PreviewPanel 立即显示问题预览，无需开 Tab）
- **chip 双击行为新增**：`openQuestion(q)`（开 Tab）—— 给希望深入工作的用户保留快速路径
- chip 右键菜单：可保留"在新 Tab 打开"项，不强求

#### Questions 模式

- 搜索框只搜问题
- 搜索结果**叠加** chip 筛选（i.e. 选"进行中" + 搜 "可观测性" → 仅返回进行中且匹配的问题）
- 不再叠加"资料命中 chip"——切换 mode 才能搜资料，避免双向漂移

### 创建新问题的落点

- Sidebar 入口无创建动作（Phase 1 那个"右键 → 新建问题"功能搬走）
- `QuestionList` 头部 + 按钮：创建后 → questions 模式 + 进行中 chip + select + preview
- `ResourceList` 右键"关联到问题"子菜单里"新建问题并关联"路径：保持现状（创建后自动建关联）；不切 mode、不开 Tab、不抢焦点（用户的注意力在资料上）
- Deep link `shibei://open/question/{id}`：保持开 Tab 行为（外部链接进来用户预期是直接进详情）

### Session 持久化 schema

`src/lib/sessionState.ts` 升 schema version → 2，新增字段：

```ts
interface SessionStateV2 {
  version: 2;
  activeTabId: string;
  readerTabs: ReaderTabState[];
  questionTabs: QuestionTabState[];           // 不变
  library: {
    // 共享
    mode: "resources" | "questions";          // 新增；默认 "resources"
    // resources 模式
    selectedFolderId: string | null;
    filterTagIds: string[];
    selectedResourceId: string | null;
    resourceListScrollTop: number;            // 旧 listScrollTop → 重命名
    // questions 模式
    questionFilter: "active" | "archived" | "all";  // 新增；默认 "active"
    selectedQuestionId: string | null;        // 新增
    questionListScrollTop: number;            // 新增
  };
}
```

#### 迁移规则（v1 → v2）

读取时若 `version !== 2`：

- `library.mode` 缺失 → 默认 `"resources"`
- `library.listScrollTop` 旧字段 → 拷到 `resourceListScrollTop`，旧 key 不删除（下次写入时按新 schema 覆盖即清掉）
- `library.questionFilter` 缺失 → `"active"`
- `library.selectedQuestionId` 缺失 → `null`
- `library.questionListScrollTop` 缺失 → `0`

整个迁移走静默兜底；解析失败 / 任何字段类型错 → 整体回落 DEFAULT_STATE（沿用现有"坏 JSON 不阻塞启动"原则）。

### Layout / 状态管理改动

`Layout.tsx` 状态扩展：

```ts
const [mode, setMode] = useState<"resources" | "questions">(initial.library.mode);
const [questionFilter, setQuestionFilter] = useState(initial.library.questionFilter);
const [selectedQuestionId, setSelectedQuestionId] = useState(initial.library.selectedQuestionId);
```

写入 sessionState：mode / questionFilter / selectedQuestionId 变更立即写；questionListScrollTop 300ms debounce（与 resourceListScrollTop 对齐）。

事件订阅：
- `QUESTION_CHANGED`：若被删除的问题正是 `selectedQuestionId`，置空（避免 preview 空指针）
- 不订阅 `QUESTION_LINK_CHANGED`（由 `QuestionDetailView` 内部处理）

### Sidebar 反向交互

用户在 questions 模式下点 sidebar 任意 folder：
- `setMode("resources")` + `setSelectedFolderId(folderId)`
- `selectedQuestionId` 保留在 session 里**不清空**（切回 questions 模式时恢复）

用户在 resources 模式下点 sidebar "问题"入口：
- `setMode("questions")`
- `selectedFolderId / filterTagIds` 保留

切换是**双向无损**的——session 让两种模式各自的状态独立活在 session 里。

### 受影响文件清单（桌面端）

新增：
- `src/components/QuestionList/QuestionList.tsx`
- `src/components/QuestionList/QuestionList.module.css`
- `src/components/QuestionList/QuestionFilterChips.tsx` + `.module.css`
- `src/components/QuestionList/QuestionListItem.tsx`（从原 `Sidebar/QuestionItem.tsx` 搬过来；保留接口）

修改：
- `src/components/Layout.tsx`：mode 分支 + 第三栏 preview 分支 + sidebar 入口 prop 传递
- `src/components/Sidebar/Sidebar.tsx`：移除 `<QuestionSection>`，插入"问题"入口行
- `src/components/PreviewPanel.tsx`：新增 questions 模式分支，渲染 `<QuestionDetailView variant="preview">`
- `src/components/QuestionDetail/QuestionDetailView.tsx`：加 `variant?: "tab" | "preview"` prop，按 variant 切换 chrome
- `src/components/ResourceList.tsx`：问题命中 chip 单击 / 双击行为变更（接 `onSelectQuestion` 和 `onOpenQuestion` 两个 callback）
- `src/lib/sessionState.ts`：schema v2 + 迁移
- `src/App.tsx`：把新增的 `setMode / setSelectedQuestionId / setQuestionFilter` 用于响应 `cmd_create_question` 之后的"切模式 + select"逻辑；deep link `shibei://open/question/{id}` 路径不变
- `src/locales/{zh,en}/sidebar.json`：新增 "问题" 入口文案（如已存在则复用）
- `src/locales/{zh,en}/question.json`：新增 chip 文案 / preview 模式按钮文案

删除：
- `src/components/Sidebar/QuestionSection.tsx`（功能完全拆走）
- `src/components/Sidebar/QuestionSection.module.css`

不动：
- 后端 / NAPI / MCP / 同步 / DB / 事件常量
- `questionTabs[]` 持久化机制
- `QuestionLinkItem` 组件
- Deep link 解析（`src/lib/deepLink.ts`）

## 移动端设计

### 整体思路

桌面端"Sidebar 入口 → 中间栏切换"的语义，在移动端的最自然映射是：
- **抽屉（FolderDrawer）= 桌面 Sidebar**（导航源）
- **Library 主区 = 桌面中间栏**（内容）
- 抽屉里点"问题"行 → 关闭抽屉 + Library 主区切换到问题列表，**不再 push 新页面**

用户体感：跟点了个不同的"目录"一样，只是这个"目录"里装的是问题。

### `FolderDrawer.ets`

- 底部"问题"行**保留原位**，不动 UI 布局
- 点击行为从 `router.pushUrl pages/Questions` 改成：
  ```
  closeDrawer()
  Library.setMode('questions')
  ```
- 行高亮状态联动 `libraryMode`：
  - `mode === 'resources'`：folder items 按 `selectedFolderId` 高亮，"问题"行不亮
  - `mode === 'questions'`：folder items 全部不亮，"问题"行高亮
- 抽屉始终如实反映"用户在看什么"

### `pages/Library.ets`

- 新增 `@State libraryMode: 'resources' | 'questions' = 'resources'`
- 主区按 mode 分支：
  - `'resources'` → 现有资料列表（ResourceListView builder）
  - `'questions'` → 新增 `QuestionListView` builder
- `libraryMode` 通过 `SessionState` 持久化（与桌面字段名对齐）
- `aboutToAppear` 读 session 恢复 mode；进入 Library 后若 deep link `shibei://open/folder/...` 触发，自动 `setMode('resources')`
- `setMode(next)` 是 Library 暴露给 FolderDrawer 的方法（既有架构里 FolderDrawer 已经能调 Library 的回调）

### `@Builder QuestionListView()`

布局参考桌面 QuestionList，但用 ArkUI 原语：

```
┌─────────────────────────────────────┐
│ [🔍 搜索问题...]                     │  TextInput
│ [ 进行中 12 ] [ 已归档 4 ] [ 全部 ] │  Row + 3 个 chip Button
├─────────────────────────────────────┤
│ ● Question 1                         │
│ ● Question 2                         │
│ ● Question 3                         │
│                                  [+] │  FAB（右下浮动）
└─────────────────────────────────────┘
```

- 数据源：现有 `QuestionService.subscribeList()`（不变）
- 筛选：复用桌面 `questionFilter` 字段名，session 共享
- 列表行：单击 → `router.pushUrl({ url: 'pages/QuestionDetail', params: { id } })`（**移动端没有 preview，仍直接进详情页**）
- 长按 → 现有 dialog 菜单（编辑 / 复制链接 / 归档 / 删除 / 取消）
- FAB：右下角浮动 + 按钮 → `gotoCreate()` → push `pages/QuestionEdit`（创建模式）
- 搜索：复用桌面端 `cmd_search_questions` 通过 NAPI（已有同名命令）；筛选 chip 与搜索同时生效

### 删除 `pages/Questions.ets`

- 入口已迁移到 Library 内 view
- 路由表清掉
- `EntryAbility.onCreate` / `Library.consumePendingDeepLink` 等位置如有 hardcoded path 同步清理（grep 后 case-by-case 处理）
- 旧 deep link `shibei://open/question/{id}` 仍直接 push `pages/QuestionDetail`（语义不变）

### Session 持久化（移动端）

`SessionState.ets` 新增字段（与桌面字段同名）：

```ts
{
  inReader: boolean,
  readerResourceId: string | null,
  library: {
    mode: 'resources' | 'questions',           // 新增
    selectedFolderId: string | null,
    selectedTagIds: string[],
    selectedResourceId: string | null,
    questionFilter: 'active' | 'archived' | 'all',  // 新增
  }
}
```

- 列表 scrollTop 移动端 v1 不实现持久化（既有也没做，先保留 parity）
- 迁移：旧 session 字段缺失静默兜底，同桌面规则

### 受影响文件清单（移动端）

新增：
- `shibei-harmony/entry/src/main/ets/components/QuestionListView.ets`（或作为 Library.ets 内 `@Builder`，二选一，前者更解耦）
- `shibei-harmony/entry/src/main/ets/components/QuestionFilterChips.ets`

修改：
- `shibei-harmony/entry/src/main/ets/pages/Library.ets`：mode 状态 + view 分支 + setMode 方法
- `shibei-harmony/entry/src/main/ets/components/FolderDrawer.ets`：问题行点击改为 `closeDrawer + setMode('questions')`；高亮联动
- `shibei-harmony/entry/src/main/ets/app/SessionState.ets`：schema 加字段
- `shibei-harmony/entry/src/main/ets/entryability/EntryAbility.ets`：若有 hardcoded `pages/Questions` 路径需清理
- `shibei-harmony/entry/src/main/resources/{zh_CN,en_US,base}/element/string.json`：chip 文案 key

删除：
- `shibei-harmony/entry/src/main/ets/pages/Questions.ets`
- `shibei-harmony/entry/src/main/resources/base/profile/main_pages.json` 中的对应路由

不动：
- `pages/QuestionDetail.ets` / `pages/QuestionEdit.ets`
- `services/QuestionService.ets`
- NAPI 14 个 question 命令

## 跨平台一致性矩阵

| 维度 | 桌面 | 移动 |
|---|---|---|
| 导航源 | Sidebar 单行入口 | FolderDrawer 底部行 |
| 内容容器 | 中间栏 ResourceList ↔ QuestionList 切换 | Library 主区 ResourceListView ↔ QuestionListView 切换 |
| 选中预览 | 第三栏 PreviewPanel（QuestionDetailView variant=preview）| **无 preview**，单击直接 push QuestionDetail |
| Tab / 二级页 | 双击开 Tab；q:<id> 持久化 | 不适用（移动栈式导航） |
| 顶部筛选 | chip 三选一（进行中/已归档/全部） | chip 三选一（同上） |
| 搜索范围 | 受 chip 约束 | 受 chip 约束 |
| 创建后 | 切模式 + select + preview | push QuestionDetail（沿用现状） |
| Session 字段 | `library.mode` / `questionFilter` / `selectedQuestionId` / `questionListScrollTop` | `library.mode` / `questionFilter`（scrollTop 暂缺）|

## 风险与边界

### Tab 与 preview 同步问题

- 用户开了 Q1 Tab、又在 preview 里 select Q1 编辑了描述 —— 编辑通过事件 `QUESTION_CHANGED` 广播；Tab 内的 `QuestionDetailView` 通过 `useQuestion(id)` 自动 refetch；preview 也通过同 hook refetch。两端**最终一致**，无需额外同步代码。

### Phase 1 创建后自动开 Tab 的回归

- 旧行为：`QuestionSection` 在创建成功的 callback 里调 `openQuestion(newQ)`
- 新行为：`QuestionList` 头部 + 按钮的创建 callback 调 `setMode + setSelectedQuestionId`，**不开 Tab**
- 但 `ResourceList` 右键 "关联到问题 → 新建并关联" 的 callback 路径**保留不开 Tab**（用户在资料场景里，不要打断），同时也不切 mode（用户注意力在资料上）
- 验证点：测试覆盖三种创建入口的副作用矩阵

### 搜索 + chip 组合的歧义

- 用户在"已归档" chip 下搜 "可观测性"，命中 3 条已归档问题；切到"进行中" chip → 搜索框保留，结果重过滤为 0
- 设计选择：保留搜索框文本不清空（与 ResourceList 切 folder 行为对齐）；用户自己看到 "0 results" 会按需调整 chip
- 备选：切 chip 时清空搜索框 —— **不采用**，因为切 chip 是高频动作，清空会打断"逐步收窄"心流

### Library 模式问题 chip 单击行为变更的回归测试

- 改前：chip 单击 → 开 Tab
- 改后：chip 单击 → 切 mode + select
- 用户可能依赖旧行为做"快速进 Tab"。补救：chip 双击 = 开 Tab；同时在 ResourceList chip 上加 `title="单击预览，双击在 Tab 中打开"` 提示

### 移动端 FAB 与系统手势冲突

- 鸿蒙的全屏手势区域在屏幕底部；FAB 不能贴底，需要至少 80vp 安全边距（与导航条避让）
- 复用既有 ArkUI safeArea 处理（参考 Library 现有 + 按钮位置）

### 文件夹深链与 mode 切换

- 用户在 questions 模式时收到 `shibei://open/folder/{id}` deep link
- 期望：自动切回 resources 模式 + select 该 folder
- 桌面：`App.tsx` 在 deep link handler 里 `setMode('resources') + setSelectedFolderId(...)`
- 移动：`Library.consumePendingDeepLink` 已经把 folder 类型走 resources view，需补一句 `setMode('resources')`

### v1 session 文件兼容

- 旧版用户重启会读到 v1 schema
- 必须在 `loadSessionState` 入口先 normalize，再分发给 reducers
- 测试用例覆盖：v1 文件 / 缺字段 / 类型错 / 字段值越界（如 `questionFilter: "unknown"` → 回落 `"active"`）

## 验收标准

桌面端：

1. Sidebar 显示"问题 N"单行入口，N 等于 active 问题数
2. 点 Sidebar "问题"入口 → 中间栏切换为 QuestionList，第三栏 PreviewPanel 进入问题预览空态
3. QuestionList 顶部 chip 默认选中"进行中"，列表展示所有 active 问题
4. 单击列表行 → 第三栏显示该问题 QuestionDetailView（preview variant，含描述 / 链接列表 / 编辑按钮 / "在 Tab 中打开"按钮）
5. 双击列表行 → 开 Tab 并激活
6. chip 切换 → 列表内容相应过滤
7. 搜索框输入 "xxx" + chip 选"已归档" → 仅返回已归档且 FTS 命中的问题
8. + 按钮创建新问题 → 自动切到 "进行中" chip + select + preview 显示新问题
9. ResourceList 顶部问题命中 chip 单击 → 切 questions 模式 + select；双击 → 开 Tab
10. 关闭并重启应用 → mode / questionFilter / selectedQuestionId / scrollTop 全部恢复
11. 在 questions 模式下点 Sidebar 任意 folder → 切回 resources 模式，selectedQuestionId 保留（session 里）
12. Deep link `shibei://open/question/{id}` 仍直接开 Tab
13. Deep link `shibei://open/folder/{id}` 自动切到 resources 模式 + select folder

移动端：

1. FolderDrawer 底部"问题"行位置不变
2. 点击该行 → 抽屉关闭，Library 主区切换为问题列表
3. 问题列表顶部 chip 默认"进行中"
4. 单击问题 → push QuestionDetail（与既有行为一致）
5. FAB 右下角浮动 + 按钮 → push QuestionEdit
6. 长按问题行 → 现有 dialog 菜单
7. 重启应用恢复 mode / questionFilter
8. `pages/Questions.ets` 不再可达（已删除）
9. Deep link `shibei://open/question/{id}` 仍直接 push QuestionDetail
10. Deep link `shibei://open/folder/{id}` 触发 Library 切 resources 模式 + 选中 folder

## 时间线（建议）

按 plan 文档的 task 切分大致是：

- Task 1：sessionState schema v2 + 迁移 + 单测
- Task 2：`QuestionList` + `QuestionFilterChips` 新组件 + Vitest
- Task 3：`PreviewPanel` 问题分支 + `QuestionDetailView.variant`
- Task 4：`Layout` mode 状态接入 + Sidebar 入口替换 / `QuestionSection` 删除
- Task 5：`ResourceList` 问题 chip 单击/双击行为改动
- Task 6：创建问题副作用矩阵（QuestionList / ResourceList / deep link）
- Task 7：移动 `Library.ets` mode 状态 + `QuestionListView` + `FolderDrawer` 行为改动
- Task 8：移动 `SessionState.ets` schema + `pages/Questions.ets` 删除 + 路由表清理
- Task 9：i18n 文案补充（zh/en/base 三份）
- Task 10：手动回归 + 验收

具体步骤化在对应 plan 文档 `docs/superpowers/plans/2026-05-28-questions-navigation-redesign.md`。
