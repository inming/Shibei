# UI 细节优化（2026-04-17）

## 概述

针对拾贝桌面应用的 6 处 UI 细节问题做精修，涵盖：tooltip 文案、预览面板元数据交互、标注跳转、本地文件导入入口、设置页样式一致性。不改变底层数据模型与后端命令，主要在前端 React 组件层面调整。

每项改动独立、互不依赖，可分别提交。

---

## 1. 左下角设置按钮 tooltip 改为"设置"

### 问题

Sidebar 底部齿轮按钮的 tooltip 现在是"同步设置"（`sync.syncSettings`），但点击后进入的设置页包含外观/同步/加密/安全/数据/AI 六大分区，不仅仅是同步。

### 方案

- 文件：`src/components/SyncStatus.tsx`
- 将 `title={t('syncSettings')}` 改为 `title={t('common:settings')}`
- i18n：复用 `common.settings` key；若不存在则在 `src/locales/{zh,en}/common.json` 中新增（中"设置" / 英"Settings"）
- 保留 `sync.syncSettings` 旧 key，避免波及其他可能引用它的地方

### 验收

- 鼠标悬停齿轮按钮显示"设置"（中文）/ "Settings"（英文）

---

## 2. URL 打开按钮紧跟 URL、高度一致

### 问题

`ResourceMeta.module.css` 中 `.urlRow` 是 flex 容器、`.url` 为 `flex: 1`，导致打开按钮被推到行尾，与 URL 文字间出现大空隙，且按钮 22×22px 明显高于 URL 字号。

### 方案

- 文件：`src/components/ResourceMeta.module.css`
- `.urlRow`：去除 `display: flex`，使用默认 inline 流
- `.url`：去除 `flex: 1`
- `.urlOpenBtn`：
  - `display: inline-flex`
  - `vertical-align: middle`
  - 尺寸从 22×22px 降至 18×18px（与 `--font-size-sm` 行高匹配）
  - `margin-left: 4px`，移除 `margin-top: 1px`
  - `flex-shrink` 失效（不再是 flex 容器子项），移除

### 效果

- URL 短：按钮紧跟 URL 右侧 4px
- URL 长需换行：按钮跟随最后一行末尾（inline baseline 行为）
- 按钮视觉高度与 URL 文字行高一致

### 验收

- 打开不同长度 URL 的资料，按钮始终紧跟 URL 末尾，不再悬空
- 按钮高度与 URL 文字目测一致

---

## 3. 元数据右上角新增编辑按钮

### 问题

元数据（title、URL、日期、文件夹、标签）目前只能通过第二栏资料列表项右键菜单 → 编辑弹窗修改，从第三栏预览面板看到元数据时无直接编辑入口。

### 方案

- 文件：`src/components/ResourceMeta.tsx` + `.module.css`
- 在 `.meta` 容器右上角放置一个小按钮（铅笔 ✎ 或 SVG 图标）
  - 容器 `.meta` 加 `position: relative`
  - 按钮 `position: absolute; top: var(--spacing-md); right: var(--spacing-lg)`
- 按钮样式参照 `.urlOpenBtn`：18×18px，透明背景，hover 变 accent 色
- 点击 → 打开已有 `ResourceEditDialog`（组件位于 `src/components/Sidebar/ResourceEditDialog.tsx`，可编辑 title + description）
- i18n：新增 `sidebar.metaEdit`（中"编辑" / 英"Edit"），作为 tooltip

### 组件间通信

- `ResourceMeta` 内部用 `useState` 控制 dialog 开关，自包含，不改接口
- 编辑成功后 `ResourceEditDialog` 已 emit `data:resource-changed` 事件，父组件会自动 refresh

### 验收

- 在预览面板看到右上角铅笔按钮
- 点击弹出编辑弹窗，可修改标题和描述
- 保存后预览面板自动刷新展示新值

---

## 4. 预览面板标注可点击跳转

### 问题

`PreviewPanel` 列出的高亮/评论条目无点击事件，无法从预览面板一键跳到标注位置。

### 方案

#### Prop 透传

- 文件：`src/components/PreviewPanel.tsx`
- 新增 prop：`onOpenHighlight?: (resourceId: string, highlightId: string) => void`
- 文件：`src/components/Layout.tsx`
- `Layout` 已有的 `onOpenResource` 回调（由 `App.tsx` 的 `openResource(resource, highlightId?)` 提供，line 37）
- 透传到 `PreviewPanel`：`onOpenHighlight={(_rid, hid) => onOpenResource(selectedResource, hid)}`
  - 传入的 resourceId 和 selectedResource.id 必然一致（preview 永远展示的是选中项），闭包直接捕获 selectedResource 即可

#### 点击目标

- `PreviewPanel` 中每个 `.highlightItem` 容器（含该高亮下所有评论）整体可点击
- `onClick` → `onOpenHighlight(resource.id, hl.id)`
- 样式：hover 时加浅色背景 + `cursor: pointer`
- 评论区内 `MarkdownContent` 渲染的 `<a>` 链接需防止误触发外层点击：给 Markdown 内链接加 `onClick={(e) => e.stopPropagation()}`，或在外层 `onClick` 中用 `e.target` 判断是否点在链接上

#### 资源加载中的跳转保护

完全复用现有机制，无需新增代码：

- `App.openResource(resource, highlightId)` 将 `highlightId` 放到 `ReaderTab.initialHighlightId`
- `ReaderView` 接收 `initialHighlightId` prop
- iframe 内 `annotator.js` 就绪后发送 `shibei:annotator-ready` postMessage
- `ReaderView` 用 `didScrollToInitial` 标志确保仅在 iframe 就绪后滚动一次

### 验收

- 点击预览面板中某高亮 → 打开该资源的阅读器 Tab 并滚动到该高亮
- 资源尚未加载时点击 → 先渲染 iframe，然后跳转（不丢失跳转意图）
- 点击已在 Tab 的资源的另一个高亮 → 切换到该 Tab 并跳到新位置

---

## 5. 去掉 PDF+ 按钮，改为右键菜单上传

### 问题

当前第二栏（ResourceList）顶部有 "PDF+" 按钮，与"文件夹+"入口并列。用户希望按上下文操作：选中文件夹后在文件夹上右键、或在列表空白处右键，都能导入 PDF。

### 方案

#### 约束

- 仅支持 PDF（未来加其他格式时再扩展）
- 文件对话框 filter 限制为 `.pdf`
- Root（"全部资料"/未选中真实文件夹）不允许上传 → 菜单项不出现或禁用

#### 具体改动

**删除旧入口 + 抽取共享函数**
- 文件：`src/components/Sidebar/ResourceList.tsx`
- 删除顶部 "PDF+" 按钮（第 313-319 行）
- 把 `handleImportPdf` 的核心逻辑（弹对话框 + 调 `cmd.importPdf`）抽成独立工具函数 `importPdfToFolder(folderId: string)`，放到 `src/lib/commands.ts` 或新建 `src/lib/importPdf.ts`
  - 该函数包含文件对话框打开 + 调用 `cmd.importPdf` + toast 成功/失败提示
  - FolderTree 右键菜单和 ResourceList 空白处右键菜单都调用此函数，避免重复代码

**Sidebar 文件夹右键菜单加"导入 PDF"**
- 文件：`src/components/Sidebar/FolderTree.tsx`
- 现有菜单项：新建子文件夹 / 编辑 / 删除
- 追加一项"导入 PDF"，位置在"新建子文件夹"下方
- 不显示条件：点击的是虚拟节点（"全部资料"/"回收站"等）时不显示该项
- 点击 → 复用 `cmd.importPdf(filePath, folderId)`，其中 folderId = 被右键的文件夹 id

**ResourceList 空白处右键菜单**
- 文件：`src/components/Sidebar/ResourceList.tsx`
- 监听 `.listScroll` 容器的 `onContextMenu` 事件
- 仅当事件 `target === currentTarget`（即点在空白，非列表项）时阻止默认并弹菜单
- 菜单只有一项："导入 PDF"
- 仅当 `selectedFolderId` 为真实 folder id 时才响应；虚拟视图（all/trash/untagged/tag-filter）下忽略右键
- 点击 → `cmd.importPdf(filePath, selectedFolderId)`

#### 文件对话框

使用 `@tauri-apps/plugin-dialog` 的 `open`：

```ts
const path = await open({
  filters: [{ name: "PDF", extensions: ["pdf"] }],
  multiple: false,
});
```

Tauri dialog 的 filter 已能过滤非 PDF 文件。

#### i18n

- `reader.importPdf`（现有）：用于菜单项文案

### 验收

- 第二栏顶部无 "PDF+" 按钮
- 在 Sidebar 的真实文件夹上右键 → 菜单含"导入 PDF"项
- 在 Sidebar 的"全部资料"/"回收站" 上右键 → 不显示"导入 PDF"
- 在已选中真实文件夹下、ResourceList 空白处右键 → 弹出菜单含"导入 PDF"
- 在"全部资料" 视图下、ResourceList 空白处右键 → 不弹菜单
- 所有入口都走同一 `handleImportPdf` 逻辑，导入后资料进入目标文件夹

---

## 6. 外观 / 同步设置页样式对齐 Data/AI

### 问题

- `AppearancePage`：第一项（主题按钮）缺 subheading，两项（主题、语言）之间无分隔线
- `SyncPage`：第一块（S3 配置 + 按钮）整体缺 subheading；第二块（维护）有 subheading 但无分隔线容器

### 参考结构（Data/AI 页模式）

```tsx
<h2 className={styles.heading}>{title}</h2>

<div className={styles.form}>
  <h3 className={styles.subheading}>{section1Title}</h3>
  ...section 1 content...
</div>

<div className={styles.passwordSection}>  {/* border-top 作为 divider */}
  <h3 className={styles.subheading}>{section2Title}</h3>
  ...section 2 content...
</div>
```

`.passwordSection` 已在 `Settings.module.css` 中提供 `border-top: 1px solid var(--color-border)` + `padding-top/margin-top: var(--spacing-md)`。

### AppearancePage 改动

- 文件：`src/components/Settings/AppearancePage.tsx`
- 第一块（主题）：在现有 `<div className={styles.themeOptions}>` 外再包一层 `<div className={settingsStyles.form}>`，并在 form 内 themeOptions 前加 `<h3 className={settingsStyles.subheading}>{t('theme')}</h3>`
- 第二块（语言）：在现有 `<h3>` + `<div className={styles.themeOptions}>` 外包一层 `<div className={settingsStyles.passwordSection}>`
- 新增 i18n key：`settings.theme`（中"主题" / 英"Theme"）

### SyncPage 改动

- 文件：`src/components/Settings/SyncPage.tsx`
- 现有 `<div className={styles.form}>` 开头加 `<h3 className={styles.subheading}>{t('connection')}</h3>`
- `.lastSync` 和 `.actions`（测试/保存按钮）保持在 form 容器外，或视位置整合到 form 内（倾向于移入 form 容器内末尾，使整个"连接"分区是一个逻辑块）
  - 选择：保持现状（form 块结束后才是 lastSync 和 actions），仅加 subheading，最小化侵入
- 维护区块（`hasCredentials` 条件内）：把现有 `<h3 subheading>maintenance</h3>` 及其后内容用 `<div className={styles.passwordSection}>` 包裹
- 新增 i18n key：`sync.connection`（中"连接" / 英"Connection"）

### 验收

- 外观页：主题分区上方有"主题"子标题，主题和语言之间有分隔线
- 同步页：S3 配置分区上方有"连接"子标题，维护分区上方有分隔线

---

## 改动范围汇总

| 文件 | 变更类型 | 对应项 |
|---|---|---|
| `src/components/SyncStatus.tsx` | tooltip i18n key | 1 |
| `src/components/ResourceMeta.tsx` | 新增编辑按钮 + dialog 状态 | 3 |
| `src/components/ResourceMeta.module.css` | URL 按钮 CSS + 编辑按钮样式 | 2, 3 |
| `src/components/PreviewPanel.tsx` | 新增 prop + onClick | 4 |
| `src/components/PreviewPanel.module.css` | highlight item hover/cursor | 4 |
| `src/components/Layout.tsx` | 透传 `onOpenResource` 到 PreviewPanel | 4 |
| `src/components/Sidebar/ResourceList.tsx` | 删按钮、加空白处右键菜单 | 5 |
| `src/components/Sidebar/FolderTree.tsx` | 右键菜单加"导入 PDF" | 5 |
| `src/components/Settings/AppearancePage.tsx` | 加 subheading + passwordSection | 6 |
| `src/components/Settings/SyncPage.tsx` | 加 subheading + passwordSection | 6 |
| `src/locales/{zh,en}/common.json` | `common.settings`（若缺） | 1 |
| `src/locales/{zh,en}/sidebar.json` | `sidebar.metaEdit` | 3 |
| `src/locales/{zh,en}/settings.json` | `settings.theme` | 6 |
| `src/locales/{zh,en}/sync.json` | `sync.connection` | 6 |

---

## 提交拆分

每项独立成一个 commit：

1. `fix(i18n): unify "settings" tooltip on sidebar gear button`
2. `fix(preview): align URL open button with URL, match text height`
3. `feat(preview): add edit button in metadata header`
4. `feat(preview): click highlight in preview to jump to position in reader`
5. `refactor(resources): replace PDF+ button with folder/list context menu upload`
6. `style(settings): add subheadings and dividers to Appearance/Sync pages`

---

## 测试

- 无单元测试新增（纯 UI 调整，现有 component/hook 测试覆盖不变）
- 手动验证列表：每项的验收条件即为手动测试步骤
- `cargo check` 无涉（不改 Rust）
- `tsc --noEmit` + Vite 构建：需确保新增 i18n key 的 TS 类型（`src/types/i18next.d.ts` 会根据 locale JSON 自动推导）和 import 路径无误
