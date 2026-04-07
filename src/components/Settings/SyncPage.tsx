import { useState, useEffect, useCallback } from "react";
import * as cmd from "@/lib/commands";
import type { SyncConfig } from "@/types";
import toast from "react-hot-toast";
import styles from "./Settings.module.css";

function formatError(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: string }).message);
  }
  return String(err);
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
          </div>
        </>
      )}
    </>
  );
}
