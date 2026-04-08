import { useState, useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import type { DeletedResource, DeletedFolder } from "@/types";
import * as cmd from "@/lib/commands";
import { DataEvents } from "@/lib/events";
import { Modal } from "@/components/Modal";
import toast from "react-hot-toast";
import styles from "./TrashList.module.css";

export function TrashList() {
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
      toast.success("已恢复");
    } catch {
      toast.error("恢复失败");
    }
  };

  const handlePurge = async () => {
    if (!purgeTarget) return;
    try {
      if (purgeTarget.type === "resource") await cmd.purgeResource(purgeTarget.id);
      else await cmd.purgeFolder(purgeTarget.id);
      toast.success("已彻底删除");
    } catch {
      toast.error("删除失败");
    }
    setPurgeTarget(null);
  };

  const empty = resources.length === 0 && folders.length === 0;

  return (
    <div className={styles.container}>
      <div className={styles.header}>回收站</div>
      {empty && <div className={styles.empty}>回收站为空</div>}

      {folders.length > 0 && (
        <>
          <div className={styles.sectionLabel}>文件夹</div>
          {folders.map((f) => (
            <div key={f.id} className={styles.item}>
              <div className={styles.itemInfo}>
                <span className={styles.itemName}>{f.name}</span>
                <span className={styles.itemDate}>
                  {new Date(f.deleted_at).toLocaleDateString()}
                </span>
              </div>
              <div className={styles.itemActions}>
                <button onClick={() => handleRestore("folder", f.id)}>恢复</button>
                <button
                  className={styles.dangerBtn}
                  onClick={() =>
                    setPurgeTarget({ type: "folder", id: f.id, name: f.name })
                  }
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </>
      )}

      {resources.length > 0 && (
        <>
          <div className={styles.sectionLabel}>资料</div>
          {resources.map((r) => (
            <div key={r.id} className={styles.item}>
              <div className={styles.itemInfo}>
                <span className={styles.itemName}>{r.title}</span>
                <span className={styles.itemDate}>
                  {new Date(r.deleted_at).toLocaleDateString()}
                </span>
              </div>
              <div className={styles.itemActions}>
                <button onClick={() => handleRestore("resource", r.id)}>恢复</button>
                <button
                  className={styles.dangerBtn}
                  onClick={() =>
                    setPurgeTarget({ type: "resource", id: r.id, name: r.title })
                  }
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </>
      )}

      {purgeTarget && (
        <Modal title="确认彻底删除" onClose={() => setPurgeTarget(null)}>
          <p style={{ marginBottom: "16px" }}>
            确定要彻底删除「{purgeTarget.name}」吗？此操作无法撤销。
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
              取消
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
              彻底删除
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
