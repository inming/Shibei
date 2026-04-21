# Phase 2 — HarmonyOS 骨架 + 核心能力 实施计划

- 日期：2026-04-21
- 范围：workspace 重构（crates 拆分）+ `src-harmony-napi` 正式化 + `shibei-harmony/entry` ArkTS 骨架
- 前置依赖：Phase 0 ✅（真机验证通过） / Phase 1 ✅（配对 envelope 已就绪）
- 后置消费者：Phase 3（阅读与标注）
- 设计文档：`docs/superpowers/specs/2026-04-20-harmony-mobile-mvp-design.md` §二、§三、§四、§六、§七
- 预计工期：4~5 周（1 人）
- 状态：🚧 进行中（Track A1 ✅ + A2 ✅ + A3 ✅ + B 部分 ✅ 合入 main；A4/A5/剩余 B/C/D/E/F 待开工）

---

## 进度记录

### Track A2 — 桌面 crates 拆分（2026-04-21 完成，合入 main 于 `489338c`）

5 个 commit 全部按计划合入，加 Phase 1 基线 2 个（workspace 初始化 + shibei-pairing），顶层 workspace 现有 7 个 crate：

| # | Commit | 说明 | 测试 |
|---|---|---|---|
| 1 | `d0c2a6a` | `feat(workspace): extract shibei-db crate` — 8 DB CRUD 模块 + 7 SQL migrations + HLC + sync_log + SyncContext | 96 |
| 2 | `12e6e42` | `feat(workspace): extract shibei-events crate` — 9 个领域事件名常量 | 0 |
| 3 | `cc72db8` | `feat(workspace): extract shibei-storage crate` — storage + plain_text + pdf_text | 14 |
| 4 | `e62b624` | `feat(workspace): extract shibei-sync crate` — backend/engine/crypto/keyring/encrypted_backend/pairing/sync_state/… | 51 |
| 5 | `9d7f632` | `feat(workspace): extract shibei-backup crate` — 本地备份 zip + restore | 4 |

合入后 `src-tauri/src/` 只剩 `commands/` + `server/` + `lib.rs` + `main.rs` + `annotator.js`；domain 代码全部在 `crates/` 下，通过 `src-tauri/src/lib.rs` 的 `pub use shibei_* as …` facade 保证 `crate::db::…` / `crate::sync::…` / `crate::backup::…` / `crate::events::…` / `crate::storage::…` / `crate::plain_text::…` / `crate::pdf_text::…` 全部 call site **零改动**。

**验收（2026-04-21，main 基线）**：

- `cargo test --workspace`：**184 passed, 3 ignored**（6 shibei + 4 backup + 96 db + 13 pairing + 14 storage + 51 sync），与 Phase 1 post-merge 基线完全一致
- `cargo clippy --workspace --all-targets`：2 个预存 warning（无新增）
- `cargo check --workspace --all-targets`：全绿
- `tsc --noEmit`：全绿
- Frontend vitest：32 failed / 111 passed —— 已验证与 main 基线相同（**预存，非 A2 引入**）

**偏离计划的细节**：

1. **hlc / sync_log / SyncContext 归 shibei-db**，而非 plan 原说的 shibei-sync。原因：db CRUD 要在同事务写 sync_log，若留 shibei-sync 会形成 sync → db → sync 循环。`sync/lib.rs` 加 `pub use shibei_db::{hlc, sync_log, SyncContext}` facade，老路径仍可用。
2. **`search::backfill_plain_text` 改成泛型 `F: Fn(&str) -> String`**，避免 shibei-db 拉 `scraper` / `pdf-extract`。2 个 caller（`src-tauri/src/lib.rs` 启动路径、`shibei-backup/src/lib.rs` 恢复路径）显式注入 extractor。
3. **`test_db` / `init_db` 加 `test-support` feature**。原 `#[cfg(test)]` 在下游 crate 测试里不可见，`src-tauri/Cargo.toml` 的 `[dev-dependencies]` 显式启用。
4. **`keyring::compute_verification_hash` 从 `pub(crate)` 升到 `pub`**。原先 in-crate 访问即可，跨 crate 后需要完整 `pub`。
5. **`shibei-events` 暂只做常量 crate，不带 `EventEmitter` trait**。原 plan §3.3 的 trait 等 Track A5（NAPI 事件转发）再加；桌面目前全部通过 `AppHandle::emit` 直接调，sync engine 也不 emit，trait 没有消费者。
6. **src-tauri 依赖瘦身**：`rust-s3` / `async-trait` / `chacha20poly1305` / `hkdf` / `sha2` / `zeroize` / `flate2` / `scraper` / `pdf-extract` / `zip` 全部迁到对应 crate。保留 `base64` / `keyring` / `argon2` / `rand`（commands/server 直接用）。
7. **plan 原说 "Day 1 末 Go/No-Go 判断是否退回 `src-tauri` 暴露成 lib 的 fallback"**：Day 1 `shibei-db` 拆分一次成功，无需 fallback。

### Track A1 — NAPI codegen（2026-04-21 完成，M1.b Go）

3 个 commit 合入 main，Mate X5 真机 3 条路径全通。

| # | Commit | 说明 |
|---|---|---|
| 1 | `7219581` | `feat(harmony-napi): codegen tool for NAPI bindings (Track A1)` — `crates/shibei-napi-macros` 空 proc-macro marker + `crates/shibei-napi-codegen` syn-based 解析 + 3 个渲染器（shim.c / bindings.rs / Index.d.ts） |
| 2 | `6fc44cf` | `fix(harmony): build script uses workspace-level target dir` — workspace 后 `target/` 移到仓库根，脚本 + `.cargo/config.toml` 升到根部 |
| 3 | `f147e1e` | `feat(harmony): Demo 8 page for NAPI codegen validation` — Mate X5 验证页 |

**5 个注解命令全绿**（3 sync + 1 async + 1 event）：

```
[sync ] hello          () -> string
[sync ] add            (i32,i32) -> i32
[sync ] s3_smoke_test  (5 strings) -> string
[async] echo_async     async(string) -> Promise<string>     (50ms latency验证过)
[event] on_tick        (i64,cb) -> () => void (unsub)        (启停正常，AtomicBool cancel 观察无误)
```

**验收（2026-04-21 Mate X5 真机 + 主机）**：

- `cargo test --workspace`：**189 passed, 3 ignored**（+5 codegen parser unit tests）
- `cargo clippy --workspace --all-targets`：无新增 warning
- `scripts/build-harmony-napi.sh release`：`libshibei_core.so` 4.2 MB，零 warning
- **Mate X5 Demo 8 端到端**：
  - sync `hello()` → 正确字符串
  - async `echoAsync("hi")` → Promise 约 50ms resolve 到 `"echo:hi"`
  - event `onTick(500, cb)` → 每 500ms 触发回调；`unsub()` 后立刻停

**偏离 plan**：

1. **codegen 位置**：plan §4.1 写 `src-harmony-napi/codegen/`，实际放 `crates/shibei-napi-codegen/` —— 与其他 workspace crates 一致。
2. **marker 用 proc-macro 而非 build.rs 触发 codegen**：plan §4.1 已决策"不挂 build.rs，手动 `cargo run -p shibei-napi-codegen`"，实施上用 no-op proc-macro（`crates/shibei-napi-macros/`）让 rustc 接受 `#[shibei_napi]`；codegen 是独立 bin，手动调用，CI 守恒用 `git diff --exit-code`。
3. **Async 返回类型仅实现 `Result<String, _>`**：`render_bindings.emit_async` 其他分支 stub reject；Phase 2 批 3（`sync_metadata` 等）前补齐。
4. **Event payload 仅 `i64`**：`on_tick` 足以证明 threadsafe_function + AtomicBool cancel 路径；其他 payload 类型等 Track A5 事件转发时泛化。
5. **`.cargo/config.toml` 升到 workspace 根**：A2 之后 `target/` 移到仓库根，原 `src-harmony-napi/.cargo/config.toml` 的 OHOS linker 设置不再生效；升级后所有方向调用 `cargo build -p shibei-core --target aarch64-unknown-linux-ohos` 都能找到正确 linker。

### Track A3 — AppState 单例 + 生命周期命令（2026-04-21 完成）

Commits：`e65aede` (AppState + 5 commands + B scaffolds) → `7dfd2b0`/`16b84db`/`57d79ea`/`0136008` (NAPI import 诊断迭代) → `3de11a0` (回滚 .so binary 提交)。

5 个 sync NAPI 命令上线：

```
initApp(dataDir: string) -> string        // "ok" | "error.*"
isInitialized() -> boolean
hasSavedConfig() -> boolean
isUnlocked() -> boolean
lockVault() -> void
```

`src-harmony-napi/src/state.rs` — `OnceLock<AppState>` 包 `data_dir` + `db_pool`（shibei-db `SharedPool`）+ `encryption`（shibei-sync `EncryptionState`）+ `device_id`（UUID 首次 init 生成并写 sync_state）。`init_app` idempotent。

**验收（Mate X5 Demo 9，2026-04-21）**：

- `initApp(/data/storage/el2/base/haps/entry/files)` → `ok`
- `isInitialized()` → `true` / `hasSavedConfig()` → `false` / `isUnlocked()` → `false`
- `lockVault()` 无异常，再 probe `isUnlocked()` 仍 `false`

### Track B — ArkTS 外壳骨架（部分完成）

4 个基础模块合入，页面骨架等后续 Track 消费：

| 文件 | 说明 |
|---|---|
| `app/AppStorageKeys.ets` | 9 个 key 常量 |
| `app/NavPathManager.ets` | 共享 `NavPathStack` + 6 个页名常量 |
| `app/FoldObserver.ets` | Phase 0 Demo 1 升级 + 100ms settle debounce |
| `services/ShibeiService.ets` | NAPI facade 单例 |

未完成：Navigation `PageMap` 骨架、EventBus 真正订阅逻辑 —— 等 C/E 页面落地时串起来。

### Debug 记录（Phase 2 A3/B 期间踩的坑）

1. **ArkTS `import * as` 对 `.so` 不工作** —— 返回 `undefined`，每次 `napi.foo()` 抛 `TypeError: undefined is not callable`。必须用命名导入（`import { init as napiInit }`）。16b84db 修复。
2. **NAPI export 名 `init` 被 ArkTS 保留** —— module linker 抛 `SyntaxError: does not provide an export name 'init'`。重命名 shim register fn 无效（57d79ea 无效），必须把公开导出名也换掉。Rust `init` → `init_app`，JS `initApp`。0136008 修复。
3. **`.so` 二进制不进 git** —— 另一台机器没 cross-compile 工具链时发现问题，原因是该机器用的是 pull 前缓存的旧 `.so`，不是最新构建。短暂提交二进制（d7b81d9）后回滚（3de11a0），补 `docs/harmony-dev-setup.md` 一次性配置文档。两个 memory 条目固化：[ArkTS NAPI 导入风格](file:///Users/work/.claude/projects/-Users-work-workspace-Shibei/memory/feedback_arkts_napi_import.md) + [Harmony .so workflow](file:///Users/work/.claude/projects/-Users-work-workspace-Shibei/memory/feedback_harmony_so_workflow.md)。

### Track A4 / A5 / 剩余 B / C / D / E / F — 待开工

下一步起手 **Track A4 批 2（`listFolders` / `listResources` / `searchResources` / `listTags` / `getResource` / `getResourceSummary`）** —— 开始真消费 shibei-db CRUD。A4 批 1（setS3Config / setE2EEPassword）推迟到 Track C 之前（需要 S3 网络栈 + Argon2id 解 keyring）。

---

## 一、目标与范围

### 1.1 产出

Phase 2 交付"可冷启动进 Library 看到真实资料列表"的最小闭环。不含阅读标注（Phase 3）、不含 PDF（Phase 4）。

M4 验收剧本：

```
冷启动 Mate X5 app
 → OnboardPage：扫描桌面 QR → 输 PIN → 输 E2EE 密码 → 启用生物（可跳过）
 → 首次元数据同步（进度条）
 → LibraryPage 折叠态单栏显示资料列表
 → 手动展开 Mate X5 → 自动切双栏布局
 → 点资料 → 跳 ReaderPage 占位（显示元数据 + "Phase 3 施工中"）
 → 切到后台 > 10min → 回前台弹 LockPage → 生物解锁 → 回 Library
```

### 1.2 明确不做（推到 Phase 3+）

- 阅读器 WebView + annotator.js 集成
- PDF 渲染
- 浮动选词工具条
- 标注 CRUD
- 搜索页的正文（body_text）命中（首次同步后 body_text 全空）
- 快照下载（NAPI 接口有，但 Library 不触发；点资料只跳占位）
- 缓存上限设置 / WiFi 自动预下载（Settings 精简）
- 标签管理 UI / 文件夹 CRUD
- 分享菜单保存网页
- 卡片 / Widget

### 1.3 锁定决策（来自 2026-04-21 对话）

| 决策点 | 选定 | 影响 |
|---|---|---|
| 桌面模块搬 crates | ✅ 接受完整重构 | Track A2 起手做，约 2–3 天 |
| codegen 投入 | ✅ 做 | Track A1 投入约 1 周，避免 40+ 手写 shim |
| Settings 精简 | ✅ 不含缓存/预下载设置 | Track F 只做"账号/重置/同步/深色/语言" |
| Phase 3 占位 Reader | ✅ 空白 NavDestination 显示元数据 | 不阻塞 Library 集成测试 |
| A2 执行分支策略 | ✅ 独立分支 `feature/harmony-phase2-workspace`，桌面 smoke 全绿再合 main | 避免 main 上拆 crate 出事导致 Phase 1 不能紧急热修 |
| codegen 产物入 git | ✅ 入 git（`src-harmony-napi/generated/*`） | Code review 可见；DevEco 环境不需要装 codegen 工具链；`.gitignore` 只忽略 `target/` |
| NAPI 异步 runtime | ✅ `OnceCell<tokio::runtime::Runtime>` 全局单例，默认 4 worker | Phase 2 不做 per-call handle |
| 密码错误限次 | ✅ LockPage 不限次（对齐桌面 spec §6.1；仅 Onboard Step 3 的 PIN 限 3 次） | — |

---

## 二、Track 总览与依赖

```
A1 codegen ─┐
            ├─→ A3 State ─→ A4 命令 ─┬─→ C Onboard/Lock ─┐
A2 crates   ┘                        │                   ├─→ 集成验证 ─→ M4
            ↑                        ├─→ D 同步 ────────┤
B 外壳 ─────┴────────────────────────┴─→ E Library ─────┤
                                                         │
A5 事件 ─────────────────────────────────────────────────┤
F Settings ──────────────────────────────────────────────┘
```

**关键路径**：A2（workspace 重构）→ A1（codegen）→ A4（命令实现）→ (C/D/E 并行) → 集成。

**并行空间**：
- B 外壳（ArkTS Navigation + FoldObserver）与 A1/A2 完全独立，可第一天就起
- F Settings UI 框架不依赖 NAPI（只在最后接通），可与 E 并行

---

## 三、桌面端前置改动（Track A2）

### 3.1 目标

把 `src-tauri/src/{db,sync,storage,events,plain_text,pdf_text,backup}` 提到顶层 `crates/shibei-*`，让 `shibei-core` NAPI crate 可以 path-dep 引用同一套代码。

### 3.2 现状调查

- 核心模块**零 Tauri 耦合**：`grep "tauri::" src-tauri/src/{db,sync,storage}/*.rs` 无命中，`AppHandle` / `Emitter` 全在 `commands/` 和 `server/` 层
- `src-tauri/src/commands/` + `server/` + `lib.rs` 共 118 处 `crate::{db,sync,storage,…}` 引用 — 这些要重定向

### 3.3 拆分清单

| 新 crate | 含原 `src-tauri/src/` 子模块 | 行数 | 依赖 |
|---|---|---|---|
| `shibei-db` | `db/*.rs`（8 文件） | ~4500 | rusqlite, r2d2, thiserror, serde, chrono, uuid |
| `shibei-sync` | `sync/*.rs`（13 文件，含 pairing.rs）| ~4000 | shibei-db, shibei-pairing, rust-s3, chacha20poly1305, argon2, hkdf, tokio |
| `shibei-storage` | `storage/*.rs` + `plain_text.rs` + `pdf_text.rs` | ~650 | shibei-db, scraper, pdf-extract |
| `shibei-backup` | `backup.rs` | ~430 | shibei-db, shibei-storage, zip |
| `shibei-events` | 新建；抽象 `events.rs` 为 trait | ~120 | （无 Tauri） |

`shibei-events` 设计（解耦 Tauri）：

```rust
// crates/shibei-events/src/lib.rs
pub trait EventEmitter: Send + Sync {
    fn emit(&self, event: &str, payload: serde_json::Value);
}

pub const RESOURCE_CHANGED: &str = "data:resource-changed";
// ... 其他 7 个常量
```

桌面 `src-tauri` 提供 `TauriEmitter(AppHandle)` 实现；NAPI 侧提供 `ThreadsafeFnEmitter` 实现。`shibei-sync` / `shibei-db` 接受 `Arc<dyn EventEmitter>` 替代原来的 `AppHandle`（目前 `crud` 函数接 `Option<&SyncContext>`，`SyncContext` 里新增 `emitter: Arc<dyn EventEmitter>`）。

### 3.4 Migration 策略（控制爆炸半径）

**用 facade 压 118 处重写到 ~5 处**：`src-tauri/src/lib.rs` 顶端加

```rust
pub use shibei_db as db;
pub use shibei_sync as sync;
pub use shibei_storage as storage;
pub use shibei_events as events;
pub use shibei_backup as backup;
```

这样 `commands/` 和 `server/` 里所有 `crate::db::…` 引用**零改动**。

### 3.5 执行步骤（3 天）

**分支策略**：整个 A2 在独立分支 `feature/harmony-phase2-workspace` 完成。Day 3 末桌面端 `cargo test --workspace` + `cargo clippy --workspace` + `npm run tauri dev` 手动冒烟（启动 / 同步 / 标注 / 备份恢复 / 配对 QR）全部通过后才合入 `main`。A2 合入前，后续 Track（A1/B/C/D/E/F）在同一分支上继续推进；A2 合 main 后其他 Track 改从 main rebase。

**Day 1：shibei-db**
0. `git checkout -b feature/harmony-phase2-workspace`
1. `git mv src-tauri/src/db crates/shibei-db/src/`，改 `mod.rs` → `lib.rs`
2. 新建 `crates/shibei-db/Cargo.toml`，抄 `src-tauri/Cargo.toml` 的 db 相关依赖
3. `src-tauri/Cargo.toml` 加 `shibei-db = { path = "../crates/shibei-db" }`
4. `src-tauri/src/lib.rs` 加 `pub use shibei_db as db;`
5. `src-tauri/src/{commands,server}/` 所有 `use crate::db::` 保持不动（facade 生效）
6. `cargo test --workspace` 验证——**零行为变化**

**Day 2：shibei-events + shibei-sync + shibei-storage**
- 先抽 `shibei-events`（新建，只有 trait + 常量）
- `shibei-sync`：连带 `pairing.rs`（Phase 1 已独立为 `shibei-pairing`，这里 `shibei-sync` path-dep）；`SyncContext` 加 `emitter: Arc<dyn EventEmitter>` 字段；`src-tauri/src/commands/` 改 `SyncContext::new(…, Arc::new(TauriEmitter(app.clone())))`
- `shibei-storage`：含 `plain_text.rs` + `pdf_text.rs`

**Day 3：shibei-backup + 清理 + 回归**
- 抽 `shibei-backup`
- `src-tauri/src/lib.rs` 保留 facade re-exports，删掉已搬走的 `mod db;` 等
- `cargo test --workspace` 全绿、`cargo clippy --workspace --all-targets` 零新增警告
- 桌面 `npm run tauri dev` 手动冒烟：启动 + 同步 + 标注 + 备份恢复 + 配对 QR 各试一次
- commit 按 crate 分 4~5 个（每个可独立编译）

### 3.6 回退预案

若 Day 1 shibei-db 拆分失败（rusqlite feature flag / r2d2 复杂），回退到**不拆 crate，`src-tauri` 暴露成 lib**：`src-tauri/Cargo.toml` 加 `[lib] name="shibei_desktop"`，NAPI crate `path = "../src-tauri"` 直接 depend — 丑但可行，代价是 NAPI 构建会拉 tauri 依赖（~500 crate）。**Day 1 末做 Go/No-Go**。

---

## 四、Track A — NAPI 桥（~1.5 周）

### 4.1 A1 — codegen 工具（~1 周）

**目标**：写 40+ 命令时，只写 Rust 函数签名 + `#[shibei_napi]` 注解；C shim + ArkTS `.d.ts` + JSON de/ser 自动生成。

**位置**：`src-harmony-napi/codegen/`（独立 `[[bin]]` 或独立 crate，不是 proc-macro，build.rs 触发）。

**输入**：`src-harmony-napi/src/commands/*.rs` 里的

```rust
#[shibei_napi]
pub fn list_folders() -> Result<Vec<Folder>, SError> { ... }

#[shibei_napi(async)]
pub async fn sync_metadata() -> Result<SyncReport, SError> { ... }

#[shibei_napi(event)]
pub fn on_resource_changed(cb: ThreadsafeCallback<ResourceChangedPayload>) -> Subscription { ... }
```

**输出**（全部入 git，`.gitignore` 只忽略 `src-harmony-napi/target/`）：
1. `src-harmony-napi/generated/shim.c` — 每个命令一个 `napi_value shibei_list_folders(napi_env, napi_callback_info)`，调用 napi API 解析参数 → `serde_json::from_str` → 调用 Rust 函数 → `serde_json::to_string` → napi_create_string_utf8 返回
2. `shibei-harmony/entry/src/main/cpp/types/libshibei_core/Index.d.ts` — ArkTS 类型声明，自动生成
3. `src-harmony-napi/generated/bindings.rs` — 被 `shim.c` 调用的 `extern "C" fn shibei_list_folders_ffi(params_json: *const c_char) -> *mut c_char` 包装层

**执行方式**：codegen 作为 `src-harmony-napi/codegen/` 独立 `[[bin]]`，**不挂 build.rs**。开发者手动 `cargo run -p shibei-codegen` 重新生成；CI 可加一步"重新生成后 `git diff --exit-code`"确保入库产物与源同步。理由：DevEco Studio 环境不需要装 codegen 工具链（只消费生成产物）；build.rs 自动跑会让 review 时的 diff 噪声大。

**类型映射**：

| Rust | JSON Wire | ArkTS |
|---|---|---|
| `String` / `&str` | string | `string` |
| `i32` / `i64` | number | `number` |
| `bool` | boolean | `boolean` |
| `Vec<T>` | array | `T[]` |
| `Option<T>` | nullable | `T \| null` |
| `HashMap<String, T>` | object | `Record<string, T>` |
| Struct with `#[derive(Serialize, Deserialize)]` | object | `interface` 自动生成 |
| `Result<T, SError>` | `{ok: T}` or `{err: {...}}` | throw / return |
| `async fn` | Promise | `Promise<T>` |
| `ThreadsafeCallback<T>` | — | 注册 + `(payload: T) => void` |

**异步模型**：

- `#[shibei_napi(async)]` → shim.c 用 `napi_create_promise`；Rust 端跑在 NAPI crate 内置 tokio runtime（`OnceCell<tokio::runtime::Runtime>`，`new_multi_thread().worker_threads(4).enable_all()`，**全局单例、多次调用复用**）。shim 在 NAPI C 侧用 `napi_create_threadsafe_function` 从 tokio worker 线程回调 resolve/reject
- sync 命令（`listFolders` 等）直接同步返回

**错误模型**：

```rust
#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum SError {
    #[error("{message}")]
    NotUnlocked { message: String },
    #[error("{message}")]
    S3Unreachable { message: String },
    #[error("{message}")]
    ResourceNotFound { message: String },
    #[error("{message}")]
    Internal { message: String },
    // ...
}
```

ArkTS 侧：

```typescript
try { await shibei.listFolders() } catch (e) {
  // e 有 code / message，code 可直接当 i18n key（加 "error." 前缀）
}
```

**codegen 依赖**（作为 build.rs 或独立 CLI）：

- `syn` 2.x — 解析 Rust 源
- `quote` — 生成 Rust 绑定
- `tinytemplate` — 生成 C shim 和 .d.ts

**验收**：
- 1 个 sync 命令（`hello`）+ 1 个 async 命令（`echo_async`）+ 1 个 event（`on_tick`）用 codegen 生成，Mate X5 调通全链路
- `cargo build --target aarch64-unknown-linux-ohos --release` ≤ 45s（目前 Demo 0 是 30s；加个 100 行 codegen 影响小）

**回退**：W1 末判断。若 codegen 没跑通，**只手写前 15 个最关键命令的 shim**（LibraryPage + Onboard 够用），codegen 推到 Phase 3。

### 4.2 A3 — AppState 单例（~0.5 天）

```rust
// src-harmony-napi/src/state.rs
pub struct AppState {
    pub data_dir: PathBuf,
    pub db_pool: shibei_db::SharedPool,
    pub encryption: Arc<shibei_sync::EncryptionState>,
    pub sync_config: Arc<RwLock<Option<shibei_sync::SyncConfig>>>,
    pub emitter: Arc<NapiEventEmitter>,
    pub runtime: tokio::runtime::Handle,
}

static APP_STATE: OnceCell<AppState> = OnceCell::new();

pub fn init(data_dir: &Path) -> Result<(), SError> { ... }
pub fn get() -> Result<&'static AppState, SError> {
    APP_STATE.get().ok_or(SError::NotInitialized { ... })
}
```

### 4.3 A4 — NAPI 命令清单（~3 天）

按优先级分批。每个命令签名见 spec §3.1，这里列具体化清单：

**批 1 — 初始化 / 解锁**（M2 前必需）：
- `init(data_dir: String) -> Result<()>` — 打开 DB 池、跑 migrations、装载 keyring、加载 sync_config
- `is_unlocked() -> bool`
- `lock_vault() -> ()`
- `set_s3_config(cfg: S3Config) -> Result<()>` — 写 DB + keyring
- `set_e2ee_password(pwd: String) -> Result<()>` — 拉 keyring.json + Argon2id 派生 + 解 MK，缓存到 `EncryptionState`

**批 2 — 浏览**（M3 前必需）：
- `list_folders() -> Result<Vec<Folder>>`
- `list_resources(folder_id: String, tag_ids: Option<Vec<String>>, sort: Option<Sort>) -> Result<Vec<Resource>>`
- `search_resources(query: String, tag_ids: Option<Vec<String>>) -> Result<Vec<SearchResult>>`
- `get_resource(id: String) -> Result<Option<Resource>>`
- `get_resource_summary(id: String, max_chars: Option<i32>) -> Result<String>`
- `list_tags() -> Result<Vec<Tag>>`

**批 3 — 同步**（M2 后）：
- `sync_metadata() -> Result<SyncReport>`（`#[shibei_napi(async)]`）
- `get_sync_status() -> SyncStatus`
- `on_sync_progress(cb) -> Subscription`

**批 4 — 标注**（Phase 3，Phase 2 只留接口 stub 不实现 body）：
- `list_highlights` / `list_comments` / `create_highlight` / `update_highlight` / `delete_highlight` / `create_comment` / `update_comment` / `delete_comment`

**批 5 — 快照文件**（Phase 3 才用，Phase 2 留 stub）：
- `has_snapshot_cached(id) -> Result<bool>`
- `download_snapshot(id) -> Result<String>`（返回本地 file:// 路径）
- `extract_plain_text(id) -> Result<()>`
- `evict_snapshot_lru(target_bytes) -> Result<()>`

**批 6 — 事件订阅**：
- `on(event: String, cb: ThreadsafeCallback<Value>) -> Subscription`
- 6 领域事件 + `sync-started` / `sync-failed` / `sync-progress`

**Phase 2 在批 1~3 + 6 即可**，4/5 做签名但返回 `SError::NotImplemented`。

### 4.4 A5 — 事件转发（~0.5 天，与 A3 并行）

NAPI 侧 `NapiEventEmitter` 实现 `shibei_events::EventEmitter`：

```rust
pub struct NapiEventEmitter {
    subscribers: Mutex<HashMap<String, Vec<ThreadsafeCallback>>>,
}
impl EventEmitter for NapiEventEmitter {
    fn emit(&self, event: &str, payload: Value) {
        let subs = self.subscribers.lock().unwrap();
        if let Some(cbs) = subs.get(event) {
            for cb in cbs {
                cb.call_async(payload.clone(), Non blocking);
            }
        }
    }
}
```

`sync_metadata` 等命令拿到 `&AppState`，SyncContext 构造时传 `state.emitter.clone()`。

---

## 五、Track B — ArkTS 外壳（~0.5 周，可第一天起）

### 5.1 目录结构

```
shibei-harmony/entry/src/main/ets/
  entryability/
    EntryAbility.ets          # 单实例 / deep link / onForeground·onBackground
  app/
    FoldObserver.ets          # 从 Phase 0 Demo 1 升级
    EventBus.ets              # NAPI event → ArkTS observers
    NavPathManager.ets        # 单例 NavPathStack
    AppStorageKeys.ets        # 所有 AppStorage/preferences key 常量
  services/
    ShibeiService.ets         # NAPI facade（所有 shibei.* 调用从这里走）
    PreferencesService.ets    # @ohos.data.preferences wrapper
    SessionStateService.ets   # 对齐桌面 sessionState schema
  pages/
    Index.ets                 # 路由入口（判断冷启动该去哪）
    OnboardPage.ets
    LockPage.ets
    LibraryPage.ets
    SearchPage.ets
    SettingsPage.ets
    ReaderPage.ets            # 占位
  components/
    FolderDrawer.ets
    ResourceList.ets
    ResourceItem.ets
    TopBar.ets
  i18n/
    en.ets / zh.ets           # 从桌面 locales/ 镜像脚本生成
```

### 5.2 Navigation 骨架

```typescript
// Index.ets
@Entry @Component
struct App {
  @Provide pathStack: NavPathStack = NavPathManager.instance;
  @StorageProp('foldStatus') foldStatus: FoldStatus = FoldStatus.FOLDED;

  @Builder PageMap(name: string) {
    if (name === 'Onboard')  OnboardPage();
    if (name === 'Lock')     LockPage();
    if (name === 'Library')  LibraryPage({ foldStatus: this.foldStatus });
    if (name === 'Reader')   ReaderPage();
    if (name === 'Search')   SearchPage();
    if (name === 'Settings') SettingsPage();
  }

  aboutToAppear() {
    FoldObserver.instance.start();
    this.routeInitial();
  }

  async routeInitial(): Promise<void> {
    const hasConfig = await shibei.hasSavedConfig();
    if (!hasConfig) { this.pathStack.replacePath({ name: 'Onboard' }); return; }
    if (!shibei.isUnlocked()) { this.pathStack.replacePath({ name: 'Lock' }); return; }
    this.pathStack.replacePath({ name: 'Library' });
  }

  build() {
    Navigation(this.pathStack)
      .mode(NavigationMode.Auto)
      .navBarWidth('40%')
      .navBarWidthRange([280, 400])
      .hideNavBar(isFullscreenPage(this.pathStack));
  }
}
```

### 5.3 FoldObserver（基于 Phase 0 Demo 1）

Phase 0 发现 Mate X5 发 HALF_FOLDED、最小 delta 86ms。采用"状态静默 100ms 后才应用"而非 debounce：

```typescript
class FoldObserver {
  private pendingTimer: number = -1;
  start(): void {
    display.on('foldStatusChange', (status) => {
      const normalized = this.normalize(status);
      if (this.pendingTimer >= 0) clearTimeout(this.pendingTimer);
      this.pendingTimer = setTimeout(() => {
        AppStorage.setOrCreate('foldStatus', normalized);
        this.pendingTimer = -1;
      }, 100);
    });
  }
}
```

### 5.4 EventBus

```typescript
class EventBus {
  private subs = new Map<string, Set<(p: unknown) => void>>();

  constructor() {
    for (const e of DOMAIN_EVENTS) {
      shibei.on(e, (p) => this.dispatch(e, p));
    }
  }

  subscribe(event: string, cb: (p: unknown) => void): () => void { ... }
  dispatch(event: string, payload: unknown) { ... }
}
```

组件里：

```typescript
@Component struct FolderDrawer {
  private unsub?: () => void;
  aboutToAppear() {
    this.unsub = EventBus.instance.subscribe('data:folder-changed', () => this.reload());
  }
  aboutToDisappear() { this.unsub?.(); }
}
```

### 5.5 i18n

写 `scripts/sync-harmony-i18n.mjs`：读 `src/locales/{zh,en}/*.json` 合并导出到 `shibei-harmony/entry/src/main/ets/i18n/{zh,en}.ets`（扁平化为 `Record<string, string>`，key 加命名空间前缀 `sidebar.xxx`）。`t(key)` 函数从 `AppStorage` 取当前语言。

---

## 六、Track C — Onboard + Lock + 生物（~1 周，依赖 A4 批 1 + 批 2）

### 6.1 OnboardPage 状态机

```typescript
@Component struct OnboardPage {
  @State step: 1 | 2 | 3 | 4 | 5 = 1;
  @State envelope: string = '';      // Step 2 扫到的
  @State s3Config: S3Config | null = null;  // Step 3 解密得到的
  @State pinAttempts: number = 0;
  @State error: string = '';

  build() {
    Column() {
      if (this.step === 1) this.WelcomeStep();
      if (this.step === 2) this.ScanStep();
      if (this.step === 3) this.PinStep();
      if (this.step === 4) this.PasswordStep();
      if (this.step === 5) this.BiometricStep();
    }
  }

  // Step 2: ScanKit 集成（@kit.ScanKit）
  async onScanSuccess(qrText: string): Promise<void> {
    const env = JSON.parse(qrText);
    if (env.v !== 1) { this.error = t('error.pairingInvalidEnvelope'); return; }
    this.envelope = qrText;
    this.step = 3;
  }

  // Step 3: PIN 解密（走 NAPI 到 shibei-pairing）
  async submitPin(pin: string): Promise<void> {
    try {
      const plain = await shibei.decryptPairingPayload(pin, this.envelope);
      this.s3Config = JSON.parse(plain);
      await shibei.setS3Config(this.s3Config);
      this.step = 4;
    } catch (e) {
      this.pinAttempts++;
      if (this.pinAttempts >= 3) { this.error = t('error.pairingTooManyAttempts'); return; }
      this.error = t('error.pairingPinIncorrect', { left: 3 - this.pinAttempts });
    }
  }

  // Step 4: E2EE 密码
  async submitPassword(pwd: string): Promise<void> {
    try {
      await shibei.setE2EEPassword(pwd);
      this.step = 5;
    } catch (e) {
      this.error = t(errorKey(e));  // 区分 kBadPassword / kNetworkError
    }
  }

  // Step 5: 生物解锁（可跳过）
  async enableBiometric(): Promise<void> {
    // 1. 生成 wrapper_key
    const wrapperKey = cryptoFramework.createRandom().generateRandomSync(32);
    // 2. userIAM.userAuth 认证（Phase 0 定 ATL2 + FINGERPRINT + 回退密码）
    const authResult = await authenticate({ level: AuthTrustLevel.ATL2, types: [AuthType.FINGERPRINT, AuthType.PIN] });
    if (!authResult.success) return;
    // 3. HUKS 存 wrapper_key
    await huks.generateKey('shibei_mk_wrapper', { ...biometricParams });
    // 4. 用 wrapper_key 包裹 MK
    const wrappedMk = await shibei.wrapMasterKeyForBiometric(wrapperKey);
    await preferences.put('mk_biometric_wrapped', wrappedMk);
    this.finish();
  }

  finish(): void {
    pathStack.replacePath({ name: 'Library' });
    shibei.syncMetadata();  // 后台启动首次同步
  }
}
```

### 6.2 新增 NAPI 命令（Track A4 之外，Onboard 专用）

- `has_saved_config() -> bool`（未进 Onboard 前都没有）
- `decrypt_pairing_payload(pin: String, envelope: String) -> Result<String>` — 包 `shibei-pairing::decrypt_payload`；返回 JSON 字符串
- `wrap_master_key_for_biometric(wrapper_key: Vec<u8>) -> Result<Vec<u8>>`
- `unlock_with_wrapped_mk(wrapper_key: Vec<u8>, wrapped_mk: Vec<u8>) -> Result<()>`

### 6.3 LockPage

```typescript
@Component struct LockPage {
  @State passwordInput: string = '';
  @State biometricEnabled: boolean = preferences.has('mk_biometric_wrapped');

  async tryBiometric(): Promise<void> {
    const authResult = await authenticate({ ... });
    if (!authResult.success) return;
    const wrapperKey = await huks.export('shibei_mk_wrapper');  // 触发生物 prompt
    const wrappedMk = await preferences.get('mk_biometric_wrapped');
    await shibei.unlockWithWrappedMk(wrapperKey, wrappedMk);
    this.afterUnlock();
  }

  async tryPassword(): Promise<void> {
    // 密码错误不限次（对齐桌面 spec §6.1）；仅 toast 错误文案，用户可无限重试
    try {
      await shibei.setE2EEPassword(this.passwordInput);
      this.afterUnlock();
    } catch (e) {
      this.error = t(errorKey(e));  // kBadPassword / kNetworkError
      this.passwordInput = '';
    }
  }

  afterUnlock(): void {
    const pending = AppStorage.get<string>('pendingDeepLink');
    if (pending) { AppStorage.delete('pendingDeepLink'); /* 跳转 */ }
    else { pathStack.replacePath({ name: 'Library' }); }
  }
}
```

### 6.4 Auto-lock 时序（EntryAbility）

按 spec §6.3 原样落地（`suspendedAt` preferences + `autoLockMinutes` 默认 10 分钟）。

### 6.5 HUKS 三个 alias

按 spec §6.4 创建：

- `shibei_s3_aead` — `PURPOSE_ENCRYPT \| PURPOSE_DECRYPT`，普通访问
- `shibei_mk_wrapper` — `BIOMETRIC_REQUIRED`，每次 prompt
- `shibei_device_salt` — 启动读一次常驻内存

---

## 七、Track D — 首次/增量同步（~0.5 周，依赖 A4 批 3）

### 7.1 首次同步（Onboard 完成后后台启动）

```typescript
// OnboardPage.finish() 后
shibei.on('sync-progress', (p: { current: number, total: number }) => {
  AppStorage.set('syncProgress', p);
});
shibei.syncMetadata();
```

**LibraryPage 顶部浮动进度条**：首次 `syncProgress.total > 0 && current < total` 时显示。

### 7.2 Rust 侧改造（shibei-sync）

`SyncEngine::run` 加进度回调：

```rust
impl SyncEngine {
    pub fn run_with_progress<F: Fn(usize, usize) + Send>(
        &self, ctx: &SyncContext, on_progress: F
    ) -> SyncReport { ... }
}
```

`apply_entries` 每 100 条调一次 `on_progress`。NAPI 侧 `sync_metadata` 传 closure 桥到 `emitter.emit("sync-progress", …)`。

### 7.3 FTS 首次重建

桌面 `backfill_plain_text` + `rebuild_all_search_index` 已在 `shibei-db::search` 内；移动端首次同步后 body_text 全为 NULL，重建只覆盖元数据/标注/评论。`config:fts_initialized` 在首次同步成功后写入。

### 7.4 失败恢复

- 网络断 → `last_log_seq` 不更新 → 下次启动 `syncMetadata` 自动续
- UI：Library 顶部持久化 banner "同步未完成 (1234/2500)，[立即重试]"

---

## 八、Track E — LibraryPage（~1 周，依赖 A4 批 2 + B）

### 8.1 折叠态布局

```typescript
@Component struct LibraryPage {
  @Prop foldStatus: FoldStatus;
  @State selectedFolderId: string = INBOX_FOLDER_ID;
  @State selectedTagIds: string[] = [];
  @State selectedResourceId: string | null = null;
  @State drawerOpen: boolean = false;
  @State resources: Resource[] = [];

  build() {
    if (this.foldStatus === FoldStatus.FOLDED) {
      this.FoldedLayout();
    } else {
      this.ExpandedLayout();
    }
  }

  @Builder FoldedLayout() {
    SideBarContainer(SideBarContainerType.Overlay) {
      FolderDrawer({ onSelect: (id) => this.onFolderSelect(id) });
      Column() {
        TopBar({ onMenu: () => this.drawerOpen = true });
        ResourceList({
          resources: this.resources,
          onTap: (id) => pathStack.pushPath({ name: 'Reader', param: id })
        });
      }
    }.showSideBar(this.drawerOpen).controlButton({ showButton: false });
  }

  @Builder ExpandedLayout() {
    // Navigation.mode(Auto) 已经 split，这里只渲染 navBar（左栏）
    // 右栏由 NavDestination('Reader') 托管
    SideBarContainer(SideBarContainerType.Overlay) {
      FolderDrawer({ onSelect: (id) => this.onFolderSelect(id) });
      Column() {
        TopBar({ onMenu: () => this.drawerOpen = true });
        ResourceList({
          resources: this.resources,
          onTap: (id) => { this.selectedResourceId = id; pathStack.pushPath({ name: 'Reader', param: id }); }
        });
      }
    };
  }

  async onFolderSelect(id: string): Promise<void> {
    this.selectedFolderId = id;
    this.resources = await shibei.listResources(id, this.selectedTagIds);
    this.drawerOpen = false;
  }

  aboutToAppear() {
    EventBus.instance.subscribe('data:resource-changed', () => this.reload());
    EventBus.instance.subscribe('data:sync-completed', () => this.reload());
    this.onFolderSelect(this.selectedFolderId);
  }
}
```

### 8.2 ResourceList（`LazyForEach` 虚拟滚动）

```typescript
@Component struct ResourceList {
  @Prop resources: Resource[];
  @State dataSource: ResourceDataSource;

  build() {
    List({ space: 0 }) {
      LazyForEach(this.dataSource, (r: Resource) => {
        ListItem() {
          ResourceItem({ resource: r, onTap: () => this.onTap(r.id) });
        }
      }, (r: Resource) => r.id);
    }
    .cachedCount(10)
  }
}
```

**ResourceItem 视觉**：标题 + URL + 日期 + 最多 3 个标签色点 + 高亮数徽章。对齐桌面 `ResourceList` 列表项（不做搜索时的 snippet，Phase 2 暂不展示）。

### 8.3 FolderDrawer

- `listFolders()` 拿树，`@ObservedV2` 扁平化渲染
- 支持 `INBOX_FOLDER_ID`（收件箱）+ `ALL_RESOURCES_ID`（所有资料）虚拟项置顶
- 无 CRUD
- 单选，`onSelect(id)` 回调 + 自动关抽屉

### 8.4 SearchPage

- 折叠全屏 / 展开 overlay
- 顶部搜索框，debounce 300ms → `shibei.searchResources(q, tags)`
- 结果列表同 ResourceList，但显示 `match_fields` 标签
- 点击 → `pathStack.pushPath({ name: 'Reader', param: result.id })`

### 8.5 TopBar

```
[ ☰ ] [ 当前folder名 ] [ 🔍 ] [ ⚙ ]
```

点 🔍 跳 SearchPage，点 ⚙ 跳 SettingsPage。

### 8.6 持久化（对齐桌面 sessionState schema）

```typescript
// PreferencesService key: shibei-session-state
{
  version: 1,
  library: {
    selectedFolderId: string,
    selectedTagIds: string[],
    selectedResourceId: string | null,
    listScrollOffset: number,
  },
  readerTabs: [],  // Phase 3 才填
  activeTabId: null,  // Phase 3 才填
  libraryLeftWidth: number,  // 展开态左栏宽
}
```

### 8.7 ReaderPage 占位

```typescript
@Component struct ReaderPage {
  @State resource: Resource | null = null;

  aboutToAppear() {
    const id = pathStack.getParamByName('Reader');
    shibei.getResource(id).then(r => this.resource = r);
  }

  build() {
    Column() {
      if (this.resource) {
        Text(this.resource.title);
        Text(this.resource.url).fontSize(12);
        Text(`Phase 3 施工中 — 阅读器将在 Phase 3 上线`).margin({ top: 40 });
      }
    }.padding(20);
  }
}
```

---

## 九、Track F — Settings 精简版（~0.5 周，与 E 并行）

### 9.1 页面结构

```
Settings
├─ 账号
│  └─ S3 endpoint（显示，隐藏 secret）
│  └─ 已配对设备名（仅显示，不做撤销）
├─ 安全
│  └─ [锁定应用]
│  └─ [重置本机]（危险操作，需二次确认）
├─ 数据
│  └─ 上次同步: 14:23
│  └─ [立即同步]
│  └─ 缓存用量: 234 MB（只读，Phase 3 才做淘汰）
├─ 外观
│  └─ 深色模式: [light | dark | system]
│  └─ 语言: [简体中文 | English]
```

### 9.2 "重置本机"实现

```typescript
async function resetDevice(): Promise<void> {
  // 1. HUKS 清 3 个 alias
  await huks.deleteKey('shibei_s3_aead');
  await huks.deleteKey('shibei_mk_wrapper');
  await huks.deleteKey('shibei_device_salt');
  // 2. preferences 清所有 key
  await preferences.deleteAll();
  // 3. NAPI 关 DB，删 data_dir
  await shibei.resetAll();
  // 4. 重启 app（ability.restart）
}
```

NAPI 新增 `reset_all() -> Result<()>`：锁 DB pool → 删 `{data_dir}/shibei.db` → 删 `{data_dir}/storage/` → 清内存 state。

---

## 十、里程碑与 Go/No-Go

| M | 目标 | 位置 | 验收 | No-Go 预案 |
|---|---|---|---|---|
| M1.a | A2 shibei-db 拆出，桌面 cargo test 全绿 | W1 Day 1 | `cargo test --workspace` 184+ 全过，`npm run tauri dev` 冒烟 | 退回 `src-tauri` 暴露成 lib |
| M1.b | A1 codegen 跑通 3 示例命令 | W1 Day 7 | Mate X5 调通 hello/echo_async/on_tick | 退回手写 15 个关键命令 |
| M2 | Onboard 5 步走通 + 首次同步 DB 有数据 | W3 Day 3 | 扫桌面 QR → 输 PIN + 密码 → 进度条跑完 → DB 有 resource 行 | 扫码失败则手动贴 envelope 文本 fallback |
| M3 | LibraryPage 折叠/展开双态稳定 | W4 Day 3 | 手动折叠 Mate X5，布局切换 ≤ 1s，虚拟滚动不掉帧 | 展开态砍掉，先发折叠态 |
| M4 | Phase 2 全绿 | W5 Day 5 | 冷启动 → 解锁 → 看到列表 → 搜索 → 跳占位 Reader → 后台 10min → 锁屏 → 生物解锁 | — |

---

## 十一、风险矩阵

| 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|
| A2 crates 拆分破坏桌面 cargo test | 低 | 高 | Day 1 末 Go/No-Go；预案：`src-tauri` 暴露成 lib 的 fallback 路径 |
| codegen 比预想复杂（syn 解析、C shim 模板） | 中 | 中 | W1 末判断；手写前 15 命令兜底 |
| rusqlite + rust-s3 + tokio 在 Mate X5 arm64 构建链问题 | 低 | 高 | Phase 0 Demo 7 已验证 rust-s3 跑通；rusqlite bundled SQLite 首次构建试 |
| ArkTS strict mode + ObservedV2 学习曲线 | 中 | 中 | 先拿 LibraryPage 做一个样板，后续复用 |
| 首次同步 apply 几千条卡 UI 线程 | 中 | 中 | `sync_metadata` 走 tokio 多线程 runtime；ArkTS 只收事件 |
| 生物认证 API 12 vs API 13 行为差 | 低 | 中 | Phase 0 Demo 5 已验证 IAuthCallback 接口；运行时探测能力 |
| HarmonyOS 深色模式与 ArkUI 资源 fork 互动复杂 | 低 | 低 | Phase 2 只做 CSS 变量；精细调优推到 Phase 5 |
| 展开态双栏 Navigation.mode(Auto) 边界情况（栈里多个 Reader） | 中 | 中 | 展开切折叠时保留栈；对齐 spec §4.4 保底逻辑 |

---

## 十二、commit 拆分建议

按 Track 和 crate 边界分，每个 commit 可独立编译：

```
A2 （~5 commit）
  - feat(workspace): extract shibei-db crate
  - feat(workspace): extract shibei-events crate
  - feat(workspace): extract shibei-sync crate
  - feat(workspace): extract shibei-storage crate
  - feat(workspace): extract shibei-backup crate

A1 （~3 commit）
  - feat(harmony-napi): codegen tool for NAPI bindings
  - feat(harmony-napi): annotate 3 example commands with #[shibei_napi]
  - build(harmony-napi): wire codegen into build.rs

A3/A4/A5 （~6 commit）
  - feat(harmony-napi): AppState singleton
  - feat(harmony-napi): init + isUnlocked + lockVault commands
  - feat(harmony-napi): setS3Config + setE2EEPassword
  - feat(harmony-napi): listFolders + listResources + listTags + search + getResource
  - feat(harmony-napi): syncMetadata + progress events
  - feat(harmony-napi): NapiEventEmitter + 6 domain events

B （~4 commit）
  - feat(harmony): NavPathManager + Index routing
  - feat(harmony): FoldObserver with 100ms settle
  - feat(harmony): EventBus + ShibeiService facade
  - feat(harmony): i18n bridge from desktop locales

C （~4 commit）
  - feat(harmony): OnboardPage 5-step state machine
  - feat(harmony): ScanKit integration + PIN decrypt
  - feat(harmony): LockPage + biometric unlock
  - feat(harmony): auto-lock via suspendedAt tracking

D （~2 commit）
  - feat(harmony-sync): progress events in SyncEngine
  - feat(harmony): first-sync progress UI overlay

E （~4 commit）
  - feat(harmony): FolderDrawer component
  - feat(harmony): ResourceList with LazyForEach
  - feat(harmony): LibraryPage folded/expanded layout
  - feat(harmony): SearchPage with match_fields tags

F （~2 commit）
  - feat(harmony): SettingsPage shell + sync section
  - feat(harmony): reset-device flow

文档与收尾 （~2 commit）
  - docs(harmony): Phase 2 verification report
  - docs(harmony): mark Phase 2 complete in spec / CLAUDE.md
```

总约 **32 commits**，符合 Phase 1 的粒度感。

---

## 十三、验证剧本（Mate X5 手工测试）

M2 验收脚本：

```bash
# 桌面
npm run tauri dev
# → Settings → 同步 → 配好 S3 + E2EE 密码 → 保存
# → 添加移动设备 → 记 PIN，保持 QR 不关

# 鸿蒙
hdc install shibei.hap
hdc shell aa start -a EntryAbility -b com.shibei.mobile
# → Onboard Step 1 [开始]
# → Step 2 扫桌面 QR
# → Step 3 输 PIN → 预期：跳 Step 4
# → Step 4 输 E2EE 密码 → 预期：跳 Step 5（加载 keyring 成功）
# → Step 5 [启用生物] → 指纹 → 成功
# → 首次同步启动，顶部 banner "同步中 0/N"
# → 等进度条跑完 → Library 有资料
# 验证：
hdc shell 'sqlite3 /data/app/el2/100/base/com.shibei.mobile/database/shibei.db "SELECT COUNT(*) FROM resources WHERE deleted_at IS NULL"'
# 应 > 0
```

M3 验收：

```
# 手动折叠 Mate X5 → 应单栏
# 展开 → 应双栏（左栏资料列表、右栏 Reader 占位）
# 反复折叠/展开 10 次 → 无布局抖动 / 白屏
# 滚资料列表 1000 条 → FPS 稳定 > 50
```

M4 全链路：

```
冷启动 → LockPage → 指纹 → Library
→ 点资料 → ReaderPage 占位
→ 返回 → 搜索框输 "笔记" → SearchPage 结果
→ 按 HOME → 等 10 分钟 → 回 app → LockPage
→ 密码解锁 → 回 Library（状态保留）
```

---

## 十四、后续 Phase 对接

- **Phase 3** 消费的 NAPI 接口：标注 CRUD（批 4）+ 快照文件（批 5）— 本 plan 只预留签名
- **Phase 3** 消费的 ArkTS：ReaderPage 替换占位，接入 ArkWeb + annotator.js
- **Phase 4** PDF：`resource_type === 'pdf'` 分支，pdf-shell.html 由 Vite `build:harmony-pdf` 产出到 `entry/src/main/resources/rawfile/pdf-shell/`
- **Phase 5** 打磨：主题 / 完整 i18n 路径 / 失败 UI / 性能 profile / AGC 提交

---

**执行方式**：按 §二 依赖图顺序执行。每个 Track 做完单独开 PR / 分支合入，便于回滚。偏离本计划需在 Phase 2 verification report 里记录（参考 Phase 1 写法）。
