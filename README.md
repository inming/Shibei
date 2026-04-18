<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" alt="Shibei" width="128" />
</p>

<h1 align="center">拾贝 · Shibei</h1>

<p align="center">
  <strong>一个只读的个人资料库 —— 收藏网页与 PDF，做高亮与 Markdown 标注，本地优先，端到端加密同步，AI 原生。</strong>
</p>

<p align="center">
  <strong>中文</strong> · <a href="README.en.md">English</a> ·
  <a href="LICENSE">AGPL-3.0</a>
</p>

---

## 是什么

拾贝是一个**只读的个人资料库**桌面应用，**从设计之初就把 AI 当作一等公民**。它帮你把网上看到的长文、技术文档、PDF 保存到本地，以原始排版阅读，在上面做高亮 + Markdown 评论 + 笔记；然后**通过内置的 MCP Server 把你攒下的资料、标注、笔记直接喂给 Claude / Cursor / Windsurf / OpenCode 等 AI 工具**——像 Zotero 但去掉了引用管理的复杂；像 Joplin 但原始快照不可编辑，保证内容真实性；而且**从一开始就不是一个只给人读的孤岛**。

### 设计原则

- **AI-native**：资料库不是死档案，而是你 AI 工作流的长期记忆。MCP Server 是内置能力而非事后补丁：9 个工具覆盖搜索 / 读取 / 标注 / 组织；纯文本在保存时提取，结构化元信息（标签、文件夹、高亮锚点）天然对 AI 友好；设置页一键配置进主流 AI 客户端
- **只读**：资料导入后不修改原文，标注与原文解耦——AI 读到的永远是原始快照，不会被二次改写污染
- **本地优先**：所有数据存在本地 SQLite + 文件系统，云同步是可选项；AI 调用走本地 stdio，敏感资料不出机器
- **原始排版**：网页用 SingleFile 内联所有资源保存为单个 HTML，离线也能读出原貌
- **标注与资料分离**：高亮/评论独立存储，重新抓取或同步不会丢失标注，也不会污染喂给 AI 的原文

## 功能

**抓取与导入**
- Chrome 插件一键保存当前网页（整页）
- 选区保存：鼠标悬停 → 点击选中 DOM 子树 → 裁剪保留祖先链样式
- 本地导入 PDF（右键"导入文件"）
- 所有快照以 SingleFile HTML 格式本地存储，后缀资源全部内联

**阅读**
- 自定义协议 `shibei://resource/{id}` 用 WebView 还原原始排版
- PDF 用 pdfjs-dist 渲染（canvas + 文本层 + 文本选择）
- 顶栏沉浸模式（向下滚动隐藏 meta）+ 顶部进度条
- 阅读器与标注面板可拖拽分栏，窄条折叠

**标注**
- 文本高亮（8 色 × 明/暗两套）
- 高亮评论：Markdown 渲染（react-markdown + remark-gfm）
- 资料级笔记：同样 Markdown
- 所有标注可深链跳转：`shibei://open/resource/{id}?highlight={hlId}`

**组织与检索**
- 文件夹层级（拖拽、多选、收件箱为系统预设）
- 标签（多色、多选 OR 过滤）
- 全文搜索：FTS5 trigram，覆盖标题 / URL / 描述 / 高亮 / 评论 / 快照正文，匹配字段标签 + snippet 高亮

**同步与安全**
- S3 兼容云同步（HLC 时钟 + LWW 冲突解决）
- 端到端加密：XChaCha20-Poly1305，Argon2id 派生密码，主密钥运行时 `Zeroizing` 保护
- 应用锁屏（密码解锁，暂存 deep link 解锁后打开）
- 本地备份与恢复（zip：`manifest.json` + 数据库 + 快照）

**AI 集成**
- 内置 MCP Server（9 个工具：`search_resources` / `get_resource` / `get_annotations` / `get_resource_content` / `list_folders` / `list_tags` / `update_resource` / `manage_tags` / `manage_notes`）
- 设置页一键配置到 Claude Desktop / Cursor / Windsurf / OpenCode，配置写入前有 diff 预览

**体验细节**
- 深色模式（`light` / `dark` / `system` 三档，CSS 变量切换）
- 中英双语（i18next，11 个命名空间）
- 会话持久化：重启恢复 Tab 列表、滚动位置、资料库选中
- 右键菜单边界防溢出：`useFlipPosition` / `useSubmenuPosition` hook + ResizeObserver 兜住 async 内容
- 单实例 + deep link 转发

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面框架 | Tauri 2.x（Rust 后端） |
| 前端 | React 19 + TypeScript + Vite |
| 数据库 | SQLite（rusqlite bundled，FTS5 trigram，r2d2 连接池） |
| 本地 HTTP | axum（127.0.0.1:21519，仅供插件） |
| 浏览器插件 | Chrome Extension Manifest V3 + SingleFile |
| PDF 渲染 | pdfjs-dist 5.x |
| PDF 文本提取 | `pdf-extract` crate（带 `catch_unwind` 兜底） |
| 云存储 | `rust-s3`，自定义 endpoint 支持 |
| 加密 | `chacha20poly1305` + `argon2` + `hkdf` + `zeroize` |
| MCP | `@modelcontextprotocol/sdk`（Node.js stdio） |
| i18n | i18next + react-i18next |
| Markdown | react-markdown + remark-gfm |

## 快速开始

### 前置

- Node.js ≥ 20
- Rust stable（含 `cargo`）
- macOS / Linux / Windows（已在 macOS Sequoia 验证）

### 开发模式

```bash
# 安装依赖
npm install

# 启动 Tauri 开发窗口（自动打包 MCP bundle + annotator）
npm run tauri dev

# 打开 debug 日志（前端 debugLog 将写入 data_dir/debug.log）
VITE_DEBUG=1 npm run tauri dev
```

### 打包发布

```bash
npm run tauri build
# 产物在 src-tauri/target/release/bundle/
```

### 安装浏览器插件

开发期：

1. 打开 Chrome `chrome://extensions/`，启用"开发者模式"
2. 点击"加载已解压的扩展程序"，选择 `extension/` 目录
3. 启动拾贝桌面应用，点击插件图标验证连接

插件通过 `chrome.runtime.sendMessage` → Background Service Worker → `127.0.0.1:21519` 与桌面应用通信（background `chrome-extension://` origin 豁免 Chrome Private Network Access）。

### 运行测试

```bash
# 前端（Vitest）
npx vitest run --dir src

# 后端（Cargo）
cd src-tauri && cargo test

# 类型检查
npx tsc --noEmit
```

## 目录结构

```
src-tauri/          Rust 后端（Tauri core + commands + db + sync + storage）
src/                React 前端（components / hooks / lib / locales）
extension/          Chrome 浏览器插件（MV3 + SingleFile）
mcp/                MCP Server（Node.js，stdio transport）
docs/               设计文档与实现计划（中文）
```

架构细节、数据库迁移、同步冲突解决等见 [CLAUDE.md](CLAUDE.md) 和 [`docs/superpowers/specs/`](docs/superpowers/specs/)。

## 许可证

[AGPL-3.0](LICENSE) © inming。由于使用 [SingleFile](https://github.com/gildas-lormeau/SingleFile)（AGPL-3.0）打包快照，本项目也采用 AGPL-3.0。
