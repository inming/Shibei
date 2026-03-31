# 拾贝 (Shibei) MVP 实现计划

## Context

拾贝是一个个人只读资料库桌面应用，用于收集网页快照并进行标注。设计文档已确认：`docs/superpowers/specs/2026-03-31-shibei-mvp-design.md`

技术栈：Tauri 2.x + React + TypeScript + SQLite + Chrome Extension (Manifest V3)

## 实现阶段

项目较大，建议分为多个独立阶段逐步实现。以下是 MVP 的完整实现路线：

### Phase 1: 项目脚手架与基础设施
- 初始化 Tauri 2.x 项目（Rust + React + TypeScript + Vite）
- 配置项目结构：`src-tauri/`（Rust 后端）、`src/`（React 前端）、`extension/`（浏览器插件）
- 初始化 git 仓库
- 设置测试框架：
  - Rust：`cargo test`（标准库自带），使用 `tempfile` crate 创建临时数据库/目录用于测试隔离
  - 前端：Vitest + React Testing Library（轻量，与 Vite 无缝集成）
  - E2E：Tauri 内置的 WebDriver 测试（后续按需启用，MVP 暂不强制）
- 设置 SQLite 集成（rusqlite），实现 migration 版本管理：
  - 使用 `user_version` pragma 跟踪当前数据库版本号
  - SQL migration 文件按版本编号存放（如 `migrations/001_init.sql`、`002_xxx.sql`）
  - 应用启动时自动检测版本差异并依次执行未应用的 migration
  - migration 在事务中执行，失败则回滚
- 创建初始 migration：所有表结构（folders, resources, tags, resource_tags, highlights, comments）
- 设置本地文件存储目录结构（`~/.shibei/`）
- **技术 Spike：MHTML 渲染验证**（阻塞性风险，必须在 Phase 1 完成）
  - 实现最简自定义协议（`shibei://`），从本地读取 MHTML 并在 Webview 中加载
  - 准备 3-5 个测试用 MHTML 样本：中文页面、图片密集页面、复杂 CSS 页面、大体积页面（>5MB）
  - 验证项：图片是否正常显示、CSS 样式是否保留、中文编码是否正确、大页面渲染性能
  - 验证 `with_initialization_script()` 注入是否被页面 CSP 阻止
  - 如果验证不通过，在此阶段就调整技术方案（如改用 iframe + blob URL、或 PDF 化存储等），不要带着风险进入后续阶段

### Phase 2: Rust 后端核心
本阶段实现纯 Rust 层的 db 操作和存储逻辑，不依赖 HTTP Server 或 Tauri 运行时。单元测试直接调用 Rust 函数，用 tempfile 创建临时 db/目录做隔离。
- 实现文件夹 CRUD（创建、重命名、删除、移动、排序）+ 单元测试
- 实现资料存储：接收 MHTML 字节流（`&[u8]`），写入文件系统 + SQLite 元信息 + 单元测试
- 实现标签 CRUD + 单元测试
- 实现资料-标签关联管理 + 单元测试
- 实现高亮 CRUD（含 anchor 序列化/反序列化）+ 单元测试
- 实现评论 CRUD（支持一个高亮多条评论）+ 单元测试
- 将以上功能暴露为 Tauri Commands

### Phase 3: 插件技术调研
- 调研 Zotero Connector 插件的实现方式：网页快照保存机制、选区处理、资源打包（图片/CSS/字体）、与桌面端通信
- 调研 SingleFile 等开源网页归档工具的技术方案
- 评估区域选择的实现路径：(a) 整页 MHTML + 选区标记 (b) 借助现有库做片段打包 (c) 其他方案
- 输出调研结论，必要时修订设计文档中插件和存储相关的技术方案

### Phase 4: 本地 HTTP Server（插件通信）
- 在 Tauri 应用中启动本地 HTTP Server（端口 21519）
- 实现 `POST /api/save` — 接收插件发送的网页快照数据 + 集成测试（接口设计依据 Phase 3 调研结论）
- 实现 `GET /api/folders` — 返回文件夹树
- 实现 `GET /api/tags` — 返回标签列表
- 实现 `GET /api/ping` — 健康检查

### Phase 5: React 前端 — 资料库管理
- 三栏布局框架（左侧边栏 + 中间阅读区 + 右侧标注面板）
- 使用 CSS 变量定义颜色体系（为后续 Dark Mode 预留），MVP 只实现浅色主题
- 左侧边栏：文件夹树组件（可折叠、拖拽排序）
- 左侧边栏：标签筛选组件
- 左侧边栏：资料列表组件（当前文件夹下的资料）
- 资料元信息显示（标题、URL、保存时间、标签）
- UI 文案与组件逻辑分离（为后续 i18n 多语言预留），MVP 先用中文

### Phase 6a: 阅读器 — MHTML 加载与渲染
- 实现 Tauri 自定义协议 `shibei://resource/{id}`，Rust 端读取 MHTML 文件并返回内容
- 在主界面中间区域嵌入 Webview，通过自定义协议加载 MHTML
- 验证各类网页快照的渲染效果（图片、CSS 样式、中英文内容）
- 顶部元信息栏展示（标题、原始 URL、保存时间）

### Phase 6b: 标注 — 高亮创建与持久化
- 编写注入脚本基础框架，通过 `with_initialization_script()` 注入 Webview
- 实现选中文字 → 弹出浮动工具条（颜色选择）
- 实现选区 → TextPositionSelector + TextQuoteSelector 锚点计算
- 使用 `<shibei-hl>` 自定义元素渲染高亮（样式隔离）
- 通过 Tauri IPC 将高亮数据写入 SQLite

### Phase 6c: 标注 — 高亮恢复与评论
- 打开资料时从 SQLite 加载已有高亮，注入脚本根据 anchor 恢复渲染
- 处理锚点定位失败的降级策略（用 textQuote 模糊匹配 fallback）
- 实现评论创建/追加 UI（浮动工具条 → 评论输入框）

### Phase 6d: 标注 — 侧边栏与双向联动
- 右侧标注面板：高亮列表 + 评论串展示
- 点击 Webview 高亮 → 侧边栏滚动定位到对应条目
- 点击侧边栏条目 → Webview 滚动到对应高亮位置并闪烁
- 高亮和评论的删除操作

### Phase 7: Chrome 浏览器插件 — 整页保存
- Manifest V3 插件基础结构
- 整页保存：使用 `pageCapture.saveAsMHTML()` API
- 元信息提取：从 meta/og 标签提取 title、author、description
- 保存面板 UI：文件夹选择 + 标签选择 + 保存按钮
- 与 Tauri 本地 HTTP Server 通信
- **验证标准**：浏览器一键保存 → Tauri 中打开 → 阅读 → 标注，整条链路跑通

### Phase 8: 集成测试与打磨
- 端到端流程验证（参见设计文档验证方案）
- 错误处理和边界情况
- UI 细节打磨

## 建议执行顺序

Phase 1 → Phase 2 → Phase 3（调研） → Phase 4 → Phase 5 → Phase 6a/b/c/d → Phase 7 → Phase 8

Phase 3 调研可与 Phase 4/5 并行，调研结论在 Phase 7 之前落地即可。

## MVP 之外（v1.1+）

以下功能不在 MVP 范围，按优先级排列：

1. **区域选择保存**：具体方案依据 Phase 3 调研结论，可能是整页 MHTML + 选区标记，也可能是 fragment 打包。如果调研发现 fragment 打包成本过高应及时调整方案
2. **全文搜索**：SQLite FTS5
3. **PDF 支持**
4. **深色模式**
5. **多语言 (i18n)**
6. **MCP 接入**
7. **云同步**
