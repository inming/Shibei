import type { SyncStatusType } from "@/hooks/useSync";
import styles from "./SyncStatus.module.css";

interface SyncProgress {
  phase: string;
  current: number;
  total: number;
}

interface SyncStatusProps {
  status: SyncStatusType;
  lastSyncAt: string;
  onSync: () => void;
  onOpenSettings: (section?: "sync" | "encryption") => void;
  encryptionEnabled?: boolean;
  encryptionUnlocked?: boolean;
  autoUnlockPending?: boolean;
  syncProgress?: SyncProgress | null;
}

export function SyncStatus({
  status, lastSyncAt, onSync, onOpenSettings,
  encryptionEnabled, encryptionUnlocked, autoUnlockPending, syncProgress,
}: SyncStatusProps) {
  const needsUnlock = encryptionEnabled && !encryptionUnlocked && !autoUnlockPending;

  const icon = { idle: "○", syncing: "↻", success: "✓", error: "✗" }[status];

  function getSyncLabel(): string {
    if (needsUnlock) return "需解锁";
    if (autoUnlockPending) return "正在检查...";
    if (status === "syncing" && syncProgress) {
      if (syncProgress.phase === "uploading") {
        return `上传 ${syncProgress.current}/${syncProgress.total}`;
      }
      if (syncProgress.phase === "downloading") {
        return `下载 ${syncProgress.current}/${syncProgress.total}`;
      }
    }
    return { idle: "未同步", syncing: "同步中...", success: "已同步", error: "同步失败" }[status];
  }

  const label = getSyncLabel();
  const isSpinning = status === "syncing" || autoUnlockPending;
  const displayIcon = autoUnlockPending ? "↻" : icon;

  return (
    <div className={styles.container}>
      {encryptionEnabled && !autoUnlockPending && (
        <span className={styles.lock} title={needsUnlock ? "需要输入加密密码" : "端到端加密已启用"}>
          {needsUnlock ? "🔐" : "🔒"}
        </span>
      )}
      <button
        className={`${styles.syncBtn} ${styles[status]}`}
        onClick={needsUnlock ? () => onOpenSettings("encryption") : (autoUnlockPending ? undefined : onSync)}
        disabled={status === "syncing" || autoUnlockPending}
        title={needsUnlock ? "需要输入加密密码" : lastSyncAt ? `最后同步: ${new Date(lastSyncAt).toLocaleString()}` : "点击同步"}
      >
        <span className={isSpinning ? styles.spinning : ""}>{displayIcon}</span>
        <span>{label}</span>
      </button>
      <button className={styles.gear} onClick={() => onOpenSettings()} title="同步设置">⚙</button>
    </div>
  );
}
