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
  /** "standard" = mcpServers key, "opencode" = mcp key + type field */
  format: string;
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
    const arr = JSON.parse(raw) as { name: string; path: string; format?: string }[];
    return arr.map((item) => ({ name: item.name, path: item.path, preset: false, format: item.format ?? "standard" }));
  } catch {
    return [];
  }
}

function saveCustomTools(tools: ToolDef[]) {
  const arr = tools.map((t) => ({ name: t.name, path: t.path, format: t.format }));
  localStorage.setItem(CUSTOM_TOOLS_KEY, JSON.stringify(arr));
}

// ── Format helpers ──

/** Get the top-level config key for MCP servers based on tool format */
function getConfigKey(format: string): string {
  return format === "opencode" ? "mcp" : "mcpServers";
}

/** Check if a parsed config JSON has a shibei entry */
function hasShibeiEntry(json: Record<string, unknown>, format: string): boolean {
  const key = getConfigKey(format);
  const servers = json[key] as Record<string, unknown> | undefined;
  return servers?.shibei != null;
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
      // MCP not built
    }
    setMcpPath(entryPath);

    // Get preset tool paths from backend (OS-aware)
    let presets: ToolDef[] = [];
    try {
      const paths = await cmd.getAiToolPaths();
      presets = paths.map((p) => ({ name: p.name, path: p.path, preset: true, format: p.format }));
    } catch {
      // Fallback: empty presets
    }

    const customs = loadCustomTools();
    const all = [...presets, ...customs];

    // Detect status for each tool
    const states: ToolState[] = await Promise.all(
      all.map(async (def) => {
        let content: string;
        try {
          content = await cmd.readExternalFile(def.path);
        } catch {
          // File doesn't exist
          return { def, status: "not_installed" as ToolStatus };
        }
        // File exists — parse JSON
        try {
          const json = JSON.parse(content);
          const configured = hasShibeiEntry(json, def.format);
          return {
            def,
            status: (configured ? "configured" : "not_configured") as ToolStatus,
          };
        } catch {
          // File exists but invalid/empty JSON — treat as not configured
          return { def, status: "not_configured" as ToolStatus };
        }
      }),
    );

    setToolStates(states);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Build the shibei MCP entry object based on format
  const buildShibeiEntry = useCallback(
    (format: string) => {
      if (!mcpPath) return null;
      if (format === "opencode") {
        return { type: "local", command: ["node", mcpPath], enabled: true };
      }
      return { command: "node", args: [mcpPath] };
    },
    [mcpPath],
  );

  // Prepare diff preview for a tool
  const handleConfigure = useCallback(
    async (def: ToolDef) => {
      const entry = buildShibeiEntry(def.format);
      if (!entry) return;

      let existingJson: Record<string, unknown> = {};
      let isNew = false;

      try {
        const content = await cmd.readExternalFile(def.path);
        existingJson = JSON.parse(content);
      } catch {
        isNew = true;
      }

      const configKey = getConfigKey(def.format);
      const servers = (existingJson[configKey] ?? {}) as Record<string, unknown>;
      const hadOld = servers.shibei != null;
      servers.shibei = entry;
      existingJson[configKey] = servers;

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
      const configKey = getConfigKey(removing.format);
      if (json?.[configKey]?.shibei != null) {
        delete json[configKey].shibei;
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
    customs.push({ name: fileName, path: path as string, preset: false, format: "standard" });
    saveCustomTools(customs);
    refresh();
  }, [refresh]);

  // Delete custom tool from list
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
