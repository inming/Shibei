# 阅读与标注增强 — 设计文档

## 概述

v1.1 路线图中「阅读与标注」部分的 4 项改动：资料预览面板、资料级笔记、评论编辑、标注删除确认。后端已全部就绪，改动集中在前端。

## 现状

- 资料库三栏布局：文件夹树 | 资料列表 | 欢迎占位
- 单击资料 → 直接打开阅读器 Tab（无预览）
- AnnotationPanel 只展示高亮 + 评论，无资料级笔记 UI
- 评论只能添加和删除，不能编辑
- 高亮和评论删除无确认提示

## 1. 资料预览面板

### 交互模型

- **单击**资料列表项 → 选中，右侧预览面板展示该资料信息
- **双击**资料列表项 → 打开阅读器 Tab
- 预览面板中**点击高亮片段** → 打开阅读器 Tab 并滚动定位到该高亮

### 预览面板内容

上下两部分：

1. **元信息卡片**（顶部，紧凑）：标题、域名、保存日期
2. **高亮列表**（主体）：该资料的所有高亮文本片段，带颜色指示
   - 默认折叠评论，显示评论数量
   - 点击展开/折叠关联评论
   - 点击高亮片段 → 调用 `openResource(resource, highlightId)`
   - 无高亮时显示空状态提示

### 组件变更

**ResourceList**：
- `onClick` 事件改为选中（设置 `selectedResource`），不再直接打开 Tab
- 新增 `onDoubleClick` → 调用 `onOpenResource` 打开阅读器 Tab

**LibraryView**：
- 新增 `selectedResource` 状态
- 右侧欢迎占位替换为 `PreviewPanel` 组件（当有选中资料时）
- `onOpenResource` 回调签名扩展：`(resource: Resource, highlightId?: string) => void`

**PreviewPanel**（新组件 `src/components/PreviewPanel.tsx`）：
- Props：`resource: Resource`，`onOpenInReader: (highlightId?: string) => void`
- 内部使用 `useAnnotations(resource.id)` 加载高亮和评论数据
- 样式文件：`PreviewPanel.module.css`

**App.tsx**：
- `openResource` 扩展为接受可选 `highlightId` 参数
- 传递给 ReaderView，ReaderView 在 iframe ready 后滚动到指定高亮

### 双击延迟处理

单击和双击天然不冲突：单击立即选中预览，双击在单击之后触发 `dblclick` 事件打开 Tab。无需 setTimeout 延迟技巧。单击产生的选中行为不是有害副作用，双击打开 Tab 后预览面板自然被阅读器 Tab 替换。

## 2. 资料级笔记

### 设计

在 AnnotationPanel 中，高亮列表下方增加「笔记」区块，用分隔线与高亮区分。

- 笔记列表：显示所有 `highlight_id === null` 的 Comment
- 每条笔记：内容文本 + 日期 + 编辑/删除按钮
- 底部输入框：textarea + 保存按钮，调用 `createComment(resourceId, null, content)`
- 数据来源：`useAnnotations` 已有 `resourceNotes` 计算属性

### 后端支持

已完备，无需改动：
- `cmd_create_comment` 的 `highlight_id` 参数已是 `Option<String>`
- `cmd_get_comments` 返回资料下所有评论（含 `highlight_id=null` 的）
- DB schema 中 `comments.highlight_id` 允许 NULL

## 3. 评论编辑

### 设计

AnnotationPanel 的 HighlightEntry 中，每条评论增加「编辑」按钮。

- 点击编辑 → 评论内容替换为 textarea（行内编辑模式）
- textarea 预填当前评论文本
- 保存/取消按钮
- Enter 提交（Shift+Enter 换行），Escape 取消
- 调用 `cmd.updateComment(id, newContent)`

### 组件变更

**AnnotationPanel**：
- 新增 `onEditComment: (id: string, content: string) => void` prop
- HighlightEntry 内评论项增加编辑状态管理（`editingCommentId` + `editText`）

**useAnnotations**：
- 新增 `editComment(id: string, content: string)` 方法
- 调用 `cmd.updateComment`，成功后刷新 comments 列表

笔记（资料级 Comment）复用同样的编辑逻辑。

## 4. 标注删除确认

### 设计

所有删除操作（高亮、评论、笔记）使用 Modal 对话框确认，替换 `window.confirm`。

- **高亮删除**：提示"确定删除此高亮标注？"，如有关联评论则显示"关联的 N 条评论也会一并删除"
- **评论删除**：提示"确定删除此评论？"
- **笔记删除**：提示"确定删除此笔记？"

### 实现方式

项目中已有 Modal 组件（文件夹删除用的那个）。在 AnnotationPanel 中维护一个 `deleteConfirm` 状态（`{ type: 'highlight'|'comment'|'note', id: string, commentCount?: number } | null`），控制 Modal 的显示和确认回调。

## 组件关系总览

```
App
├── TabBar
├── LibraryView (资料库 Tab)
│   ├── Sidebar (FolderTree + TagFilter)
│   ├── ResourceList
│   │   ├── onClick → setSelectedResource (单击选中)
│   │   └── onDoubleClick → onOpenResource (双击打开 Tab)
│   └── PreviewPanel [新] (替换欢迎占位)
│       ├── 元信息卡片 (标题/URL/日期)
│       └── 高亮列表 (可展开评论，点击打开 Tab)
│
└── ReaderView (阅读器 Tab)
    ├── iframe (annotator.js)
    └── AnnotationPanel
        ├── 高亮列表 + 评论
        │   ├── [新] 评论编辑按钮
        │   └── [新] 删除确认 Modal
        └── [新] 笔记区块 (resourceNotes)
```

## 不做的事

- 不改后端（所有需要的 API 已就绪）
- 不改 annotator.js（滚动到高亮的 postMessage 协议已有）
- 不做内容缩略预览（iframe 渲染开销大，收益不明显）
- 不做统计摘要（高亮数量在列表里已经能看到）
