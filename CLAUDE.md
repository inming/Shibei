# 拾贝 (Shibei) — 项目约束

## 项目概述

个人只读资料库桌面应用，用于收集网页快照并进行标注。MVP 已完成。
- 设计文档：`docs/superpowers/specs/2026-03-31-shibei-mvp-design.md`
- 实现记录：`docs/superpowers/specs/2026-03-31-shibei-mvp-plan.md`
- 插件调研：`docs/superpowers/specs/2026-03-31-phase3-clipping-research.md`
- 同步机制：`docs/superpowers/specs/2026-04-07-sync-mechanism-review.md`
- PDF 支持：`docs/superpowers/specs/2026-04-15-v2.3-pdf-support-design.md`
- UI 细节优化（v2.3.1）：`docs/superpowers/specs/2026-04-17-ui-polish-design.md`
- 会话持久化（v2.3.3）：`docs/superpowers/specs/2026-04-17-session-persistence-design.md`
- v2.4 升级（PDF 缩放 / 开机自启 / 阅读器摘要）：`docs/superpowers/specs/2026-04-19-v2.4-pdf-zoom-autolaunch-summary-design.md`
- 鸿蒙移动端 MVP 设计：`docs/superpowers/specs/2026-04-20-harmony-mobile-mvp-design.md`
- 鸿蒙 Phase 1（桌面端配对 QR）：`docs/superpowers/plans/2026-04-21-phase1-pairing-qr.md`
- 鸿蒙 Phase 2（骨架 + 核心能力，Track A2 已合入）：`docs/superpowers/plans/2026-04-21-phase2-skeleton.md`
- 鸿蒙 Phase 4（App 锁屏 + HUKS 安全存储）：`docs/superpowers/specs/2026-04-22-phase4-lockscreen-huks-design.md` / `docs/superpowers/plans/2026-04-22-phase4-lockscreen-huks.md`
- Phase 4.1（S3 凭据内存化 + 桌面 OS Keychain）：`docs/superpowers/specs/2026-04-23-phase4.1-s3-creds-keystore-design.md`
- 许可证：AGPL-3.0

## 技术栈

- **桌面框架**：Tauri 2.x（Rust 后端）
- **前端**：React + TypeScript（Vite 构建）
- **数据库**：SQLite（rusqlite, bundled）
- **浏览器插件**：Chrome Extension Manifest V3 + SingleFile
- **HTTP Server**：axum（插件通信，127.0.0.1:21519）
- **存储格式**：SingleFile HTML（内联所有资源的标准 HTML）
- **不要引入**：Electron、Next.js、任何 ORM 框架、任何 CSS-in-JS 方案

## 目录结构

```
Cargo.toml          # 顶层 workspace（members: src-tauri, src-harmony-napi, crates/*）
crates/
  shibei-db/            # 数据层：SQLite schema + CRUD + FTS5 + HLC + sync_log + SyncContext（+ 7 SQL migrations）
  shibei-events/        # 9 个领域事件名常量（desktop + mobile 共享）
  shibei-storage/       # 文件系统存储（snapshot.html/.pdf）+ plain_text（HTML→text，scraper）+ pdf_text（PDF→text，pdf-extract）
  shibei-sync/          # S3 同步（HLC LWW、sync_log 拉取、SyncBackend trait、SyncEngine、凭据、全量导出、E2EE、pairing 配对 payload、os_keystore、keyring）
  shibei-backup/        # 本地备份/恢复（zip + manifest.json + VACUUM'd shibei.db + storage/）
  shibei-pairing/       # 配对 envelope 密码学（HKDF-SHA256 + XChaCha20-Poly1305，零 Tauri/SQLite 依赖）
  shibei-pair-decrypt/  # 开发者 CLI：从 (pin, envelope) 解出 plain payload
  shibei-napi-macros/   # `#[shibei_napi]` no-op proc-macro，让 rustc 接受 marker（真正工作由 codegen 做）
  shibei-napi-codegen/  # NAPI 代码生成（syn 解析 commands.rs → shim.c + bindings.rs + Index.d.ts）
src-tauri/          # Rust 后端（Tauri core — Phase 2 A2 后仅保留 Tauri 集成层）
  src/
    commands/       # Tauri command handlers（38 个命令，含 cmd_search_resources/cmd_export_backup/cmd_import_backup/cmd_get_ai_tool_paths/cmd_generate_pairing_payload）
    server/         # 本地 HTTP server（axum，插件通信）
    lib.rs          # 启动逻辑 + facade re-exports（`pub use shibei_db as db;` 等，保留 `crate::db::…` / `crate::sync::…` 老路径）
    main.rs
    annotator.js    # 标注注入脚本（嵌入到 HTML 中）
  migrations/       # SQL migration 文件
src/                # React 前端
  components/       # UI 组件（Layout, TabBar, ReaderView, PDFReader, AnnotationPanel, MarkdownContent, SettingsView, Settings/AIPage/..., Sidebar/...）
  hooks/            # 自定义 hooks（useFolders, useResources, useTags, useAnnotations, useSync, useFlipPosition — 菜单/popover 边界防溢出）
  stores/           # 状态管理
  types/            # TypeScript 类型定义（含 i18next.d.ts 类型增强）
  lib/              # 工具函数（commands.ts — Tauri invoke 封装 + translateError；importPdf.ts — 右键菜单共享的 PDF 导入逻辑；sessionState.ts — 会话持久化 localStorage 存储）
  styles/           # CSS 变量 + 全局样式
  locales/          # i18n 语言包（zh/en 各 11 个 JSON 命名空间）
  i18n.ts           # i18next 初始化配置
extension/          # Chrome 浏览器插件
  src/
    background/     # Service Worker
    content/        # Content Script（region-selector.js 选区交互, relay.js 消息中继）
    popup/          # 插件弹窗 UI（保存面板）
  _locales/         # Chrome i18n 语言包（zh/en messages.json）
  lib/              # SingleFile 打包（single-file-bundle.js）
docs/               # 设计文档与规范
mcp/                # MCP Server（Node.js，stdio transport）
  src/
    index.ts        # 入口：MCP Server + stdio transport
    client.ts       # HTTP 客户端（调用主应用 axum server）
    tools/          # MCP 工具实现（search, resource, annotations, folders, tags）
    types.ts        # 共享类型定义
```

## 架构要点

- **网页抓取（整页）**：Chrome 插件注入 SingleFile → 生成内联 HTML → `chrome.runtime.sendMessage` → Background Service Worker → POST 到本地 HTTP Server → Rust 存储为 snapshot.html
- **网页抓取（选区）**：插件注入选区脚本(MAIN world) → 用户选 DOM 元素 → SingleFile 整页抓取 → 裁剪子树(保留祖先链样式) → postMessage → relay.js(ISOLATED world) → `chrome.runtime.sendMessage` → Background Service Worker → POST 到 HTTP Server
- **阅读渲染**：自定义协议 `shibei://resource/{id}` → 读取 snapshot.html → 注入 annotator.js → 返回给 WebView
- **标注系统**：annotator.js 在 iframe 中运行，通过 postMessage 与 React 通信，持久化通过 Tauri invoke。评论和笔记支持 Markdown 格式（react-markdown + remark-gfm 渲染）
- **UI 布局**：Tab-based（资料库三栏 Tab + 阅读器全宽 Tab + 设置 Tab），资料列表独立成列
- **数据变更事件**：所有 mutation（Tauri command / HTTP handler）在 DB 写入成功后 emit 领域事件，前端 hook 自行订阅并自动 refresh，不依赖手动回调链
- **云同步**：CRUD 操作写 sync_log → 上传 JSONL 到 S3 → 拉取远端变更 → HLC LWW 合并 → 拓扑排序 apply。快照文件按需下载。首次同步上传/导入全量快照
- **软删除**：所有业务表使用 `deleted_at` 标记删除，查询过滤 `WHERE deleted_at IS NULL`，90 天后物理清理
- **搜索**：FTS5 trigram 虚拟表 `search_index`，CRUD 操作后自动维护索引（best-effort），前端 ResourceList 顶部搜索框（固定不随列表滚动）debounce 300ms 触发，标题/URL/标注匹配高亮。快照正文通过 `body_text` 列全文索引。`SearchResult` 返回 `match_fields`（匹配字段列表）和 `snippet`（正文上下文片段），前端显示匹配类型标签（正文匹配/标注匹配/评论匹配）和 snippet 高亮
- **MCP Server**：独立 Node.js 进程，stdio transport，通过 HTTP 调用主应用 axum server（需主应用运行）。Token 文件 `{data_dir}/mcp-token` 鉴权。9 个工具：search_resources, get_resource, get_annotations, get_resource_content, list_folders, list_tags, update_resource, manage_tags, manage_notes

## 代码风格

### Rust
- 使用 `rustfmt` 默认格式化
- 使用 `clippy` 进行 lint，不允许 `#[allow(clippy::...)]` 除非有明确理由
- 错误处理使用 `thiserror` 定义错误类型，不要用 `unwrap()`/`expect()` 处理可恢复错误
- 模块公开接口尽量小——默认 private，只暴露必要的 pub
- 命名：snake_case（函数/变量），CamelCase（类型/Trait）

### TypeScript / React
- 严格模式（`strict: true`）
- 使用函数组件 + hooks，不使用 class 组件
- 组件文件名 PascalCase（如 `FolderTree.tsx`），其他文件 camelCase
- 使用 CSS Modules 进行样式管理（`.module.css`）
- 不使用 `any` 类型——如果类型不确定，用 `unknown` 并做类型收窄
- import 使用绝对路径别名（`@/components/...`）

### Chrome Extension
- Manifest V3，不使用已废弃的 Manifest V2 API
- Content Script 保持最小化，避免污染页面全局作用域
- SingleFile 在 MAIN world 中执行（需要 DOM 访问）
- **MAIN world 限制**：MAIN world 脚本受页面 CSP 限制，也不能使用 `chrome.*` API
- **Content script fetch 限制**：不论 MAIN 还是 ISOLATED world，content script 里的 `fetch` 以页面 origin 发起；公网页面 fetch `127.0.0.1` 会触发 Chrome Private Network Access 授权弹框（即使有 `<all_urls>` host_permissions 也不免）。所有到本地 HTTP Server 的请求必须通过 `chrome.runtime.sendMessage` 交给 Background Service Worker 代发，background 的 `chrome-extension://` origin 豁免 PNA
- **SingleFile 必须禁用页面脚本**：所有 `SingleFile.getPageData` 调用必须带 `removeScripts: true`（`singlefile-boot.js`、`region-selector.js`、`popup.js`）。页面脚本被保留时，iframe 重载会让它们修改 DOM（微信公众号文章尤甚，~2.8MB 脚本会改 body 文本），破坏 highlight anchor 的 text_position 对齐

## AI 协作模式

### 改动范围
- 每次改动聚焦一个功能点，不要在一次提交中混合多个不相关的修改
- 修改现有代码时先阅读完整上下文，理解后再动手
- 不要自作主张重构不相关的代码，即使它看起来"可以改进"

### 提交规范
- 使用 Conventional Commits 格式：`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`
- 提交信息使用英文
- 每个提交应该是可编译、可运行的状态

### 开发流程
- 实现新功能前先确认设计文档中的对应描述
- Rust 后端改动后运行 `cargo check` 和 `cargo clippy` 验证
- 前端改动后确认 TypeScript 编译无错误
- 不要跳过编译检查直接提交

### 测试
- **Rust 后端**：所有 db 操作和存储逻辑必须有单元测试；使用 `tempfile` 创建临时数据库/目录做测试隔离
- **前端**：Vitest + React Testing Library；核心组件和 hooks 需要测试覆盖
- **浏览器插件**：需手动验证
- **原则**：每个功能实现时同步编写测试，不要先写完所有功能再补测试

### 调试协作

AI 助手无法操作 GUI，但能运行 CLI 命令和读取文件。调试时按以下分工：

**AI 自行完成**：
- 编译检查（`cargo check`、`tsc --noEmit`）
- 运行测试（`cargo test`、`vitest`）
- 读代码分析逻辑
- 后端问题排查（Rust 日志输出到终端，AI 可直接读）

**需要用户配合**（GUI 交互、视觉效果）：
1. AI 在关键路径插入 `debugLog("label", data)` 日志
2. 用户以 `VITE_DEBUG=1 npm run tauri dev` 启动应用
3. 用户操作 UI 复现问题，告知现象（"拖不动"、"没反应"等）
4. AI 读取 `~/Library/Application Support/shibei/debug.log` 分析日志
5. 基于日志定位根因，而非盲猜修复

**调试纪律**：
- 遇到交互类 bug，**先加日志确认是事件问题还是渲染/CSS 问题**，再提修复方案
- 不要在没有诊断数据的情况下连续猜测修复
- `debugLog` 在非调试模式下是空操作，可以放心插入；问题解决后清理调试日志

**Debug 日志机制**：
- 前端：`import { debugLog } from "@/lib/commands"` → `debugLog("label", data)`
- 启用：环境变量 `VITE_DEBUG=1`（Vite 暴露为 `import.meta.env.VITE_DEBUG`）
- 输出：`{data_dir}/debug.log`（macOS: `~/Library/Application Support/shibei/debug.log`）
- 后端命令：`cmd_debug_log` 追加写入，带时间戳

### 鸿蒙真机自助 build / install / UI 测试（AI 全自动闭环）

DevEco Studio 的编译、装机、UI 测试全部有 CLI 等价物，AI 不需要用户在 IDE 里点按钮。已验证可跑：

**环境（每个 AI session 第一条 bash 都要 export）**：
```bash
export JAVA_HOME=$(/usr/libexec/java_home)            # PackageHap 阶段需要
export DEVECO_SDK_HOME=/Applications/DevEco-Studio.app/Contents/sdk
export NODE_HOME=/Applications/DevEco-Studio.app/Contents/tools/node
export PATH="$JAVA_HOME/bin:$NODE_HOME/bin:$PATH"
HVIGOR=/Applications/DevEco-Studio.app/Contents/tools/hvigor/bin/hvigorw
HDC=/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc
BUNDLE=com.shibei.harmony.phase0
HAP=/Users/inming/workspace/Shibei/shibei-harmony/entry/build/default/outputs/default/entry-default-signed.hap
```

**Build 链路**（项目根 `shibei-harmony/`）：
```bash
$HVIGOR clean       --no-daemon                       # 等价 IDE: Build → Clean Project
$HVIGOR --sync      --no-daemon                       # 等价 IDE: Sync Now
$HVIGOR assembleHap --no-daemon 2>&1 | tee /tmp/harmony-build.log
```
- 项目**没有自带 hvigorw wrapper**，必须用 DevEco 内置那份绝对路径
- 缺 `JAVA_HOME` → `Unable to locate a Java Runtime`，在 `PackageHap` 阶段失败（编译已过，仅打包不出 .hap）
- 缺 `DEVECO_SDK_HOME` → `Invalid value of 'DEVECO_SDK_HOME'`，clean 都跑不动

**编译错误（不需要再读 IDE 截图）**：
- 全量结构化 log：`shibei-harmony/.hvigor/report/report-<YYYYMMDDHHMMSSss>.json`，取 mtime 最新一份
- 解析：`events[].head.name` 含 `"ArkTS Compiler Error"` 或 `additional.logType == "error"` 的条目里有完整错误（带 ANSI 颜色码 `\x1b[31m` / `\x1b[39m`，strip 即可）
- WARN 在同一份 events 里 `logType == "warn"`
- 这套 report 比 `entry/build/default/intermediates/compile_arkts/errors.json`（在我们这套 SDK 上**没产出**）覆盖更全（含 stacktrace）

**Install + 启动**：
```bash
$HDC list targets                                      # 应该列出 Mate X5 序列号；空 = 设备未连
$HDC install "$HAP"                                    # "install bundle successfully"
$HDC shell aa force-stop $BUNDLE                       # 冷启动前清场
$HDC shell aa start -a EntryAbility -b $BUNDLE         # 拉起
sleep 3
$HDC shell hilog -x | grep -iE "shibei|EntryAbility" | tail -25
```

**UI 自动化**（无需写 Hypium 测试 HAP，`uitest` CLI 直接用）：
```bash
# 抓当前页面 UI 树（拿控件 bounds + text）
$HDC shell uitest dumpLayout -b $BUNDLE -p /data/local/tmp/layout.json
$HDC file recv /data/local/tmp/layout.json /tmp/layout.json
# 用 python 走 children 树找目标控件，按 bounds 算中心点

# 模拟点击 / 滑动 / 输入
$HDC shell uitest uiInput click <x> <y>
$HDC shell uitest uiInput swipe <x1> <y1> <x2> <y2> [velocity]
$HDC shell uitest uiInput inputText <x> <y> <text>
$HDC shell uitest uiInput keyEvent Back|Home|Power

# 截图（AI 用 Read 工具看 PNG，验证 UI 状态 + 颜色）
$HDC shell uitest screenCap -p /data/local/tmp/screen.png
$HDC file recv /data/local/tmp/screen.png /tmp/screen.png
```

**真机分工**：
- AI 自助：编译 / 装机 / 启动 / UI 控件 dump / 模拟点击 / 截图 / 读 hilog / 读 .hvigor report
- 仍需用户：①系统级 `param`（locale / dark_mode 等 `persist.global.*`）需 root 才能 `param set`，**非 root 设备只能从系统 Settings 应用 UI 切换**——AI 可以驱动系统 Settings 一路点过去，但路径不稳，问用户切更快；②真实手势（指纹识别、人脸识别）必须用户配合
- 不要再让用户手动复制粘贴编译错误截图——`/tmp/harmony-build.log` + `.hvigor/report/*.json` 全有

**Bundle name 来源**：`shibei-harmony/AppScope/app.json5` 的 `bundleName` 字段（当前 `com.shibei.harmony.phase0`），改前先核对避免 install 找不到 app

## 架构约束

- **前后端通信**：只通过 Tauri Commands（`invoke`）和 Tauri Events
- **插件通信**：只通过本地 HTTP Server（axum, 127.0.0.1:21519），不使用 Native Messaging
- **数据存储**：元信息在 SQLite，快照文件在文件系统（snapshot.html），两者通过 resource_id 关联
- **标注数据**：独立于原始资料存储，不修改快照文件
- **脚本注入**：标注脚本通过 `<script>` 标签直接嵌入 HTML `<head>`，不使用 initialization_script。注入前 `strip_script_tags()` 会剥离快照中所有原页面 `<script>` 块（只动响应体、不动磁盘文件与 S3），防止页面脚本在 iframe 重载时改动 DOM 并使 anchor 位置失效
- **外链处理**：iframe 内链接默认不可点击（cursor: inherit），Ctrl+Click 通过 plugin-opener 在系统浏览器打开
- **插件 MAIN world 通信**：MAIN world 脚本通过 `window.postMessage` → ISOLATED world `relay.js` → `chrome.runtime.sendMessage` → Background Service Worker 中继，绕过页面 CSP 限制
- **插件 HTTP 通信**：所有到 `127.0.0.1:21519` 的请求由 Background Service Worker 唯一发起（`chrome-extension://` origin 豁免 Chrome Private Network Access 弹框）。Content scripts 和 popup 通过 `chrome.runtime.sendMessage({ type: "api:save-html" | "api:save-pdf", body, meta })` 把 payload 交给 background。Background 维护 token 模块级缓存 + 401 自动重试，payload 超过 80 MB 返回 `errorPageTooLarge`（建议改用选区保存）。Popup 自身的 `/ping`/`/folders`/`/check-url` 走 popup 直连 fetch（popup 同为 `chrome-extension://` origin，不触发 PNA）
- **软删除**：所有业务表使用 `deleted_at` 字段软删除，查询必须加 `WHERE deleted_at IS NULL`，物理清理由 compaction 在 90 天后执行
- **同步日志**：所有 CRUD 函数接受 `Option<&SyncContext>` 参数，操作后追加 sync_log 记录（INSERT/UPDATE/DELETE）；硬删除写 PURGE 条目；测试中传 `None` 跳过。详见 `docs/superpowers/specs/2026-04-07-sync-mechanism-review.md`
- **同步冲突解决**：三层 LWW 保护（`apply_entries` 应用层 + `upsert_*` SQL 层 + `soft_delete_entity` SQL 层）。级联软删除同步更新子实体 HLC。快照导入只处理活跃记录（跳过 `deleted_at` 不为空的）。JSONL 断档时自动回退快照导入。Compaction 补传缺失的 HTML 快照
- **HLC 时钟**：`hlc` 字段用于同步排序（LWW），`created_at`/`updated_at` 保持 ISO8601 用于业务逻辑，两者独立
- **S3 同步**：`SyncBackend` trait 抽象存储操作，`S3Backend` 实现支持自定义 endpoint；同步引擎按需创建（每次 sync 从 DB 读配置构建）
- **E2EE 加密**：`EncryptedBackend` 装饰器透明加解密 S3 数据（XChaCha20-Poly1305 + AAD）；随机 MK 由 Argon2id 密码派生密钥包装，keyring.json 存 S3；MK 运行时缓存在 `EncryptionState`（`Mutex<Option<Zeroizing<[u8;32]>>>`）
- **S3 凭据存储（Phase 4.1）**：手机走 `secure/s3_creds.blob`（HUKS device-bound）+ `AppState.s3_creds` RwLock 运行时缓存；桌面走 macOS Keychain / Windows Credential Manager / Linux Secret Service（`os_keystore` 模块,service=`"shibei"` account=`"s3-credentials"`,单 JSON blob 存 `{access_key, secret_key}`）。**两端 SQLite 都不再存 AK/SK 明文**。`credentials::store_credentials` 只写 keystore,keystore 失败硬错(不降级);`load_credentials` keystore-first + sync_state fallback(兼容未迁移/keystore 暂不可用的装机);`delete_credentials` 双删。Tauri `setup` 起一次性迁移 thread:SQLite 有 creds && keystore 空 → 拷过去 + 删 SQLite,失败保留 SQLite 由下次启动重试。macOS 首次会弹钥匙串授权框。详见 `docs/superpowers/specs/2026-04-23-phase4.1-s3-creds-keystore-design.md`
- **设置页**：独立 Tab（`__settings__`），侧栏导航分区（外观 / 同步 / 加密 / 安全 / 数据 / AI），`SettingsView` + `Settings/AppearancePage` + `Settings/SyncPage` + `Settings/EncryptionPage` + `Settings/LockScreenPage` + `Settings/DataPage` + `Settings/AIPage`。页面分区统一模式：`<h2 heading>` 页标题 → `<div form>` 块含 `<h3 subheading>` 小标题 → `<div passwordSection>` 包裹后续分区（`border-top` 作分隔线）。齿轮按钮 tooltip 使用通用的 `common.settings` 而非 `sync.syncSettings`
- **本地备份与恢复**：`DataPage` 提供一键备份（zip：manifest.json + shibei.db VACUUM 副本 + storage/ 快照）和覆盖式恢复。连接池 `Arc<RwLock<DbPool>>`（`SharedPool`）由 commands 和 server AppState 共享，恢复时写锁替换 pool。恢复前先解压到 `restore-tmp/` 校验后再替换。恢复后 `backfill_plain_text` + `rebuild_all_search_index` 重建 FTS。文件对话框和确认对话框使用 `@tauri-apps/plugin-dialog`（`save`/`open`/`ask`），不使用 `window.confirm`（Tauri webview 中无效）
- **深色模式**：CSS 变量切换，`[data-theme="dark"]` 覆盖 `:root` 变量。三种模式 `light | dark | system`，`useTheme` hook 管理，持久化 `localStorage`（key: `shibei-theme`）。新增颜色必须在 `variables.css` 中同时定义 light 和 dark 值。iframe 快照内容不做强制反色，阅读器提供可选 invert filter
- **全文搜索**：FTS5 虚拟表 `search_index`（`tokenize='trigram'`），索引 title/url/description/highlights_text/comments_text/body_text。>= 3 字符走 FTS5 MATCH（自动搜索所有索引列含正文），2 字符回退 LIKE（搜索所有列含 body_text）。`search_resources` 返回 `SearchResult`（`Resource` + `matched_body` + `match_fields: Vec<String>` + `snippet: Option<String>`），通过 `#[serde(flatten)]` 平铺字段。`match_fields` 列出匹配字段（title/url/description/highlights/comments/body），`snippet` 为正文匹配上下文（前后各 20 字符 + 省略号）。所有 CRUD（resource/highlight/comment）操作后调用 `search::rebuild_search_index` 或 `delete_search_index`（best-effort `let _ =`）。同步 apply 后按受影响 resource_id 增量重建。首次启动通过 `sync_state` 标志位 `config:fts_initialized` 触发全量索引构建（先 `backfill_plain_text` 回填缺失纯文本，再 `rebuild_all_search_index`）。FTS5 查询必须用 `escape_fts_query` 转义用户输入（双引号包裹）
- **Markdown 标注**：评论和资料级笔记使用 `react-markdown` + `remark-gfm` 渲染，纯前端实现，后端零改动。共享组件 `MarkdownContent`（props: `content`, `searchQuery?`）。编辑使用 textarea + 预览切换按钮（"预览"/"编辑"）。搜索高亮通过自定义 rehype 插件在渲染后文本节点上做匹配。图片语法渲染为链接文本，不显示图片。不引入语法高亮库
- **MCP Server**：stdio transport，Node.js 独立进程。数据访问通过 HTTP 代理（127.0.0.1:21519），不直接访问 SQLite。Token 通过 `{data_dir}/mcp-token` 文件传递（启动时写入，退出时删除）。工具返回纯文本格式化的结果。`plain_text` 字段保存时提取，MCP 读取时懒填充，不参与同步
- **MCP 自动配置**：`Settings/AIPage` 提供一键配置 MCP Server 到 AI 工具（Claude Desktop/Cursor/Windsurf/OpenCode）。预设工具路径由后端 `cmd_get_ai_tool_paths`（`dirs` crate）按 OS 返回，自定义工具路径存 `localStorage`（key: `shibei-mcp-custom-tools`）。配置操作通过 `cmd_read_external_file`/`cmd_write_external_file` 通用命令，写入前弹窗 diff 预览。支持两种配置格式：标准格式（`mcpServers` key，Claude Desktop/Cursor/Windsurf）和 OpenCode 格式（`mcp` key + `type: "stdio"`），通过 `AiToolPath.format` 字段区分
- **标签过滤**：统一由后端 SQL 处理（`list_resources_by_folder`/`list_all_resources`/`search_resources` 均接受 `tag_ids` 参数），OR 逻辑（资料包含任一选中标签即匹配），前端不做客户端标签过滤
- **i18n 国际化**：`react-i18next` + `i18next`，11 个命名空间（common/sidebar/reader/annotation/settings/sync/encryption/lock/search/data/ai）。语言包静态导入（`src/locales/zh/*.json` + `src/locales/en/*.json`），`src/i18n.ts` 初始化。**新增 UI 文案必须使用 `t('key')` 而非硬编码中文**，同时更新 zh 和 en 两个 JSON 文件。`useTranslation('namespace')` 在组件/hooks 中获取 `t` 函数。后端错误消息返回 i18n key（`error.xxx` 格式），前端 `translateError()` 翻译。Chrome 插件使用 `chrome.i18n` API（`_locales/` 目录），MAIN world 脚本通过注入参数接收翻译字符串。语言持久化 `localStorage: shibei-language`，检测顺序 `localStorage → navigator`。TypeScript 类型安全通过 `src/types/i18next.d.ts` 的 `CustomTypeOptions` 增强
- **数据变更事件**：6 个领域事件（`data:resource-changed`、`data:folder-changed`、`data:tag-changed`、`data:annotation-changed`、`data:sync-completed`、`data:config-changed`）+ 2 个同步状态事件（`sync-started`、`sync-failed`）。后端事件常量定义在 `src-tauri/src/events.rs`，前端常量和 payload 类型定义在 `src/lib/events.ts`。**新增 mutation command 必须在 DB 写入后 emit 对应领域事件**；新增 hook 需检查订阅矩阵（见 `docs/superpowers/specs/2026-04-03-unified-data-events-design.md`）。禁止使用 `onDataChanged` 回调链、`refreshKey` state、`folderTreeRefreshRef` 等旧机制
- **单实例**：`tauri-plugin-single-instance` 确保同时只有一个应用实例运行。第二个实例启动时通过 `deep-link-received` 事件将 URL 转发给已有窗口，并聚焦已有窗口
- **Deep Link**：`shibei://open/resource/{id}?highlight={hlId}` 三种入口：`onOpenUrl`（应用已开）、`deep-link-received`（单实例转发）、`getCurrent()`（冷启动）。锁屏时暂存到 `pendingDeepLinkRef`，解锁后自动打开目标资料
- **阅读器沉浸**：meta 栏（标题/URL/日期）在向下滚动时自动隐藏（CSS transform），向上滚动或到达顶部时显示。顶部 2px 绿色进度条跟随滚动百分比。标注面板可折叠为 32px 窄条（高亮色点 + 数量）。annotator.js 的 `shibei:scroll` 消息携带 `scrollY`、`direction`、`scrollPercent` 字段
- **预览面板**：概览模式显示摘要（`description` > `plain_text` 前 200 字 > 暂无摘要）+ 高亮/评论内容列表。`cmd_get_resource_summary` 命令从 `plain_text` 提取前 N 字符。不显示打开按钮（双击打开即可）。**元数据编辑**：`ResourceMeta` 右上角铅笔按钮打开 `ResourceEditDialog` 编辑 title/description；编辑后由 `data:resource-changed` 事件驱动 PreviewPanel 自动刷新。**高亮可点击跳转**：PreviewPanel 每条高亮可点击（含键盘 Enter/Space），通过 Layout 传入的 `onOpenHighlight` 回调调用 `openResource(resource, highlightId)` 打开阅读器 Tab 并跳到标注位置；评论区内 Markdown `<a>` 链接用 `onClickCapture` 判断后 `stopPropagation`，避免误触发跳转
- **滚动条**：全局 thin scrollbar（8px，`background-clip: content-box` 内缩 2px），深色模式通过 CSS 变量自适应。iframe 快照页面通过 annotator.js 注入滚动条样式（半透明 `rgba` + `!important` 覆盖页面自带样式）
- **资料列表**：搜索栏和排序栏固定在顶部（`flex-shrink: 0`），列表独立滚动（`.listScroll` 容器 `overflow-y: auto`）。每项显示最多 3 个标签色点 + 高亮数量徽章。搜索时匹配类型标签（正文/标注/评论）独立行显示，snippet 显示 2 行截断
- **阅读器摘要**：AnnotationPanel 在 scrollArea 顶部渲染 SummarySection（内容来源 `description.trim() > cmd.getResourceSummary()` 取 `plain_text` 前 200 字），两者都空时整块不渲染。annotations header（`标注 (N)`）从固定区迁入 scrollArea 成为 section header。新增顶部 `stickyAnnotationsHeader`，IntersectionObserver 用 `boundingClientRect.top < rootBounds.top` 方向检测（只在真正向上滚出时显示，摘要下方初始位置不触发）。资料切换时 reset sticky 状态 + observer 跟随 `resource.id` 重挂载，避免闪烁。**padding 约定**：`.summarySection` 仅设上下 padding，水平 padding 由内部 `.sectionHeader` / `.summaryText` 各自负责（`var(--spacing-md)`），保证摘要 header 与 scrollArea 内 annotations header 左缘对齐——若在外层 wrapper 加水平 padding，会让内部 header 产生双层缩进与列表外 header 错位。SummarySection 渲染的 `<section data-testid="summary-section">` 便于测试定位
- **PDF 支持**：`resource_type = "pdf"` 使用 `pdfjs-dist` 渲染（canvas + 文本层），`PDFReader` 组件替代 iframe。标注复用 highlights/comments 表，anchor 格式 `{ type: "pdf", page, charIndex, length, textQuote }`。纯文本由 `pdf-extract` crate 保存时提取（`catch_unwind` 防止 panic），提取失败时前端 PDF.js `streamTextContent()` 回填（`cmd_backfill_plain_text`）。插件通过 background fetch 下载 PDF 二进制后 POST 到 `/api/save-raw`（`Content-Type: application/pdf`）。本地导入通过 `cmd_import_pdf` 命令。**初始跳转**：`ReaderView` 对 PDF 走专用 effect，等 `PDFReader.onReady()`（驱动 `iframeLoading=false`）后再设置 `pdfScrollRequest={ id, ts: Date.now() }` 触发 PDFReader 滚动；HTML iframe 走另一条路径（等 `shibei:annotator-ready` postMessage）；两者共用 `didScrollToInitial` 防重复；`initialHighlightId` 变更时重置该 ref。**pdfjs-dist v5 注意事项**：TextLayer 和文本提取必须用 `streamTextContent()`（不能用 `getTextContent()`，WebKit 会报 readableStream 错误）；页面容器需手动设置 `--scale-factor` 和 `--total-scale-factor` CSS 变量（TextLayer 不会自动设置）；页面布局用 CSS `aspect-ratio` 而非 JS 计算高度；canvas 用 `height: 100%`（不能用 `auto`，HiDPI 下会撑开容器）；resize 滚动保持通过 `scrollTop/scrollHeight` fraction 检测跨平台差异（Chromium 不调整 scrollTop，WebKit 自动调整）。**缩放**：PDFReader 接受 `zoomFactor` prop（控制 prop，无内部状态），在 `.content` 包裹层用 `width: ${zoomFactor * 100}%` 改变渲染宽度；scale 公式 `(containerWidth * zoomFactor) / pageInfo.width`。**`.content` 不得加 `min-width: 100%`**（会压制 zoom < 1 时的宽度，让缩小无效）；`.container` 用 `overflow: auto`（双向滚动），zoom < 1 时 inline `margin: 0 auto` 居中。工具条在 ReaderView meta 栏右端（PDF 模式，取代 HTML 的 🌓 按钮位置）。快捷键 `Ctrl/Cmd +/-/0`（全局监听，过滤 input/textarea focus）。每份 PDF 独立持久化到 `sessionState.ReaderTab.pdfZoom`（`clampZoom` 落地；范围 0.5–4.0，步进 0.05；`round2` 防 FP 漂移）。**滚动位置保持**：zoom effect 读 `scrollFractionRef.current`（scroll handler 每次保存的 pre-zoom fraction），**不得**在 effect 里现算 `scrollTop / scrollHeight`——effect 是 post-commit，此时 `scrollHeight` 已是新布局、`scrollTop` 还是旧值，fraction 会错。`suppressMetaHideRef` 在 zoom 引起的 programmatic scroll 帧内让 `handleScroll` 强制 direction='up'，防止 meta bar 被自动隐藏导致用户无法连点按钮；双 rAF 清理该 flag。`prevZoomRef` 守卫避免 `[zoomFactor, pageInfo, renderVisiblePages]` 依赖其他字段变化时的冗余 render gen bump。zoomFactor > 1 时水平居中
- **开机自启**：`tauri-plugin-autostart` 注册 LaunchAgent（macOS）/ 注册表（Windows），启动参数 `--autostart` 由 setup 检测并调用 `window.minimize()`，不抢焦点。前端 `src/lib/autostart.ts` 封装 `enable/disable/isEnabled`。Settings → 外观 → 启动分区提供开关，失败时 toast + 回读系统状态重同步
- **系统预设文件夹**：后端 `ensure_inbox_folder()` 在启动时保证存在一个 ID 为 `__inbox__` 的"收件箱"文件夹，新抓取的资料默认落入其中。前端 `src/types/index.ts` export `INBOX_FOLDER_ID = "__inbox__"` 常量。FolderTree 右键菜单对该 folder 只保留"导入文件"一项，屏蔽"新建子文件夹/编辑/删除"，避免用户破坏系统预设。`ALL_RESOURCES_ID = "__all__"` 为虚拟聚合视图（非真实 folder），不可作为上传/右键菜单的目标
- **文件导入入口**：通过两个右键菜单触发（已移除第二栏顶部的 "PDF+" 按钮）：①Sidebar 文件夹行右键 → "导入文件"；②ResourceList 空白处右键（选中真实 folder 时）→ "导入文件"。两处共享 `src/lib/importPdf.ts` 的 `importPdfToFolder(folderId)`，文件对话框 filter 限 `*.pdf`，错误通过 `translateError()` 翻译。i18n key 为 `reader.importFile`（文案"导入文件"，为未来扩展格式预留）
- **会话持久化**：单 localStorage key `shibei-session-state`（v1，带 `version` 字段做未来迁移）存储打开的 Tab 列表 / 激活 Tab / 每个 Tab 滚动位置 + pdfZoom / 资料库选中（folder + tags + preview resource + 列表滚动位置）。`src/lib/sessionState.ts` 维护内存 mirror，对外暴露 `loadSessionState` / `saveSessionState`（顶层字段浅合并，library 子对象同样浅合并）/ `updateReaderTab`（按 id 合并 tab 字段）/ `removeReaderTab`。**写时机**：Tab 增/删/切换、folder/tag/preview 变更立即写；HTML scroll 500ms debounce，PDF scroll 500ms debounce，资料列表 scroll 300ms debounce。ReaderView unmount 时 flush pending scroll（防丢最后 500ms）。**恢复时机**：`App.tsx` 启动 `Promise.all(cmd.getResource)` 解析每个 Tab，失败/null 静默丢弃；Settings 不恢复（`openSettings` 不写 session，最后非 Settings 的 active tab 自然存活）。**StrictMode 安全**：restore effect 只用 `restoredRef` 守卫，**不可**用 cancel flag（StrictMode 双调用会在 cleanup 里置 cancelled=true 阻断 async 写入）。**懒挂载**：`mountedTabIds: Set<string>` 只让激活 Tab 挂载 `<ReaderView>`（iframe），其余 Tab 点击时才首次挂载。**高亮深链优先于恢复滚动**：`shibei://open/resource/{id}?highlight={hlId}` 深链的 `initialHighlightId` 会让滚动恢复短路（guard: `!initialHighlightId`）。**失效兜底**：坏 JSON / 版本不匹配 / 配额满全部静默回落 `DEFAULT_STATE`；非虚拟 folder 不存在时回落 `INBOX_FOLDER_ID`。**PDF 滚动请求**扩展为 tagged union `{kind: "highlight", id, ts} | {kind: "position", page, fraction, ts}`——position 分支计算 `offsets[page] + heights[page] * fraction` 设置 scrollTop。**行高亮一致性**：资料库持久化的是单 `selectedResourceId`，启动时派生 `selectedResourceIds = new Set([id])` 和 `lastClickedResourceId` 让列表行高亮与预览内容一致。新增 mutation 必须调用对应的 sessionState API，否则重启会漂移
- **右键菜单定位**：所有 fixed-positioned 菜单/popover（`ContextMenu` / `ResourceContextMenu` / `HighlightContextMenu` / `AnnotationPanel` 高亮右菜单 / `TagPopover`）统一走 `useFlipPosition(ref, x, y)`（`src/hooks/useFlipPosition.ts`）；`useLayoutEffect` 里测量 `getBoundingClientRect()` 双向 clamp 到 `window.innerWidth/innerHeight`（4px 边距）。**新增菜单必须接入该 hook**，严禁再写裸 `style={{ top: e.clientY, left: e.clientX }}`。**子菜单**走 `useSubmenuPosition(anchorRef, submenuRef, open)`——默认 `left: 100%; top: 0`（由 CSS 兜底，保证测量前有合法布局），宽度溢出翻转到 `right: 100%`，高度溢出按 `overflowBottom` 上移（不越过 `anchor.top - margin`）。**async 内容**：子菜单内如果有 `useTags()` / `useFolders()` 之类异步加载（挂载时占位符高度远小于最终高度），hook 内置的 `ResizeObserver` 会在 submenu 大小变化时重测，保证最后的尺寸也能撑开向上偏移
- **移动设备配对（Phase 1）**：Settings → 同步 → 「添加移动设备」打开 `PairingDialog`，生成 6 位数字 PIN + 调 `cmd_generate_pairing_payload(pin)` 返回加密 envelope，`qrcode` 渲染为 QR，PIN 分组 XXX XXX 展示，30s 倒计时静默过期（UI 切「已过期」态，envelope 无 `exp` 字段）。**加密栈**：PIN 经 HKDF-SHA256（salt 16B + info `shibei-pair-v1`）派生 32B key → XChaCha20-Poly1305（nonce 24B + AAD `shibei-pair-v1`）加密 plain JSON；envelope 为 `{v,salt,nonce,ct}` JSON，字段 Base64URL 无 padding。**关键决策**：HKDF 不用 Argon2id（6 位 PIN 熵 ~20 bits，任何 KDF 都挡不住离线爆破，真防御来自一次性使用 + 短时效 + PIN 不进 QR）；原始 plain 上限 **512 字节**，超限返回 `error.pairingPayloadTooLarge`。**模块划分**：`crates/shibei-pairing/`（纯密码学，零 Tauri/SQLite 依赖，供鸿蒙 NAPI 复用）+ `src-tauri/src/sync/pairing.rs`（读 sync_state / credentials 拼 plain）+ `crates/shibei-pair-decrypt/`（开发者 CLI：`--pin --payload` 或 stdin，round-trip 验证用）+ `scripts/test-pairing-roundtrip.sh`。**按钮禁用**：`!has_credentials \|\| !bucket` 时 disabled + tooltip；**日志纪律**：后端只写 `pair_payload_generated len=N`，绝不 log PIN 或 envelope。i18n key：`sync.addMobileDevice` / `sync.pairing.*` + `common.error.pairing*`
- **鸿蒙 Reader（Phase 3a）**：ArkWeb `Web` + `loadData()` 加载 Rust 端注入脚本后的 HTML（自定义 scheme `shibei://resource/{id}` 做 baseUrl 给 annotator href 校验用）；`registerJavaScriptProxy` 暴露 `window.shibeiBridge.emit(type, json)` 让 `annotator-mobile.js` 把选区/点击事件回传 ArkTS；ArkTS 通过 `webController.runJavaScript()` 调 `window.__shibei.{paintHighlights, flashHighlight, removeHighlight, clearSelection}`。`AnnotationsService` 做内存缓存 + subscriber,任一 CRUD 写入后 notify 订阅的 Reader 重绘。标注数据经 `SyncContext` 写 sync_log,和桌面 LWW 互通
- **鸿蒙会话持久化 / Deep Link / 同步刷新（Phase 5 收尾，2026-04-24）**：`app/SessionState.ets` 使用 `@ohos.data.preferences` store=`shibei_prefs` key=`shibei-session-state`，只存移动端导航上下文（`inReader` / `readerResourceId` / `library.selectedFolderId|selectedTagIds|selectedResourceId`；`listScrollTop` 字段保留但当前未写入）；Reader scroll 和 PDF zoom 继续分别由 `ReaderScrollState.ets` / `ReaderZoomState.ets` 的 per-resource map 管理。打开 Reader 前必须 `await SessionState.save({inReader:true,readerResourceId})` 再 `router.pushUrl`，避免快速 kill 时尚未 flush；**不得在 `Reader.aboutToDisappear()` 清 `inReader`**，因为任务管理器杀 app 也会触发该生命周期；只在显式返回（系统 back / 顶部 `←`）通过 `leaveReader()` 清。`module.json5` 注册 `shibei://open/resource/{id}?highlight={hlId}`，`EntryAbility.onCreate` 暂存 `Want.uri` 到 `KEY_PENDING_DEEP_LINK`，`Library.aboutToAppear` 消费并 push Reader；`EntryAbility.onNewWant` 在已解锁态直接 push Reader、锁屏态暂存等待 Library 消费；`Reader` 读取 `highlightId` 后 ready 时 flash；`ResourceList` 长按菜单提供复制 `shibei://open/resource/{id}`。`ShibeiService.syncMetadata()` 远端 apply/download 后触发 `onDataChanged`，`ResourceList` 与 `FolderDrawer` 都必须订阅以保持自动同步后的列表新鲜度
- **鸿蒙 App 锁屏 + HUKS 安全存储（Phase 4）**：Settings → 安全 → 启用 App 锁 = 4 位 PIN + 可选生物识别。PIN Argon2id(19MiB/2 iters) hash 存 `secure/pin_hash.blob`；MK 经 `XChaCha20-Poly1305`（AAD `shibei-mk-v1`）包两份：PIN-KEK wrap（`HKDF-SHA256(Argon2id ikm, salt, info="shibei-mobile-lock-v1")`）入 `secure/mk_pin.blob`，HUKS bio-gated key wrap 入 `secure/mk_bio.blob`。**HUKS 操作由 ArkTS 侧 `services/HuksService.ets` 完成**（`@kit.UniversalKeystoreKit` 是 ArkTS kit），Rust 侧 `crates/shibei-mobile-lock/`（纯 crypto + 节流，零 HUKS/Tauri/SQLite 依赖）+ `src-harmony-napi/src/{lock.rs,secure_store.rs}` 只做 inner crypto + 文件 I/O。HUKS 密钥别名：`shibei_device_bound_v1`（AES-256-GCM 无认证，device-bound）/ `shibei_bio_kek_v1`（AES-256-GCM + `USER_AUTH_TYPE_FINGERPRINT\|FACE` + `KEY_AUTH_ACCESS_TYPE_INVALID_NEW_BIO_ENROLL` + `CHALLENGE_TYPE_NORMAL`，ATL2）。S3 凭据同样走 device-bound 包装（`secure/s3_creds.blob` + ArkTS `primeS3Creds` 冷启动解包写入 `AppState.s3_creds: Arc<RwLock<Option<(String,String)>>>`），启动透明解密，**不走 PIN 闸门**（保证锁屏态后台同步可跑）。**Phase 4.1**（2026-04-23 合入）把 SQLite `sync_state:config:s3_access_key/secret_key` runtime cache 砍掉：`build_raw_backend` 只从 RwLock 读（空 → `error.credentialsNotPrimed`）；`setS3Config` 同时填 HUKS blob + RwLock；老装机 `primeS3Creds` 每次冷启动跑一次 `s3CredsClearLegacy()`（幂等 SQL DELETE）清 v1 残留；`reset_device` 追加 `state::clear_s3_creds()`。锁屏状态机 `NotConfigured / Unlocked / GracePeriod(30s) / Locked`（`services/LockService.ets` 单例 + 订阅者）；`EntryAbility.onBackground` 起 30s grace timer，回前台 < 30s 直接 Unlocked，≥ 30s → `lockVault()` + 路由 `pages/LockScreen`；进程 kill 后冷启必锁。Grace 双保险：`setTimeout(GRACE_MS)` + `onForegrounded` 现算 `Date.now() - backgroundedAtMs` 兜底（防 OS 挂起计时器）。PIN 解锁 Argon2 verify → HKDF 派生 KEK → 解 mk_pin.blob → 推 MK 进 `EncryptionState`；bio 解锁 ArkTS `requestBioAuth` 拿 token → `huks.unwrapBio` → NAPI `lockPushUnwrappedMk` 推入。忘 PIN 回退 E2EE 密码 → `lockRecoverWithE2ee(password, newPin)` 重下 `meta/keyring.json` → 重建 HUKS 包（**旧 bio 失效，需在 Settings 重启用**）。节流：错 5 次锁 30s，每累计 5 次错上一档（30s → 5min → 30min），`preferences/security.json` 跨重启持久化；节流期间 PIN 输入 `.enabled(false)` + 每秒刷新 `lockLockoutRemainingSecs()`。指纹库变更（HUKS unwrap 抛错）自动清 `mk_bio.blob` + 删 HUKS bio key + UI 提示「指纹库已变更，请用 PIN」。启用生物识别时 NAPI `lockGetMkForBioEnroll` 短暂返回内存 MK base64 供 ArkTS HUKS wrap（必须先检查 `lockIsMkLoaded()` 再 `generateBioKey` 和 `requestBioAuth`——否则生物识别 UI 弹出后发现 MK 缺失，既浪费 UX 也会留孤立 HUKS key）。HUKS GCM `finishSession` 在 encrypt 时把 16B tag 追加到 `outData`，decrypt 时必须 `ct.slice(0, len-16)` + `AE_TAG = slice(len-16)` 分开传入；12B IV 随机生成（`Math.random` 可接受因为 AEAD 保完整性）。**AES-GCM 必需参数集**（security_huks 单测的 `g_authtokenAesParams`）：`HUKS_TAG_ALGORITHM=HUKS_ALG_AES` + `HUKS_TAG_KEY_SIZE=HUKS_AES_KEY_SIZE_256` + `HUKS_TAG_PURPOSE` + `HUKS_TAG_PADDING=HUKS_PADDING_NONE` + **`HUKS_TAG_DIGEST=HUKS_DIGEST_NONE`**（即使 GCM 自带 AEAD 也要写）+ `HUKS_TAG_BLOCK_MODE=HUKS_MODE_GCM` + **`HUKS_TAG_ASSOCIATED_DATA`**（即使 AAD 不用也必须给非空字节，Shibei 用 `b"shibei"`）+ **`HUKS_TAG_NONCE`**（不是 `HUKS_TAG_IV`——IV 是 CBC/CTR 的）+ decrypt 时追加 `HUKS_TAG_AE_TAG`。同一 param set 同时传给 `initSession` 和 `finishSession`；bio-gated 路径在 finishSession 的 props 末尾再追加 `HUKS_TAG_AUTH_TOKEN`（userAuth 返回的整包 token，无需裁剪）。Init 时 HUKS 返回 `handle.challenge`（32B），必须喂给 `userAuth.getUserAuthInstance({challenge,authType,authTrustLevel}, {title})` 的 AuthParam，否则 finish 会以 HUKS -3 "Invalid parameters" 拒绝——app 自己随机生成的 challenge 跟 HUKS 的对不上。blob 磁盘格式：`[IV(12) | CT(N) | TAG(16)]` base64 拼接（不用 JSON 包装，避免 `new util.TextDecoder(...)` 在某些 SDK build 上返回 undefined 的坑）。`userAuth.getUserAuthInstance` 比旧的 `getAuthInstance` 靠谱（旧的在 NEXT 经常直接抛 12500003 CANCELED），成功码对照 `userAuth.UserAuthResultCode.SUCCESS`；FACE 类型若设备没录入会让 `getUserAuthInstance` 抛 ohos 401，只在 `authType` 数组里放实际可用的类型（Mate X5 只放 FINGERPRINT）。Onboard Step 4（可选，E2EE 成功后） + Settings → 安全 → 启用/停用开关 + 修改 PIN + 生物识别开关 + 立即锁定，全通过 `LockService` 单点驱动。MVP 限制：PIN 位数 4（桌面对齐），未来 v2 可升级为 HUKS `USER_AUTH_TYPE_PIN` challenge（保留占位别名 `shibei_pin_kek_v1`）。
- **鸿蒙 i18n + 深色主题（Phase 5.1）**：ArkUI 走原生 `resourceManager.getStringSync(res, ...args)` 做 i18n，不引第三方库。`services/I18n.ets` 单例封装（try/catch + null-context guard + `currentLocale()` 返 `'zh'|'en'`），`EntryAbility.onWindowStageCreate` 第一行调 `I18n.init(ctx)`。资源布局：`resources/{zh_CN,en_US,base}/element/string.json` 三份（base 作 fallback，镜像 zh 内容 + 4 条 entry_label/perm_reason 鸿蒙系统 key）；key 命名沿桌面 namespace 用 `_` 分割（`common_*` / `settings_*` / `onboard_*` / `reader_*` / `annotation_*` / `lock_*` / `search_*` / `sidebar_*` / `resource_list_*` / `huks_*`），占位符用鸿蒙原生 `%1$s` / `%1$d`。**新增 UI 文案必须**：①在三份 JSON 同步加同名 key；②用 `I18n.t($r('app.string.key'), ...args)` 而非硬编码 CJK。**field initializer 陷阱**：组件 `@State foo: string = I18n.t(...)` 会在 EntryAbility 之前求值拿空串——用 `aboutToAppear` 里赋值。色板 `resources/base/element/color.json`（~20 token：`bg_*` / `text_*` / `accent_*` / `border_divider` / `shadow_default` / `surface_tap_invisible`）+ `resources/dark/element/color.json` 同名 override，鸿蒙系统按 ColorMode 自动选；**HL_COLORS 不 tokenize**（`#ffeb3b/#81c784/#64b5f6/#f48fb1` 是跨端标注数据，不是样式）；`promptAction.showDialog` 的 button.color 字段接 ResourceColor（`$r('app.color.*')`）。**dialog 按钮用 token**：cancel→text_secondary、confirm→accent_primary/accent_primary_alt、destructive→accent_danger。WebView 深色：`Reader.ets` 的 `Web` 组件 `.darkMode(WebDarkMode.Auto)`（HTML 快照 + PDF shell 都加）+ **不设** `forceDarkAccess(true)`（避免 Chromium 强制反色破坏快照原貌，对齐桌面行为）；pdf-shell 内部 `style.css` 用 `@media (prefers-color-scheme: dark)` 只改 chrome（body/status/.page shadow），**canvas 内容保持白底**（PDF 内容永远是白底，和 Acrobat/桌面一致）；pdf-shell 的 i18n 通过 Web src URL param `&loadingText=<encodeURIComponent(I18n.t(common_loading))>` 注入，main.js `params.get('loadingText')` 读取 setStatus。详见 `docs/superpowers/plans/2026-04-23-harmony-i18n-theme.md` + `docs/superpowers/plans/2026-04-23-harmony-i18n-keys.md`
- **鸿蒙 PDF Reader（Phase 3b）**：`Reader.ets` 按 `resource.resource_type === 'pdf'` 分支到 `@Builder PdfContent()`；`Web({src: $rawfile('pdf-shell/shell.html?id=<id>')})` 加载 HAP `rawfile/pdf-shell/` 下的 pdfjs v4 classic bundles（`pdf-bundle.js` + `pdf-worker-bundle.js` + `pdf-annotator-mobile.js` + `style.css`）。PDF 二进制走自定义 scheme `shibei-pdf://resource/{id}` + `onInterceptRequest` 从 NAPI `get_pdf_bytes`（返 base64）经 `new util.Base64Helper().decodeSync` 解码后 `setResponseData(bytes.buffer)` 喂给 pdfjs；本地缺失 `ensure_pdf_downloaded` 调 `shibei-sync::download_snapshot` 拉取。**关键约束**：①scheme 须在 `EntryAbility.onCreate` 用 `customizeSchemes([{schemeName,isSupportCORS:true,isSupportFetch:true,isStandard:true}])` 全局注册；`isStandard:true` 让 Chromium 按 http 规则处理 XHR；②`WebResourceResponse` 必须带 HTTP-shape 头（`Content-Type` / `Content-Length` / `Access-Control-Allow-Origin:*` / `Cache-Control` + `setReasonMessage('OK')` + `setResponseIsReady(true)`），否则 pdfjs 读到 status 0；③pdfjs 使用 fake-worker 路径（`GlobalWorkerOptions.workerSrc='about:blank'` + `window.pdfjsWorker.WorkerMessageHandler` 由 worker bundle 自动挂全局），ArkWeb 拒绝 `import(workerSrc)` from file://；④**必须 polyfill `Uint8Array.prototype.toHex/fromHex`**——ArkWeb 的 Chromium 缺 ES2024，pdfjs v4 的 fingerprint 会抛；⑤**必须把 pdfjs 的 textLayer CSS 规则照抄进 `style.css`**（`pdf_viewer.css` 里 `.textLayer > :not(.markedContent)` 的 `font-size: calc(var(--text-scale-factor) * var(--font-height))` + `transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv))`），容器类名必须是 **`textLayer`（驼峰）** 而非 `text-layer`，否则 pdfjs inline 设的 `--font-height` / `--scale-x` / `--rotate` 不参与计算，span 退回 body font-size，选区/高亮宽度 ~2× 偏大；⑥每页 pageDiv 须设 `--total-scale-factor` CSS var（pdfjs 的 `--text-scale-factor` 从它派生）。**Anchor 格式**：`{type:'pdf', page (0-indexed，和桌面对齐), charIndex, length, textQuote:{exact, prefix(32 字符), suffix(32 字符)}}`。DOM `data-page-number` 保持 1-indexed（匹配 `pdf.getPage(n)` 方便调试），anchor 出入边界加 `±1` 转换。**虚拟滚动**：IntersectionObserver 以 `rootMargin:400px` 观察每个 pageDiv 占位，可见时按需 `renderPage(n)`——canvas 宽 = `viewport.width * devicePixelRatio`（保清晰度）+ pdfjs `TextLayer.render()` 填文本层 + `paintHighlights` 画高亮。**折叠/旋转**：`ResizeObserver(pagesEl)` 触发 `relayoutForNewWidth()`——重算 scale、清所有页 DOM + `pageCache`、IO unobserve+reobserve 强制可见页重绘；`state.renderGen++` 让 in-flight 旧渲染在每个 `await` 边界 bail，不然会把旧 scale 的文本层塞进 `pageCache` 导致 hl 位置错。不可用 `window.resize` 或 `@Watch(foldStatus)`——前者 ArkWeb 不可靠，后者在 ArkWeb reshape 之前就 fire 会拿到 stale clientWidth。**flashHighlight 跨页跳转**：目标页未渲染时先 `window.__shibeiReader.scrollToPage(h.anchor.page+1)`，IO 触发渲染后 100ms 轮询直到 hl DOM 出现，双 rAF 等 draw 稳定再 `scrollIntoView({block:'center', inline:'nearest'})`。**NAPI 限制**：codegen 标量 ABI 不支持 `Vec<u8>`，PDF 字节以 base64 字符串返回，ArkTS 侧 `Base64Helper.decodeSync` 还原——~50 ms 开销 / 10 MB PDF 可接受，扩展 codegen 支持 length-prefixed buffer 是单独工作。**缩放**：shell 把 `state.scale` 拆成 `baseFitScale`（容器宽/页 1 未缩放宽，只随 resize 变）× `zoomFactor`（用户 zoom 0.5–4.0 step 0.05）；TopBar 在 PDF 模式 + `pdfReady` 下挂 `− N% +`（`N%` tap 回 1.0），`applyPdfZoom` 驱动 `window.__shibeiReader.setZoom(z)` → `applyZoom` 路径。**初始 zoom 通过 URL `?zoom=X` 注入**（`ensurePdfReady` 里 `getReaderZoom` 先解析再翻 `pdfReady`，Web src 内联 `$rawfile('pdf-shell/shell.html?id=X&zoom=Y')` 一次到位，避免 1.0→saved 闪跳）。**滚动位置**用 `captureScrollState` → `scrollTop/scrollHeight` fraction + topPage 兜底，`restoreScrollState` 双 rAF 后恢复（一次 rAF 在 ArkWeb 偶尔太早 scrollHeight 还是 0）。持久化走 `ReaderZoomState.ets` 存 `shibei_prefs` 的 `reader:zoomMap`（镜像 ReaderScrollState 结构），500ms debounce + unmount flush，读写都 clamp + round2 防坏文件/FP 漂移。**双指 pinch**：Web 组件 `.zoomAccess(false)` 关原生（原生 CSS-transform scale 会糊已渲染的 canvas，pdfjs 还在旧 scale），shell 自接 `touchstart/move/end/cancel`——两指 start 记 `initialDistance`/`initialZoom`/两指中点（做 `transform-origin`），move 时 `pagesEl.style.transform = scale(liveZoom/initialZoom)` 做实时 CSS 预览（手指跟随、`passive:false` + `preventDefault` 压 ArkWeb 默认手势），end 清 transform + 若 `|final - initial| > 0.005` 调 `applyZoom(final)` 走 pdfjs 真重渲染回清晰。`applyZoom` 通过 `window.shibeiBridge.emit('zoom', {zoom})` 把终值回传 ArkTS；`AnnotationBridge.ZoomPayload` + `onZoom` 分发到 `Reader.handleZoom`，让 `@State pdfZoom` 和 prefs 自动跟随，不管 zoom 是来自按钮还是 pinch（handleZoom 不再 runJavaScript，避免回环 rebuild）。**MVP 限制**：无本地导入、无搜索 / 跳页 / TOC、扫描 PDF 无文本高亮、加密 PDF 失败

## 三栏布局约束

资料库视图为三栏布局：Sidebar | ResourceList | PreviewPanel，两个分割条均可拖拽调整宽度。

### 窗口最小尺寸

- 最小宽度：**800px**，最小高度：**500px**（`tauri.conf.json` 中配置）

### 各栏宽度规则

| 栏 | 宽度规则 | 最小宽度 | 说明 |
|---|---------|---------|------|
| Sidebar | 可拖拽调整 | 160px | 像素值，初始 200px，持久化到 localStorage |
| Handle1 | 固定 4px | — | Sidebar↔ResourceList 拖拽分割条 |
| ResourceList | 可拖拽调整 | 240px | 像素值，初始 340px，持久化到 localStorage |
| Handle2 | 固定 4px | — | ResourceList↔PreviewPanel 拖拽分割条 |
| PreviewPanel | `flex: 1` 填充剩余 | 280px | 始终有可用空间 |

### 拖拽约束

```
可用空间 = 窗口宽度 - Handle1(4px) - Handle2(4px)
Sidebar 最大值 = 窗口宽度 × 30%
Sidebar 最小值 = 160px
ResourceList 最大值 = 可用空间 - Sidebar宽度 - PreviewPanel最小值(280px)
ResourceList 最小值 = 240px
```

- 拖拽时实时计算，确保两侧都不小于最小值
- 窗口缩小时，`resize` 事件自动收缩 Sidebar 和 ResourceList 宽度
- Sidebar 宽度持久化到 `localStorage`（key: `shibei-sidebar-width`）
- ResourceList 宽度持久化到 `localStorage`（key: `shibei-list-width`）
- 常量定义在 `Layout.tsx`：`SIDEBAR_MIN=160, LIST_MIN=240, PREVIEW_MIN=280, HANDLE_WIDTH=4`

## 阅读器双栏布局约束

阅读器视图为双栏布局：Reader（iframe）| AnnotationPanel，通过分割条可调整 AnnotationPanel 宽度。

| 栏 | 宽度规则 | 最小宽度 | 说明 |
|---|---------|---------|------|
| Reader | `flex: 1` 填充剩余 | 400px | iframe 内容区 |
| Handle | 固定 4px | — | 拖拽分割条 |
| AnnotationPanel | 可拖拽调整 | 220px | 初始 280px，持久化到 localStorage |

拖拽约束：`AnnotationPanel 最大值 = 容器宽度 - Reader最小值(400px) - Handle(4px)`。窗口缩小时 `resize` 事件自动收缩。AnnotationPanel 宽度持久化到 `localStorage`（key: `shibei-annotation-width`）。常量定义在 `ReaderView.tsx`：`PANEL_MIN=220, READER_MIN=400, HANDLE_WIDTH=4`。

## 依赖管理

- 新增 Rust crate 前先说明理由，优先使用标准库
- 新增 npm 包前先说明理由，避免引入大型框架（如 Material UI、Ant Design）
- 优先选择轻量、维护活跃的库
- 当前 Rust 依赖：tauri, rusqlite(bundled), r2d2/r2d2_sqlite, axum, tokio, tower-http, thiserror, uuid, chrono, serde/serde_json, dirs, base64, rust-s3, async-trait, chacha20poly1305, argon2, hkdf, sha2, rand, zeroize, tauri-plugin-single-instance, zip（备份导出/导入）
- 当前 npm 依赖：react, react-dom, @tauri-apps/api, react-markdown, remark-gfm, i18next, react-i18next, i18next-browser-languagedetector, @tauri-apps/plugin-dialog, pdfjs-dist, qrcode, vite, typescript, vitest, @testing-library/react
- 当前 MCP npm 依赖（`mcp/` 独立包）：@modelcontextprotocol/sdk
- 当前 Rust 依赖新增：scraper（HTML 纯文本提取）、pdf-extract（PDF 纯文本提取）
