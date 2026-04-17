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
src-tauri/          # Rust 后端（Tauri core）
  src/
    commands/       # Tauri command handlers（37 个命令，含 cmd_search_resources/cmd_export_backup/cmd_import_backup/cmd_get_ai_tool_paths）
    db/             # 数据库操作（migration、folders/resources/tags/highlights/comments/search CRUD，含软删除+HLC+FTS5）
    server/         # 本地 HTTP server（axum，插件通信）
    storage/        # 文件系统存储逻辑
    sync/           # S3 云同步（HLC 时钟、sync_log、sync_state、SyncBackend trait、SyncEngine、凭据、全量导出、E2EE 加密）
    annotator.js    # 标注注入脚本（嵌入到 HTML 中）
  migrations/       # SQL migration 文件
src/                # React 前端
  components/       # UI 组件（Layout, TabBar, ReaderView, PDFReader, AnnotationPanel, MarkdownContent, SettingsView, Settings/AIPage/..., Sidebar/...）
  hooks/            # 自定义 hooks（useFolders, useResources, useTags, useAnnotations, useSync）
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
- **PDF 支持**：`resource_type = "pdf"` 使用 `pdfjs-dist` 渲染（canvas + 文本层），`PDFReader` 组件替代 iframe。标注复用 highlights/comments 表，anchor 格式 `{ type: "pdf", page, charIndex, length, textQuote }`。纯文本由 `pdf-extract` crate 保存时提取（`catch_unwind` 防止 panic），提取失败时前端 PDF.js `streamTextContent()` 回填（`cmd_backfill_plain_text`）。插件通过 background fetch 下载 PDF 二进制后 POST 到 `/api/save-raw`（`Content-Type: application/pdf`）。本地导入通过 `cmd_import_pdf` 命令。**初始跳转**：`ReaderView` 对 PDF 走专用 effect，等 `PDFReader.onReady()`（驱动 `iframeLoading=false`）后再设置 `pdfScrollRequest={ id, ts: Date.now() }` 触发 PDFReader 滚动；HTML iframe 走另一条路径（等 `shibei:annotator-ready` postMessage）；两者共用 `didScrollToInitial` 防重复；`initialHighlightId` 变更时重置该 ref。**pdfjs-dist v5 注意事项**：TextLayer 和文本提取必须用 `streamTextContent()`（不能用 `getTextContent()`，WebKit 会报 readableStream 错误）；页面容器需手动设置 `--scale-factor` 和 `--total-scale-factor` CSS 变量（TextLayer 不会自动设置）；页面布局用 CSS `aspect-ratio` 而非 JS 计算高度；canvas 用 `height: 100%`（不能用 `auto`，HiDPI 下会撑开容器）；resize 滚动保持通过 `scrollTop/scrollHeight` fraction 检测跨平台差异（Chromium 不调整 scrollTop，WebKit 自动调整）
- **系统预设文件夹**：后端 `ensure_inbox_folder()` 在启动时保证存在一个 ID 为 `__inbox__` 的"收件箱"文件夹，新抓取的资料默认落入其中。前端 `src/types/index.ts` export `INBOX_FOLDER_ID = "__inbox__"` 常量。FolderTree 右键菜单对该 folder 只保留"导入文件"一项，屏蔽"新建子文件夹/编辑/删除"，避免用户破坏系统预设。`ALL_RESOURCES_ID = "__all__"` 为虚拟聚合视图（非真实 folder），不可作为上传/右键菜单的目标
- **文件导入入口**：通过两个右键菜单触发（已移除第二栏顶部的 "PDF+" 按钮）：①Sidebar 文件夹行右键 → "导入文件"；②ResourceList 空白处右键（选中真实 folder 时）→ "导入文件"。两处共享 `src/lib/importPdf.ts` 的 `importPdfToFolder(folderId)`，文件对话框 filter 限 `*.pdf`，错误通过 `translateError()` 翻译。i18n key 为 `reader.importFile`（文案"导入文件"，为未来扩展格式预留）
- **会话持久化**：单 localStorage key `shibei-session-state`（v1，带 `version` 字段做未来迁移）存储打开的 Tab 列表 / 激活 Tab / 每个 Tab 滚动位置 / 资料库选中（folder + tags + preview resource + 列表滚动位置）。`src/lib/sessionState.ts` 维护内存 mirror，对外暴露 `loadSessionState` / `saveSessionState`（顶层字段浅合并，library 子对象同样浅合并）/ `updateReaderTab`（按 id 合并 tab 字段）/ `removeReaderTab`。**写时机**：Tab 增/删/切换、folder/tag/preview 变更立即写；HTML scroll 500ms debounce，PDF scroll 500ms debounce，资料列表 scroll 300ms debounce。ReaderView unmount 时 flush pending scroll（防丢最后 500ms）。**恢复时机**：`App.tsx` 启动 `Promise.all(cmd.getResource)` 解析每个 Tab，失败/null 静默丢弃；Settings 不恢复（`openSettings` 不写 session，最后非 Settings 的 active tab 自然存活）。**StrictMode 安全**：restore effect 只用 `restoredRef` 守卫，**不可**用 cancel flag（StrictMode 双调用会在 cleanup 里置 cancelled=true 阻断 async 写入）。**懒挂载**：`mountedTabIds: Set<string>` 只让激活 Tab 挂载 `<ReaderView>`（iframe），其余 Tab 点击时才首次挂载。**高亮深链优先于恢复滚动**：`shibei://open/resource/{id}?highlight={hlId}` 深链的 `initialHighlightId` 会让滚动恢复短路（guard: `!initialHighlightId`）。**失效兜底**：坏 JSON / 版本不匹配 / 配额满全部静默回落 `DEFAULT_STATE`；非虚拟 folder 不存在时回落 `INBOX_FOLDER_ID`。**PDF 滚动请求**扩展为 tagged union `{kind: "highlight", id, ts} | {kind: "position", page, fraction, ts}`——position 分支计算 `offsets[page] + heights[page] * fraction` 设置 scrollTop。**行高亮一致性**：资料库持久化的是单 `selectedResourceId`，启动时派生 `selectedResourceIds = new Set([id])` 和 `lastClickedResourceId` 让列表行高亮与预览内容一致。新增 mutation 必须调用对应的 sessionState API，否则重启会漂移

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
- 当前 npm 依赖：react, react-dom, @tauri-apps/api, react-markdown, remark-gfm, i18next, react-i18next, i18next-browser-languagedetector, @tauri-apps/plugin-dialog, pdfjs-dist, vite, typescript, vitest, @testing-library/react
- 当前 MCP npm 依赖（`mcp/` 独立包）：@modelcontextprotocol/sdk
- 当前 Rust 依赖新增：scraper（HTML 纯文本提取）、pdf-extract（PDF 纯文本提取）
