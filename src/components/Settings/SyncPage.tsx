import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import * as cmd from "@/lib/commands";
import type { SyncConfig } from "@/types";
import type { OrphanScanResult } from "@/lib/commands";
import toast from "react-hot-toast";
import { Modal } from "@/components/Modal";
import { PairingDialog } from "./PairingDialog";
import styles from "./Settings.module.css";

function formatError(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: string }).message);
  }
  return String(err);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface SyncPageProps {
  intervalMinutes: number;
  onIntervalChange: (minutes: number) => void;
}

export function SyncPage({ intervalMinutes, onIntervalChange }: SyncPageProps) {
  const { t, i18n } = useTranslation('sync');
  const [config, setConfig] = useState<SyncConfig | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [region, setRegion] = useState("");
  const [bucket, setBucket] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [resettingCursors, setResettingCursors] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [interval, setInterval_] = useState(intervalMinutes);

  // Orphan cleanup state
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<OrphanScanResult | null>(null);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [confirmInput, setConfirmInput] = useState("");
  const [purging, setPurging] = useState(false);

  // Pairing dialog
  const [pairingOpen, setPairingOpen] = useState(false);

  const loadConfig = useCallback(async () => {
    try {
      const cfg = await cmd.getSyncConfig();
      setConfig(cfg);
      setEndpoint(cfg.endpoint ?? "");
      setRegion(cfg.region ?? "");
      setBucket(cfg.bucket ?? "");
      setInterval_(cfg.sync_interval ?? 5);
    } catch {
      // config may not exist yet
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  async function handleTest() {
    setTesting(true);
    try {
      const ok = await cmd.testS3Connection(
        endpoint, region, bucket,
        accessKey || "__keep__",
        secretKey || "__keep__",
      );
      if (ok) {
        toast.success(t('connectionSuccess'));
      } else {
        toast.error(t('connectionFailed'));
      }
    } catch (err) {
      toast.error(t('connectionFailedWithError', { error: formatError(err) }));
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    if (!region || !bucket) {
      toast.error(t('regionBucketRequired'));
      return;
    }
    if (!hasCredentials && (!accessKey || !secretKey)) {
      toast.error(t('credentialsRequired'));
      return;
    }
    setSaving(true);
    try {
      await cmd.saveSyncConfig(
        endpoint, region, bucket,
        accessKey || "__keep__",
        secretKey || "__keep__",
      );
      toast.success(t('configSaved'));
      setAccessKey("");
      setSecretKey("");
      await loadConfig();
    } catch (err) {
      toast.error(t('saveFailed', { error: formatError(err) }));
    } finally {
      setSaving(false);
    }
  }

  async function handleScanOrphans() {
    setScanning(true);
    setScanResult(null);
    try {
      const result = await cmd.listOrphanSnapshots();
      setScanResult(result);
    } catch (err) {
      toast.error(t('scanFailed', { error: formatError(err) }));
    } finally {
      setScanning(false);
    }
  }

  async function handleResetCursors() {
    setResettingCursors(true);
    try {
      const removed = await cmd.resetSyncCursors();
      toast.success(t('resetCursorsSuccess', { count: removed }));
      setShowResetConfirm(false);
    } catch (err) {
      toast.error(t('resetCursorsFailed', { error: formatError(err) }));
    } finally {
      setResettingCursors(false);
    }
  }

  async function handlePurgeOrphans() {
    setPurging(true);
    try {
      const result = await cmd.purgeOrphanSnapshots();
      toast.success(t('purgeSuccess', { deleted: result.deleted, size: formatSize(result.freed_bytes) }));
      setScanResult(null);
      setShowConfirmModal(false);
      setConfirmInput("");
    } catch (err) {
      toast.error(t('purgeFailed', { error: formatError(err) }));
    } finally {
      setPurging(false);
    }
  }

  const hasCredentials = config?.has_credentials ?? false;
  const credentialPlaceholder = hasCredentials ? t('credentialPlaceholder') : "";

  return (
    <>
      <h2 className={styles.heading}>{t('title')}</h2>

      <div className={styles.form}>
        <h3 className={styles.subheading}>{t('connection')}</h3>
        <label className={styles.label}>
          <span>{t('endpointLabel')}</span>
          <input
            type="text"
            className={styles.input}
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://s3.example.com"
          />
        </label>

        <label className={styles.label}>
          <span>{t('regionLabel')}</span>
          <input
            type="text"
            className={styles.input}
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            placeholder="us-east-1"
          />
        </label>

        <label className={styles.label}>
          <span>{t('bucketLabel')}</span>
          <input
            type="text"
            className={styles.input}
            value={bucket}
            onChange={(e) => setBucket(e.target.value)}
            placeholder="my-shibei-bucket"
          />
        </label>

        <label className={styles.label}>
          <span>{t('accessKeyLabel')}</span>
          <input
            type="password"
            className={styles.input}
            value={accessKey}
            onChange={(e) => setAccessKey(e.target.value)}
            placeholder={credentialPlaceholder}
          />
        </label>

        <label className={styles.label}>
          <span>{t('secretKeyLabel')}</span>
          <input
            type="password"
            className={styles.input}
            value={secretKey}
            onChange={(e) => setSecretKey(e.target.value)}
            placeholder={credentialPlaceholder}
          />
        </label>

        <label className={styles.label}>
          <span>{t('autoSyncInterval')}</span>
          <select
            className={styles.input}
            value={interval}
            onChange={(e) => {
              const v = Number(e.target.value);
              setInterval_(v);
              cmd.setSyncInterval(v);
              onIntervalChange(v);
            }}
          >
            <option value={0}>{t('intervalOff')}</option>
            <option value={1}>{t('intervalMinute', { count: 1 })}</option>
            <option value={3}>{t('intervalMinute', { count: 3 })}</option>
            <option value={5}>{t('intervalMinute', { count: 5 })}</option>
            <option value={10}>{t('intervalMinute', { count: 10 })}</option>
            <option value={30}>{t('intervalMinute', { count: 30 })}</option>
          </select>
        </label>
      </div>

      {config?.last_sync_at && (
        <p className={styles.lastSync}>
          {t('lastSync', { time: new Date(config.last_sync_at).toLocaleString(i18n.language === 'zh' ? 'zh-CN' : 'en-US') })}
        </p>
      )}

      <div className={styles.actions}>
        <button
          className={styles.secondary}
          onClick={handleTest}
          disabled={testing}
        >
          {testing ? t('testing') : t('testConnection')}
        </button>
        <button
          className={styles.primary}
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? t('saving') : t('saveConfig')}
        </button>
        <button
          className={styles.secondary}
          onClick={() => setPairingOpen(true)}
          disabled={!hasCredentials || !bucket}
          title={(!hasCredentials || !bucket) ? t('pairing.disabledTooltip') : undefined}
        >
          {t('addMobileDevice')}
        </button>
      </div>

      {pairingOpen && <PairingDialog onClose={() => setPairingOpen(false)} />}

      {hasCredentials && (
        <div className={styles.passwordSection}>
          <h3 className={styles.subheading}>{t('maintenance')}</h3>
          <div className={styles.actions}>
            <button
              className={styles.secondary}
              onClick={async () => {
                setCompacting(true);
                try {
                  const result = await cmd.forceCompact();
                  toast.success(result);
                } catch (err) {
                  toast.error(t('compactFailed', { error: formatError(err) }));
                } finally {
                  setCompacting(false);
                }
              }}
              disabled={compacting}
            >
              {compacting ? t('compacting') : t('forceCompact')}
            </button>
            <button
              className={styles.secondary}
              onClick={handleScanOrphans}
              disabled={scanning}
            >
              {scanning ? t('scanning') : t('cleanOrphans')}
            </button>
            <button
              className={styles.secondary}
              onClick={() => setShowResetConfirm(true)}
              disabled={resettingCursors}
              title={t('resetCursorsTooltip')}
            >
              {resettingCursors ? t('resettingCursors') : t('resetCursors')}
            </button>
          </div>
          <p className={styles.lastSync}>{t('resetCursorsHelp')}</p>

          {/* Scan result panel */}
          {scanResult && (
            <div className={styles.info} style={{ marginTop: "var(--spacing-md)" }}>
              {scanResult.count === 0 ? (
                <span>{t('noOrphansFound')}</span>
              ) : (
                <>
                  <div dangerouslySetInnerHTML={{ __html: t('orphansFound', { count: scanResult.count, size: formatSize(scanResult.total_size) }) }} />
                  <div className={styles.orphanList}>
                    {scanResult.items.map((item) => (
                      <div key={item.resource_id}>
                        {item.resource_id}  {formatSize(item.size)}
                      </div>
                    ))}
                  </div>
                  <div className={styles.modalActions}>
                    <button
                      className={styles.secondary}
                      onClick={() => setScanResult(null)}
                    >
                      {t('cancel')}
                    </button>
                    <button
                      className={styles.danger}
                      onClick={() => {
                        setConfirmInput("");
                        setShowConfirmModal(true);
                      }}
                    >
                      {t('startCleanup')}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Confirm modal */}
      {showConfirmModal && scanResult && scanResult.count > 0 && (
        <Modal
          title={t('cleanOrphansTitle')}
          onClose={() => {
            setShowConfirmModal(false);
            setConfirmInput("");
          }}
        >
          <p style={{ margin: "0 0 var(--spacing-sm)", fontSize: "var(--font-size-sm)" }}
            dangerouslySetInnerHTML={{ __html: t('confirmDeleteMessage', { count: scanResult.count, size: formatSize(scanResult.total_size) }) }}
          />
          <div className={styles.warning}>
            <ul className={styles.warningList}>
              <li>{t('warningIrreversible')}</li>
              <li>{t('warningDataLoss')}</li>
              <li>{t('warningEnsureSync')}</li>
            </ul>
          </div>
          <p style={{ margin: "var(--spacing-md) 0 0", fontSize: "var(--font-size-sm)" }}
            dangerouslySetInnerHTML={{ __html: t('confirmCountPrompt', { count: scanResult.count }) }}
          />
          <input
            type="text"
            className={styles.confirmInput}
            value={confirmInput}
            onChange={(e) => setConfirmInput(e.target.value)}
            placeholder={String(scanResult.count)}
            autoFocus
          />
          <div className={styles.modalActions}>
            <button
              className={styles.secondary}
              onClick={() => {
                setShowConfirmModal(false);
                setConfirmInput("");
              }}
            >
              {t('cancel')}
            </button>
            <button
              className={styles.danger}
              disabled={confirmInput !== String(scanResult.count) || purging}
              onClick={handlePurgeOrphans}
            >
              {purging ? t('purging') : t('permanentDelete')}
            </button>
          </div>
        </Modal>
      )}

      {showResetConfirm && (
        <Modal
          title={t('resetCursorsTitle')}
          onClose={() => setShowResetConfirm(false)}
        >
          <p style={{ margin: "0 0 var(--spacing-md)", fontSize: "var(--font-size-sm)" }}>
            {t('resetCursorsConfirmBody')}
          </p>
          <div className={styles.modalActions}>
            <button
              className={styles.secondary}
              onClick={() => setShowResetConfirm(false)}
            >
              {t('cancel')}
            </button>
            <button
              className={styles.primary}
              disabled={resettingCursors}
              onClick={handleResetCursors}
            >
              {resettingCursors ? t('resettingCursors') : t('resetCursorsConfirm')}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
