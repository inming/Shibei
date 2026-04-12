# 拾贝 (Shibei) — 版本路线图草案

## 当前状态

MVP 已完成（Phase 1-8）。**v1.1 全部完成。v1.1.1 全部完成。v1.2 全部完成。v1.2.1 全部完成。v1.3 全部完成（E2EE → v1.3.1）。v1.3.1 全部完成。v1.3.2 全部完成。v1.3.3 全部完成。v1.4 第一期完成（元数据搜索，全文搜索移至 v2.0）。v1.5 全部完成。v1.6 全部完成。v1.7 全部完成。v1.8 全部完成。v2.0 快照全文搜索完成。v2.1 UX 体验改进完成。下一步：v2.0 其余能力扩展（导出/PDF/AI/快捷键/移动端）。**

---

## v1.1 — 区域选择 + 核心体验

**目标**：补上最关键的缺失功能（区域选择），同时打磨影响日常使用的核心交互。

### 区域选择保存（核心）
- [x] **选区模式 UI** — 插件增加"选区保存"按钮 → 页面叠加半透明遮罩 → 鼠标悬停高亮 DOM 元素（蓝色边框）→ 点击确认选中区域
- [x] **SingleFile 子树处理** — 整页 SingleFile 抓取后裁剪选中子树，保留祖先链确保样式继承
- [x] **选区元数据** — resources 表 `selection_meta` JSON 字段，存储 CSS selector + 标签名 + 文本摘要
- [x] ~~**阅读器选区聚焦**~~ — 不再需要：选区保存已裁剪为只含选中子树的 HTML，打开即为选区内容

### 导航补全
- [x] **文件夹树多级展开/折叠** — 递归组件，展开箭头，懒加载子文件夹，资料数量显示
- [x] **文件夹编辑** — 右键上下文菜单 + 模态对话框（重命名），删除确认也改为 Modal
- [x] **URL 查重提示** — 插件保存时查询已有记录，提示"该 URL 已保存过 N 次"

### 阅读与标注
- [x] **资料预览面板** — 资料库单击资料在右侧面板显示标注/评论，双击打开阅读器 Tab
- [x] **资料级笔记** — 不关联高亮的独立笔记（后端已支持 highlight_id=NULL），AnnotationPanel 增加笔记区域
- [x] **评论编辑** — 后端 `updateComment` 已有，前端加编辑按钮
- [x] **标注删除确认** — 高亮和评论删除加确认提示

### 视觉基础
- [x] **Tab 栏指示条** — 活动 Tab 底部加颜色指示；长标题 hover 显示 tooltip
- [x] **工具条动画** — 选区工具条 fade 过渡
- [x] **Loading 组件** — 统一的 spinner 替换"加载中..."文字
- [x] **统一间距** — 清理内联 style 硬编码，统一用 CSS 变量

### 安全
- [x] **Token 鉴权** — HTTP Server Bearer token 验证

### 技术债
- [x] **annotator.js → TypeScript** — 当前无类型检查，随功能增加风险大
- [x] **插件/应用图标** — 替换默认图标

---

## v1.1.1 — Anchor 系统调研与增强

**目标**：解决高亮标注在部分网页上定位失败的问题。这是标注功能的核心机制，需要先确定技术方向再推进后续功能。

### 背景

当前 annotator 使用两级锚点策略：文本偏移量（精确匹配）→ 文本引用（prefix + exact + suffix 模糊匹配）。大部分网页工作正常，但在特定页面存在定位失败的情况——高亮创建成功但无法渲染（`resolveAnchor` 找不到对应文本位置）。已知失败场景包括隐藏元素、伪元素、零宽字符干扰 text offset 计算等。

### 调研目标

- [x] **失败模式分析** — 收集并分类 anchor 解析失败的具体场景，理解根因
- [x] **业界方案对比** — 调研 Hypothesis、Readwise、Omnivore 等工具的 anchor 策略，对比 text position / text quote / CSS selector / XPath / Range 序列化等方案的兼容性和复杂度
- [x] **方案选型** — 确定增强方向（多策略 fallback、模糊匹配增强、CSS Selector 锚点等），评估改动范围和风险
- [x] **失败可视化** — anchor 解析失败时在 AnnotationPanel 标记"定位失败"而非静默丢失
- [x] **getTextNodes 加固** — 过滤隐藏元素、脚本标签文本节点，标准化零宽字符
- [x] **模糊匹配** — Bitap 算法 fuzzy fallback，容忍轻微文本差异

### 产出

- 调研文档：`docs/superpowers/specs/2026-04-01-anchor-enhancement-design.md`
- 实现计划：`docs/superpowers/plans/2026-04-01-anchor-enhancement.md`

---

## v1.2 — 体验深度打磨

**目标**：把所有交互细节做到位，从"能用"到"好用"。

### 标签系统
- [x] **标签筛选** — TagFilter 点击标签过滤资料列表（OR 逻辑）
- [x] **标签创建/删除 UI** — popover 创建，右键编辑/删除
- [x] **资料打标签** — 右键菜单 TagSubMenu 添加/移除标签
- [x] **标签颜色选择** — 8 种预设颜色圆点选择

### 拖拽与移动
- [x] **资料移动到其他文件夹** — 拖拽到文件夹节点或右键菜单"移动到"（@dnd-kit）
- [x] **文件夹移动** — 拖拽文件夹到另一个文件夹移入为子文件夹，拖到标题栏移回根目录
- [ ] ~~**文件夹拖拽排序**~~ — 推迟，与移动手势冲突，待独立设计交互方案

### 资料列表
- [x] **资料排序** — 创建时间 / 标注时间切换，升降序
- [x] **资料元信息编辑** — 右键菜单编辑标题、描述
- [x] **批量操作** — Finder 式多选（Cmd+Click / Shift+Click），批量删除、移动、打标签

### 视觉打磨
- [x] **选区工具条边界检测** — 靠近顶部时显示在选区下方，左右边缘自动偏移
- [x] **外链处理** — 默认不可点击（光标继承），Ctrl+Click 在系统浏览器打开 + toast
- [x] **骨架屏** — ResourceList 和 PreviewPanel 加载时骨架占位动画
- [x] **键盘导航** — 文件夹树 ↑↓→← 导航，资料列表 ↑↓/Enter/Delete
- [x] **无障碍** — role="tree/listbox/menu"、aria-selected、焦点管理

---

## v1.2.1 — 技术债清理

**目标**：功能稳定后集中处理技术债务。

- [x] **DB 连接池** — `Mutex<Connection>` → `r2d2` 连接池
- [x] **前端测试补充** — 核心组件和 hooks 的单元测试

---

## v1.3 — S3 云同步

**目标**：实现多设备数据同步，让资料库不再局限于单机。基于 S3 兼容存储，支持 AWS S3、MinIO、Cloudflare R2、阿里云 OSS 等。

- 设计文档：`docs/superpowers/specs/2026-04-02-v1.3-s3-sync-design.md`
- 实现计划：`docs/superpowers/plans/2026-04-02-v1.3-s3-sync.md`

### 基础设施
- [x] **变更追踪** — `sync_log` 表记录所有 CRUD 变更，含 entity_type/entity_id/operation/payload/HLC/device_id
- [x] **软删除改造** — 6 张业务表增加 `deleted_at` + `hlc` 字段，删除改为标记，90 天后物理清理
- [x] **设备标识** — 完整 UUID v4 持久化到 `device_id` 文件
- [x] **HLC 时钟** — Hybrid Logical Clock 保证多设备全序，容忍时钟偏差

### S3 存储层
- [x] **存储后端抽象** — `SyncBackend` trait（upload/download/list/delete/head），MockBackend 用于测试
- [x] **S3 客户端** — `rust-s3` crate，支持自定义 endpoint（兼容阿里云 OSS 等 S3 兼容服务）
- [x] **凭据存储** — S3 凭据存 sync_state 表（DB 内），非敏感配置同表 `config:` 前缀

### 同步协议
- [x] **增量同步** — sync_log → JSONL 上传到 `sync/<device_id>/`，拉取远端 JSONL → 拓扑排序 → LWW apply
- [x] **首次全量同步** — 首次上传全量快照到 `state/snapshot-*.json`，新设备导入快照后回放增量
- [x] **快照按需下载** — 元数据全量同步，snapshot.html 打开阅读器时自动下载
- [x] **Compaction** — JSONL 文件超限时生成全量快照，两阶段清理旧文件 + 90 天物理清除软删除记录

### 前端
- [x] **同步设置页** — S3 配置表单 + 连接测试 + 明文存储警告 + 自动同步间隔设置
- [x] **同步状态指示** — sidebar 底部状态按钮（已同步/同步中/同步失败）+ 手动触发
- [x] **定时自动同步** — 可配置间隔（默认 5 分钟），设置页可调整或关闭
- [x] **同步后自动刷新** — 文件夹树、资料列表、标签列表同步完成后自动刷新
- [x] **快照自动下载** — 阅读器打开未下载资料时自动下载并显示加载动画

### 不在 v1.3 范围（→ v1.3.1 或后续）
- ~~端到端加密 E2EE~~ → v1.3.1 完成
- WebDAV 等其他存储协议
- 字段级冲突合并
- 密钥轮换

---

## v1.3.1 — 端到端加密 (E2EE)

**目标**：保护 S3 上的同步数据，确保云端提供商无法读取用户数据。

- 设计文档：`docs/superpowers/specs/2026-04-03-v1.3.1-e2ee-design.md`
- 实现计划：`docs/superpowers/plans/2026-04-03-v1.3.1-e2ee.md`

### 加密基础
- [x] **加密模块** — XChaCha20-Poly1305 AEAD 加密，AAD 防文件互换
- [x] **密钥管理** — 随机 MK + Argon2id 密码派生 + HKDF verification hash
- [x] **EncryptedBackend** — SyncBackend 装饰器，透明加密/解密

### 用户流程
- [x] **启用加密** — 设置密码 → 生成密钥 → 清空 S3 → 全量重传（加密）
- [x] **解锁** — 每次重启输入密码 → 解密 MK → 缓存在内存
- [x] **修改密码** — 重新 wrap 同一 MK，不重新加密数据
- [x] **多设备** — 新设备/已有设备检测远端加密 → 输入密码解锁

### 设置页
- [x] **设置页拆分** — 弹窗改为独立 Tab + 侧栏导航（同步 / 加密），可扩展

### 不在范围
- 关闭加密、密钥轮换、本地数据加密、生物识别解锁、恢复码

---

## v1.3.2 — OS 安全存储记住加密密钥

**目标**：将 E2EE 主密钥存入操作系统安全存储，启动时自动解锁，免去每次输入密码。

- 设计文档：`docs/superpowers/specs/2026-04-04-v1.3.2-os-keystore-design.md`
- 实现计划：`docs/superpowers/plans/2026-04-04-v1.3.2-os-keystore.md`

### OS Keychain 集成
- [x] **keychain 存取** — `keyring` crate 封装，macOS Keychain 存储 MK 原始字节
- [x] **自动解锁** — 启动时从 keychain 取 MK，验证 S3 keyring hash 后写入内存
- [x] **记住密钥 toggle** — 设置页 opt-in 开关，默认不记住
- [x] **keychain 清理** — 重置加密 / MK 失效时自动清除

### Bug fix
- [x] **同步重置修复** — `cmd_unlock_encryption` 只在首次解锁时重置同步进度

### 不在范围
- 生物识别解锁、~~自动锁定~~（→ v1.3.3 完成）、本地数据加密

---

## v1.3.3 — UX 增强 + 锁屏

**目标**：修复交互 bug，补充体验细节，新增 PIN 锁屏安全功能。

- 实现计划：`docs/superpowers/plans/2026-04-04-v1.5-ux-enhancements.md`

### Bug 修复
- [x] **删除资料后关闭 Tab** — 资料被删除时自动关闭对应的阅读器 Tab
- [x] **软删除保留快照** — 软删除不再物理删除快照文件，恢复后可正常打开
- [x] **同步后标签状态刷新** — 右键菜单每次打开时重新获取标签分配状态

### 体验优化
- [x] **iframe 加载动画** — 快照内容加载时显示 spinner，替代白屏
- [x] **双行标注配色** — 亮色/暗色两行各 5 种高亮颜色，适配不同底色网页
- [x] **全部资料** — 侧栏新增"全部资料"虚拟文件夹，查看所有文件夹的资料
- [x] **侧栏导航统一** — 全部资料/文件夹/标签/回收站统一为同层级导航项样式，支持折叠/展开

### 锁屏安全
- [x] **PIN 码锁屏** — 4 位数字 PIN，Argon2 哈希存 macOS Keychain
- [x] **自动锁屏** — 无操作超时自动锁定，可配置 2/5/10/15/30/60 分钟
- [x] **快速锁屏** — 侧栏底部锁定按钮，一键锁屏
- [x] **锁屏设置页** — 设置 → 安全，设置/关闭 PIN、调整超时时间

---

## v1.4 — 搜索

**目标**：让资料可被高效检索。分两期实现：第一期元数据搜索，第二期快照全文搜索。

- 设计文档：`docs/superpowers/specs/2026-04-06-v1.4-search-design.md`
- 实现计划：`docs/superpowers/plans/2026-04-06-v1.4-search.md`

### 搜索架构（第一期）
- [x] **搜索方案设计** — FTS5 trigram tokenizer，中文友好，零外部依赖
- [x] **元数据搜索** — 标题 + URL + 描述 + 高亮文本 + 评论内容
- [x] **快速筛选** — 资料列表顶部搜索框，>= 2 字符 debounce 300ms 即时搜索（>= 3 字符走 FTS5 trigram，2 字符回退 LIKE）
- [x] **搜索结果展示** — 标题高亮匹配，PreviewPanel 标注/评论高亮匹配
- [x] **标签过滤统一** — 标签过滤从前端移至后端，搜索与非搜索模式逻辑一致

### 未来扩展（不在本期）
- 快照全文搜索（第二期：提取 HTML 纯文本，复用 FTS5 基础设施）
- 向量搜索 / 语义搜索
- 搜索建议 / 自动补全
- 按标注内容搜索

---

## v1.5 — 深色模式

**目标**：补齐视觉体验，支持长时间夜间使用。

**复杂度**：低。CSS 变量已预留，主要是样式工作。

- [x] **Dark Mode** — `[data-theme="dark"]` CSS 变量覆盖 + `useTheme` hook（light/dark/system）+ 设置页外观面板
- [x] **高亮颜色适配** — 高亮颜色由用户手动选择（亮底/暗底两行），不随主题自动切换
- [x] **快照内容适配** — iframe 不强制反色，阅读器 metaBar 提供 🌓 反色按钮（`filter: invert(0.85) hue-rotate(180deg)`），用户按需切换
- [x] **输入框深色适配** — 全局 input/textarea 设置 background + color，覆盖浏览器默认白底
- [x] **评论/笔记自动高度** — textarea 随内容自动调整高度（max 200px）
- [x] **面板宽度持久化** — ResourceList 和 AnnotationPanel 宽度持久化到 localStorage

---

## v1.6 — Markdown 标注

**目标**：评论和资料级笔记支持 Markdown 格式，提升标注表达能力。

**复杂度**：中。需要引入 Markdown 渲染器，改造评论/笔记的编辑和展示组件，数据库字段兼容。

### 编辑器
- [x] **Markdown 编辑** — 评论和资料级笔记输入框支持 Markdown 语法（标题、列表、粗斜体、代码块、链接等）
- [x] **切换预览** — textarea + 预览切换按钮，支持编辑/预览模式切换
- [x] **选型：textarea + react-markdown** — 纯 textarea 编辑 + react-markdown 渲染，remark-gfm 支持 GFM 扩展

### 渲染
- [x] **评论 Markdown 渲染** — AnnotationPanel 中评论内容按 Markdown 渲染展示
- [x] **笔记 Markdown 渲染** — 资料级笔记、PreviewPanel 笔记区域 Markdown 渲染
- [x] **搜索高亮兼容** — react-markdown 自定义 rehype 插件在渲染后文本节点上做搜索匹配
- [ ] ~~**代码高亮**~~ — 不引入，等宽字体 + 灰底足够

### 兼容性
- [x] **数据兼容** — 已有纯文本评论无需迁移，渲染时自动兼容（纯文本即合法 Markdown）
- [x] **搜索索引** — FTS5 原样索引 Markdown 源文本，trigram 分词不受语法符号影响

---

## v1.7 — MCP Server

**目标**：暴露 MCP 接口，让 AI 助手（Claude、Cursor 等）能访问和操作资料库，释放 AI 时代的生产力。

**复杂度**：中高。需要实现 MCP 协议、设计资源/工具暴露范围、处理认证和安全边界。

- 设计文档：`docs/superpowers/specs/2026-04-06-v1.7-mcp-server-design.md`
- 实现计划：`docs/superpowers/plans/2026-04-06-v1.7-mcp-server.md`

### 协议层
- [x] **MCP Server 实现** — Node.js 独立进程（@modelcontextprotocol/sdk），stdio transport
- [x] **技术选型** — Node.js + 官方 TypeScript SDK，通过 HTTP 代理访问主应用 axum server

### 基础设施
- [x] **纯文本提取** — `scraper` crate 解析 HTML，提取可见文本存入 `plain_text` 字段（Migration 006）
- [x] **Token 传递** — 主应用启动写 `{data_dir}/mcp-token`，退出删除，MCP 进程读取鉴权
- [x] **HTTP API 扩展** — 新增 10 个 RESTful 路由（4 读 + 6 写），复用现有 Bearer token 中间件

### 读取工具（6 个）
- [x] **搜索资料** — `search_resources`：关键词搜索 + 文件夹/标签/排序筛选
- [x] **资料详情** — `get_resource`：元数据 + 标签
- [x] **标注列表** — `get_annotations`：高亮 + 评论
- [x] **资料内容** — `get_resource_content`：纯文本分页读取（懒填充）
- [x] **文件夹树** — `list_folders`：嵌套结构 + 计数
- [x] **标签列表** — `list_tags`：全部标签

### 写入工具（3 个）
- [x] **编辑资料** — `update_resource`：标题/描述/移动文件夹
- [x] **管理标签** — `manage_tags`：创建/添加/移除
- [x] **管理笔记** — `manage_notes`：创建资料级笔记/编辑评论

### 安全
- [x] **本地限制** — HTTP Server 仅绑定 127.0.0.1，Bearer token 鉴权
- [ ] ~~**权限控制**~~ — 可配置只读/读写模式（暂不实现，当前默认读写）

---

## v1.8 — 多语言 (i18n)

**目标**：UI 文案国际化，支持中英文切换。

**复杂度**：中低。无新功能，主要是文案抽取的体力活，但涉及面广（所有组件）。

- 设计文档：`docs/superpowers/specs/2026-04-09-v1.8-i18n-design.md`
- 实现计划：`docs/superpowers/plans/2026-04-09-v1.8-i18n.md`

### i18n 框架
- [x] **react-i18next** — i18next + react-i18next + i18next-browser-languagedetector，9 个命名空间
- [x] **TypeScript 类型安全** — `CustomTypeOptions` 类型增强，`t()` 调用编译时检查 key

### 语言包
- [x] **中文语言包** — 296 条字符串，按模块拆分（common/sidebar/reader/annotation/settings/sync/encryption/lock/search）
- [x] **英文语言包** — 完整英文翻译，中英文 key 完全对齐

### 前端迁移
- [x] **组件迁移** — 25+ React 组件/hooks 的硬编码中文 → `useTranslation()` + `t()` 调用
- [x] **alert() → toast** — FolderTree/FolderEditDialog 中的 alert() 改为 toast.error()
- [x] **日期格式化** — `toLocaleString("zh-CN")` 改为跟随 app 语言设置

### 后端
- [x] **错误消息 i18n** — 20 条 Rust 手写错误消息改为 i18n key，前端 `translateError()` 翻译层

### Chrome 插件
- [x] **chrome.i18n API** — `_locales/` 目录 + `chrome.i18n.getMessage()`
- [x] **MAIN world 处理** — region-selector.js 通过注入参数接收翻译后字符串

### 设置页
- [x] **语言切换** — 设置 → 外观，中文/English 切换，持久化 `localStorage: shibei-language`

---

## v2.0 — 能力扩展

**目标**：支持更多格式、平台覆盖和高级功能。每个子项都是独立的功能模块，可以按需选做。

### 快照全文搜索
- [x] **HTML 纯文本提取** — 快照解析提取可见文本，写入 search_index（`body_text` 列）
- [x] **全文搜索** — 复用 FTS5 trigram 基础设施，搜索范围扩展到快照正文，搜索结果显示"正文匹配"标签
- [x] **启动时回填** — 首次升级时自动从 snapshot.html 提取纯文本回填已有资料

### 数据导出
- [ ] **本地备份** — 一键导出完整资料库（SQLite + snapshots）为压缩包
- [ ] **备份恢复** — 从备份包恢复资料库
- [ ] **单篇导出** — 单个资料导出为 HTML（含标注）

### PDF 支持
- [ ] **PDF 阅读器** — resource_type="pdf"，PDF.js 渲染
- [ ] **PDF 标注** — PDF.js annotation layer 集成

### AI 增强
- [ ] **AI 摘要** — 自动生成资料摘要（依赖 MCP 或内置 LLM 调用）
- [ ] **智能标签** — AI 推荐标签

### 全局快捷键
- [ ] **Cmd+K 快速搜索** — 全局搜索跳转面板
- [ ] **常用操作快捷键** — 新建文件夹、切换 Tab 等

### 移动端支持
- [ ] **技术选型** — 评估方案：Tauri Mobile (iOS/Android) / 独立 Swift+Kotlin 原生 / PWA 只读查看
- [ ] **核心只读体验** — 移动端浏览资料库、阅读快照、查看标注
- [ ] **同步对接** — 复用 S3 同步协议，移动端作为同步客户端
- [ ] **离线缓存** — 已下载快照本地缓存，离线可读
- [ ] **移动端标注** — 触屏选文高亮、添加评论（可选，视交互复杂度）

---

## v2.1 — UX 体验改进

**目标**：系统性 UX 评审后的体验提升，聚焦搜索可用性、信息架构、阅读沉浸感和浏览效率。

- UX 评审报告：`docs/2026-04-11-ux-review.md`
- 实现计划：`docs/superpowers/plans/2026-04-11-ux-improvements.md`
- 验证清单：`docs/2026-04-11-ux-checklist.md`

### 搜索增强
- [x] **搜索结果 snippet** — 正文匹配时返回关键词前后各 20 字符上下文片段，列表中显示并高亮
- [x] **匹配类型标签** — 搜索结果标注匹配来源（正文匹配 / 标注匹配 / 评论匹配），独立行显示
- [x] **match_fields 后端** — `SearchResult` 新增 `match_fields: Vec<String>` + `snippet: Option<String>`

### 预览面板重构
- [x] **概览模式** — PreviewPanel 从完整标注列表改为：摘要（description > plain_text 前 200 字）+ 高亮/评论内容 + 标签
- [x] **正文摘要 fallback** — 新增 `cmd_get_resource_summary` 命令，从 `plain_text` 提取前 N 字符
- [x] **去除冗余** — 删除与阅读器 AnnotationPanel 重复的打开按钮，保留内容展示

### 阅读器沉浸感
- [x] **Meta 栏 auto-hide** — 向下滚动自动隐藏，向上滚动或到顶时显示，CSS transform 动画
- [x] **阅读进度条** — 阅读器顶部 2px 绿色进度条，跟随滚动百分比
- [x] **标注面板折叠** — 折叠为 32px 窄条（高亮色点 + 数量），点击展开，分割条 hover 显示折叠按钮
- [x] **annotator.js 增强** — scroll 事件传递 direction/scrollY/scrollPercent

### 浏览效率
- [x] **标签色点** — 资料列表每项显示最多 3 个标签颜色圆点
- [x] **标注计数** — 资料列表显示高亮数量徽章，后端批量查询 `count_by_resource_ids`
- [x] **空状态引导** — 空文件夹、搜索无结果、空标注面板分别显示引导文案

### 回收站增强
- [x] **保留天数** — 每条删除项显示剩余天数，<= 7 天红色预警
- [x] **提示横幅** — 回收站顶部「90 天后永久移除」提示
- [x] **批量恢复** — 全选 checkbox + 批量恢复按钮

### 全局样式
- [x] **滚动条统一** — 全局 thin scrollbar（8px，content-box 内缩），深色模式自适应
- [x] **iframe 滚动条** — annotator.js 注入滚动条样式（半透明 rgba，!important 覆盖页面自带样式）
- [x] **资料列表固定头** — 搜索栏和排序栏固定顶部，列表独立滚动

### Deep Link 增强
- [x] **单实例** — `tauri-plugin-single-instance`，第二个实例转发 URL 给已有窗口并聚焦
- [x] **锁屏暂存** — deep link 到达时若锁屏则暂存，解锁后自动打开目标资料
- [x] **冷启动处理** — `getCurrent()` 获取启动 URL，锁屏暂存或直接打开

---

## 版本节奏

| 版本 | 核心主题 | 复杂度 | 性质 |
|------|---------|--------|------|
| **v1.1** | 区域选择 + 核心体验 | — | 补缺 + 打磨（让产品真正可用） |
| **v1.2** | 标签 + 拖拽 + 排序 + 深度打磨 | — | 效率提升（让产品好用） |
| **v1.3** | S3 云同步 + E2EE + OS 密钥存储 + UX 增强 + 锁屏 | — | 多设备同步 + 安全（让数据不丢失） |
| **v1.4** | 搜索 | — | 信息检索（让资料找得到） |
| **v1.5** | 深色模式 | 低 | 视觉体验（夜间使用无障碍） |
| **v1.6** | Markdown 标注 | 中 | 标注能力升级（富文本表达） |
| **v1.7** | MCP Server | 中高 | AI 集成（让资料库接入 AI 工作流） |
| **v1.8** | 多语言 | 中低 | 国际化（中英文支持） |
| **v2.0** | 全文搜索 | — | 能力扩展（快照正文检索） |
| **v2.1** | UX 体验改进 | 中 | 搜索增强 + 阅读沉浸 + 信息密度 + deep link |
| **v2.x** | 导出 / PDF / AI / 快捷键 / 移动端 | — | 能力扩展（按需选做） |
