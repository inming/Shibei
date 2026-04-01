# 导航补全 — 设计文档

## 概述

补全文件夹导航的三个缺失功能：多级展开/折叠、文件夹编辑（重命名）、URL 查重提示。

## 设计决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 多级展开 | 递归组件 + 懒加载 | 后端已支持嵌套，前端只需递归渲染 |
| 文件夹编辑入口 | 右键上下文菜单 | 避免双击误操作，未来可扩展更多操作 |
| 编辑方式 | 模态对话框 | 未来可扩展图标选择等更多属性 |
| URL 查重 | 插件加载时自动查询 | 不阻止重复保存，只做提示 |

## 1. 文件夹树多级展开/折叠

### 现状

`FolderTree` 组件只调用 `useFolders("__root__")` 加载根级文件夹，渲染为扁平列表。后端已完整支持嵌套：`parent_id` 字段、`createFolder(name, parentId)`、`moveFolder`。

### 方案

将 FolderTree 改为递归渲染，每个文件夹节点可展开/折叠：

- 每个文件夹前显示展开箭头 `▶`（折叠）/ `▼`（展开），无子文件夹时显示空占位保持对齐
- 点击箭头区域展开/折叠，点击文件夹名区域选中
- 子文件夹通过 `padding-left` 缩进，每级 16px
- 展开时才调用 `useFolders(folderId)` 加载子文件夹（懒加载，避免一次性加载所有层级）
- 创建文件夹时 `parentId` 使用当前选中的文件夹（若无选中则为 `__root__`）

### 组件结构

```
FolderTree（根组件，管理选中/展开状态）
  └─ FolderNode（递归组件，渲染单个文件夹 + 子级）
       ├─ 展开箭头
       ├─ 📁 文件夹名
       └─ [展开时] 子 FolderNode 列表
```

`FolderTree` 持有全局状态（`selectedFolderId`、`expandedIds: Set<string>`），通过 props 传递给 `FolderNode`。

### 改动

- **`FolderTree.tsx`**：重构为 `FolderTree`（根）+ `FolderNode`（递归），可放在同一文件或拆分
- **`FolderTree.module.css`**：新增缩进、箭头样式
- **创建文件夹逻辑**：`parentId` 改为 `selectedFolderId || "__root__"`

## 2. 文件夹编辑（右键菜单 + 模态对话框）

### 方案

- 右键文件夹 → 显示上下文菜单：「编辑」「删除」
- 点击「编辑」→ 弹出模态对话框，包含名称输入框
- 点击「删除」→ 现有确认逻辑（`window.confirm`）
- 现有的 hover 删除按钮（×）移除，统一到右键菜单

### 上下文菜单

- 绝对定位的 div，出现在鼠标右键位置
- 点击菜单项或菜单外区域关闭
- ESC 关闭
- 简单实现，不引入第三方库

### 编辑对话框

- 模态对话框（Modal 组件），覆盖层 + 居中卡片
- 内容：标题「编辑文件夹」、名称输入框（预填当前名称）、确认/取消按钮
- Enter 提交，ESC 取消
- 空名称不允许提交
- 提交后调用 `cmd.renameFolder(id, newName)` → 刷新文件夹列表

### 新增组件

- **`ContextMenu.tsx`** — 通用右键菜单组件（位置、菜单项、关闭回调）
- **`Modal.tsx`** — 通用模态对话框组件（标题、内容插槽、关闭回调）
- **`FolderEditDialog.tsx`** — 文件夹编辑对话框（使用 Modal）

## 3. URL 查重提示

### 现状

后端 `find_by_url` 已实现 URL 归一化匹配，但 HTTP Server 没有对应接口。

### 方案

- 后端新增 `GET /api/check-url?url=xxx` 接口
- 调用 `find_by_url` 返回匹配数量

```json
{ "count": 2 }
```

- 插件 popup 在获取到当前 tab URL 后自动调用此接口
- 如果 `count > 0`，在页面信息区域下方显示黄色提示条："该 URL 已保存过 N 次"
- 不阻止保存，仅提示

### 改动

- **`server/mod.rs`**：新增 `handle_check_url` handler + 路由
- **`popup.js`**：`init()` 中加查重请求
- **`popup.html`**：新增提示条 div
- **`popup.css`**：黄色提示条样式

## 改动范围总结

| 功能 | 文件 | 改动类型 |
|------|------|---------|
| 多级展开 | `FolderTree.tsx` | 重构：递归组件 |
| 多级展开 | `FolderTree.module.css` | 修改：缩进/箭头样式 |
| 右键菜单 | `components/ContextMenu.tsx` | **新增** |
| 模态对话框 | `components/Modal.tsx` | **新增** |
| 文件夹编辑 | `components/Sidebar/FolderEditDialog.tsx` | **新增** |
| 文件夹编辑 | `FolderTree.tsx` | 修改：接入右键菜单 + 对话框 |
| URL 查重 | `server/mod.rs` | 修改：新增 `/api/check-url` |
| URL 查重 | `popup.html`, `popup.js`, `popup.css` | 修改：查重提示 |

## 不在本次范围

- 文件夹拖拽排序/移动（v1.2）
- 文件夹图标自定义（未来扩展对话框即可）
- 标签筛选（v1.2）
