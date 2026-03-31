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
- 设置 SQLite 集成（rusqlite），创建数据库初始化和 migration 机制
- 创建所有表结构（folders, resources, tags, resource_tags, highlights, comments）
- 设置本地文件存储目录结构（`~/.shibei/`）

### Phase 2: Rust 后端核心
- 实现文件夹 CRUD（创建、重命名、删除、移动、排序）
- 实现资料存储：接收 MHTML 数据，保存到文件系统，写入 SQLite 元信息
- 实现标签 CRUD
- 实现资料-标签关联管理
- 实现高亮 CRUD（含 anchor 序列化/反序列化）
- 实现评论 CRUD（支持一个高亮多条评论）
- 将以上功能暴露为 Tauri Commands

### Phase 3: 本地 HTTP Server（插件通信）
- 在 Tauri 应用中启动本地 HTTP Server（端口 21519）
- 实现 `POST /api/save` — 接收插件发送的网页快照数据
- 实现 `GET /api/folders` — 返回文件夹树
- 实现 `GET /api/tags` — 返回标签列表
- 实现 `GET /api/ping` — 健康检查
- 处理 HTML fragment → MHTML 的转换（区域选择场景）

### Phase 4: React 前端 — 资料库管理
- 三栏布局框架（左侧边栏 + 中间阅读区 + 右侧标注面板）
- 左侧边栏：文件夹树组件（可折叠、拖拽排序）
- 左侧边栏：标签筛选组件
- 左侧边栏：资料列表组件（当前文件夹下的资料）
- 资料元信息显示（标题、URL、保存时间、标签）

### Phase 5: React 前端 — 阅读器与标注
- Webview 阅读器：加载并渲染 MHTML 快照
- 标注脚本注入：在 Webview 中注入 JS 实现高亮功能
- 高亮创建：选中文字 → 浮动工具条 → 选择颜色 / 添加评论
- 高亮恢复：打开资料时从 SQLite 加载已有标注并渲染
- 右侧标注面板：高亮列表 + 评论串展示
- 双向联动：点击高亮 ↔ 侧边栏滚动定位

### Phase 6: Chrome 浏览器插件
- Manifest V3 插件基础结构
- 整页保存：使用 `pageCapture.saveAsMHTML()` API
- 区域选择模式：Content Script 实现 DOM 元素选择器（悬停高亮 + 点击确认）
- 元信息提取：从 meta/og 标签提取 title、author、description
- 保存面板 UI：文件夹选择 + 标签选择 + 保存按钮
- 与 Tauri 本地 HTTP Server 通信

### Phase 7: 集成测试与打磨
- 端到端流程验证（参见设计文档验证方案）
- 错误处理和边界情况
- UI 细节打磨

## 建议执行顺序

Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6 → Phase 7

每个 Phase 完成后验证再继续下一个。Phase 4 和 Phase 6 可以部分并行（前端资料管理和插件开发相对独立）。
