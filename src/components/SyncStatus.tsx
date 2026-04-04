import type { SyncStatusType } from "@/hooks/useSync";
import styles from "./SyncStatus.module.css";

interface SyncStatusProps {
  status: SyncStatusType;
  lastSyncAt: string;
  onSync: () => void;
  onOpenSettings: (section?: "sync" | "encryption") => void;
  encryptionEnabled?: boolean;
  encryptionUnlocked?: boolean;
  autoUnlockPending?: boolean;
}

export function SyncStatus({
  status, lastSyncAt, onSync, onOpenSettings,
  encryptionEnabled, encryptionUnlocked, autoUnlockPending,
}: SyncStatusProps) {
  const label = { idle: "未同步", syncing: "同步中...", success: "已同步", error: "同步失败" }[status];
  const icon = { idle: "○", syncing: "↻", success: "✓", error: "✗" }[status];
  const needsUnlock = encryptionEnabled && !encryptionUnlocked && !autoUnlockPending;

  return (
    <div className={styles.container}>
      {encryptionEnabled && !autoUnlockPending && (
        <span className={styles.lock} title={needsUnlock ? "需要输入加密密码" : "端到端加密已启用"}>
          {needsUnlock ? "🔐" : "🔒"}
        </span>
      )}
      {autoUnlockPending ? (
        <span className={styles.btn}>
          <span className={styles.spinning}>↻</span>
          <span className={styles.text}>正在检查...</span>
        </span>
      ) : (
        <button className={`${styles.btn} ${styles[status]}`} onClick={needsUnlock ? () => onOpenSettings("encryption") : onSync}
          disabled={status === "syncing"}
          title={needsUnlock ? "需要输入加密密码" : lastSyncAt ? `最后同步: ${new Date(lastSyncAt).toLocaleString()}` : "点击同步"}>
          <span className={status === "syncing" ? styles.spinning : ""}>{icon}</span>
          <span className={styles.text}>{needsUnlock ? "需解锁" : label}</span>
        </button>
      )}
      <button className={styles.gear} onClick={() => onOpenSettings()} title="同步设置">⚙</button>
    </div>
  );
}
