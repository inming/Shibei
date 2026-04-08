# 拾贝同步机制完整文档

> 最后更新：2026-04-08，反映所有已修复问题后的最新状态。

## 一、数据模型

### 实体关系

```
folders (树形)
  └── resources (N:1 属于 folder)
        ├── highlights (N:1 属于 resource)
        │     └── comments (N:1 属于 highlight，可选)
        ├── comments (N:1 属于 resource，无 highlight 的独立笔记)
        └── resource_tags (N:N 关联 tag)
tags (扁平)
```

### 每个实体的关键字段

| 字段 | 说明 |
|------|------|
| `id` | UUID 主键 |
| `hlc` | Hybrid Logical Clock 时间戳，格式 `{wall_ms:013}-{counter:04}-{device_id}`，用于 LWW 冲突解决 |
| `deleted_at` | 软删除时间戳，NULL = 活跃 |
| `created_at` / `updated_at` | 业务时间，不参与同步冲突解决 |

## 二、三种删除操作

### 1. 软删除（移到回收站）

- **函数**: `delete_resource()`, `delete_folder()` 等
- **做了什么**: `SET deleted_at = now, hlc = new_hlc`
- **级联**: 子实体也同步更新 `deleted_at` 和 `hlc`（已修复，之前子实体不更新 HLC）
- **sync_log**: ✅ 写 DELETE 条目（含删除前的实体快照作为 payload）
- **可恢复**: 可通过 `restore_resource()` / `restore_folder()` 恢复

### 2. 硬删除（清空回收站）

- **函数**: `purge_resource()`, `purge_all_deleted()`
- **做了什么**: `DELETE FROM table WHERE id = ? AND deleted_at IS NOT NULL`，物理删除行
- **sync_log**: ✅ 写 PURGE 条目（已修复，之前不写）
- **级联**: 同时硬删 comments, highlights, resource_tags
- **文件系统**: 删除 `storage/{id}/snapshot.html`
- **sync_state**: 清理对应的 `snapshot:{id}` 标记
- **不可恢复**

### 3. Compaction 清理（自动/手动）

- **自动触发**: sync 目录超过 100 个文件或 10MB
- **手动触发**: 设置页"强制压缩"按钮（`cmd_force_compact`）
- **做了什么**:
  1. 上传新的全量快照 JSON
  2. 删除本设备的旧快照（只保留最新一个）
  3. 检查并补传缺失的 HTML 快照（HEAD 检查 S3，缺失则上传）
  4. 两阶段清理旧 JSONL 文件
  5. 硬删除 `deleted_at` 超过 90 天的行，清理对应 `snapshot:*` 标记
  6. 清理已上传的 sync_log 条目

## 三、S3 上的数据结构

```
S3 Bucket
├── meta/
│   └── keyring.json              # E2EE 加密密钥环
├── state/
│   ├── snapshot-{timestamp}.json  # 全量快照（每设备保留最新 1 个）
│   └── compaction-pending.json    # 待清理的文件列表
├── sync/
│   ├── {device_id_A}/
│   │   ├── 20260401T120000000Z.jsonl  # 增量变更日志
│   │   └── 20260402T080000000Z.jsonl
│   └── {device_id_B}/
│       └── 20260401T130000000Z.jsonl
└── snapshots/
    └── {resource_id}/
        └── snapshot.html          # 网页快照 HTML 文件
```

### S3 数据生命周期

| 路径 | 创建时机 | 删除时机 | 长期状态 |
|------|----------|----------|----------|
| `state/snapshot-*.json` | Phase 0 / compaction | compaction 时删本设备旧的 | 每设备 1 个 |
| `sync/{device_id}/*.jsonl` | Phase 1（每次同步） | compaction 两阶段清理 | 定期清空 |
| `snapshots/*/snapshot.html` | Phase 0 / Phase 1 / compaction 补传 | 手动孤儿清理工具 | 需手动维护 |
| `state/compaction-pending.json` | compaction | 下次 compaction 覆盖 | 始终 1 个 |
| `meta/keyring.json` | 启用加密时 | 关闭加密时 | 0 或 1 个 |

### 快照（snapshot JSON）内容

```json
{
  "timestamp": "2026-04-07T10:00:00Z",
  "device_id": "8c867497-...",
  "folders": [
    { "id": "f1", "name": "收藏", "hlc": "1775...", "deleted_at": null },
    { "id": "f2", "name": "已归档", "hlc": "1775...", "deleted_at": "2026-04-05T..." }
  ],
  "resources": [...],
  "tags": [...],
  "resource_tags": [...],
  "highlights": [...],
  "comments": [...]
}
```

**关键点**：快照包含**所有行**（含软删除的），但**不包含**已硬删除的。导入时**只处理 `deleted_at` 为空的记录**，删除传播只通过 JSONL 增量条目。

### JSONL 条目格式

```json
{
  "id": 42,
  "entity_type": "resource",
  "entity_id": "uuid-here",
  "operation": "INSERT",        // INSERT / UPDATE / DELETE / PURGE
  "payload": "{...实体JSON...}",
  "hlc": "1775276576135-0000-device-a",
  "device_id": "device-a"
}
```

## 四、同步流程（6 个阶段）

```
cmd_sync_now
  ├── 自愈检查（加密转换修复）
  └── engine.sync()
        ├── Phase 0:  ensure_initial_snapshot()    首次上传全量快照 + HTML
        ├── Phase 1:  upload_local_changes()       上传增量 JSONL + 新资源 HTML
        ├── Phase 1.5: maybe_import_snapshot()     新设备导入快照（仅首次）
        ├── Phase 2+3: download_and_apply()        下载并应用远端 JSONL（含断档检测）
        ├── Phase 4:  download_pending_snapshots() 下载 HTML 文件
        └── Phase 5:  maybe_compact()              压缩清理 + 补传缺失 HTML
```

### Phase 0: ensure_initial_snapshot()

**条件**: `last_sync_at` 为空（首次同步或加密转换后重置）

**做了什么**:
1. `export_full_state()` 导出 DB 全量（含软删除）
2. 上传为 `state/snapshot-{timestamp}.json`
3. 遍历所有活跃资料，上传 `snapshots/{id}/snapshot.html`
4. 将已有 sync_log 标记为 `uploaded = 1`

**不做的**: 不检查 S3 是否已有快照，每个设备重置后都会上传自己的。

### Phase 1: upload_local_changes()

**条件**: sync_log 表中有 `uploaded = 0` 的条目

**做了什么**:
1. 读取所有 pending 条目
2. 序列化为 JSONL 格式
3. 上传到 `sync/{device_id}/{timestamp}.jsonl`
4. 标记为 `uploaded = 1`
5. 对 operation=INSERT 的 resource，上传 snapshot.html

### Phase 1.5: maybe_import_snapshot()

**条件**: `last_sync_at` 为空

**做了什么**:
1. 列出 S3 上所有 `state/snapshot-*.json`
2. 按 device_id 分组，**每个外部设备只取最新的一个快照**（旧快照是新快照的子集）
3. **跳过 device_id = 自己的快照**
4. 对每个外部快照，调用 `import_snapshot_data()`：
   - folders → tags → resources → resource_tags → highlights → comments（拓扑序）
   - **只导入 `deleted_at` 为空的记录**（跳过已删除的）
   - resource_tags 插入前检查 tag 和 resource 是否存在（防孤儿）
5. 标记所有已有 JSONL 为"已处理"（设置 `remote:{device}:last_seq`）

### Phase 2+3: download_and_apply()

**条件**: 总是运行

**做了什么**:
1. 列出 `sync/` 下所有设备目录 + 本地 `sync_state` 中已知的设备（`remote:*:last_seq`）
2. 对每个远端设备：
   - **断档检测**: 如果 `last_seq` 有值，但 S3 上最早的 JSONL 比它新（或为空），说明中间的文件被 compaction 清理了
   - **断档恢复**: 下载该设备的最新全量快照，调用 `import_snapshot_data()` 导入
   - 然后继续处理 `last_seq` 之后的可用 JSONL
3. 下载、解析所有新条目
4. 拓扑排序（INSERT/UPDATE 先于 DELETE，DELETE 先于 PURGE）
5. 逐条应用，**每条都做 LWW 检查**：
   ```
   local_hlc = 从 DB 读当前实体的 hlc
   if local_hlc >= remote_hlc:
       跳过（本地更新）
   else:
       应用变更
   ```
6. INSERT/UPDATE → `upsert_entity()`（SQL 层面也有 LWW WHERE 条件）
7. DELETE → `soft_delete_entity()`（SQL 层面也有 LWW WHERE 条件）
8. PURGE → `purge_entity()`（仅对已软删除的实体执行物理删除，同时清理 `snapshot:*` 标记）

### Phase 4: download_pending_snapshots()

**条件**: `sync_state` 中有 `snapshot:{id} = "pending"` 的条目

**做了什么**:
1. 逐个下载 `snapshots/{id}/snapshot.html` 到本地
2. 成功则标记为 `synced`
3. **失败时检查资源是否仍存在**：如果资源已删除/purge，清除 stale pending 标记而非无限重试

### Phase 5: maybe_compact()

**条件**: 设备的 sync 目录超过 100 个文件或 10MB（手动强制压缩无此限制）

**做了什么**:
1. 上传新的全量快照 JSON
2. 删除本设备的旧快照（只保留最新一个）
3. **检查并补传缺失的 HTML 快照**（对每个活跃资源 HEAD 检查 S3，缺失则上传）
4. 两阶段清理旧 JSONL 文件（本次标记 → 下次删除）
5. 硬删除 `deleted_at` 超过 90 天的行，清理对应 `snapshot:*` 标记
6. 清理已上传的 sync_log 条目

## 五、LWW 冲突解决

HLC 格式: `{wall_ms:013}-{counter:04}-{device_id}`

**比较规则**: 字符串字典序比较。wall_ms 占主导，相同毫秒看 counter，再相同看 device_id。

**在三个地方使用**:

| 位置 | 怎么做 |
|------|--------|
| `apply_entries()`（Phase 2+3） | 应用前先查本地 hlc，`local >= remote` 则跳过 |
| `upsert_*()`（Phase 1.5 + 2+3） | SQL `ON CONFLICT DO UPDATE ... WHERE excluded.hlc > COALESCE(table.hlc, '')` |
| `soft_delete_entity()`（Phase 1.5 + 2+3） | SQL `WHERE hlc IS NULL OR hlc < ?` |
| `add_tag_to_resource()`（本地 CRUD） | SQL `ON CONFLICT ... WHERE ?3 IS NULL OR COALESCE(resource_tags.hlc, '') < ?3` |

**注意**: Phase 2+3 有**双重 LWW**（先在 `apply_entries` 检查一次，再在 SQL 里检查一次）。Phase 1.5 只有 SQL 层面的 LWW。

## 六、各操作的 sync_log 写入

| 操作 | entity_type | operation | 谁触发 |
|------|-------------|-----------|--------|
| 创建文件夹 | folder | INSERT | cmd + http server |
| 重命名文件夹 | folder | UPDATE | cmd |
| 移动文件夹 | folder | UPDATE | cmd |
| 删除文件夹 | folder | DELETE | cmd + http server |
| 创建资料 | resource | INSERT | http server（插件保存）|
| 更新资料 | resource | UPDATE | cmd |
| 移动资料 | resource | UPDATE | cmd |
| 删除资料 | resource | DELETE | cmd |
| 创建标签 | tag | INSERT | cmd + http server |
| 更新标签 | tag | UPDATE | cmd |
| 删除标签 | tag | DELETE | cmd + http server |
| 加标签到资料 | resource | UPDATE（含 tag_ids）| cmd + http server |
| 移除标签 | resource | UPDATE（含 tag_ids）| cmd + http server |
| 创建高亮 | highlight | INSERT | cmd |
| 删除高亮 | highlight | DELETE | cmd |
| 创建评论 | comment | INSERT | cmd |
| 更新评论 | comment | UPDATE | cmd |
| 删除评论 | comment | DELETE | cmd |
| **硬删除** | 各类型 | **PURGE** | cmd |
| **恢复** | 各类型 | UPDATE | cmd |

## 七、已修复问题总结

### 问题 1: 快照导入 deleted 记录覆盖活跃数据 ✅

**修复**: `import_snapshot_data()` 跳过 `deleted_at` 不为空的记录。删除传播只通过 JSONL 增量条目。
**提交**: `b2e4995`

### 问题 2: 硬删除不写 sync_log ✅

**修复**: 三个 purge 命令（`cmd_purge_resource`、`cmd_empty_trash`、`cmd_purge_all_deleted_folders`）都写 PURGE sync_log 条目。`apply_entries` 和 `purge_entity` 处理远端 PURGE。
**提交**: `98a02cf`

### 问题 3: S3 上快照累积 ✅

**修复**: Phase 1.5 每个外部设备只导入最新快照。Compaction 上传新快照后删除本设备旧快照。
**提交**: `6eef79c`

### 问题 4: 级联软删除不跨设备传播 ✅（早期修复）

### 问题 5: upsert_tag name 唯一约束 ✅（早期修复）

### 问题 6: 级联软删除子实体不更新 HLC ✅

**修复**: `delete_resource()`、`delete_highlight()`、`delete_tag()` 的级联 UPDATE 加上 `hlc = COALESCE(?2, hlc)`。`soft_delete_folder_tree()` 接受 HLC 参数传递给所有子实体。
**提交**: `6eef79c`

### 问题 7: add_tag_to_resource 缺少 LWW ✅

**修复**: ON CONFLICT 加 `WHERE ?3 IS NULL OR COALESCE(resource_tags.hlc, '') < ?3`。
**提交**: `6eef79c`

### 问题 8: 孤儿 resource_tags ✅

**修复**: `upsert_resource` 和 `import_snapshot_data` 的 resource_tags 插入改为 `SELECT ... WHERE EXISTS`，只在 tag/resource 存在时插入。
**提交**: `6eef79c`

### 问题 9: 预删冲突行静默丢数据 ✅

**修复**: `upsert_folder` 改为移动子实体到保留的文件夹 + 软删冲突行；`upsert_tag` 迁移 resource_tags + 软删。
**提交**: `0491289`

### 问题 10: JSONL 断档导致数据丢失 ✅

**场景**: 设备 A compaction 清理了 JSONL，设备 B 的 `last_seq` 指向已不存在的文件，中间变更静默丢失。
**修复**: `download_and_apply` 检测断档（最早可用 JSONL > last_seq，或无 JSONL），自动回退导入该设备的最新全量快照。设备列表同时从 S3 `sync/` 目录和本地 `sync_state` 的 `remote:*:last_seq` 记录中提取（防止 JSONL 全清后设备不可见）。
**提交**: `aa9f1ad`

### 问题 11: Compaction 不补传缺失 HTML ✅

**场景**: sync_log INSERT 被 compaction 清理后，HTML 上传不会再触发。断档回退恢复了元数据但 HTML 既不在本地也不在 S3。
**修复**: Compaction 步骤 1c 对每个活跃资源 HEAD 检查 S3，缺失则上传本地 HTML。
**提交**: `a4d0eb1`

### 问题 12: Stale pending snapshot 标记 ✅

**场景**: 资源被删除/purge 后 `sync_state` 中的 `snapshot:{id} = pending` 标记残留，每次同步 Phase 4 都尝试下载并失败。
**修复**: Phase 4 下载失败时检查资源是否存在，不存在则清除标记。Compaction 和 `purge_entity` 也同步清理。
**提交**: `6eef79c`

### 问题 13: Engine cascade_folder_delete 不传播 HLC ✅

**场景**: 远端 folder DELETE 级联删除子实体时不更新 HLC，导致子实体保留旧 HLC。后续较新的 UPDATE 会在 LWW 判定中胜出，意外复活已删除的子实体，造成跨设备数据不一致。
**修复**: `cascade_folder_delete` 接收并传播 `hlc` 参数到所有子实体的 UPDATE 语句，与本地 `soft_delete_folder_tree` 行为一致。
**提交**: `6a84351`

### 问题 14: restore_resource 子实体不同步到远端 ✅

**场景**: 恢复资料时本地级联恢复了 highlights/comments/resource_tags，但不更新子实体 HLC，且不写 sync_log 条目。远端设备不知道子实体已恢复，导致跨设备不一致。
**修复**: `restore_resource` 恢复子实体时更新 HLC（`COALESCE(?2, hlc)`），并为每个恢复的 highlight/comment 写 UPDATE sync_log 条目。
**提交**: `e9b49c0`

### 问题 15: restore_folder 不级联恢复子内容 ✅

**场景**: 删除文件夹时通过 `soft_delete_folder_tree` 级联删除所有子文件夹和资料，但恢复文件夹时只恢复文件夹自身，子内容保持删除状态。
**修复**: 新增 `restore_folder_tree` 递归恢复子文件夹、资料及标注，更新 HLC 并写 sync_log 条目，与删除操作对称。
**提交**: `5b38d6d`

### 问题 16: purge_folder 不递归处理子文件夹 ✅

**场景**: `purge_folder` 只硬删直接子资料，不处理嵌套的子文件夹。子文件夹及其资料变成孤儿行，等 90 天 compaction 才清理。
**修复**: `purge_folder` 改为递归实现（`purge_folder_recursive`），先深度遍历子文件夹，再依次清理资料和文件夹本身。
**提交**: `9708df3`

## 八、维护工具

### 强制压缩

- **位置**: 设置 > 同步 > 维护 > "强制压缩"
- **命令**: `cmd_force_compact`
- **作用**: 跳过阈值（100 文件 / 10MB）直接执行完整 compaction 流程
- **提交**: `7bc50ef`

### 孤儿快照清理

- **位置**: 设置 > 同步 > 维护 > "清理孤儿文件"
- **命令**: `cmd_list_orphan_snapshots` + `cmd_purge_orphan_snapshots`
- **作用**: 扫描 S3 上存在但本地 DB 中无记录（含软删除）的 HTML 文件，手动确认后删除
- **确认机制**: 三层确认——扫描结果预览 → 三条警告 + 输入孤儿数量确认 → 执行
- **提交**: `ffda1a1`
