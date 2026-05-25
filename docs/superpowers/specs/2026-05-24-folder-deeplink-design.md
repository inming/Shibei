# Folder Deeplink 设计文档

**日期**：2026-05-24
**范围**：桌面端与鸿蒙端的目录 deeplink 打开、目录链接复制入口

## 背景

Shibei 当前已经支持资料和高亮的 deeplink：

- `shibei://open/resource/{resourceId}` 打开资料
- `shibei://open/resource/{resourceId}?highlight={highlightId}` 打开资料并跳到高亮

桌面端在 `src/App.tsx` 解析 deeplink，资料右键菜单与标注菜单提供复制链接。鸿蒙端在
`Library.ets` 消费 pending deeplink，资源列表长按与标注面板提供复制链接。

目录当前只有选择、导入、新建子目录、编辑、删除、缓存等操作。用户希望目录也能复制
deeplink，用于跨设备或跨上下文快速打开同一个目录视图。

## 目标与非目标

### 目标

- 为目录定义稳定 deeplink 格式，和现有 resource deeplink 风格一致。
- 桌面端支持复制目录链接，并能在冷启动、已启动、锁屏后解锁场景打开目录链接。
- 鸿蒙端支持复制目录链接，并能在 pending deeplink 消费流程中打开目录链接。
- 支持系统目录 `__inbox__` 和虚拟目录 `__all__` 的链接复制与打开。
- 打开目录链接时进入资料库视图，选中目标目录，并清空标签过滤，避免链接打开后列表为空造成误解。

### 非目标

- 不做目录路径名称型链接，例如 `shibei://open/folder-path/工作/论文`。目录重名、改名、同步冲突会让路径不稳定。
- 不把标签过滤、搜索词、排序状态编码进目录链接。本次只做“打开目录”。
- 不做 Web 落地页或外部网页协议，仍然只支持 app 内 deeplink。
- 不为已删除目录自动 fallback 到收件箱，避免静默打开错误位置。

## Deeplink 格式

新增目录链接格式：

```text
shibei://open/folder/{folderId}
```

示例：

```text
shibei://open/folder/__all__
shibei://open/folder/__inbox__
shibei://open/folder/018f7b6a-...
```

选择该格式的原因：

- 与现有 `shibei://open/resource/{resourceId}` 平级，语义清晰。
- 后续如果要增加 `tag`、`search` 等入口，可以自然扩展为 `shibei://open/tag/{tagId}`。
- 不复用 resource 路径，避免 parser 和错误处理语义混淆。

`folderId` 使用已有数据库 ID 或虚拟 ID，不做 URL path 之外的名称解析。实现时应对
`folderId` 做 `encodeURIComponent` / `decodeURIComponent` 处理，虽然当前 ID 基本是 ASCII，
但这能保持和 URL 语义一致。

## 桌面端设计

### 打开目录链接

`src/App.tsx` 当前 `handleDeepLinkUrl` 只识别 resource 链接。需要扩展为两类：

- resource：保持现有行为不变。
- folder：进入资料库 Tab 并选中目录。

由于目录选中状态位于 `LibraryView` 内部，`App.tsx` 需要向 `LibraryView` 传入一个“待打开目录”的指令状态，或暴露一个集中式 library navigation prop。推荐使用最小侵入方案：

- `App.tsx` 保存 `pendingFolderOpen`，结构为 `{ folderId: string; ts: number }`。
- `LibraryView` 新增 prop `folderOpenRequest?: { folderId: string; ts: number }`。
- `LibraryView` 用 effect 响应请求：校验目录存在后设置 `selectedFolderId`、清空 `filterTagIds`、关闭 `showTrash`、清空当前预览资源。

校验规则：

- `__all__`：直接允许。
- `__inbox__`：直接允许。
- 其他 ID：调用 `cmd.getFolder(folderId)`，成功后允许；失败则 toast “目录不存在或已删除”。

打开成功后的状态：

- `activeTabId = __library__`
- `selectedFolderId = folderId`
- `filterTagIds = []`
- `showTrash = false`
- `selectedResource = null`
- 会话持久化沿用 `Layout.tsx` 现有保存逻辑。

锁屏行为沿用现有 pending deeplink：如果 app locked，先存入 `pendingDeepLinkRef`，解锁后再解析。

### 复制目录链接入口

桌面端入口保持与现有右键菜单一致：

- `FolderTree` 中普通目录右键菜单增加“复制链接”。
- `__inbox__` 当前右键菜单只有“导入文件”，追加“复制链接”。
- `__all__` 当前是单独按钮，不在 folder tree item 内，需要单独支持右键菜单，菜单只包含“复制链接”。

复制成功后使用现有 toast 模式。文案可以优先复用 `sidebar.contextCopyLink` / `sidebar.contextLinkCopied`；如果语义过于资源化，再新增通用 key，例如：

- `common.copyLink`
- `common.linkCopied`
- `common.copyFailed`

新增 UI 文案必须同步更新 zh/en 语言包。

## 鸿蒙端设计

### 打开目录链接

`Library.ets` 当前 `consumePendingDeepLink()` 只识别：

```text
shibei://open/resource/{resourceId}?highlight={highlightId}
```

需要增加 folder 分支：

```text
shibei://open/folder/{folderId}
```

打开成功时复用 `onFolderPick(folderId)` 的语义：

- 更新 `selectedFolderId`
- 清空 `selectedTagIds`
- 更新顶部 folder label
- 写入 `SessionState.library`
- 折叠态下关闭 drawer

校验规则与桌面一致：

- `__all__` 和 `__inbox__` 直接允许。
- 其他 ID 在 `ShibeiService.instance.listFolders()` 中存在才允许。
- 不存在时 toast “目录不存在或已删除”，不改变当前视图。

### 复制目录链接入口

`FolderDrawer.ets` 当前目录长按用于缓存目录，且 `__all__` 直接 return。需要改为菜单：

- 普通目录 / `__inbox__`：`缓存此目录`、`复制链接`、`取消`。
- `__all__`：`复制链接`、`取消`。

复制使用系统 pasteboard：

```text
shibei://open/folder/{folderId}
```

成功 / 失败 toast 复用 `common_copy_success` / `common_copy_failed`。按钮文案可复用
`annotation_copy_link`，如果希望语义更通用，再新增 `common_copy_link`。

## 数据流

### 桌面端

1. 用户右键目录，选择“复制链接”。
2. 前端写入剪贴板：`shibei://open/folder/{folderId}`。
3. 用户打开链接。
4. Tauri deep-link plugin 或 single-instance 转发把 URL 交给 `App.tsx`。
5. `App.tsx` 解析为 folder 请求，切换到资料库 Tab，并传递给 `LibraryView`。
6. `LibraryView` 校验 folder，更新资料库状态。

### 鸿蒙端

1. 用户长按 drawer 目录，选择“复制链接”。
2. ArkTS 写入系统剪贴板。
3. 用户打开链接。
4. `EntryAbility` 暂存 URI 到 `KEY_PENDING_DEEP_LINK`。
5. `Library.ets` 消费 pending deeplink。
6. folder 分支校验并调用目录选择逻辑。

## 错误处理

- URL 不匹配已知 deeplink：静默忽略，保持现有行为。
- folder ID decode 失败：记录 console/hilog warn，不改变 UI。
- folder 不存在或已删除：toast 提示，不改变当前 UI。
- 剪贴板写入失败：toast “复制失败”。
- 锁屏期间收到 folder deeplink：暂存，解锁后处理。

## 测试计划

### 桌面端

- 复制普通目录链接，剪贴板内容为 `shibei://open/folder/{id}`。
- 复制 `__inbox__` 链接并打开，资料库选中收件箱，标签过滤清空。
- 复制 `__all__` 链接并打开，资料库选中全部资料，标签过滤清空。
- 已启动 app 收到 folder deeplink，切回资料库 Tab。
- 锁屏期间收到 folder deeplink，解锁后打开目标目录。
- 打开不存在目录链接，显示错误 toast，不改变当前选择。

### 鸿蒙端

- 长按普通目录可复制链接。
- 长按 `__inbox__` 可复制链接并仍保留缓存目录能力。
- 长按 `__all__` 可复制链接。
- 冷启动 pending folder deeplink 后进入目标目录。
- 不存在目录链接显示 toast，不改变当前选择。

## 实施顺序建议

1. 桌面端扩展 parser 和 `LibraryView` folder open request。
2. 桌面端增加 `FolderTree` / `__all__` 复制入口和 i18n。
3. 鸿蒙端扩展 `Library.ets` folder deeplink 消费。
4. 鸿蒙端增加 `FolderDrawer.ets` 长按复制入口和 i18n。
5. 分别跑桌面 TypeScript 检查与鸿蒙 ArkTS build；桌面可补最小单元测试覆盖 URL 解析辅助函数，如果实现时抽出纯函数。
