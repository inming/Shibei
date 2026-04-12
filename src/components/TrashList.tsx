import { useState, useEffect, useCallback, useMemo } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import type { DeletedResource, DeletedFolder } from "@/types";
import * as cmd from "@/lib/commands";
import { DataEvents } from "@/lib/events";
import { Modal } from "@/components/Modal";
import toast from "react-hot-toast";
import styles from "./TrashList.module.css";

const RETENTION_DAYS = 90;
const EXPIRING_THRESHOLD = 7;

function daysRemaining(deletedAt: string): number {
  const deleted = new Date(deletedAt);
  const expiry = new Date(deleted.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const now = new Date();
  return Math.max(0, Math.ceil((expiry.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
}

export function TrashList() {
  const { t } = useTranslation('sidebar');
  const [resources, setResources] = useState<DeletedResource[]>([]);
  const [folders, setFolders] = useState<DeletedFolder[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [purgeTarget, setPurgeTarget] = useState<{
    type: "resource" | "folder";
    id: string;
    name: string;
  } | null>(null);

  const refresh = useCallback(() => {
    cmd.listDeletedResources().then(setResources).catch(() => setResources([]));
    cmd.listDeletedFolders().then(setFolders).catch(() => setFolders([]));
    setSelectedIds(new Set());
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

  const allItemIds = useMemo(() => {
    const ids: string[] = [];
    for (const f of folders) ids.push(`folder:${f.id}`);
    for (const r of resources) ids.push(`resource:${r.id}`);
    return ids;
  }, [folders, resources]);

  const allSelected = allItemIds.length > 0 && allItemIds.every((id) => selectedIds.has(id));

  const toggleItem = (compositeId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(compositeId)) next.delete(compositeId);
      else next.add(compositeId);
      return next;
    });
  };

  const toggleAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(allItemIds));
    }
  };

  const handleRestore = async (type: "resource" | "folder", id: string) => {
    try {
      if (type === "resource") await cmd.restoreResource(id);
      else await cmd.restoreFolder(id);
      toast.success(t('restored'));
    } catch {
      toast.error(t('restoreFailed'));
    }
  };

  const handleBatchRestore = async () => {
    if (selectedIds.size === 0) return;
    let failed = 0;
    for (const compositeId of selectedIds) {
      const [type, id] = compositeId.split(":", 2) as ["resource" | "folder", string];
      try {
        if (type === "resource") await cmd.restoreResource(id);
        else await cmd.restoreFolder(id);
      } catch {
        failed++;
      }
    }
    if (failed > 0) {
      toast.error(t('batchRestoreFailed'));
    } else {
      toast.success(t('restored'));
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

  const renderDays = (deletedAt: string) => {
    const days = daysRemaining(deletedAt);
    const isExpiring = days <= EXPIRING_THRESHOLD;
    return (
      <span className={isExpiring ? styles.daysExpiring : styles.daysRemaining}>
        {isExpiring ? t('trashExpiringSoon') : t('trashDaysRemaining', { days })}
      </span>
    );
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>{t('trash')}</div>

      {!empty && (
        <div className={styles.retentionHint}>
          <span className={styles.retentionIcon}>&#9432;</span>
          {t('trashRetentionHint')}
        </div>
      )}

      {!empty && (
        <div className={styles.batchBar}>
          <label className={styles.selectAllLabel}>
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleAll}
            />
            {t('selectAll')}
          </label>
          {selectedIds.size > 0 && (
            <button
              className={styles.batchRestoreBtn}
              onClick={handleBatchRestore}
            >
              {t('restoreSelected', { count: selectedIds.size })}
            </button>
          )}
        </div>
      )}

      {empty && <div className={styles.empty}>{t('trashEmpty')}</div>}

      {folders.length > 0 && (
        <>
          <div className={styles.sectionLabel}>{t('trashFolders')}</div>
          {folders.map((f) => (
            <div key={f.id} className={styles.item}>
              <input
                type="checkbox"
                className={styles.itemCheckbox}
                checked={selectedIds.has(`folder:${f.id}`)}
                onChange={() => toggleItem(`folder:${f.id}`)}
              />
              <div className={styles.itemInfo}>
                <span className={styles.itemName}>{f.name}</span>
                {renderDays(f.deleted_at)}
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
              <input
                type="checkbox"
                className={styles.itemCheckbox}
                checked={selectedIds.has(`resource:${r.id}`)}
                onChange={() => toggleItem(`resource:${r.id}`)}
              />
              <div className={styles.itemInfo}>
                <span className={styles.itemName}>{r.title}</span>
                {renderDays(r.deleted_at)}
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
