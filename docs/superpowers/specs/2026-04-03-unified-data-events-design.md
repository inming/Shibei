# 统一数据变更事件机制设计

## 问题背景

项目反复出现状态同步 bug：删除资料后文件夹计数不更新、同步后标注信息不刷新、加密设置后同步按钮状态不变等。

### 根因分析

当前刷新机制是 **ad-hoc 手动刷新**——每个 mutation 调用点通过 callback prop（`onDataChanged`）、ref（`folderTreeRefreshRef`）、state（`refreshKey`）手动通知相关组件刷新。问题：

1. **刷新链条依赖人工维护**：每新增一个操作入口都要记得接上完整的刷新链，遗漏一个就是一个 bug
2. **缺少完整的领域事件覆盖**：目前只有 `resource-saved`（插件保存）和 `sync-completed`（同步完成）两个 Tauri 事件，所有 app 内操作（删除、移动、标注、标签等）完全靠组件间回调链协调
3. **多套机制并存**：Tauri event、refreshKey state、callback prop、自定义 window event（`shibei:annotations-changed`）混用，逻辑分散难以审计

## 设计目标

- 所有数据变更后，相关 UI 自动刷新，不依赖手动回调链
- 新增功能时只需在 mutation 后 emit 事件，不需要知道谁在消费数据
- 可通过 grep 审计所有 emit 点和订阅方

## 方案概述

```
Mutation（Tauri command / HTTP handler）
  ↓ DB 写入完成后
emit 领域事件（Tauri event）
  ↓
前端 hook 自行订阅 → 自动 refresh
```

- **后端统一 emit**：所有 Tauri command 和 HTTP handler 在完成 DB 写入后 emit 标准领域事件
- **前端 hook 自行订阅**：每个 hook 监听自己关心的事件，自动 refresh
- **完全移除旧机制**：删掉 `onDataChanged` 回调链、`refreshKey`、`folderTreeRefreshRef`、自定义 window event

## 事件定义

6 个领域事件，粗粒度 + payload 区分 action：

| 事件名 | 触发时机 | payload 类型 |
|--------|---------|-------------|
| `data:resource-changed` | 资料增删改移 | `{ action, resource_id?, folder_id? }` |
| `data:folder-changed` | 文件夹增删改移排序 | `{ action, folder_id?, parent_id? }` |
| `data:tag-changed` | 标签增删改、资料标签绑定/解绑 | `{ action, tag_id?, resource_id? }` |
| `data:annotation-changed` | 高亮/评论增删改 | `{ action, resource_id }` |
| `data:sync-completed` | 同步完成 | `{}` |
| `data:config-changed` | 同步配置/加密状态变更 | `{ scope }` |
| `sync-started` | 同步开始 | `{}` |
| `sync-failed` | 同步失败 | `{ message }` |

注：`sync-started` 和 `sync-failed` 是同步状态事件（非领域数据事件），仅由 useSync 监听用于 UI 状态展示，不触发数据 refresh。

### payload 字段说明

- `action`: `"created" | "updated" | "deleted" | "moved" | "reordered"` 等字符串，listener 可按需精确处理，也可忽略直接全量 refresh
- 其他字段均为 optional，提供给需要精确刷新的 listener 使用
- `scope`（config-changed 专用）: `"sync" | "encryption"`

### 替换关系

| 旧事件 | 新事件 |
|--------|--------|
| `resource-saved`（server emit） | `data:resource-changed` |
| `sync-completed`（command emit） | `data:sync-completed` |
| `shibei:annotations-changed`（window event） | `data:annotation-changed` |
| `sync-started`（从未 emit，仅 listen） | 在 `cmd_sync_now` 中补齐 emit |
| `sync-failed`（从未 emit，仅 listen） | 在 `cmd_sync_now` 中补齐 emit |

## 后端 emit 点

### Folder（5 个 command）

| Command | 事件 | payload | 备注 |
|---------|------|---------|------|
| `cmd_create_folder` | `data:folder-changed` | `{ action: "created", parent_id }` | |
| `cmd_rename_folder` | `data:folder-changed` | `{ action: "updated", folder_id }` | |
| `cmd_delete_folder` | `data:folder-changed` + `data:resource-changed` | `{ action: "deleted", folder_id }` | 级联软删除子资料，需同时通知资料变更 |
| `cmd_move_folder` | `data:folder-changed` | `{ action: "moved", folder_id }` | |
| `cmd_reorder_folder` | `data:folder-changed` | `{ action: "reordered", folder_id }` | |

### Resource（3 个 command + 1 个 HTTP handler）

| Command | 事件 | payload |
|---------|------|---------|
| `cmd_delete_resource` | `data:resource-changed` | `{ action: "deleted", resource_id, folder_id }` |
| `cmd_move_resource` | `data:resource-changed` | `{ action: "moved", resource_id, folder_id }` |
| `cmd_update_resource` | `data:resource-changed` | `{ action: "updated", resource_id }` |
| HTTP `handle_save` | `data:resource-changed` | `{ action: "created", resource_id, folder_id }` |

### Tag（5 个 command）

| Command | 事件 | payload |
|---------|------|---------|
| `cmd_create_tag` | `data:tag-changed` | `{ action: "created", tag_id }` |
| `cmd_update_tag` | `data:tag-changed` | `{ action: "updated", tag_id }` |
| `cmd_delete_tag` | `data:tag-changed` | `{ action: "deleted", tag_id }` |
| `cmd_add_tag_to_resource` | `data:tag-changed` | `{ action: "updated", tag_id, resource_id }` |
| `cmd_remove_tag_from_resource` | `data:tag-changed` | `{ action: "updated", tag_id, resource_id }` |

### Annotation（5 个 command）

| Command | 事件 | payload |
|---------|------|---------|
| `cmd_create_highlight` | `data:annotation-changed` | `{ action: "created", resource_id }` |
| `cmd_delete_highlight` | `data:annotation-changed` | `{ action: "deleted", resource_id }` |
| `cmd_create_comment` | `data:annotation-changed` | `{ action: "created", resource_id }` |
| `cmd_update_comment` | `data:annotation-changed` | `{ action: "updated", resource_id }` |
| `cmd_delete_comment` | `data:annotation-changed` | `{ action: "deleted", resource_id }` |

### Sync（1 个 command）

| Command | 事件 | payload | 备注 |
|---------|------|---------|------|
| `cmd_sync_now` | `data:sync-completed` | `{}` | 同时补齐 `sync-started` 和 `sync-failed` 事件 emit |

### Config（5 个 command）

| Command | 事件 | payload |
|---------|------|---------|
| `cmd_setup_encryption` | `data:config-changed` | `{ scope: "encryption" }` |
| `cmd_unlock_encryption` | `data:config-changed` | `{ scope: "encryption" }` |
| `cmd_change_encryption_password` | `data:config-changed` | `{ scope: "encryption" }` |
| `cmd_save_sync_config` | `data:config-changed` | `{ scope: "sync" }` |
| `cmd_set_sync_interval` | `data:config-changed` | `{ scope: "sync" }` |

**合计 26 个 mutation 点，全部覆盖。**

## 前端 hook 订阅矩阵

| Hook / 组件 | resource-changed | folder-changed | tag-changed | annotation-changed | sync-completed | config-changed |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **useResources** | refresh 列表 | - | refresh（标签过滤） | - | refresh | - |
| **useFolders** | loadMeta（计数） | refresh 树 + loadMeta | - | - | refresh + loadMeta | - |
| **useTags** | - | - | refresh | - | refresh | - |
| **useAnnotations** | - | - | - | refresh | refresh | - |
| **useSync** | - | - | - | - | 更新 status/lastSyncAt | refresh（encryption scope） |

useSync 还监听 `sync-started`（设置 status="syncing"）和 `sync-failed`（设置 status="error" + error message），这两个是 UI 状态事件，不在上表（仅数据事件）中列出。
| **PreviewPanel** | refresh resource meta + tags | - | refresh tags | （走 useAnnotations） | （走 useAnnotations） | - |

### 说明

- PreviewPanel 内部已使用 `useAnnotations` hook，`annotation-changed` 和 `sync-completed` 对标注的刷新自动走 hook 订阅
- PreviewPanel 需单独监听 `resource-changed` 刷新资料元数据（标题、域名等）和 `tag-changed` 刷新标签，因为这些不在现有 hook 中
- `tag-changed` 通知 useResources 是因为 ResourceList 有按标签过滤功能，标签绑定变更会影响过滤结果
- `sync-completed` 是全局刷新事件，因为同步可能改变任何数据

## 移除的旧机制

| 移除项 | 位置 | 替代 |
|--------|------|------|
| `onDataChanged` prop 及其回调链 | ResourceList.tsx → Layout.tsx | hook 自动监听事件 |
| `resourceRefreshKey` state + `setResourceRefreshKey` | Layout.tsx | useResources 监听 `data:resource-changed` |
| `folderTreeRefreshRef` (MutableRefObject) | Layout.tsx → FolderTree.tsx | useFolders 监听 `data:folder-changed` / `data:resource-changed` |
| `refreshKey` prop | ResourceList, PreviewPanel, FolderNode | hook 监听事件 |
| `refreshAll()` 函数 | FolderTree.tsx | useFolders + loadMeta 各自监听事件 |
| `shibei:annotations-changed` window event + `notifyChange()` | useAnnotations.ts | `data:annotation-changed` Tauri 事件 |
| mutation 函数中的手动 state 更新 | useAnnotations.ts（addHighlight/removeHighlight/addComment/editComment/removeComment 中的 setHighlights/setComments） | 统一由事件触发 refresh |
| useTags 中 mutation 后手动调 `refresh()` | useTags.ts | 后端 emit `data:tag-changed` |
| `resource-saved` 事件名 | server/mod.rs, useResources.ts, FolderTree.tsx | 统一为 `data:resource-changed` |
| `sync-started` / `sync-failed` listener（从未被 emit） | useSync.ts | `cmd_sync_now` 补齐 emit |

### 移除后组件接口简化

```typescript
// Before: ResourceList 需要刷新相关 prop
interface ResourceListProps {
  refreshKey: number;
  onDataChanged?: () => void;
  // ...业务 props
}

// After: 纯业务 prop
interface ResourceListProps {
  folderId: string | null;
  selectedResourceIds: Set<string>;
  selectedTagIds: Set<string>;
  sortBy: "created_at" | "annotated_at";
  sortOrder: "asc" | "desc";
  onSelectResource: (...) => void;
  onOpen: (resource: Resource) => void;
  onSortByChange: (...) => void;
  onSortOrderChange: (...) => void;
}

// Before: FolderTree 通过 ref 暴露 refresh
interface FolderTreeProps {
  onRefreshRef?: React.MutableRefObject<(() => void) | null>;
  // ...
}

// After: 无需暴露 refresh
interface FolderTreeProps {
  selectedFolderId: string | null;
  onSelectFolder: (id: string) => void;
}
```

## 实现约束

### 后端

- 事件 emit 必须在 DB 写入成功之后，不在 error 路径上 emit
- 使用 `serde_json::json!()` 构造 payload，保持与前端 TypeScript 类型一致
- Rust 端可定义事件名常量模块（如 `events.rs`），避免字符串散落

### 前端

- `src/lib/events.ts` 集中定义事件名常量和 TypeScript payload 类型
- hook 中使用 `useEffect` + `listen()` 订阅，返回 unlisten 清理
- 不在组件中直接写事件名字符串，统一从 `events.ts` 导入
- 前端一般不 emit 事件（mutation 都走 Tauri command，由后端 emit）；如有特殊场景需要前端 emit，必须在 `events.ts` 中注释说明原因

### 开发规范

- **新增 Tauri command 时**：如果是 mutation 操作，必须在 DB 写入后 emit 对应领域事件
- **新增前端 hook 时**：检查订阅矩阵，确认需要监听哪些事件
- **审计方法**：`grep "app.emit" src-tauri/` 查看所有 emit 点；`grep "listen(DataEvents" src/` 查看所有订阅方
