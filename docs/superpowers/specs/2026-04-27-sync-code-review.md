# 同步子系统 Code Review — 问题清单

日期：2026-04-27
范围：`crates/shibei-sync/`, `crates/shibei-db/`, `src-tauri/src/commands/`, `src/hooks/useSync.ts`

---

## Critical（数据丢失 / 安全问题）

### 1. 加密未解锁时裸后端回退污染 S3 桶

**文件**: `src-tauri/src/commands/mod.rs:706-722`

**问题**: 当 S3 上存在 `meta/keyring.json`（加密已启用）但当前设备未解锁时，`build_sync_engine` 回退使用裸 `S3Backend` 而非返回错误。

**具体 case**:

```
初始状态：旧 Mac 启用了加密，S3 上有 meta/keyring.json，所有数据加密存储。
新 Mac 刚配好 S3 凭据，还没解锁加密。

新 Mac 点同步 →
  build_sync_engine:
    local_encryption_enabled = false        # 新设备，本地没有加密标记
    head("meta/keyring.json") → 存在       # S3 上有 keyring
    encryption_enabled = true               # 自动检测到加密
    encryption_state.get_key() → None       # 没解锁，内存里没有 MK
    回退用 raw S3Backend                   # ← 这里是 bug

  Phase 0:
    export_full_state() → 空数据库状态（0 resources）
    raw_backend.upload("state/snapshot-...json", plaintext_bytes)
    # ⚠️ 明文快照上传到了加密桶里

  Phase 2:
    list("sync/") → 发现旧 Mac 的 JSONL 文件
    raw_backend.download("sync/old-device/xxx.jsonl") → 拿到密文字节
    String::from_utf8_lossy() → 乱码
    serde_json::from_str() → 解析失败 → 同步中断
    # ⚠️ 明文和密文混在一起，后续所有设备都会遇到这个问题

  Phase 3: 0 entries（已被 Phase 2 中断）
  last_sync_at 已设置 → Phase 1.5 后续同步跳过快照导入
```

**影响**: 明文数据混入加密桶，污染整个同步体系。Phase 2 下载加密 JSONL 必然解析失败，同步实际上永远无法完成。

**建议修复**: 加密已检测但未解锁时应返回错误，引导用户解锁后再同步。不需要回退到裸后端。

---

### 2. 重复调用 `cmd_setup_encryption` 销毁现有 MK

**文件**: `src-tauri/src/commands/mod.rs:762-813`

**问题**: 加密已启用时再次调用设置加密，生成全新随机 MK → 新 keyring.json 覆盖 S3 上旧的 → 所有已加密数据永久不可解密。

**具体 case**:

```
初始状态：旧 Mac 启用了加密（keyring 在 S3），100 篇资料已加密上传。
所有设备（2 台 Mac + 1 台手机）都用同一个 MK 正常同步。

某天，手机用户进设置→加密页面。由于某种原因（网络抖动、UI 状态不同步），
页面显示"未配置加密"而非"已启用"。用户点了"启用端到端加密"。

cmd_setup_encryption:
  没有检查 config:encryption_enabled 是否已为 true
  → generate() → 全新的随机 salt + 全新的随机 MK
  → backend.upload("meta/keyring.json", 新 keyring)
  → S3 上的 keyring 被新版本覆盖

结果：
  - 手机持有 MK_new
  - 两台 Mac 持有 MK_old（在各自的 keychain 里）
  - S3 上的 keyring 包裹的是 MK_new
  - 三台设备现在用三个不同的 MK

  - 手机下次同步上传的数据 → 加密用 MK_new → 两台 Mac 无法解密
  - 两台 Mac 下次同步上传的数据 → 加密用 MK_old → 手机无法解密
  - 旧数据（用 MK_old 加密的）→ 手机无法解密
  - 没有任何设备能读取完整的数据集 → 实际上数据已裂化
```

**影响**: 所有加密数据事实上永久丢失。没有任何恢复手段——如果所有设备都失去了旧的 MK，100% 无法恢复。

**建议修复**: `cmd_setup_encryption` 开始处检查 `config:encryption_enabled`，如果已为 true 则返回错误 `"encryption already configured"`。

---

### 3. 旧明文 JSONL 残留导致同步崩溃

**文件**: `src-tauri/src/commands/mod.rs:797-803`（自愈重置）+ `crates/shibei-sync/src/engine.rs:547-636`（Phase 1 上传）

**问题**: 设备启用加密后，`sync_log.uploaded = 0` 让 Phase 1 重新上传了**新加密 JSONL**（含新时间戳）。但旧的**明文 JSONL** 文件（旧时间戳）仍留在 S3 上。

**具体 case**:

```
初始状态：两台 Mac 都在明文模式下同步了一段时间。

S3 上有：
  sync/A-Mac/20260427T100000.jsonl  （明文）
  sync/A-Mac/20260427T110000.jsonl  （明文）
  sync/B-Mac/20260427T103000.jsonl  （明文）

B-Mac 启用加密：
  cmd_setup_encryption:
    sync_log.uploaded = 0          # 所有条目标记为"未上传"
    last_sync_at 删除

B-Mac 下一次同步：
  Phase 0: last_sync_at 不存在 → 上传加密版 snapshot
  Phase 1: sync_log 有 pending 条目 → 上传新 JSONL：
    sync/B-Mac/20260427T120000.jsonl  （加密！）

S3 现在有：
  sync/A-Mac/20260427T100000.jsonl  （明文，旧）
  sync/A-Mac/20260427T110000.jsonl  （明文，旧）
  sync/B-Mac/20260427T103000.jsonl  （明文，旧）
  sync/B-Mac/20260427T120000.jsonl  （加密，新）

A-Mac 下一次同步：
  Phase 2: list("sync/") → 发现 B-Mac 有 2 个 JSONL
    remote:B-Mac:last_seq = 无（或指向 103000）
    需要下载 103000.jsonl 和 120000.jsonl

    EncryptedBackend.download("sync/B-Mac/20260427T103000.jsonl")
    → 拿到明文字节 → crypto::decrypt() 尝试解密 → ❌ 解密失败
    → 同步中断，A-Mac 无法继续
```

**影响**: 只要有旧明文 JSONL 残留，其他加密设备同步必然崩溃。实际上阻止了所有跨设备同步。

**建议修复**: `cmd_setup_encryption` 在设置加密时，需要清理**自己设备**在 `sync/{device_id}/` 下的旧 JSONL。或者 Phase 2 下载解密失败时 log + skip 而非中断整个同步。

---

### 4. `cascade_folder_delete` 无 HLC 保护

**文件**: `crates/shibei-sync/src/engine.rs:1538-1556`

**问题**: 级联删除子实体时，直接用父文件夹的 `hlc` 和 `deleted_at` 覆盖所有子实体，没有 `WHERE hlc < ?` 守卫（对比 `soft_delete_entity` 有这个守卫）。

**具体 case**:

```
初始状态：两台 Mac 同步正常。
  - Folder "工作"（HLC=100），含 Resource A（HLC=150）

A-Mac 本地操作：
  删除 Folder "工作" → 写 sync_log: DELETE folder, HLC=200
  （同时）修改 Resource A 的标题 → 写 sync_log: UPDATE resource, HLC=250
  # Resource A 被修改发生在"删除文件夹"之后，HLC 更高

B-Mac 拉取 A-Mac 的 JSONL：
  apply_entries 按拓扑序：
    1. DELETE folder, HLC=200 → cascade_folder_delete
       执行：
         UPDATE resources SET deleted_at=..., hlc='200' WHERE folder_id='工作' AND deleted_at IS NULL
         # ⚠️ Resource A 的 HLC=150 → 被覆写为 HLC=200
    2. UPDATE resource, HLC=250 → upsert_resource
       # ⚠️ Resource A 已经被标记为 deleted_at，HLC=200 < 250
       # 但 upsert_resource 更新了 title...然后 deleted_at 呢？
       # SQL: ON CONFLICT(id) DO UPDATE SET ... WHERE excluded.hlc > COALESCE(table.hlc,'')
       # HLC 250 > 200 → 更新成功，但 deleted_at 已被设置
       # Resource A 现状：title 被更新了但 deleted_at 也已设置 → 状态不一致

B-Mac 最终状态：
  Resource A 已被标记为"已删除"（因为父文件夹被删），
  但又有更新内容（因为修改的 HLC 更高）。
  这是一个不可能的状态——一个被删除的 resource 被更新了字段。
  用户打开 B-Mac：Resource A 不显示（被 deleted_at 过滤），修改丢失。
```

**影响**: 并发场景下，文件夹删除会覆盖掉对子实体的并发修改，造成静默数据丢失。

**建议修复**: 级联删除每种子实体时加 `AND (hlc IS NULL OR hlc < ?)` 守卫。

---

## High（行为错误）

### 5. 初始同步无视 `sync_interval=0`

**文件**: `src/hooks/useSync.ts:36-47`

**问题**: 应用启动时，只要配置了 S3 凭据就会自动执行首次同步，即使用户设了"禁用自动同步"（`sync_interval=0`）。

**具体 case**:

```
用户设置 sync_interval = 0（不想自动同步）

每次启动应用：
  useSync useEffect:
    cmd.getSyncConfig() → has_credentials = true
    cmd.getEncryptionStatus() → encryptionResolvedRef = true
    tryInitialSync() → 500ms 后自动调用 cmd.syncNow()

  首次同步执行，拉取所有远端变更 → 用户没预期会触发同步
  （HLC LWW 能保护本地未提交的新改动不被覆盖，但静默拉取数据会改变 UI 状态）
```

**影响**: 用户明确禁用了自动同步，但启动时仍会执行一次。不符合用户预期。

---

### 6. `syncingRef` 可能永久卡死

**文件**: `src/hooks/useSync.ts:92-98,129-140`

**问题**: 成功路径上 `syncingRef=false` 仅通过 `SYNC_COMPLETED` 事件回调设置。如果该事件未发出，`syncingRef` 永久为 `true`，彻底阻塞后续同步。

**具体 case**:

```
用户点同步按钮：
  doSync():
    syncingRef.current = true
    await cmd.syncNow()

    后端 engine.sync() 成功完成
    后端设置 last_sync_at
    后端 emit("data:sync-completed")  ← ❌ 假设此时 app 正在退出/窗口关闭
    前端 listener 未收到事件

    .then: 无异常 → catch 不触发
    syncingRef.current 保持 true

下次用户点同步：
  doSync():
    if (syncingRef.current) return;  ← 被跳过，同步永远无法再执行
```

**影响**: 用户点同步按钮后如果事件丢失，后续所有同步被阻塞，直到重启应用。

**建议修复**: `doSync` 的 try 块在 `await cmd.syncNow()` 之后加 `syncingRef.current = false`，或者至少加 `finally { syncingRef.current = false }`。

---

### 7. 设置加密后不把 MK 保存到 keychain

**文件**: `src-tauri/src/commands/mod.rs:806`

**问题**: `cmd_setup_encryption` 把 MK 存入内存后，不检查 `remember_key` 标记就把 MK 持久化到 OS keychain。对比 `cmd_unlock_encryption`（行 852-858）有保存逻辑。

**具体 case**:

```
用户在设置加密时勾选了"记住加密密钥" → config:remember_encryption_key = true
cmd_setup_encryption:
  encryption_state.set_key(mk)   # 只在内存里
  ❌ 没有 os_keystore::save_master_key(&mk)

应用重启后：
  EncryptionState 为空
  cmd_auto_unlock:
    os_keystore::load_master_key() → None（从未写过 keychain）
    返回 "no_stored_key"
  → 用户看到 "端到端加密已启用，需要输入密码后才能同步"
  → 用户困惑：我不是勾了"记住密钥"吗？

对比 cmd_unlock_encryption：
  encryption_state.set_key(mk)
  if remember_key → os_keystore::save_master_key(&mk)  ✅ 正确实现了
```

**影响**: 设置加密勾选了"记住密钥"，重启后仍需手动解锁，用户体验差，且和设定不一致。

**建议修复**: 在 `cmd_setup_encryption` 中加同样的 `remember_key` 检查，存到 keychain。

---

### 8. 快照导入 resource_tags 无 HLC 比较

**文件**: `crates/shibei-sync/src/engine.rs:793-799`

**问题**: 从快照导入资源标签关联时用 `INSERT OR IGNORE`，没有 HLC 比较。本地已有（更旧的）关联会阻挡快照中更新的关联。

**具体 case**:

```
A-Mac 导入 B-Mac 的 state snapshot。

B-Mac 的 snapshot 中有：
  resource_tags: {rid:"r1", tid:"tag1", hlc:"300"}

A-Mac 本地已有：
  resource_tags: {rid:"r1", tid:"tag1", hlc:"100"}  （很早之前加的同一条关联）

import_snapshot_data:
  INSERT OR IGNORE INTO resource_tags (resource_id, tag_id, hlc) VALUES ('r1', 'tag1', '300')
  → IGNORE：因为 (r1, tag1) 已存在 → 跳过
  → A-Mac 的 hlc 保持 100，B-Mac 认为 hlc 为 300

后续同步时，A-Mac 的 sync_log 可能用 hlc 100 覆盖 B-Mac 的 300
```

**影响**: 标签关联的 HLC 可能被旧版本覆盖，导致 LWW 比较出现不一致。

**建议修复**: 改用 `INSERT ... ON CONFLICT DO UPDATE SET hlc=... WHERE excluded.hlc > COALESCE(table.hlc, '')`。

---

### 9. `upsert_resource` 删除所有标签再重建

**文件**: `crates/shibei-sync/src/engine.rs:1400-1415`

**问题**: 资源 upsert 时，先 `DELETE FROM resource_tags WHERE resource_id = ?`，再重新插入 payload 中的 `tag_ids`。标签作为资源的一部分原子操作，而非独立实体。

**具体 case**:

```
两设备同时对同一 Resource A 添加不同标签：

A-Mac 加标签 "重要"（HLC=200）
B-Mac 加标签 "待办"（HLC=180）

A-Mac 的 JSONL（HLC=200）到达 B-Mac：
  upsert_resource A, tag_ids=["重要"]
    1. DELETE FROM resource_tags WHERE resource_id = A
       # B-Mac 本地的 "待办" 标签被删除
    2. INSERT resource_tags (A, 重要)
  → B-Mac 上 A 只有"重要"标签，B 添加的"待办"丢失

B-Mac 的 JSONL（HLC=180）到达 A-Mac：
  upsert_resource A, tag_ids=["待办"]
    1. DELETE FROM resource_tags WHERE resource_id = A
       # A-Mac 的 "重要" 标签被删除
    2. INSERT resource_tags (A, 待办)
  → A-Mac 上 A 只有"待办"标签

最终两设备上 A 都只剩一个标签，而且两个标签还不一样！
应该：两设备最终都有 "重要"+"待办" 两个标签。
```

**影响**: 并发添加标签→互相覆盖。标签应该作为独立同步实体，有自己的 sync_log 条目。

**建议修复**: 资源 tags 通过 `resource_tags` 表的 INSERT/DELETE sync_log 条目独立同步（类似 highlihgts/comments），而非跟随 resource upsert 一次性替换。

---

### 10. 每次同步重建 HlcClock

**文件**: `src-tauri/src/commands/mod.rs:729`

**问题**: 每次同步都 `HlcClock::new(device_id)`，从 `Hlc(0,0,device_id)` 开始。`apply_entries` 中 `receive()` 推进的时钟在 engine 销毁后丢失。

**具体 case**:

```
AppState 持有一个全局 clock（用于本地 CRUD 生成 HLC）。

全局 clock 当前状态：Hlc(物理时钟=1000, counter=5, device-A)

Sync 1:
  engine.clock = HlcClock::new("device-A")  → 从 (0, 0) 开始
  下载远端 entries，最高 HLC = (物理时钟=2000, counter=20)
  apply_entries 中 engine.clock.receive(2000, 20) → 推进到 (2000, 20)
  engine 销毁 → 推进的 clock 丢失，全局 clock 仍在 (1000, 5)

本地创建新资源：
  全局 clock.tick() → Hlc(1000, 6, device-A)  // counter 从 5 变 6
  sync_log entry HLC = "1000-6-device-A"

下次同步时，这个 HLC(1000, 6, device-A) 上传到远端。
远端已有 HLC(2000, 20, device-A)，比较次序：
  先比物理时钟：1000 < 2000 → 远端更"新"
  新 entry 的 HLC(1000, 6) 被视为"旧于"远端的最新状态
  对同一实体的 UPDATE，LWW 会比较后丢弃本地这条

结果：本地的最新操作可能被 LWW 判为"旧"，虽然实际时间更晚。
根因：全局 clock 没有被远端 HLC 推进，物理时钟分量滞留在旧值。
```

**影响**: 远端 HLC 推进不回馈到全局 clock，新本地操作的 HLC 可能在 LWW 比较中处于劣势。不过只要设备时钟正常（NTP 同步），物理时钟分量的差距通常很小，影响有限。

---

## Medium（边界条件 / 健壮性）

### 11. 单行 JSONL 解析失败 → 整个同步中断

**文件**: `crates/shibei-sync/src/engine.rs:1090-1094`

**问题**: JSONL 中有一条损坏的行，整个同步全部中断，所有后续正常条目都不处理。

**具体 case**:

```
S3 上有一份 JSONL 文件，含 500 条同步记录。

#499 条：{正常 JSON}
#500 条：{损坏的 JSON，某个字段缺失或被截断}  ← 上传时网络故障导致

其他设备同步到这个 JSONL 文件：
  第 1-499 条解析成功，已 push 进 all_entries
  第 500 条：
    serde_json::from_str::<SyncLogEntry>(line) → Err
    → return Err(SyncError::Json(err))  ← 整个 sync 失败
    → all_entries 中前面的 499 条全部丢弃，没有任何条目被 apply
```

**影响**: 一个坏的 entry 拖累整个 JSONL。sync_log 是追加写入的，不会被删除或修复，意味着这个 JSONL 文件会永远导致所有设备同步失败。

**建议修复**: 解析失败时 `log + skip`，继续处理后续行和后续文件。

---

### 12. 自愈逻辑在 engine 构建前执行

**文件**: `src-tauri/src/commands/mod.rs:542-560`

**问题**: 重置同步状态在 `build_sync_engine` 之前，如果 engine 构建失败，状态已被重置。

**具体 case**:

```
cmd_sync_now:
  # 自愈检查：
  encryption_enabled = true, encryption_sync_completed = false

  执行自愈：
    UPDATE sync_log SET uploaded = 0   ← 状态改变
    删除所有 remote:*:last_seq         ← 状态改变
    删除 last_sync_at                  ← 状态改变

  build_sync_engine:
    加载凭据 → ❌ 凭据未配置（或 keychain 访问失败）
    → 返回 Err("error.syncCredentialsNotSet")
    → cmd_sync_now 返回错误

下次用户修复凭据后，再次调用 cmd_sync_now：
  再次检查自愈：encryption_sync_completed 仍为 false
  再次执行自愈：再次把 sync_log.uploaded 设 0、删除游标
  → 每次都重置一次未上传 flag，虽然幂等但浪费
```

**影响**: 每次失败都重置一次标志，浪费但不破坏。如 engine 构建持续失败，重复重置 sync_log 不会有实际副作用（本身就是幂等的 `SET uploaded = 0`），仅在 engine 构建成功前保留重置态。

---

### 13. Snapshot 写入非原子

**文件**: `crates/shibei-sync/src/engine.rs:1776`

**问题**: `std::fs::write` 直接写最终路径，中途 crash 残留损坏文件。

**具体 case**:

```
download_snapshot("resource-123")：

  从 S3 下载 15MB 的 PDF snapshot → data
  std::fs::write("storage/resource-123/snapshot.pdf", data)
    → 系统正在写入第 10MB...
    → 用户强制退出应用 / 系统 crash
    → "snapshot.pdf" 只有 10MB，文件损坏

  下次启动：
    sync_state 中没有 "snapshot:resource-123" = "synced" 标记
    → 重新下载 ✅（这个兜底是有效的）

  但如果 crash 发生在标记写入之后（行 1779-1781）
  → 标记为 "synced" 但文件不完整
  → 不会再下载 → 用户看到损坏的 PDF（无法渲染）
```

**影响**: 极低概率但影响大。标记和文件写入之间不是原子操作。

**建议修复**: 写临时文件 → rename 到最终路径（POSIX 保证 rename 是原子操作）。

---

### 14. 旧设备 state snapshot 永不清理

**文件**: `crates/shibei-sync/src/engine.rs:383-395`

**问题**: Compaction 清理快照时，只删自己的旧快照。其他设备（尤其是已废弃不用的设备）的快照永远堆积。

**具体 case**:

```
用户换了 3 台 Mac，每次换机都重新生成 device_id：

旧 Mac #1（已卖掉）：device_id A → S3 上留下 5 个旧 snapshot
旧 Mac #2（已重置）：device_id B → S3 上留下 3 个旧 snapshot  
新 Mac #3：device_id C → 正常使用

Compaction 运行：
  只检查 device_id C 的同步目录（sync/{C}/）
  只删 C 的旧 snapshot → 留下 A、B 的快照不变

N 年后：state/ 下有几十个无用快照
```

**影响**: 存储空间无限增长，但量不大（每个快照 JSON 几 KB 到几百 KB）。

**建议修复**: Compaction 也清理其他设备的旧快照（保留每个设备最新一个）。

---

### 15. `get_resource_type` 默认返回 "html"

**文件**: `crates/shibei-sync/src/engine.rs:143-153`

**问题**: 资源不存在或 DB 出错时默认返回 `"html"`，可能对 PDF 用错的 S3 key。

**具体 case**:

```
资源 "r-pdf" 类型为 pdf，S3 上 snapshot key 为：
  snapshots/r-pdf/snapshot.pdf.gz

但 import_snapshot_data 在导入 resource 的 INSERT 失败了（某种约束冲突）
→ resource 行不存在于 DB

下载该 resource 的 snapshot：
  get_resource_type("r-pdf") → query_row → 找不到 → unwrap_or_else → "html"
  snapshot_s3_key("r-pdf", "html") → "snapshots/r-pdf/snapshot.html.gz"
  backend.download() → ❌ 404 Not Found
```

**影响**: 资源尚未写入 DB 时下载其 snapshot 会失败。不过这种情况比较少见（快照导入通常是顺序执行的）。

**建议修复**: 返回 `Result<String, ...>` 而非默认值，让调用方处理未知类型。

---

## Low（代码质量 / 小问题）

### 16. Compaction 阈值硬编码，不可配置

`crates/shibei-sync/src/engine.rs:251` — 100 文件 / 10MB 写死，不支持用户调优。

### 17. `EncryptedBackend::head()` 返回加密后大小

`crates/shibei-sync/src/encrypted_backend.rs:42-44` — 每个对象多报 ~41 字节（1B version + 24B nonce + 16B tag），对 compaction 阈值影响可忽略。

### 18. `sync_diag_log` 文件无上限，无轮转

`crates/shibei-sync/src/engine.rs:166-175` — 频繁同步设备上可能撑满磁盘。需在修复完成后移除或加轮转。

### 19. `cmd_purge_all_deleted` 批量 PURGE 共用同一个 HLC

`src-tauri/src/commands/mod.rs:1375` — 批量操作共享同一 HLC，技术上正确（逻辑上同时发生）但可能不易调试。

---

## 已在本会话修复的问题

1. `cmd_setup_encryption` 清空 S3 全部数据 → 已移除清理逻辑
2. `download_and_apply` 在 `sync/` 为空时不处理 state snapshot → 已加回退导入
3. `build_sync_engine` 加密未解锁时报错阻塞同步 → 已加回退（但引入 Critical #1）
4. `getEncryptionStatus` 不检测 S3 keyring → 已加远程检测
5. 两台设备各设加密导致 MK 不一致 → 已加 `cmd_restore_keyring` 恢复
6. 明文密码输入框 → 改用 password dialog
