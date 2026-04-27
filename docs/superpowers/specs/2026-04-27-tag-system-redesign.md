# 标签系统重构设计

日期：2026-04-27
范围：桌面端 + 鸿蒙移动端

---

## 问题描述

1. **标签过滤是全局状态，切文件夹不清除**：用户选中标签后切换到另一文件夹，列表变空（被之前选的标签过滤了）。用户意识不到"标签过滤还在生效"，困惑为什么进了文件夹看不到东西。

2. **标签与文件夹并列在侧栏，但语义不同**：文件夹是容器，标签是属性，二者不应被视为同一类"分类方式"并排展示。

3. **缺少 AND 交集筛选**：当前只支持 OR，无法做"同时有 A 和 B 标签"的筛选。

### 设计决策

- **标签回归纯粹筛选角色**：不在侧栏作为浏览维度，仅在 ResourceList 顶部作为 AND 筛选器
- 标签管理独立入口（顶部 ⚙），与筛选解耦
- 切文件夹时**自动清空筛选标签**（对齐鸿蒙端已有行为）
- 筛选标签列表**跟随当前文件夹**，只显示该文件夹内实际存在的标签，保证不会选了后 0 结果

---

## 桌面端 UI

### Sidebar

```
📁 资料库
  ├── 全部资料 (142)
  ├── 收件箱   (23)
  └── 工作      (8)
```

不再展示标签区域。纯文件夹导航。

### ResourceList 顶部

```
┌──────────────────────────────────┐
│ 🔍 搜索...    📅↓    🏷️ 筛选  ⚙│  ← 搜索 + 排序 + 筛选入口 + 管理
│━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━│
│ ▊▊ 重要 ×   待办 ×  ...  +2    │  ← AND 筛选 chips（有选中时才出现）
│──────────────────────────────────│
│  结果列表...                      │
└──────────────────────────────────┘
```

- **`🏷️ 筛选` 入口按钮始终可见**（最高优先级：不选标签时用户必须能看到功能存在）
- 右侧 `⚙` 是标签管理入口（新建/重命名/删除/编辑颜色），与筛选功能视觉分离，避免误操作
- 选中标签后，入口按钮下方出现 chips 行：每个 chip = 颜色点 + 标签名 + × 移除
- chips 超出 2 行时截断，末尾显示 `+N` 展开按钮
- 无选中标签时，chips 行不渲染（不占高度）

#### 筛选标签选择器 Popover

点击 `🏷️ 筛选` 弹出：

```
┌──────────────────┐
│ 🔍 搜索标签...    │
│──────────────────│
│ ● AI         23 ✓│
│ ● 重要       17  │
│ ● 周报        8  │
│ ● 待办        5  │
│ ● 未归档      3  │
└──────────────────┘
```

- 标签列表**仅显示当前文件夹内存在的标签**，保证不会选了后 0 结果
- 数字 = 当前文件夹内有该标签的资源数
- 点击标签即时切换选中（无需确认按钮）
- 标签数 > 8 时显示搜索框
- Popover 使用 `useFlipPosition`，`max-height: 60vh`
- **每次打开 popover 时重新查询**，保证计数和数据新鲜

#### 标签管理面板

点击顶部 `⚙` 弹出（与筛选 popover 分离，不同入口）：

```
┌──────────────────┐
│ 管理标签          │
│──────────────────│
│ ● AI         23  │  ← hover 出 ✎ / 🗑
│ ● 重要       17  │
│ ● 周报        8  │
│────              │
│ + 新建标签       │
└──────────────────┘
```

复用现有 `TagPopover` 的创建/编辑流程。

### 行为规则

| 操作 | 筛选标签行为 |
|------|------------|
| `selectedFolderId` 变化（前后值不同） | **清空**筛选标签 |
| 点击 `🏷️ 筛选` popover 中的标签 | 添加/移除到筛选，即时生效 |
| 点击 chip 的 × | 移除该筛选 |
| 清空所有筛选 | chips 行消失，`🏷️ 筛选` 入口仍在 |

**切换 `__all__` 也清空** — 统一规则：只要 `selectedFolderId` 变了就清，简单可预测。

### 搜索 + 标签筛选的合成顺序

`cmd_search_resources(query, folder_id, filter_tag_ids, sort_by, sort_order)`

1. 先按搜索关键词和 folder_id 获取结果集
2. 再对结果集做 AND 标签交集过滤
3. 排序

即：搜索结果再被标签过滤，不是"搜索在过滤范围内搜"。

### 边缘情况

- **stale tag ID**：同步可能在其他设备删掉某个 tag，`filterTagIds` 中残留无效 ID。`useTags` 加载完已知标签后过滤一次 `filterTagIds = filterTagIds.filter(id => knownTagIds.has(id))`
- **空文件夹**：`listTagsInFolder` 返回空列表，`🏷️ 筛选` 不可点击（disabled + tooltip "当前文件夹无标签"）

### 前端 `__all__` 约定

`__all__` 和 `__inbox__` 在前端 `commands.ts` 中统一处理：

```typescript
// src/lib/commands.ts
function normalizeFolderId(id: string): string | null {
  // __all__ 是虚拟视图，后端不识别 → 传 null
  if (id === '__all__') return null;
  // __inbox__ 是真实 folder，直接传 ID
  return id;
}
```

`cmd_list_tags_in_folder`、`cmd_list_resources` 等依赖 folder_id 的命令统一通过此工具转换，避免各组件各自判断导致不一致。

### 状态管理

- `filterTagIds: string[]` — AND 筛选标签 ID 列表
- `selectedFolderId` 变更 → `filterTagIds` 置空
- 持久化到 `sessionState.library.filterTagIds`（已有字段）

### 文件改动

| 文件 | 改动 |
|------|------|
| `src/components/ResourceList.tsx` | 顶部新增 `🏷️ 筛选` 入口 + `⚙` 管理按钮 + `FilterChips` |
| `src/components/FilterChips.tsx` | **新组件**：chips 行（含 2 行截断 + `+N` 展开） |
| `src/components/FilterTagPopover.tsx` | **新组件**：按文件夹过滤的标签列表（含搜索 + 计数） |
| `src/components/FilterManagePanel.tsx` | **新组件**：标签管理面板（列表 + 新建/编辑/删除） |
| `src/components/Sidebar/TagFilter.tsx` | **删除** |
| `src/components/Sidebar/TagSubMenu.tsx` | 保留 — 资源右键加标签仍需要 |
| `src/components/Sidebar/TagPopover.tsx` | 保留 — 标签创建/编辑表单复用 |
| `src/lib/commands.ts` | 新增 `listTagsInFolder` + `normalizeFolderId` 工具 |
| `src/lib/sessionState.ts` | 维护 `filterTagIds`（已有） |

---

## 移动端 UI

### 布局

```
┌─────────────────────┐
│ 拾贝         🔍  ⚙ │  ← 顶栏
│━━━━━━━━━━━━━━━━━━━│
│ 当前: 收件箱    ▾  │  ← 已有：文件夹切换
│ 🏷️ 筛选  ▊▊ 重要 × 待办 ×  │  ← 筛选入口 + chips（水平滚动）
│─────────────────────│
│  [资源列表卡片...]  │
│                     │
└─────────────────────┘
```

- `🏷️ 筛选` 入口始终显示（桌面端同理）
- 选中 chips 水平滚动（`Scroll` 组件 `NestedScrollMode.SELF_ONLY`）
- 超过 3 个 chip 时左右两侧加渐隐遮罩 + 滚动指示器
- 每个 chip 右侧 × 可移除
- 标签管理入口在顶栏 `⚙` 菜单中（或 `🏷️ 筛选` 入口旁）

#### 筛选标签 Sheet

点击 `🏷️ 筛选` → 底部 Sheet：

```
┌──────────────────┐
│ 筛选标签          │
│ 🔍 搜索标签...    │
│──────────────────│
│ ● AI         23 ✓│
│ ● 重要       17  │
│ ● 周报        8  │
│ ● 待办        5  │
└──────────────────┘
```

- 标签列表跟随当前文件夹
- 点击即切换，即时生效
- 每次打开时重新查询

### 文件夹切换 Sheet（已有）

保留现有 `FolderDrawer`，不做改动。

### 文件改动

| 文件 | 改动 |
|------|------|
| `shibei-harmony/.../pages/Library.ets` | 新增 `FilterChipsRow`；注册 TagManagePage 路由链接 |
| `shibei-harmony/.../components/FilterChipsRow.ets` | **新组件**：`🏷️ 筛选` 入口 + chips 水平滚动 + 渐隐 |
| `shibei-harmony/.../components/FilterTagSheet.ets` | **新组件**：筛选标签选择 Sheet |
| `shibei-harmony/.../pages/TagManagePage.ets` | **新组件**：标签管理页（新建/重命名/删除/颜色） |
| `shibei-harmony/.../resources/base/profile/main_pages.json` | **新增路由**：`pages/TagManagePage` |
| `shibei-harmony/.../services/ShibeiService.ets` | 新增 `listTagsInFolder(folderId)` |

---

## 后端改动

### 新增命令：`cmd_list_tags_in_folder`

```rust
#[tauri::command]
fn cmd_list_tags_in_folder(
    state: tauri::State<'_, AppState>,
    folder_id: Option<String>,  // None = 全部资料
) -> Result<Vec<TagWithCount>, String>
```

```sql
-- folder_id 非空：仅该文件夹下的标签
SELECT t.id, t.name, t.color, COUNT(DISTINCT r.id) as count
FROM tags t
JOIN resource_tags rt ON t.id = rt.tag_id
JOIN resources r ON r.id = rt.resource_id
WHERE r.folder_id = ?
  AND t.deleted_at IS NULL
  AND rt.deleted_at IS NULL
  AND r.deleted_at IS NULL
GROUP BY t.id
ORDER BY t.name

-- folder_id 为空（全部资料）：所有标签
SELECT t.id, t.name, t.color, COUNT(DISTINCT r.id) as count
FROM tags t
JOIN resource_tags rt ON t.id = rt.tag_id
JOIN resources r ON r.id = rt.resource_id
WHERE t.deleted_at IS NULL
  AND rt.deleted_at IS NULL
  AND r.deleted_at IS NULL
GROUP BY t.id
ORDER BY t.name
```

返回类型：

```rust
#[derive(Serialize)]
struct TagWithCount {
    id: String,
    name: String,
    color: String,
    count: usize,
}
```

### 资源列表新增 AND 筛选

`cmd_list_resources` / `cmd_list_all_resources` / `cmd_search_resources` 新增 `filter_tag_ids: Vec<String>` 参数。

AND 筛选使用 **INTERSECT** 方案（替代逐行 COUNT 子查询）：

```sql
-- folder_id 非空：
WITH matched_ids AS (
  SELECT resource_id FROM resource_tags rt
  WHERE rt.tag_id = ?1 AND rt.deleted_at IS NULL
  INTERSECT
  SELECT resource_id FROM resource_tags rt
  WHERE rt.tag_id = ?2 AND rt.deleted_at IS NULL
  INTERSECT ...
)
SELECT r.id, r.title, ...
FROM resources r
WHERE r.id IN (SELECT resource_id FROM matched_ids)
  AND r.folder_id = ?
  AND r.deleted_at IS NULL
ORDER BY ...

-- folder_id 为空（全部资料）：去掉 r.folder_id = ? 行即可
```

- **INTERSECT 在 SQLite 中等价于 N 个 index lookup 求交集**，配合 `resource_tags(tag_id, resource_id) WHERE deleted_at IS NULL` 部分索引，每个 tag 扫描很小
- 对比 COUNT 子查询（每行计算一次），INTERSECT 只需求一次交集再从 resources 主表取数
- **外层必须叠加 `folder_id` 和 `deleted_at IS NULL`**，防止 INTERSECT 出来的 ID 跨文件夹或指向已软删除的资源
- 当 `filter_tag_ids` 为空时不注入 CTE，行为等同旧版

### 文件改动

| 文件 | 改动 |
|------|------|
| `crates/shibei-db/src/tags.rs` | 新增 `list_tags_in_folder(conn, folder_id)` |
| `crates/shibei-db/src/resources.rs` | `list_resources_by_folder` / `list_all_resources` 新增 `filter_tag_ids` |
| `crates/shibei-db/src/search.rs` | `search_resources` 新增 `filter_tag_ids` |
| `src-tauri/src/commands/mod.rs` | 新增 `cmd_list_tags_in_folder`；`cmd_list_resources` 等增加 `filter_tag_ids` |
| `src-harmony-napi/src/commands.rs` | 新增 `list_tags_in_folder` |

---

## 迁移

### 移除项

- 侧栏 `TagFilter` 组件
- `useTags` hook 中与侧栏交互相关的逻辑
- 鸿蒙端 `FolderDrawer` 中标签段（如果有）

### 保留项

- 所有后端标签 CRUD 命令不变
- 资源右键 `TagSubMenu` 不变
- `TagPopover` 创建/编辑不变
- 同步中标签处理逻辑不变

### OR 参数清理

`cmd_list_resources` / `cmd_list_all_resources` / `cmd_search_resources` 的 `tag_ids: Vec<String>` OR 参数仅服务于旧侧栏 `TagFilter`。侧栏移除后该参数无真实调用方。**实现前用 `grep -rn "tag_ids" src/ src-tauri/ crates/` 确认**，确认无调用后连同 db 层 `resources::list_resources_by_folder` / `list_all_resources` / `search::search_resources` 的 `tag_ids` 参数一并删除，精简接口面。

> 注意：这不影响同步引擎 payload 中的 `tag_ids` 字段（sync_log 序列化用），也不影响 `server/mod.rs` HTTP API 的 `tag_ids` query param（如有外部调用方）。

### 用户影响

- 标签仍在，只是不在侧栏显示。所有资源的标签数据不丢失
- 旧的 `sessionState` 中 `filterTagIds` 字段自然升级为 AND 语义
- 旧版中仅通过侧栏点标签来过滤的用户，升级后通过顶部 `🏷️ 筛选` 完成同样操作

---

## 实现备注（不入 spec，供实现阶段参考）

- **鸿蒙 chip 行布局**：`🏷️ 筛选` 入口 `flex-shrink: 0` 固定不滚，右侧 chips 独立 `Scroll` 横滑。避免选多个 chip 后入口按钮被滚出视图。
- **桌面管理面板交互**：标签列表中每行右侧 hover 显示 ✎ / 🗑 按钮，比右键/长按更直观（桌面端标准交互）。
- **标签计数刷新**：建议 `useTags` 同时订阅 `data:tag-changed` 和 `data:resource-changed`，任意变更时 refetch `listTagsInFolder` 保持芯片行 popover 内计数新鲜。
