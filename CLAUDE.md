# 拾贝 (Shibei) — 项目约束

## 项目概述

个人只读资料库桌面应用，用于收集网页快照并进行标注。
- 设计文档：`docs/superpowers/specs/2026-03-31-shibei-mvp-design.md`
- 实现计划：`docs/superpowers/specs/2026-03-31-shibei-mvp-plan.md`

## 技术栈

- **桌面框架**：Tauri 2.x（Rust 后端）
- **前端**：React + TypeScript（Vite 构建）
- **数据库**：SQLite（rusqlite）
- **浏览器插件**：Chrome Extension Manifest V3
- **不要引入**：Electron、Next.js、任何 ORM 框架、任何 CSS-in-JS 方案

## 目录结构

```
src-tauri/          # Rust 后端（Tauri core）
  src/
    commands/       # Tauri command handlers
    db/             # 数据库操作（migration、CRUD）
    server/         # 本地 HTTP server（插件通信）
    storage/        # 文件系统存储逻辑
src/                # React 前端
  components/       # UI 组件
  hooks/            # 自定义 hooks
  stores/           # 状态管理
  types/            # TypeScript 类型定义
  lib/              # 工具函数
extension/          # Chrome 浏览器插件
  src/
    background/     # Service Worker
    content/        # Content Script（选区等）
    popup/          # 插件弹窗 UI
docs/               # 设计文档与规范
```

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
- 使用 IIFE 或 module 隔离插件代码

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
- Rust 后端核心逻辑需要写单元测试（db 操作、存储逻辑）
- 前端组件暂不要求测试覆盖（MVP 阶段）
- 插件功能需手动验证

## 架构约束

- **前后端通信**：只通过 Tauri Commands（`invoke`）和 Tauri Events
- **插件通信**：只通过本地 HTTP Server，不使用 Native Messaging
- **数据存储**：元信息在 SQLite，原始文件在文件系统，两者通过 resource_id 关联
- **标注数据**：独立于原始资料存储，不修改 MHTML 文件
- **Webview 注入**：标注脚本通过 Tauri Webview API 注入，不打包进 MHTML

## 依赖管理

- 新增 Rust crate 前先说明理由，优先使用标准库
- 新增 npm 包前先说明理由，避免引入大型框架（如 Material UI、Ant Design）
- 优先选择轻量、维护活跃的库
