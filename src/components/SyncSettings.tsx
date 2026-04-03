import { useState, useEffect, useCallback } from "react";
import * as cmd from "@/lib/commands";
import type { SyncConfig } from "@/types";
import toast from "react-hot-toast";
import styles from "./SyncSettings.module.css";

interface SyncSettingsProps {
  onClose: () => void;
}

export function SyncSettings({ onClose }: SyncSettingsProps) {
  const [config, setConfig] = useState<SyncConfig | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [region, setRegion] = useState("");
  const [bucket, setBucket] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadConfig = useCallback(async () => {
    try {
      const cfg = await cmd.getSyncConfig();
      setConfig(cfg);
      setEndpoint(cfg.endpoint ?? "");
      setRegion(cfg.region ?? "");
      setBucket(cfg.bucket ?? "");
    } catch {
      // config may not exist yet; leave fields empty
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  async function handleTest() {
    setTesting(true);
    try {
      const ok = await cmd.testS3Connection();
      if (ok) {
        toast.success("连接成功");
      } else {
        toast.error("连接失败");
      }
    } catch (err) {
      toast.error(`连接失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      await cmd.saveSyncConfig(endpoint, region, bucket, accessKey, secretKey);
      toast.success("配置已保存");
      setAccessKey("");
      setSecretKey("");
      await loadConfig();
    } catch (err) {
      toast.error(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  const hasCredentials = config?.has_credentials ?? false;
  const credentialPlaceholder = hasCredentials ? "(已保存，留空保持不变)" : "";

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <span className={styles.title}>S3 同步设置</span>
          <button className={styles.closeBtn} onClick={onClose}>
            &times;
          </button>
        </div>

        <div className={styles.body}>
          <div className={styles.warning}>
            当前版本数据以明文存储在 S3。请确保 bucket 访问权限设置正确。端到端加密将在后续版本中支持。
          </div>

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
        </div>
      </div>
    </div>
  );
}
