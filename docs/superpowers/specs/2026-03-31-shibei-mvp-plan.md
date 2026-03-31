# 拾贝 (Shibei) MVP 实现计划

## Context

拾贝是一个个人只读资料库桌面应用，用于收集网页快照并进行标注。设计文档：`docs/superpowers/specs/2026-03-31-shibei-mvp-design.md`

技术栈：Tauri 2.x + React + TypeScript + SQLite + Chrome Extension (Manifest V3) + SingleFile

## MVP 完成状态

所有 Phase 已完成。以下为实际实现记录。

### Phase 1: 项目脚手架与基础设施 ✅ (6ae9c49)
- Tauri 2.x + React + TypeScript + Vite 项目初始化
- SQLite 集成（rusqlite），migration 引擎（PRAGMA user_version）
- 初始 migration：6 表 + 8 索引 + 虚拟根节点 `__root__`
- 本地存储目录：`~/Library/Application Support/shibei/`
- 测试框架：Rust cargo test + tempfile 隔离，Vitest + Testing Library
- 技术 Spike：验证 WKWebView 不能直接渲染 MHTML → 改为解析后分别提供

### Phase 2: Rust 后端核心 ✅ (df5f983)
- 5 个 CRUD 模块：folders（含循环检测）、resources（含 URL 归一化查重）、tags（含关联管理）、highlights（含 anchor JSON 序列化）、comments（支持高亮级和资料级笔记）
- 53 单元测试全部通过

### Phase 3: 插件技术调研 ✅ (ed93f39)
- 调研文档：`docs/superpowers/specs/2026-03-31-phase3-clipping-research.md`
- **关键结论**：采用 SingleFile 替代 pageCapture.saveAsMHTML()
  - 原因：WKWebView 不支持 MHTML，SingleFile 输出标准 HTML 可直接渲染
  - Zotero 验证了同样的方案
  - SingleFile 支持未来的区域选择功能
  - 许可证：AGPL-3.0（项目同样采用 AGPL-3.0）

### Phase 4: 本地 HTTP Server ✅ (eea6008)
- axum 框架，监听 127.0.0.1:21519
- 4 个端点：ping、folders（树形）、tags、save
- CORS 支持，100MB body limit
- 保存后通过 Tauri event 通知桌面端自动刷新

### Phase 5: React 前端 ✅ (eea6008)
- **Tab-based 布局**（非原设计的三栏内嵌）：资料库 Tab + 阅读器 Tab（全宽）
  - 变更原因：MHTML/HTML 保真渲染需要完整宽度，挤在面板中会变形
- 资料库 Tab：文件夹树 | 资料列表 | 欢迎页（三栏）
- 阅读器 Tab：元信息栏 + iframe 全宽渲染 + 标注面板
- 20 个 Tauri Commands 暴露全部 CRUD
- CSS 变量体系（为 Dark Mode 预留）

### Phase 6: 标注系统 ✅ (ed93f39)
- annotator.js 注入脚本：选区检测、W3C 锚点计算、`<shibei-hl>` 自定义元素渲染
- 脚本注入方式：直接嵌入 HTML `<head>`（比 initialization_script 更可靠）
- 通信：iframe ↔ React 用 postMessage，持久化用 Tauri invoke
- SelectionToolbar（5 色浮动工具条）
- AnnotationPanel（高亮列表 + 评论展开/折叠 + 添加/删除）
- 双向联动：面板 ↔ iframe 滚动定位 + 闪烁动画
- 高亮恢复：从 DB 加载后通过 postMessage 渲染
- 外链拦截：iframe 内点链接不导航，在外部浏览器打开

### Phase 7: Chrome 浏览器插件 ✅ (292f7ce)
- Manifest V3 + SingleFile 核心库打包（~1.2MB）
- Popup 面板：检测桌面端连接 → 页面信息 → 文件夹/标签选择 → 一键保存
- 元信息自动提取（title/author/description/domain）
- 存储格式：SingleFile HTML（内联所有资源），文件名 snapshot.html
- AGPL-3.0 LICENSE

### Phase 8: 收尾打磨 ✅ (76aa401)
- 删除 MHTML 支持（mhtml.rs）和 seed 数据
- 插件保存后桌面端自动刷新（Tauri events）
- 插件错误处理：系统页面检测、CSP 限制提示
- 文件夹/资料删除确认对话框
- 业务错误提示（重复文件夹名等）
- Loading 状态
- 49 Rust tests + 1 frontend test

## 与原设计的偏差

| 原设计 | 实际实现 | 原因 |
|--------|---------|------|
| MHTML (pageCapture) | SingleFile HTML | WKWebView 不支持 MHTML 直接渲染，SingleFile 更好 |
| 三栏内嵌阅读区 | Tab-based 全宽阅读器 | 网页保真渲染需要完整宽度 |
| 资料列表在侧边栏 | 资料列表独立成列 | 参考 Zotero/Joplin，空间更充裕 |
| initialization_script 注入 | HTML head 直接嵌入 | iframe 跨平台行为不一致 |
| Bearer token 鉴权 | MVP 暂不校验 | 只监听 127.0.0.1，安全风险低 |

## v1.1+ 路线图

1. **区域选择保存**：SingleFile 处理 DOM 子树 + 选区标记
2. **全文搜索**：SQLite FTS5
3. **PDF 支持**
4. **深色模式**（CSS 变量已预留）
5. **多语言 i18n**
6. **MCP 接入**
7. **云同步**
8. **Token 鉴权**（Phase 8 遗留）
