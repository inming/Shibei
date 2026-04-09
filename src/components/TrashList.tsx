import { useState, useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import type { DeletedResource, DeletedFolder } from "@/types";
import * as cmd from "@/lib/commands";
import { DataEvents } from "@/lib/events";
import { Modal } from "@/components/Modal";
import toast from "react-hot-toast";
import styles from "./TrashList.module.css";

export function TrashList() {
  const { t } = useTranslation('sidebar');
  const [resources, setResources] = useState<DeletedResource[]>([]);
  const [folders, setFolders] = useState<DeletedFolder[]>([]);
  const [purgeTarget, setPurgeTarget] = useState<{
    type: "resource" | "folder";
    id: string;
    name: string;
  } | null>(null);

  const refresh = useCallback(() => {
    cmd.listDeletedResources().then(setResources).catch(() => setResources([]));
    cmd.listDeletedFolders().then(setFolders).catch(() => setFolders([]));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const u1 = listen(DataEvents.RESOURCE_CHANGED, refresh);
    const u2 = listen(DataEvents.FOLDER_CHANGED, refresh);
    const u3 = listen(DataEvents.SYNC_COMPLETED, refresh);
    return () => {
      u1.then((f) => f());
      u2.then((f) => f());
      u3.then((f) => f());
    };
  }, [refresh]);

  const handleRestore = async (type: "resource" | "folder", id: string) => {
    try {
      if (type === "resource") await cmd.restoreResource(id);
      else await cmd.restoreFolder(id);
      toast.success(t('restored'));
    } catch {
      toast.error(t('restoreFailed'));
    }
  };

  const handlePurge = async () => {
    if (!purgeTarget) return;
    try {
      if (purgeTarget.type === "resource") await cmd.purgeResource(purgeTarget.id);
      else await cmd.purgeFolder(purgeTarget.id);
      toast.success(t('permanentDeleted'));
    } catch {
      toast.error(t('permanentDeleteFailed'));
    }
    setPurgeTarget(null);
  };

  const empty = resources.length === 0 && folders.length === 0;

  return (
    <div className={styles.container}>
      <div className={styles.header}>{t('trash')}</div>
      {empty && <div className={styles.empty}>{t('trashEmpty')}</div>}

      {folders.length > 0 && (
        <>
          <div className={styles.sectionLabel}>{t('trashFolders')}</div>
          {folders.map((f) => (
            <div key={f.id} className={styles.item}>
              <div className={styles.itemInfo}>
                <span className={styles.itemName}>{f.name}</span>
                <span className={styles.itemDate}>
                  {new Date(f.deleted_at).toLocaleDateString()}
                </span>
              </div>
              <div className={styles.itemActions}>
                <button onClick={() => handleRestore("folder", f.id)}>{t('restore')}</button>
                <button
                  className={styles.dangerBtn}
                  onClick={() =>
                    setPurgeTarget({ type: "folder", id: f.id, name: f.name })
                  }
                >
                  {t('delete', { ns: 'common' })}
                </button>
              </div>
            </div>
          ))}
        </>
      )}

      {resources.length > 0 && (
        <>
          <div className={styles.sectionLabel}>{t('trashResources')}</div>
          {resources.map((r) => (
            <div key={r.id} className={styles.item}>
              <div className={styles.itemInfo}>
                <span className={styles.itemName}>{r.title}</span>
                <span className={styles.itemDate}>
                  {new Date(r.deleted_at).toLocaleDateString()}
                </span>
              </div>
              <div className={styles.itemActions}>
                <button onClick={() => handleRestore("resource", r.id)}>{t('restore')}</button>
                <button
                  className={styles.dangerBtn}
                  onClick={() =>
                    setPurgeTarget({ type: "resource", id: r.id, name: r.title })
                  }
                >
                  {t('delete', { ns: 'common' })}
                </button>
              </div>
            </div>
          ))}
        </>
      )}

      {purgeTarget && (
        <Modal title={t('permanentDeleteTitle')} onClose={() => setPurgeTarget(null)}>
          <p style={{ marginBottom: "16px" }}>
            {t('permanentDeleteConfirm', { name: purgeTarget.name })}
          </p>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
            <button
              style={{
                padding: "6px 16px",
                borderRadius: "4px",
                border: "1px solid var(--color-border)",
                background: "transparent",
                cursor: "pointer",
              }}
              onClick={() => setPurgeTarget(null)}
            >
              {t('cancel', { ns: 'common' })}
            </button>
            <button
              style={{
                padding: "6px 16px",
                borderRadius: "4px",
                border: "none",
                background: "var(--color-danger)",
                color: "white",
                cursor: "pointer",
              }}
              onClick={handlePurge}
            >
              {t('permanentDelete')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
