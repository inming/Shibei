import { useState, useEffect, useCallback } from "react";
import * as cmd from "@/lib/commands";
import type { SyncConfig } from "@/types";
import toast from "react-hot-toast";
import styles from "./SyncSettings.module.css";

function formatError(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: string }).message);
  }
  return String(err);
}

interface SyncSettingsProps {
  onClose: () => void;
  intervalMinutes: number;
  onIntervalChange: (minutes: number) => void;
}

export function SyncSettings({ onClose, intervalMinutes, onIntervalChange }: SyncSettingsProps) {
  const [config, setConfig] = useState<SyncConfig | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [region, setRegion] = useState("");
  const [bucket, setBucket] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [interval, setInterval_] = useState(intervalMinutes);
  const [encryptionEnabled, setEncryptionEnabled] = useState(false);
  const [encryptionUnlocked, setEncryptionUnlocked] = useState(false);
  const [showPasswordDialog, setShowPasswordDialog] = useState<"setup" | "unlock" | "change" | null>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [oldPassword, setOldPassword] = useState("");
  const [encryptionLoading, setEncryptionLoading] = useState(false);

  const loadConfig = useCallback(async () => {
    try {
      const cfg = await cmd.getSyncConfig();
      setConfig(cfg);
      setEndpoint(cfg.endpoint ?? "");
      setRegion(cfg.region ?? "");
      setBucket(cfg.bucket ?? "");
      setInterval_(cfg.sync_interval ?? 5);
    } catch {
      // config may not exist yet; leave fields empty
    }
    try {
      const es = await cmd.getEncryptionStatus();
      setEncryptionEnabled(es.enabled);
      setEncryptionUnlocked(es.unlocked);
    } catch {
      // encryption status not available
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

  function resetPasswordFields() {
    setPassword("");
    setConfirmPassword("");
    setOldPassword("");
    setShowPasswordDialog(null);
  }

  async function handleSetupEncryption() {
    if (password.length < 8) {
      toast.error("密码至少 8 个字符");
      return;
    }
    if (password !== confirmPassword) {
      toast.error("两次输入的密码不一致");
      return;
    }
    setEncryptionLoading(true);
    try {
      await cmd.setupEncryption(password);
      toast.success("端到端加密已启用，正在重新同步...");
      setEncryptionEnabled(true);
      setEncryptionUnlocked(true);
      resetPasswordFields();
    } catch (err) {
      toast.error(`启用加密失败：${formatError(err)}`);
    } finally {
      setEncryptionLoading(false);
    }
  }

  async function handleUnlockEncryption() {
    setEncryptionLoading(true);
    try {
      await cmd.unlockEncryption(password);
      toast.success("加密已解锁");
      setEncryptionUnlocked(true);
      resetPasswordFields();
    } catch (err) {
      toast.error(`解锁失败：${formatError(err)}`);
    } finally {
      setEncryptionLoading(false);
    }
  }

  async function handleChangePassword() {
    if (password.length < 8) {
      toast.error("新密码至少 8 个字符");
      return;
    }
    if (password !== confirmPassword) {
      toast.error("两次输入的新密码不一致");
      return;
    }
    setEncryptionLoading(true);
    try {
      await cmd.changeEncryptionPassword(oldPassword, password);
      toast.success("加密密码已修改");
      resetPasswordFields();
    } catch (err) {
      toast.error(`修改密码失败：${formatError(err)}`);
    } finally {
      setEncryptionLoading(false);
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
          <div className={styles.encryptionSection}>
            {!encryptionEnabled ? (
              <>
                <div className={styles.warning}>
                  数据以明文存储在 S3。建议启用端到端加密以保护数据安全。
                </div>
                <button
                  className={styles.secondary}
                  onClick={() => setShowPasswordDialog("setup")}
                >
                  启用端到端加密
                </button>
              </>
            ) : !encryptionUnlocked ? (
              <>
                <div className={styles.info}>
                  端到端加密已启用，需要输入密码后才能同步。
                </div>
                <button
                  className={styles.primary}
                  onClick={() => setShowPasswordDialog("unlock")}
                >
                  输入加密密码
                </button>
              </>
            ) : (
              <>
                <div className={styles.success}>
                  端到端加密已启用且已解锁
                </div>
                <button
                  className={styles.secondary}
                  onClick={() => setShowPasswordDialog("change")}
                >
                  修改加密密码
                </button>
              </>
            )}
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

          {showPasswordDialog && (
            <div className={styles.passwordDialog}>
              <div className={styles.passwordHeader}>
                {showPasswordDialog === "setup" && "设置加密密码"}
                {showPasswordDialog === "unlock" && "输入加密密码"}
                {showPasswordDialog === "change" && "修改加密密码"}
              </div>
              {showPasswordDialog === "change" && (
                <label className={styles.label}>
                  <span>旧密码</span>
                  <input
                    type="password"
                    className={styles.input}
                    value={oldPassword}
                    onChange={(e) => setOldPassword(e.target.value)}
                  />
                </label>
              )}
              <label className={styles.label}>
                <span>{showPasswordDialog === "change" ? "新密码" : "密码"}</span>
                <input
                  type="password"
                  className={styles.input}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="至少 8 个字符"
                />
              </label>
              {showPasswordDialog !== "unlock" && (
                <label className={styles.label}>
                  <span>确认密码</span>
                  <input
                    type="password"
                    className={styles.input}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                  />
                </label>
              )}
              <div className={styles.actions}>
                <button
                  className={styles.secondary}
                  onClick={resetPasswordFields}
                  disabled={encryptionLoading}
                >
                  取消
                </button>
                <button
                  className={styles.primary}
                  onClick={() => {
                    if (showPasswordDialog === "setup") handleSetupEncryption();
                    else if (showPasswordDialog === "unlock") handleUnlockEncryption();
                    else handleChangePassword();
                  }}
                  disabled={encryptionLoading}
                >
                  {encryptionLoading ? "处理中…" : "确认"}
                </button>
              </div>
            </div>
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
