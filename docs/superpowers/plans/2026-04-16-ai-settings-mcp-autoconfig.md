# AI Settings Page — MCP Auto-Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "AI" settings page that auto-configures Shibei MCP Server into AI tools (Claude Desktop, Cursor, Windsurf) with diff preview and status detection.

**Architecture:** Frontend-driven JSON manipulation — Rust backend provides file I/O commands + OS-aware tool path detection + MCP entry path resolution; frontend handles config detection, diffing, merging logic. New `ai` i18n namespace. Settings sidebar gains an "AI" nav item.

**Tech Stack:** React + TypeScript (frontend), Rust/Tauri commands (backend), `@tauri-apps/plugin-dialog` (file picker), localStorage (custom tool persistence)

**Spec:** `docs/superpowers/specs/2026-04-16-ai-settings-mcp-autoconfig-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src-tauri/src/commands/mod.rs` | Modify | Add 4 new Tauri commands |
| `src-tauri/src/lib.rs` | Modify | Register 4 new commands |
| `src/lib/commands.ts` | Modify | Add 4 TypeScript invoke wrappers |
| `src/components/Settings/AIPage.tsx` | Create | AI settings page component |
| `src/components/Settings/AIPage.module.css` | Create | AI page styles |
| `src/components/SettingsView.tsx` | Modify | Add "ai" section to nav |
| `src/locales/zh/ai.json` | Create | Chinese locale |
| `src/locales/en/ai.json` | Create | English locale |
| `src/i18n.ts` | Modify | Register `ai` namespace |
| `src/types/i18next.d.ts` | Modify | Add `ai` type |
| `src/locales/zh/settings.json` | Modify | Add `navAi` key |
| `src/locales/en/settings.json` | Modify | Add `navAi` key |

---

### Task 1: Backend — 4 Tauri commands

**Files:**
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add `cmd_get_mcp_entry_path` command**

Append to the end of `src-tauri/src/commands/mod.rs` (before the file ends):

```rust
// ── AI / MCP ──

#[tauri::command]
pub async fn cmd_get_mcp_entry_path(
    app: tauri::AppHandle,
) -> Result<String, CommandError> {
    use tauri::Manager;
    // In production, mcp/ is bundled as a resource
    let resource_dir = app.path().resource_dir().map_err(|e| CommandError {
        message: format!("error.mcp_path: {e}"),
    })?;
    let bundled = resource_dir.join("mcp").join("dist").join("index.js");
    if bundled.exists() {
        return Ok(bundled.to_string_lossy().to_string());
    }
    // Dev mode: relative to CARGO_MANIFEST_DIR (src-tauri/)
    let dev = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("mcp")
        .join("dist")
        .join("index.js");
    if dev.exists() {
        return Ok(dev.to_string_lossy().to_string());
    }
    Err(CommandError {
        message: "error.mcp_not_built".to_string(),
    })
}
```

- [ ] **Step 2: Add `cmd_read_external_file` command**

Append right after the previous command:

```rust
#[tauri::command]
pub async fn cmd_read_external_file(path: String) -> Result<String, CommandError> {
    std::fs::read_to_string(&path).map_err(|e| CommandError {
        message: format!("error.read_file: {e}"),
    })
}
```

- [ ] **Step 3: Add `cmd_write_external_file` command**

```rust
#[tauri::command]
pub async fn cmd_write_external_file(path: String, content: String) -> Result<(), CommandError> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| CommandError {
            message: format!("error.write_file: {e}"),
        })?;
    }
    std::fs::write(&path, content).map_err(|e| CommandError {
        message: format!("error.write_file: {e}"),
    })
}
```

- [ ] **Step 4: Add `cmd_get_ai_tool_paths` command**

This returns OS-aware preset tool config paths using the `dirs` crate (already a dependency):

```rust
#[derive(Debug, Serialize)]
pub struct AiToolPath {
    pub name: String,
    pub path: String,
}

#[tauri::command]
pub async fn cmd_get_ai_tool_paths() -> Result<Vec<AiToolPath>, CommandError> {
    let mut tools = Vec::new();

    #[cfg(target_os = "macos")]
    {
        if let Some(home) = dirs::home_dir() {
            tools.push(AiToolPath {
                name: "Claude Desktop".to_string(),
                path: home
                    .join("Library/Application Support/Claude/claude_desktop_config.json")
                    .to_string_lossy()
                    .to_string(),
            });
            tools.push(AiToolPath {
                name: "Cursor".to_string(),
                path: home.join(".cursor/mcp.json").to_string_lossy().to_string(),
            });
            tools.push(AiToolPath {
                name: "Windsurf".to_string(),
                path: home
                    .join(".codeium/windsurf/mcp_config.json")
                    .to_string_lossy()
                    .to_string(),
            });
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(appdata) = dirs::config_dir() {
            tools.push(AiToolPath {
                name: "Claude Desktop".to_string(),
                path: appdata
                    .join("Claude\\claude_desktop_config.json")
                    .to_string_lossy()
                    .to_string(),
            });
        }
        if let Some(home) = dirs::home_dir() {
            tools.push(AiToolPath {
                name: "Cursor".to_string(),
                path: home.join(".cursor\\mcp.json").to_string_lossy().to_string(),
            });
            tools.push(AiToolPath {
                name: "Windsurf".to_string(),
                path: home
                    .join(".codeium\\windsurf\\mcp_config.json")
                    .to_string_lossy()
                    .to_string(),
            });
        }
    }

    Ok(tools)
}
```

- [ ] **Step 5: Register all 4 commands in `src-tauri/src/lib.rs`**

Add these 4 lines inside the `tauri::generate_handler![]` macro, right before the closing `]` (after `commands::cmd_backfill_plain_text`):

```rust
            commands::cmd_get_mcp_entry_path,
            commands::cmd_read_external_file,
            commands::cmd_write_external_file,
            commands::cmd_get_ai_tool_paths,
```

- [ ] **Step 6: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: compiles without errors.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(ai): add Tauri commands for MCP config file I/O and tool path detection"
```

---

### Task 2: Frontend command wrappers

**Files:**
- Modify: `src/lib/commands.ts`

- [ ] **Step 1: Add 4 command wrappers**

Append to the end of `src/lib/commands.ts`:

```typescript
// ── AI / MCP ──

export function getMcpEntryPath(): Promise<string> {
  return invoke("cmd_get_mcp_entry_path");
}

export function readExternalFile(path: string): Promise<string> {
  return invoke("cmd_read_external_file", { path });
}

export function writeExternalFile(path: string, content: string): Promise<void> {
  return invoke("cmd_write_external_file", { path, content });
}

export interface AiToolPath {
  name: string;
  path: string;
}

export function getAiToolPaths(): Promise<AiToolPath[]> {
  return invoke("cmd_get_ai_tool_paths");
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/commands.ts
git commit -m "feat(ai): add frontend command wrappers for MCP config I/O"
```

---

### Task 3: i18n — `ai` namespace

**Files:**
- Create: `src/locales/zh/ai.json`
- Create: `src/locales/en/ai.json`
- Modify: `src/i18n.ts`
- Modify: `src/types/i18next.d.ts`
- Modify: `src/locales/zh/settings.json`
- Modify: `src/locales/en/settings.json`

- [ ] **Step 1: Create `src/locales/zh/ai.json`**

```json
{
  "title": "AI 工具集成",
  "description": "将拾贝 MCP Server 配置到 AI 助手，让 AI 能读取和操作你的资料库。",
  "presetTools": "AI 工具",
  "customTools": "自定义",
  "addCustom": "添加自定义工具",
  "configure": "配置",
  "remove": "移除",
  "delete": "删除",
  "statusConfigured": "已配置",
  "statusNotConfigured": "未配置",
  "statusNotInstalled": "未检测到",
  "confirmTitle": "确认配置",
  "confirmDesc": "将向以下文件写入 MCP 配置：",
  "confirmButton": "确认写入",
  "cancel": "取消",
  "removeConfirmTitle": "确认移除",
  "removeConfirmDesc": "将从以下文件中移除 shibei MCP 配置：",
  "removeButton": "确认移除",
  "diffAdd": "新增内容",
  "diffUpdate": "更新内容",
  "diffNewFile": "将创建新文件",
  "configSuccess": "配置成功",
  "removeSuccess": "已移除配置",
  "deleteSuccess": "已删除",
  "errorJsonParse": "文件格式错误，无法解析 JSON，请手动检查",
  "errorMcpNotBuilt": "MCP Server 未构建，请先在 mcp/ 目录运行 npm run build"
}
```

- [ ] **Step 2: Create `src/locales/en/ai.json`**

```json
{
  "title": "AI Tool Integration",
  "description": "Configure Shibei MCP Server for AI assistants so they can read and manage your library.",
  "presetTools": "AI Tools",
  "customTools": "Custom",
  "addCustom": "Add Custom Tool",
  "configure": "Configure",
  "remove": "Remove",
  "delete": "Delete",
  "statusConfigured": "Configured",
  "statusNotConfigured": "Not Configured",
  "statusNotInstalled": "Not Detected",
  "confirmTitle": "Confirm Configuration",
  "confirmDesc": "The following MCP config will be written to:",
  "confirmButton": "Confirm",
  "cancel": "Cancel",
  "removeConfirmTitle": "Confirm Removal",
  "removeConfirmDesc": "Remove shibei MCP config from:",
  "removeButton": "Confirm Removal",
  "diffAdd": "Content to add",
  "diffUpdate": "Content to update",
  "diffNewFile": "New file will be created",
  "configSuccess": "Configured successfully",
  "removeSuccess": "Configuration removed",
  "deleteSuccess": "Deleted",
  "errorJsonParse": "Invalid JSON format, please check the file manually",
  "errorMcpNotBuilt": "MCP Server not built, please run npm run build in mcp/ directory first"
}
```

- [ ] **Step 3: Register namespace in `src/i18n.ts`**

Add imports after the existing `zhData` / `enData` imports (around lines 14-15):

```typescript
import zhAi from './locales/zh/ai.json';
```

```typescript
import enAi from './locales/en/ai.json';
```

Add `ai: zhAi,` after `data: zhData,` in the `zh` resources object (line 35):

```typescript
data: zhData, ai: zhAi,
```

Add `ai: enAi,` after `data: enData,` in the `en` resources object (line 41):

```typescript
data: enData, ai: enAi,
```

- [ ] **Step 4: Update TypeScript types in `src/types/i18next.d.ts`**

Add import after the `zhData` import (line 11):

```typescript
import type zhAi from '../locales/zh/ai.json';
```

Add to `resources` object inside `CustomTypeOptions` (after the `data` line):

```typescript
      ai: typeof zhAi;
```

- [ ] **Step 5: Add nav key to settings locales**

In `src/locales/zh/settings.json`, add before the closing `}`:
```json
  "navAi": "AI"
```

In `src/locales/en/settings.json`, add before the closing `}`:
```json
  "navAi": "AI"
```

- [ ] **Step 6: Commit**

```bash
git add src/locales/zh/ai.json src/locales/en/ai.json src/i18n.ts src/types/i18next.d.ts src/locales/zh/settings.json src/locales/en/settings.json
git commit -m "feat(ai): add i18n namespace for AI settings page"
```

---

### Task 4: Settings navigation — add "AI" section

**Files:**
- Modify: `src/components/SettingsView.tsx`

- [ ] **Step 1: Update SettingsView.tsx**

1. Add `"ai"` to the `SettingsSection` type union (line 12):

Change:
```typescript
type SettingsSection = "appearance" | "sync" | "encryption" | "security" | "data";
```
To:
```typescript
type SettingsSection = "appearance" | "sync" | "encryption" | "security" | "data" | "ai";
```

2. Add nav entry to `NAV_KEYS` array — add `{ id: "ai", key: "navAi" },` after the `data` entry (line 19):

```typescript
const NAV_KEYS = [
  { id: "appearance", key: "navAppearance" },
  { id: "sync", key: "navSync" },
  { id: "encryption", key: "navEncryption" },
  { id: "security", key: "navSecurity" },
  { id: "data", key: "navData" },
  { id: "ai", key: "navAi" },
] as const;
```

3. Add import at top (after the DataPage import, line 8):

```typescript
import { AIPage } from "@/components/Settings/AIPage";
```

4. Add conditional render inside the `.page` div, after line 67 (`{section === "data" && <DataPage />}`):

```tsx
          {section === "ai" && <AIPage />}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/SettingsView.tsx
git commit -m "feat(ai): add AI section to settings navigation"
```

---

### Task 5: AIPage component + styles

**Files:**
- Create: `src/components/Settings/AIPage.tsx`
- Create: `src/components/Settings/AIPage.module.css`

- [ ] **Step 1: Create `src/components/Settings/AIPage.module.css`**

```css
.toolList {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}

.toolRow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-sm) var(--spacing-md);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-primary);
}

.toolInfo {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.toolName {
  font-size: var(--font-size-base);
  font-weight: 500;
  color: var(--color-text-primary);
}

.toolPath {
  font-size: 11px;
  color: var(--color-text-muted);
  font-family: monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.toolActions {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  flex-shrink: 0;
  margin-left: var(--spacing-md);
}

.statusBadge {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 10px;
  white-space: nowrap;
}

.statusConfigured {
  background: var(--color-success-bg, #e6f4ea);
  color: var(--color-success, #1e7e34);
}

.statusNotConfigured {
  background: var(--color-bg-secondary);
  color: var(--color-text-muted);
}

.statusNotInstalled {
  background: var(--color-bg-secondary);
  color: var(--color-text-muted);
  font-style: italic;
}

.diffOverlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.diffModal {
  background: var(--color-bg-primary);
  border-radius: 8px;
  padding: var(--spacing-lg);
  max-width: 560px;
  width: 90%;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
}

.diffTitle {
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--color-text-primary);
  margin: 0 0 var(--spacing-sm);
}

.diffDesc {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  margin: 0 0 var(--spacing-md);
}

.diffFilePath {
  font-size: 12px;
  color: var(--color-text-muted);
  font-family: monospace;
  margin-bottom: var(--spacing-sm);
  word-break: break-all;
}

.diffContent {
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  padding: var(--spacing-sm);
  font-family: monospace;
  font-size: 12px;
  line-height: 1.5;
  overflow-y: auto;
  max-height: 40vh;
  white-space: pre-wrap;
  word-break: break-all;
}

.diffAdd {
  color: var(--color-success, #1e7e34);
}
```

- [ ] **Step 2: Create `src/components/Settings/AIPage.tsx`**

```tsx
import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import toast from "react-hot-toast";
import * as cmd from "@/lib/commands";
import { translateError } from "@/lib/commands";
import settingsStyles from "./Settings.module.css";
import styles from "./AIPage.module.css";

// ── Types ──

interface ToolDef {
  name: string;
  path: string;
  preset: boolean;
}

type ToolStatus = "configured" | "not_configured" | "not_installed";

interface ToolState {
  def: ToolDef;
  status: ToolStatus;
}

interface DiffInfo {
  tool: ToolDef;
  filePath: string;
  preview: string;
  isNew: boolean;
  merged: string;
}

// ── Custom tools persistence ──

const CUSTOM_TOOLS_KEY = "shibei-mcp-custom-tools";

function loadCustomTools(): ToolDef[] {
  try {
    const raw = localStorage.getItem(CUSTOM_TOOLS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as { name: string; path: string }[];
    return arr.map((item) => ({ name: item.name, path: item.path, preset: false }));
  } catch {
    return [];
  }
}

function saveCustomTools(tools: ToolDef[]) {
  const arr = tools.map((t) => ({ name: t.name, path: t.path }));
  localStorage.setItem(CUSTOM_TOOLS_KEY, JSON.stringify(arr));
}

// ── Component ──

export function AIPage() {
  const { t } = useTranslation("ai");
  const [mcpPath, setMcpPath] = useState<string | null>(null);
  const [toolStates, setToolStates] = useState<ToolState[]>([]);
  const [diff, setDiff] = useState<DiffInfo | null>(null);
  const [removing, setRemoving] = useState<ToolDef | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);

    // Get MCP entry path
    let entryPath: string | null = null;
    try {
      entryPath = await cmd.getMcpEntryPath();
    } catch {
      // MCP not built — will show warning
    }
    setMcpPath(entryPath);

    // Get preset tool paths from backend (OS-aware)
    let presets: ToolDef[] = [];
    try {
      const paths = await cmd.getAiToolPaths();
      presets = paths.map((p) => ({ name: p.name, path: p.path, preset: true }));
    } catch {
      // Fallback: empty presets
    }

    const customs = loadCustomTools();
    const all = [...presets, ...customs];

    // Detect status for each tool
    const states: ToolState[] = await Promise.all(
      all.map(async (def) => {
        try {
          const content = await cmd.readExternalFile(def.path);
          const json = JSON.parse(content);
          const hasShibei = json?.mcpServers?.shibei != null;
          return {
            def,
            status: (hasShibei ? "configured" : "not_configured") as ToolStatus,
          };
        } catch {
          return { def, status: "not_installed" as ToolStatus };
        }
      }),
    );

    setToolStates(states);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Build the shibei MCP entry object
  const buildShibeiEntry = useCallback(() => {
    if (!mcpPath) return null;
    return { command: "node", args: [mcpPath] };
  }, [mcpPath]);

  // Prepare diff preview for a tool
  const handleConfigure = useCallback(
    async (def: ToolDef) => {
      const entry = buildShibeiEntry();
      if (!entry) return;

      let existingJson: Record<string, unknown> = {};
      let isNew = false;

      try {
        const content = await cmd.readExternalFile(def.path);
        existingJson = JSON.parse(content);
      } catch {
        isNew = true;
      }

      const mcpServers = (existingJson.mcpServers ?? {}) as Record<string, unknown>;
      const hadOld = mcpServers.shibei != null;
      mcpServers.shibei = entry;
      existingJson.mcpServers = mcpServers;

      const merged = JSON.stringify(existingJson, null, 2);
      const preview = JSON.stringify({ shibei: entry }, null, 2);

      setDiff({
        tool: def,
        filePath: def.path,
        preview,
        isNew: isNew || !hadOld,
        merged,
      });
    },
    [buildShibeiEntry],
  );

  // Write config after user confirms
  const handleConfirmWrite = useCallback(async () => {
    if (!diff) return;
    try {
      await cmd.writeExternalFile(diff.filePath, diff.merged);
      toast.success(t("configSuccess"));
      setDiff(null);
      refresh();
    } catch (err) {
      toast.error(translateError(String(err)));
    }
  }, [diff, t, refresh]);

  // Remove shibei entry from config
  const handleConfirmRemove = useCallback(async () => {
    if (!removing) return;
    try {
      const content = await cmd.readExternalFile(removing.path);
      const json = JSON.parse(content);
      if (json?.mcpServers?.shibei != null) {
        delete json.mcpServers.shibei;
        await cmd.writeExternalFile(removing.path, JSON.stringify(json, null, 2));
      }
      toast.success(t("removeSuccess"));
      setRemoving(null);
      refresh();
    } catch (err) {
      toast.error(translateError(String(err)));
    }
  }, [removing, t, refresh]);

  // Add custom tool via file picker
  const handleAddCustom = useCallback(async () => {
    const path = await open({
      filters: [{ name: "JSON", extensions: ["json"] }],
      multiple: false,
    });
    if (!path) return;

    const customs = loadCustomTools();
    if (customs.some((c) => c.path === path)) {
      refresh();
      return;
    }
    const fileName =
      (path as string).split(/[/\\]/).pop()?.replace(".json", "") ?? "Custom";
    customs.push({ name: fileName, path: path as string, preset: false });
    saveCustomTools(customs);
    refresh();
  }, [refresh]);

  // Delete custom tool from list (does not modify config file)
  const handleDeleteCustom = useCallback(
    (def: ToolDef) => {
      const customs = loadCustomTools().filter((c) => c.path !== def.path);
      saveCustomTools(customs);
      toast.success(t("deleteSuccess"));
      refresh();
    },
    [t, refresh],
  );

  // ── Render helpers ──

  const renderToolRow = (ts: ToolState) => {
    const statusClass =
      ts.status === "configured"
        ? styles.statusConfigured
        : ts.status === "not_configured"
          ? styles.statusNotConfigured
          : styles.statusNotInstalled;
    const statusText =
      ts.status === "configured"
        ? t("statusConfigured")
        : ts.status === "not_configured"
          ? t("statusNotConfigured")
          : t("statusNotInstalled");

    return (
      <div key={ts.def.path} className={styles.toolRow}>
        <div className={styles.toolInfo}>
          <span className={styles.toolName}>{ts.def.name}</span>
          <span className={styles.toolPath}>{ts.def.path}</span>
        </div>
        <div className={styles.toolActions}>
          <span className={`${styles.statusBadge} ${statusClass}`}>
            {statusText}
          </span>
          {ts.status === "not_configured" && mcpPath && (
            <button
              className={settingsStyles.primary}
              onClick={() => handleConfigure(ts.def)}
            >
              {t("configure")}
            </button>
          )}
          {ts.status === "configured" && (
            <>
              <button
                className={settingsStyles.primary}
                onClick={() => handleConfigure(ts.def)}
              >
                {t("configure")}
              </button>
              <button
                className={settingsStyles.danger}
                onClick={() => setRemoving(ts.def)}
              >
                {t("remove")}
              </button>
            </>
          )}
          {!ts.def.preset && (
            <button
              className={settingsStyles.secondary}
              onClick={() => handleDeleteCustom(ts.def)}
            >
              {t("delete")}
            </button>
          )}
        </div>
      </div>
    );
  };

  const presets = toolStates.filter((ts) => ts.def.preset);
  const customs = toolStates.filter((ts) => !ts.def.preset);

  return (
    <div>
      <h2 className={settingsStyles.heading}>{t("title")}</h2>
      <p className={settingsStyles.hint}>{t("description")}</p>

      {!mcpPath && !loading && (
        <p className={settingsStyles.warning}>{t("errorMcpNotBuilt")}</p>
      )}

      {/* Preset tools */}
      <div className={settingsStyles.form}>
        <h3 className={settingsStyles.subheading}>{t("presetTools")}</h3>
        <div className={styles.toolList}>{presets.map(renderToolRow)}</div>
      </div>

      {/* Custom tools */}
      <div className={settingsStyles.passwordSection}>
        <h3 className={settingsStyles.subheading}>{t("customTools")}</h3>
        <div className={styles.toolList}>{customs.map(renderToolRow)}</div>
        <div className={settingsStyles.actions}>
          <button className={settingsStyles.secondary} onClick={handleAddCustom}>
            {t("addCustom")}
          </button>
        </div>
      </div>

      {/* Diff preview modal */}
      {diff && (
        <div className={styles.diffOverlay} onClick={() => setDiff(null)}>
          <div
            className={styles.diffModal}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className={styles.diffTitle}>{t("confirmTitle")}</h3>
            <p className={styles.diffDesc}>{t("confirmDesc")}</p>
            <p className={styles.diffFilePath}>{diff.filePath}</p>
            <p className={settingsStyles.hint}>
              {diff.isNew ? t("diffAdd") : t("diffUpdate")}
            </p>
            <pre className={styles.diffContent}>
              <span className={styles.diffAdd}>{diff.preview}</span>
            </pre>
            <div className={settingsStyles.modalActions}>
              <button
                className={settingsStyles.secondary}
                onClick={() => setDiff(null)}
              >
                {t("cancel")}
              </button>
              <button
                className={settingsStyles.primary}
                onClick={handleConfirmWrite}
              >
                {t("confirmButton")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Remove confirmation modal */}
      {removing && (
        <div className={styles.diffOverlay} onClick={() => setRemoving(null)}>
          <div
            className={styles.diffModal}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className={styles.diffTitle}>{t("removeConfirmTitle")}</h3>
            <p className={styles.diffDesc}>{t("removeConfirmDesc")}</p>
            <p className={styles.diffFilePath}>{removing.path}</p>
            <div className={settingsStyles.modalActions}>
              <button
                className={settingsStyles.secondary}
                onClick={() => setRemoving(null)}
              >
                {t("cancel")}
              </button>
              <button
                className={settingsStyles.danger}
                onClick={handleConfirmRemove}
              >
                {t("removeButton")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/Settings/AIPage.tsx src/components/Settings/AIPage.module.css
git commit -m "feat(ai): add AIPage component with MCP auto-config UI"
```

---

### Task 6: Manual verification

- [ ] **Step 1: Start the dev server**

Run: `npm run tauri dev`

- [ ] **Step 2: Navigate to Settings > AI**

Verify:
- "AI" appears in settings sidebar navigation
- Page loads with title and description
- Preset tools (Claude Desktop, Cursor, Windsurf) listed with correct paths
- Tools that aren't installed show "未检测到" / "Not Detected"

- [ ] **Step 3: Test configure flow**

If any AI tool is installed:
- Click "配置" → verify diff preview modal with JSON content
- Click "确认写入" → verify toast success
- Verify tool now shows "已配置" with green badge
- Open the actual config file and verify `mcpServers.shibei` entry

If no AI tool is installed:
- Test with a custom JSON file (create a test file `~/test-mcp.json` with `{}`)
- Click "添加自定义工具" → select the file
- Configure it and verify write

- [ ] **Step 4: Test remove flow**

- Click "移除" on a configured tool
- Confirm → verify toast success, status back to "未配置"
- Verify config file no longer has `shibei` entry

- [ ] **Step 5: Test custom tool flow**

- Click "添加自定义工具" → select a JSON file
- Verify it appears in custom tools section
- Click "删除" → verify removed from list

- [ ] **Step 6: Commit any fixes**

```bash
git add -A
git commit -m "fix(ai): address issues found during manual testing"
```

---

### Task 7: Update CLAUDE.md and roadmap

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-03-31-shibei-roadmap.md`

- [ ] **Step 1: Update CLAUDE.md**

1. In the 目录结构 `components/` line, update the Settings list to include `AIPage`:
   - Change: `Settings/..., Sidebar/...`
   - To: `Settings/AIPage, Settings/..., Sidebar/...`

2. In 架构约束 section, add a new bullet after the MCP Server bullet:
   ```
   - **MCP 自动配置**：`Settings/AIPage` 提供一键配置 MCP Server 到 AI 工具（Claude Desktop/Cursor/Windsurf）。预设工具路径由后端 `cmd_get_ai_tool_paths`（`dirs` crate）按 OS 返回，自定义工具路径存 `localStorage`（key: `shibei-mcp-custom-tools`）。配置操作通过 `cmd_read_external_file`/`cmd_write_external_file` 通用命令，只修改 `mcpServers.shibei` 字段，写入前弹窗 diff 预览
   ```

3. Update i18n namespace count from 10 to 11, add `ai` to the namespace list.

4. Update commands count (33 → 37 or the current accurate count).

- [ ] **Step 2: Update roadmap**

In the v1.7 MCP Server section, add a checked item:
```markdown
- [x] **MCP 自动配置** — 设置页 AI 分区，一键配置 MCP Server 到 Claude Desktop/Cursor/Windsurf，支持自定义工具路径
```

Update the "当前状态" line at the top to include this feature.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-03-31-shibei-roadmap.md
git commit -m "docs: update CLAUDE.md and roadmap for MCP auto-config"
```
