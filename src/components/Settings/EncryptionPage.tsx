import { useState, useEffect, useCallback } from "react";
import * as cmd from "@/lib/commands";
import toast from "react-hot-toast";
import styles from "./Settings.module.css";

function formatError(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: string }).message);
  }
  return String(err);
}

export function EncryptionPage() {
  const [encryptionEnabled, setEncryptionEnabled] = useState(false);
  const [encryptionUnlocked, setEncryptionUnlocked] = useState(false);
  const [rememberKey, setRememberKey] = useState(false);
  const [showPasswordDialog, setShowPasswordDialog] = useState<"setup" | "unlock" | "change" | null>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [oldPassword, setOldPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const es = await cmd.getEncryptionStatus();
      setEncryptionEnabled(es.enabled);
      setEncryptionUnlocked(es.unlocked);
      setRememberKey(es.remember_key);
    } catch {
      // encryption status not available
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

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
    setLoading(true);
    try {
      await cmd.setupEncryption(password);
      toast.success("端到端加密已启用，正在重新同步...");
      setEncryptionEnabled(true);
      setEncryptionUnlocked(true);
      resetPasswordFields();
    } catch (err) {
      toast.error(`启用加密失败：${formatError(err)}`);
    } finally {
      setLoading(false);
    }
  }

  async function handleUnlockEncryption() {
    setLoading(true);
    try {
      await cmd.unlockEncryption(password);
      toast.success("加密已解锁");
      setEncryptionUnlocked(true);
      resetPasswordFields();
      void loadStatus();
    } catch (err) {
      toast.error(`解锁失败：${formatError(err)}`);
    } finally {
      setLoading(false);
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
    setLoading(true);
    try {
      await cmd.changeEncryptionPassword(oldPassword, password);
      toast.success("加密密码已修改");
      resetPasswordFields();
    } catch (err) {
      toast.error(`修改密码失败：${formatError(err)}`);
    } finally {
      setLoading(false);
    }
  }

  async function handleToggleRememberKey() {
    const newValue = !rememberKey;
    try {
      await cmd.setRememberKey(newValue);
      setRememberKey(newValue);
      toast.success(newValue ? "已保存到系统钥匙串" : "已从系统钥匙串移除");
    } catch (err) {
      toast.error(`操作失败：${formatError(err)}`);
    }
  }

  return (
    <>
      <h2 className={styles.heading}>端到端加密</h2>

      {!encryptionEnabled ? (
        <>
          <div className={styles.warning}>
            数据以明文存储在 S3。建议启用端到端加密以保护数据安全。
          </div>
          <div className={styles.actions}>
            <button
              className={styles.primary}
              onClick={() => setShowPasswordDialog("setup")}
            >
              启用端到端加密
            </button>
          </div>
        </>
      ) : !encryptionUnlocked ? (
        <>
          <div className={styles.info}>
            端到端加密已启用，需要输入密码后才能同步。
          </div>
          <div className={styles.actions}>
            <button
              className={styles.primary}
              onClick={() => setShowPasswordDialog("unlock")}
            >
              输入加密密码
            </button>
          </div>
        </>
      ) : (
        <>
          <div className={styles.success}>
            端到端加密已启用且已解锁
          </div>
          <label className={styles.toggleRow}>
            <input
              type="checkbox"
              checked={rememberKey}
              onChange={handleToggleRememberKey}
            />
            <span>记住加密密钥</span>
          </label>
          <div className={styles.hint}>
            将加密密钥保存在系统钥匙串中，启动时自动解锁。macOS 可能需要系统密码或 TouchID 验证。
          </div>
          <div className={styles.actions}>
            <button
              className={styles.secondary}
              onClick={() => setShowPasswordDialog("change")}
            >
              修改加密密码
            </button>
          </div>
        </>
      )}

      {showPasswordDialog && (
        <div className={styles.passwordSection}>
          <div className={styles.passwordHeader}>
            {showPasswordDialog === "setup" && "设置加密密码"}
            {showPasswordDialog === "unlock" && "输入加密密码"}
            {showPasswordDialog === "change" && "修改加密密码"}
          </div>
          <div className={styles.form}>
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
          </div>
          <div className={styles.actions}>
            <button
              className={styles.secondary}
              onClick={resetPasswordFields}
              disabled={loading}
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
              disabled={loading}
            >
              {loading ? "处理中…" : "确认"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
