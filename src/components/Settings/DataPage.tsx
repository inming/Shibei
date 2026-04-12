import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { save, open, ask } from "@tauri-apps/plugin-dialog";
import toast from "react-hot-toast";
import * as cmd from "@/lib/commands";
import { translateError } from "@/lib/commands";
import styles from "./Settings.module.css";

function formatError(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return translateError(String((err as { message: string }).message));
  }
  return translateError(String(err));
}

// Module-level state + listeners to notify all mounted instances
let _backingUp = false;
let _restoring = false;
let _listeners = new Set<() => void>();

function setBusy(type: "backup" | "restore", value: boolean) {
  if (type === "backup") _backingUp = value;
  else _restoring = value;
  _listeners.forEach((fn) => fn());
}

export function DataPage() {
  const { t } = useTranslation("data");
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    const listener = () => forceUpdate((n) => n + 1);
    _listeners.add(listener);
    return () => { _listeners.delete(listener); };
  }, []);

  const handleBackup = useCallback(async () => {
    const now = new Date();
    const ts = now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
    const defaultName = `shibei-backup-${ts}.zip`;

    const path = await save({
      defaultPath: defaultName,
      filters: [{ name: "Zip", extensions: ["zip"] }],
    });
    if (!path) return;

    setBusy("backup", true);
    try {
      const result = await cmd.exportBackup(path);
      toast.success(t("backupSuccess", { count: result.resource_count }));
    } catch (err) {
      toast.error(formatError(err));
    } finally {
      setBusy("backup", false);
    }
  }, [t]);

  const handleRestore = useCallback(async () => {
    const path = await open({
      filters: [{ name: "Zip", extensions: ["zip"] }],
      multiple: false,
    });
    if (!path) return;

    // Check if sync is configured for extra warning
    let hasSyncConfig = false;
    try {
      const config = await cmd.getSyncConfig();
      hasSyncConfig = !!config.endpoint;
    } catch {
      // No sync config
    }

    const fileName = (path as string).split("/").pop() || path;
    let confirmMsg = t("restoreConfirm", { file: fileName });
    if (hasSyncConfig) {
      confirmMsg += "\n\n" + t("restoreSyncWarning");
    }

    const confirmed = await ask(confirmMsg, {
      title: t("restoreTitle"),
      kind: "warning",
    });
    if (!confirmed) return;

    setBusy("restore", true);
    try {
      const result = await cmd.importBackup(path as string);
      toast.success(t("restoreSuccess", { count: result.resource_count }));
    } catch (err) {
      toast.error(formatError(err));
    } finally {
      setBusy("restore", false);
    }
  }, [t]);

  return (
    <div>
      <h2 className={styles.heading}>{t("title")}</h2>

      <div className={styles.form}>
        <h3 className={styles.subheading}>{t("backupTitle")}</h3>
        <p className={styles.hint}>{t("backupDesc")}</p>
        <div className={styles.actions}>
          <button
            className={styles.primary}
            onClick={handleBackup}
            disabled={_backingUp || _restoring}
          >
            {_backingUp ? t("backupInProgress") : t("backupButton")}
          </button>
        </div>
      </div>

      <div className={styles.passwordSection}>
        <h3 className={styles.subheading}>{t("restoreTitle")}</h3>
        <p className={styles.hint}>{t("restoreDesc")}</p>
        <div className={styles.actions}>
          <button
            className={styles.danger}
            onClick={handleRestore}
            disabled={_backingUp || _restoring}
          >
            {_restoring ? t("restoreInProgress") : t("restoreButton")}
          </button>
        </div>
      </div>
    </div>
  );
}
