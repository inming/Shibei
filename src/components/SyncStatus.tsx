import { useTranslation } from "react-i18next";
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
  lockEnabled?: boolean;
  onLock?: () => void;
}

export function SyncStatus({
  status, lastSyncAt, onSync, onOpenSettings,
  encryptionEnabled, encryptionUnlocked, autoUnlockPending, syncProgress,
  lockEnabled, onLock,
}: SyncStatusProps) {
  const { t, i18n } = useTranslation('sync');
  const needsUnlock = encryptionEnabled && !encryptionUnlocked && !autoUnlockPending;

  const icon = { idle: "○", syncing: "↻", success: "✓", error: "✗" }[status];

  function getSyncLabel(): string {
    if (needsUnlock) return t('needsUnlock');
    if (autoUnlockPending) return t('autoUnlockChecking');
    if (status === "syncing" && syncProgress) {
      if (syncProgress.phase === "uploading") {
        return t('uploading', { current: syncProgress.current, total: syncProgress.total });
      }
      if (syncProgress.phase === "downloading") {
        return t('downloading', { current: syncProgress.current, total: syncProgress.total });
      }
    }
    return { idle: t('statusIdle'), syncing: t('statusSyncing'), success: t('statusSuccess'), error: t('statusError') }[status];
  }

  const label = getSyncLabel();
  const isSpinning = status === "syncing" || autoUnlockPending;
  const displayIcon = autoUnlockPending ? "↻" : icon;

  return (
    <div className={styles.container}>
      {encryptionEnabled && !autoUnlockPending && (
        <span className={styles.lock} title={needsUnlock ? t('needsPasswordTitle') : t('encryptionEnabledTitle')}>
          {needsUnlock ? "🔐" : "🔒"}
        </span>
      )}
      <button
        className={`${styles.syncBtn} ${styles[status]}`}
        onClick={needsUnlock ? () => onOpenSettings("encryption") : (autoUnlockPending ? undefined : onSync)}
        disabled={status === "syncing" || autoUnlockPending}
        title={needsUnlock ? t('needsPasswordTitle') : lastSyncAt ? t('lastSyncTitle', { time: new Date(lastSyncAt).toLocaleString(i18n.language === 'zh' ? 'zh-CN' : 'en-US') }) : t('clickToSync')}
      >
        <span className={isSpinning ? styles.spinning : ""}>{displayIcon}</span>
        <span>{label}</span>
      </button>
      <button className={styles.gear} onClick={() => onOpenSettings()} title={t('syncSettings')}>⚙</button>
      {lockEnabled && onLock && (
        <button className={styles.gear} onClick={onLock} title={t('lockApp')}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="7" width="10" height="8" rx="1.5" />
            <path d="M5 7V5a3 3 0 0 1 6 0v2" />
          </svg>
        </button>
      )}
    </div>
  );
}
