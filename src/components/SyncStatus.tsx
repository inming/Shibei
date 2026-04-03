import type { SyncStatusType } from "@/hooks/useSync";
import styles from "./SyncStatus.module.css";

interface SyncStatusProps {
  status: SyncStatusType;
  lastSyncAt: string;
  onSync: () => void;
  onOpenSettings: () => void;
}

export function SyncStatus({ status, lastSyncAt, onSync, onOpenSettings }: SyncStatusProps) {
  const label = { idle: "未同步", syncing: "同步中...", success: "已同步", error: "同步失败" }[status];
  const icon = { idle: "○", syncing: "↻", success: "✓", error: "✗" }[status];

  return (
    <div className={styles.container}>
      <button className={`${styles.btn} ${styles[status]}`} onClick={onSync}
        disabled={status === "syncing"}
        title={lastSyncAt ? `最后同步: ${new Date(lastSyncAt).toLocaleString()}` : "点击同步"}>
        <span className={status === "syncing" ? styles.spinning : ""}>{icon}</span>
        <span className={styles.text}>{label}</span>
      </button>
      <button className={styles.gear} onClick={onOpenSettings} title="同步设置">⚙</button>
    </div>
  );
}
