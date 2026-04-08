import { useState, useEffect, useCallback } from "react";
import * as cmd from "@/lib/commands";
import type { SyncConfig } from "@/types";
import type { OrphanScanResult } from "@/lib/commands";
import toast from "react-hot-toast";
import { Modal } from "@/components/Modal";
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
  const [config, setConfig] = useState<SyncConfig | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [region, setRegion] = useState("");
  const [bucket, setBucket] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [interval, setInterval_] = useState(intervalMinutes);

  // Orphan cleanup state
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<OrphanScanResult | null>(null);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [confirmInput, setConfirmInput] = useState("");
  const [purging, setPurging] = useState(false);

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
        toast.success("连接成功");
      } else {
        toast.error("连接失败");
      }
    } catch (err) {
      toast.error(`连接失败：${formatError(err)}`);
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    if (!region || !bucket) {
      toast.error("Region 和 Bucket 为必填项");
      return;
    }
    if (!hasCredentials && (!accessKey || !secretKey)) {
      toast.error("首次配置需填写 Access Key 和 Secret Key");
      return;
    }
    setSaving(true);
    try {
      await cmd.saveSyncConfig(
        endpoint, region, bucket,
        accessKey || "__keep__",
        secretKey || "__keep__",
      );
      toast.success("配置已保存");
      setAccessKey("");
      setSecretKey("");
      await loadConfig();
    } catch (err) {
      toast.error(`保存失败：${formatError(err)}`);
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
      toast.error(`扫描失败：${formatError(err)}`);
    } finally {
      setScanning(false);
    }
  }

  async function handlePurgeOrphans() {
    setPurging(true);
    try {
      const result = await cmd.purgeOrphanSnapshots();
      toast.success(`已删除 ${result.deleted} 个文件，释放 ${formatSize(result.freed_bytes)}`);
      setScanResult(null);
      setShowConfirmModal(false);
      setConfirmInput("");
    } catch (err) {
      toast.error(`清理失败：${formatError(err)}`);
    } finally {
      setPurging(false);
    }
  }

  const hasCredentials = config?.has_credentials ?? false;
  const credentialPlaceholder = hasCredentials ? "(已保存，留空保持不变)" : "";

  return (
    <>
      <h2 className={styles.heading}>同步设置</h2>

      <div className={styles.form}>
        <label className={styles.label}>
          <span>Endpoint（可选，留空使用 AWS 默认）</span>
          <input
            type="text"
            className={styles.input}
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://s3.example.com"
          />
        </label>

        <label className={styles.label}>
          <span>Region</span>
          <input
            type="text"
            className={styles.input}
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            placeholder="us-east-1"
          />
        </label>

        <label className={styles.label}>
          <span>Bucket</span>
          <input
            type="text"
            className={styles.input}
            value={bucket}
            onChange={(e) => setBucket(e.target.value)}
            placeholder="my-shibei-bucket"
          />
        </label>

        <label className={styles.label}>
          <span>Access Key</span>
          <input
            type="password"
            className={styles.input}
            value={accessKey}
            onChange={(e) => setAccessKey(e.target.value)}
            placeholder={credentialPlaceholder}
          />
        </label>

        <label className={styles.label}>
          <span>Secret Key</span>
          <input
            type="password"
            className={styles.input}
            value={secretKey}
            onChange={(e) => setSecretKey(e.target.value)}
            placeholder={credentialPlaceholder}
          />
        </label>

        <label className={styles.label}>
          <span>自动同步间隔</span>
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
            <option value={0}>关闭</option>
            <option value={1}>1 分钟</option>
            <option value={3}>3 分钟</option>
            <option value={5}>5 分钟</option>
            <option value={10}>10 分钟</option>
            <option value={30}>30 分钟</option>
          </select>
        </label>
      </div>

      {config?.last_sync_at && (
        <p className={styles.lastSync}>
          上次同步：{new Date(config.last_sync_at).toLocaleString("zh-CN")}
        </p>
      )}

      <div className={styles.actions}>
        <button
          className={styles.secondary}
          onClick={handleTest}
          disabled={testing}
        >
          {testing ? "测试中…" : "测试连接"}
        </button>
        <button
          className={styles.primary}
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? "保存中…" : "保存配置"}
        </button>
      </div>

      {hasCredentials && (
        <>
          <h3 className={styles.subheading}>维护</h3>
          <div className={styles.actions}>
            <button
              className={styles.secondary}
              onClick={async () => {
                setCompacting(true);
                try {
                  const result = await cmd.forceCompact();
                  toast.success(result);
                } catch (err) {
                  toast.error(`压缩失败：${formatError(err)}`);
                } finally {
                  setCompacting(false);
                }
              }}
              disabled={compacting}
            >
              {compacting ? "压缩中…" : "强制压缩"}
            </button>
            <button
              className={styles.secondary}
              onClick={handleScanOrphans}
              disabled={scanning}
            >
              {scanning ? "扫描中…" : "清理孤儿文件"}
            </button>
          </div>

          {/* Scan result panel */}
          {scanResult && (
            <div className={styles.info} style={{ marginTop: "var(--spacing-md)" }}>
              {scanResult.count === 0 ? (
                <span>未发现孤儿文件</span>
              ) : (
                <>
                  <div>
                    发现 <strong>{scanResult.count}</strong> 个孤儿文件（共 {formatSize(scanResult.total_size)}）
                  </div>
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
                      取消
                    </button>
                    <button
                      className={styles.danger}
                      onClick={() => {
                        setConfirmInput("");
                        setShowConfirmModal(true);
                      }}
                    >
                      开始清理
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}

      {/* Confirm modal */}
      {showConfirmModal && scanResult && scanResult.count > 0 && (
        <Modal
          title="清理孤儿文件"
          onClose={() => {
            setShowConfirmModal(false);
            setConfirmInput("");
          }}
        >
          <p style={{ margin: "0 0 var(--spacing-sm)", fontSize: "var(--font-size-sm)" }}>
            即将永久删除 <strong>{scanResult.count}</strong> 个文件（共 {formatSize(scanResult.total_size)}）
          </p>
          <div className={styles.warning}>
            <ul className={styles.warningList}>
              <li>删除后不可恢复</li>
              <li>如果有其他设备尚未同步，可能导致数据丢失</li>
              <li>请确保所有设备已完成至少一次同步</li>
            </ul>
          </div>
          <p style={{ margin: "var(--spacing-md) 0 0", fontSize: "var(--font-size-sm)" }}>
            请输入 <strong>{scanResult.count}</strong> 以确认：
          </p>
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
              取消
            </button>
            <button
              className={styles.danger}
              disabled={confirmInput !== String(scanResult.count) || purging}
              onClick={handlePurgeOrphans}
            >
              {purging ? "删除中…" : "永久删除"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
