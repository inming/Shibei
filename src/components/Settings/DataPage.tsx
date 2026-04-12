import { useState } from "react";
import { useTranslation } from "react-i18next";
import { save, open } from "@tauri-apps/plugin-dialog";
import toast from "react-hot-toast";
import * as cmd from "@/lib/commands";
import { translateError } from "@/lib/commands";
import styles from "./Settings.module.css";

export function DataPage() {
  const { t } = useTranslation("data");
  const [backingUp, setBackingUp] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const handleBackup = async () => {
    const now = new Date();
    const ts = now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
    const defaultName = `shibei-backup-${ts}.zip`;

    const path = await save({
      defaultPath: defaultName,
      filters: [{ name: "Zip", extensions: ["zip"] }],
    });
    if (!path) return;

    setBackingUp(true);
    try {
      const result = await cmd.exportBackup(path);
      toast.success(t("backupSuccess", { count: result.resource_count }));
    } catch (err) {
      toast.error(translateError(String(err)));
    } finally {
      setBackingUp(false);
    }
  };

  const handleRestore = async () => {
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

    let confirmMsg = t("restoreConfirm");
    if (hasSyncConfig) {
      confirmMsg += "\n\n" + t("restoreSyncWarning");
    }

    if (!window.confirm(confirmMsg)) return;

    setRestoring(true);
    try {
      const result = await cmd.importBackup(path as string);
      toast.success(t("restoreSuccess", { count: result.resource_count }));
    } catch (err) {
      toast.error(translateError(String(err)));
    } finally {
      setRestoring(false);
    }
  };

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
            disabled={backingUp || restoring}
          >
            {backingUp ? t("backupInProgress") : t("backupButton")}
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
            disabled={backingUp || restoring}
          >
            {restoring ? t("restoreInProgress") : t("restoreButton")}
          </button>
        </div>
      </div>
    </div>
  );
}
