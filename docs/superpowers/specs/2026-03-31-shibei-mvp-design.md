# 拾贝 (Shibei) — MVP 设计文档

## 概述

拾贝是一个个人只读资料库桌面应用，用于收集、存储、阅读和标注外部资料。MVP 聚焦网页快照场景：通过浏览器插件一键保存网页（支持区域选择），在桌面应用中以原始排版阅读，并对内容进行高亮标注和评论。

### 核心理念

- **只读资料库**：资料导入后不编辑原始内容，保持快照的真实性
- **轻量 Zotero**：借鉴 Zotero 的收集体验，但去掉引用管理等复杂功能
- **Joplin 式组织**：文件夹层级为主 + 标签辅助筛选

### MVP 范围

| 包含 | 不包含（后续扩展） |
|------|-------------------|
| 网页快照保存与浏览 | PDF 及其他格式支持 |
| 浏览器插件（Chrome） | MCP / AI 分析 |
| 文件夹 + 标签组织 | 云同步 |
| 高亮标注 + 评论 | 全文搜索 |
| 纯本地存储 | 多设备同步 |

---

## 技术栈

| 层 | 技术选型 | 说明 |
|----|---------|------|
| 桌面框架 | Tauri 2.x | Rust 后端，轻量打包 |
| 前端 | React + TypeScript | Vite 构建 |
| 数据库 | SQLite (via rusqlite) | 元信息 + 标注存储 |
| 文件存储 | 本地文件系统 | MHTML 快照文件 |
| 浏览器插件 | Chrome Extension (Manifest V3) | 网页抓取 + 区域选择 |
| 插件通信 | 本地 HTTP Server | Tauri 内嵌，插件通过 HTTP POST 发送数据 |

---

## 系统架构

```
┌─────────────────────────────────────────────────┐
│                 Tauri 桌面应用                     │
│  ┌───────────────────────────────────────────┐  │
│  │           React + TypeScript 前端           │  │
│  │  ┌─────────┐ ┌──────────┐ ┌───────────┐  │  │
│  │  │ 资料库   │ │ 阅读器    │ │ 标注管理   │  │  │
│  │  │ 管理面板 │ │ (Webview) │ │ (侧边栏)  │  │  │
│  │  └─────────┘ └──────────┘ └───────────┘  │  │
│  └───────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────┐  │
│  │           Rust 后端 (Tauri Core)            │  │
│  │  ┌──────────┐ ┌─────────┐ ┌───────────┐  │  │
│  │  │ 资料存储  │ │ 元信息   │ │ 标注引擎   │  │  │
│  │  │ (文件系统)│ │ (SQLite) │ │ (SQLite)  │  │  │
│  │  └──────────┘ └─────────┘ └───────────┘  │  │
│  │  ┌──────────────────────────────────────┐ │  │
│  │  │  本地 HTTP Server (插件通信)           │ │  │
│  │  └──────────────────────────────────────┘ │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘

┌─────────────────────┐
│   浏览器插件 (Chrome) │
│  ┌─────────────────┐ │
│  │ 页面选区捕获     │ │
│  │ MHTML 生成       │ │
│  │ 元信息提取       │ │
│  │ → 发送到本地服务  │ │
│  └─────────────────┘ │
└─────────────────────┘
```

### 数据流

1. **导入**：浏览器插件 → HTTP POST → Tauri 本地服务 → 存储 MHTML + 写入 SQLite 元信息
2. **阅读**：用户选择资料 → Webview 加载 MHTML → 注入标注脚本 → 恢复已有高亮
3. **标注**：用户选中文字 → JS 生成锚点 → Tauri IPC → Rust 写入 SQLite → 前端更新侧边栏

---

## 数据模型

### 本地文件系统结构

```
~/.shibei/
├── config.toml              # 应用配置
├── shibei.db                # SQLite 数据库
└── storage/
    └── {resource_id}/       # 每份资料一个目录
        ├── snapshot.mhtml   # 原始网页快照
        └── meta.json        # 元信息备份（冗余，方便迁移）
```

### Migration 策略

使用 SQLite `user_version` pragma 管理数据库版本：
- SQL migration 文件按版本编号存放在 `src-tauri/migrations/`（如 `001_init.sql`、`002_add_selector.sql`）
- 应用启动时读取 `PRAGMA user_version`，与最新 migration 版本比对，依次执行未应用的 migration
- 每次 migration 在事务中执行，失败则回滚，不会产生半更新状态
- 不引入外部 migration 框架，用 rusqlite 手写即可满足需求

### SQLite 表结构

#### folders（文件夹）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT (UUID) | 主键 |
| name | TEXT | 文件夹名称 |
| parent_id | TEXT | 父文件夹 ID，NULL 为根 |
| sort_order | INTEGER | 排序权重 |
| created_at | TEXT (ISO 8601) | 创建时间 |
| updated_at | TEXT (ISO 8601) | 更新时间 |

#### resources（资料）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT (UUID) | 主键 |
| title | TEXT | 标题 |
| url | TEXT | 原始 URL |
| domain | TEXT | 来源域名 |
| author | TEXT | 作者（可为空） |
| description | TEXT | 摘要/描述 |
| folder_id | TEXT | 所属文件夹（外键） |
| resource_type | TEXT | 类型：webpage |
| file_path | TEXT | MHTML 文件相对路径 |
| created_at | TEXT (ISO 8601) | 保存到拾贝的时间 |
| captured_at | TEXT (ISO 8601) | 原始页面抓取时间 |

#### tags（标签）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT (UUID) | 主键 |
| name | TEXT | 标签名（UNIQUE） |
| color | TEXT | 标签颜色，如 #FF5733 |

#### resource_tags（资料-标签关联）

| 字段 | 类型 | 说明 |
|------|------|------|
| resource_id | TEXT | 资料 ID（外键） |
| tag_id | TEXT | 标签 ID（外键） |
| PRIMARY KEY | | (resource_id, tag_id) |

#### highlights（高亮标注）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT (UUID) | 主键 |
| resource_id | TEXT | 所属资料（外键） |
| text_content | TEXT | 高亮的文字内容 |
| anchor | TEXT (JSON) | 文本锚点定位信息（见下文） |
| color | TEXT | 高亮颜色 |
| created_at | TEXT (ISO 8601) | 创建时间 |

#### comments（评论）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT (UUID) | 主键 |
| highlight_id | TEXT | 关联的高亮（外键，可为空） |
| resource_id | TEXT | 所属资料（外键） |
| content | TEXT | 评论内容（支持 Markdown） |
| created_at | TEXT (ISO 8601) | 创建时间 |
| updated_at | TEXT (ISO 8601) | 更新时间 |

一个高亮可以有多条评论（一对多），支持随时追加想法。highlight_id 为空时表示资料级别的笔记。

### 文本锚点格式（anchor）

采用 W3C Web Annotation Data Model 规范，组合两种选择器确保定位稳定：

```json
{
  "textPosition": {
    "start": 1024,
    "end": 1089
  },
  "textQuote": {
    "exact": "高亮的文字内容",
    "prefix": "前面的上下文文字",
    "suffix": "后面的上下文文字"
  }
}
```

- `textPosition`：基于纯文本偏移量的精确定位
- `textQuote`：基于文本内容的模糊匹配，作为 fallback

---

## 浏览器插件设计

### 功能

1. **一键保存整页** — 利用 Chrome `pageCapture.saveAsMHTML()` API 生成 MHTML
2. **区域选择保存** — Content Script 实现 DOM 元素选择器
3. **元信息自动提取** — 从页面 meta 标签、Open Graph 等提取 title/author/description
4. **保存面板** — 弹窗选择目标文件夹、添加标签

### 区域选择交互

```
用户点击插件图标 → 选择"选区保存"
  → 页面叠加半透明遮罩
  → 鼠标移动时高亮当前 DOM 元素（蓝色边框 + 淡蓝背景）
  → 点击确认选中区域
  → 弹出侧边面板：显示选区预览 + 文件夹/标签选择
  → 点击"保存到拾贝"
  → 发送到 Tauri 本地服务
```

### 插件 → Tauri 通信协议

Tauri 应用启动时监听本地 HTTP 端口（默认 `localhost:21519`）。

**POST /api/save**

```json
{
  "title": "页面标题",
  "url": "https://example.com/article",
  "domain": "example.com",
  "author": "作者名",
  "description": "页面描述或摘要",
  "content": "<base64 编码的 MHTML 或 HTML 片段>",
  "content_type": "mhtml | html_fragment",
  "folder_id": "uuid-of-target-folder",
  "tags": ["tag1", "tag2"],
  "captured_at": "2026-03-31T10:00:00Z"
}
```

- 整页保存：`content_type = "mhtml"`，content 为 MHTML base64
- 区域选择：`content_type = "html_fragment"`，Tauri 后端负责下载内联图片并打包为 MHTML

**GET /api/folders**

返回文件夹树，供插件弹窗展示文件夹选择。

**GET /api/tags**

返回标签列表，供插件弹窗展示标签选择。

**GET /api/ping**

健康检查，插件用于检测 Tauri 应用是否运行。

---

## 桌面应用 UI

### 主界面布局（三栏）

```
┌──────────┬────────────────────────┬──────────────┐
│          │                        │              │
│  侧边栏   │      阅读区域            │   标注面板    │
│          │                        │              │
│ ┌──────┐ │  ┌──────────────────┐  │ ┌──────────┐ │
│ │文件夹树│ │  │                  │  │ │ 高亮列表  │ │
│ │      │ │  │   Webview 渲染    │  │ │          │ │
│ │ 📁 技术│ │  │   MHTML 内容     │  │ │ [高亮1]  │ │
│ │ 📁 研究│ │  │                  │  │ │  ├ 评论1  │ │
│ │ 📁 ...│ │  │  (选中文字可高亮)  │  │ │  ├ 评论2  │ │
│ │      │ │  │                  │  │ │  └ +追加   │ │
│ ├──────┤ │  │                  │  │ │ [高亮2]  │ │
│ │标签筛选│ │  │                  │  │ │  └ 评论... │ │
│ │ 🏷️ ... │ │  │                  │  │ │          │ │
│ └──────┘ │  │                  │  │ │          │ │
│          │  └──────────────────┘  │ └──────────┘ │
│ ┌──────┐ │                        │              │
│ │资料列表│ │  ┌──────────────────┐  │              │
│ │      │ │  │ 标题 | URL | 时间 │  │              │
│ └──────┘ │  └──────────────────┘  │              │
└──────────┴────────────────────────┴──────────────┘
```

- **左侧边栏**：上方文件夹树（可折叠、拖拽排序），中间标签筛选区，下方当前文件夹的资料列表
- **中间阅读区**：Webview 渲染 MHTML，顶部元信息栏（标题、原始 URL 链接、保存时间、标签）
- **右侧标注面板**：当前资料的高亮列表，每个高亮下展示关联评论串，可折叠/展开

### 标注交互

1. **创建高亮**：Webview 中选中文字 → 弹出浮动工具条 → 选择颜色 / 添加评论
2. **查看高亮**：点击 Webview 中的高亮 → 右侧面板滚动定位到对应条目
3. **反向定位**：点击右侧面板的高亮条目 → Webview 滚动到对应位置并闪烁高亮
4. **追加评论**：在任意高亮条目下点击"追加"按钮添加新评论
5. **删除**：高亮和评论支持删除操作

### 标注技术实现

#### MHTML 加载与脚本注入

MHTML 通过 Tauri 自定义协议加载（如 `shibei://resource/{id}`），Rust 端读取文件并返回内容。不使用 `file://` 协议，避免系统级安全限制。

标注脚本通过 Tauri 特权 API 注入，不受同源策略约束：
- **`WebviewBuilder::with_initialization_script()`**：页面加载前注册脚本，保证 MHTML 渲染时脚本已就绪
- **`webview.eval()`**：运行时动态注入（如加载已有高亮数据后恢复渲染）

#### 高亮渲染与样式隔离

使用自定义元素 `<shibei-hl>` 代替 `<mark>`，避免原始网页 CSS 冲突：
- 原始网页几乎不可能有针对 `<shibei-hl>` 的样式规则，天然隔离
- 注入样式使用高特异性属性选择器 + `!important` 兜底：`shibei-hl[data-hl-id] { background: var(--shibei-hl-color) !important; }`
- 若遇到极端冲突，可将 `<shibei-hl>` 注册为 Web Component 并用 Shadow DOM 做完全样式隔离

#### 标注流程

1. **初始化**：从 SQLite 读取该资料的所有高亮，JS 脚本根据 anchor 信息在 DOM 中恢复高亮渲染（用 `<shibei-hl>` 自定义元素包裹）
2. **创建高亮**：监听 `mouseup` 事件，通过 `window.getSelection()` 获取选区，计算 TextPositionSelector + TextQuoteSelector
3. **通信**：通过 Tauri IPC（`window.__TAURI__.invoke()`）将标注数据发回 Rust 后端存入 SQLite
4. **同步**：前端 React 通过 Tauri event 监听标注变更，实时更新侧边栏

---

## 未来扩展预留

以下功能不在 MVP 范围，但架构设计上预留接口：

- **PDF 支持**：resource_type 字段已预留，阅读器可按类型切换 PDF.js 渲染
- **全文搜索**：SQLite FTS5 扩展，后续添加 resources_fts 虚拟表
- **MCP 接入**：Tauri 后端可暴露 MCP Server，让 AI 访问资料库内容和标注
- **云同步**：存储层抽象接口，后续可接入 S3/WebDAV
- **更多导入源**：HTTP Server API 设计通用，未来其他客户端（移动端、CLI）可复用
- **多语言 (i18n)**：UI 文案抽取为语言包，支持中英文切换；MVP 阶段先用中文硬编码，但组件设计上避免文案与逻辑耦合，便于后续抽取
- **深色模式 (Dark Mode)**：使用 CSS 变量定义颜色体系（`--color-bg-primary`、`--color-text-primary` 等），MVP 阶段只实现浅色主题，后续通过新增变量集切换深色主题；标注高亮颜色需同时定义浅色/深色两套色值

---

## 验证方案

### 端到端验证流程

1. **启动 Tauri 应用** → 确认主界面三栏布局正常显示
2. **创建文件夹** → 在左侧边栏创建文件夹层级结构
3. **安装浏览器插件** → 确认插件图标出现在工具栏
4. **保存网页快照** → 在浏览器中打开一个网页 → 点击插件 → 整页保存 → 确认资料出现在 Tauri 应用中
5. **区域选择保存** → 点击插件 → 进入选区模式 → 选择 DOM 区域 → 保存 → 确认只保存了选中区域
6. **阅读快照** → 在 Tauri 中打开已保存资料 → 确认 MHTML 渲染正确（含图片和样式）
7. **创建高亮** → 在阅读器中选中文字 → 创建高亮 → 确认高亮显示 + 侧边栏更新
8. **添加评论** → 对高亮添加评论 → 追加第二条评论 → 确认评论串正确显示
9. **重新打开** → 关闭并重新打开资料 → 确认高亮和评论正确恢复
10. **文件夹和标签** → 给资料添加标签 → 通过标签筛选 → 确认筛选结果正确
