# AI 设置页 — MCP 自动配置

## 背景

拾贝 v1.7 实现了 MCP Server，但配置到 AI 工具（Claude Desktop、Cursor 等）需要用户手动编辑 JSON 文件，容易出错。本功能让程序自动完成配置文件的读写，降低使用门槛。

## 功能概述

设置页新增「AI」分区（与外观/同步/加密/安全/数据同级），提供一键将 Shibei MCP Server 配置写入 AI 工具的配置文件。支持预设工具 + 自定义文件路径。

## 预设工具与配置路径

所有工具使用相同的 JSON 结构（MCP 协议标准）：

```json
{
  "mcpServers": {
    "shibei": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/dist/index.js"]
    }
  }
}
```

### 预设工具列表

| 工具 | macOS 路径 | Windows 路径 |
|------|-----------|-------------|
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | `%APPDATA%/Claude/claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` | `%USERPROFILE%/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `%USERPROFILE%/.codeium/windsurf/mcp_config.json` |

另提供「自定义」选项，用户可通过文件对话框选择任意 JSON 文件。

### 不支持的工具

- **Claude Code**：配置在 `~/.claude.json`，但 Claude Code 用户完全有能力手动配置，且该文件包含大量其他配置，自动写入风险高。不做预设，用户可通过自定义路径自行配置。

## 交互流程

### 预设工具（两步确认）

1. AI 设置页列出预设工具，每个工具显示当前状态
2. 用户点击「配置」→ 程序读取目标配置文件 → 弹窗显示 diff 预览（即将添加的 `shibei` 条目）
3. 用户点击「确认」→ 写入文件 → toast 成功

### 自定义工具（三步）

1. 用户点击「添加自定义」→ `@tauri-apps/plugin-dialog` 的 `open()` 文件选择对话框（过滤 `*.json`）
2. 程序读取选中文件 → 弹窗显示 diff 预览
3. 确认写入 → 路径 + 名称存入 `localStorage`（key: `shibei-mcp-custom-tools`，JSON 数组 `[{ name: string, path: string }]`）

### 状态检测

每次打开 AI 设置页时，对所有工具（预设 + 自定义）读取配置文件并检测状态：

| 状态 | 含义 | UI 表现 |
|------|------|---------|
| 已配置 | 配置文件中存在 `mcpServers.shibei` | 绿色勾 + 「移除」按钮 |
| 未配置 | 配置文件存在但无 `shibei` 条目 | 「配置」按钮 |
| 未安装 | 配置文件不存在 | 灰色提示「未检测到」，按钮禁用 |

自定义工具额外显示「删除」按钮（从 localStorage 移除记录，不修改配置文件）。

### 移除配置

已配置的工具显示「移除」按钮：
1. 点击「移除」→ 弹窗确认
2. 从配置文件中删除 `mcpServers.shibei` 条目 → 写回文件 → toast 成功

## Diff 预览

弹窗中显示将要写入的内容，让用户确认：

- **新增场景**：显示将要添加的 `shibei` 条目（绿色高亮）
- **更新场景**（已存在旧的 `shibei` 条目）：显示旧 → 新的变化
- **文件不存在但目录存在**：提示将创建新文件，显示完整内容

使用简单的文本 diff 展示（JSON 格式化后逐行对比），不需要引入 diff 库，手动构建即可（新增行绿色、删除行红色）。

## MCP 路径推算

写入配置的关键是 `mcp/dist/index.js` 的绝对路径。这个路径取决于拾贝的安装/开发位置：

- **开发模式**：项目目录下 `mcp/dist/index.js`
- **打包后**：随应用资源打包，路径由 Tauri `resource_dir` 决定

后端新增 Tauri command `cmd_get_mcp_entry_path` 返回 `mcp/dist/index.js` 的绝对路径。开发模式下使用 `env!("CARGO_MANIFEST_DIR")` 推算项目根目录；打包模式下使用 Tauri 的 `path::resource_dir`。

## 实现分层

### 后端（Rust）

新增 3 个 Tauri commands：

| 命令 | 功能 |
|------|------|
| `cmd_get_mcp_entry_path` | 返回 `mcp/dist/index.js` 绝对路径 |
| `cmd_read_external_file` | 读取应用沙箱外的文件（返回字符串内容），用于读取 AI 工具配置文件 |
| `cmd_write_external_file` | 写入应用沙箱外的文件（接收路径 + 内容），用于写入 AI 工具配置文件 |

`cmd_read_external_file` 和 `cmd_write_external_file` 是通用的文件读写命令，路径由前端传入。需要在 Tauri 权限配置中允许文件系统访问（`fs` scope）。

### 前端（React）

| 文件 | 职责 |
|------|------|
| `src/components/Settings/AIPage.tsx` | AI 设置页主组件 |
| `src/components/Settings/AIPage.module.css` | 样式 |
| `src/locales/zh/settings.json` | 新增 AI 相关中文文案 |
| `src/locales/en/settings.json` | 新增 AI 相关英文文案 |

AIPage 内部逻辑：
1. 组件挂载时，调用 `cmd_get_mcp_entry_path` 获取 MCP 路径
2. 对每个预设工具，计算配置文件路径（按当前 OS），调用 `cmd_read_external_file` 检测状态
3. 从 localStorage 读取自定义工具列表，同样检测状态
4. 配置/移除操作：读取 → JSON.parse → 修改 `mcpServers` → JSON.stringify(null, 2) → `cmd_write_external_file`

### JSON 操作规则

- **读取**：`JSON.parse` 解析，失败则提示格式错误
- **写入**：`JSON.stringify(data, null, 2)` 保持可读格式
- **合并**：只操作 `mcpServers.shibei` 字段，不动其他配置
- **空文件/不存在**：目录存在时创建 `{ "mcpServers": { "shibei": { ... } } }`

### 设置页导航更新

`SettingsView.tsx` 侧栏导航新增「AI」项，插入位置在「数据」之后（或之前，视觉上合理即可）。

## i18n

新增命名空间 `ai`（`src/locales/zh/ai.json` + `src/locales/en/ai.json`），或复用 `settings` 命名空间加 `ai.` 前缀。

关键文案：
- 页面标题：「AI 工具集成」/「AI Tool Integration」
- 描述：「自动配置 MCP Server 到 AI 助手」/「Auto-configure MCP Server for AI assistants」
- 按钮：配置 / 移除 / 添加自定义 / 确认 / 取消
- 状态：已配置 / 未配置 / 未检测到
- Diff 预览弹窗标题/说明

## 错误处理

| 场景 | 处理 |
|------|------|
| 配置文件不存在 | 预设工具显示「未检测到」；自定义工具提示文件不存在 |
| JSON 解析失败 | toast 提示文件格式错误，建议手动检查 |
| 写入失败（权限） | toast 错误信息 |
| MCP 路径不存在 | 提示 MCP Server 未构建（`npm run build`） |

## 不在范围

- MCP Server 运行状态监控（需要进程管理，复杂度高）
- MCP 工具的权限配置（`alwaysAllow` 等字段）
- Linux 平台支持
- 项目级配置（Cursor 的 `.cursor/mcp.json`、Claude Code 的 `.mcp.json`）——只处理全局配置
