import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation('encryption');
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
      toast.error(t('passwordMinLength'));
      return;
    }
    if (password !== confirmPassword) {
      toast.error(t('passwordMismatch'));
      return;
    }
    setLoading(true);
    try {
      await cmd.setupEncryption(password);
      toast.success(t('setupSuccess'));
      setEncryptionEnabled(true);
      setEncryptionUnlocked(true);
      resetPasswordFields();
    } catch (err) {
      toast.error(t('setupFailed', { error: formatError(err) }));
    } finally {
      setLoading(false);
    }
  }

  async function handleUnlockEncryption() {
    setLoading(true);
    try {
      await cmd.unlockEncryption(password);
      toast.success(t('unlockSuccess'));
      setEncryptionUnlocked(true);
      resetPasswordFields();
      void loadStatus();
    } catch (err) {
      toast.error(t('unlockFailed', { error: formatError(err) }));
    } finally {
      setLoading(false);
    }
  }

  async function handleChangePassword() {
    if (password.length < 8) {
      toast.error(t('newPasswordMinLength'));
      return;
    }
    if (password !== confirmPassword) {
      toast.error(t('newPasswordMismatch'));
      return;
    }
    setLoading(true);
    try {
      await cmd.changeEncryptionPassword(oldPassword, password);
      toast.success(t('changeSuccess'));
      resetPasswordFields();
    } catch (err) {
      toast.error(t('changeFailed', { error: formatError(err) }));
    } finally {
      setLoading(false);
    }
  }

  async function handleToggleRememberKey() {
    const newValue = !rememberKey;
    try {
      await cmd.setRememberKey(newValue);
      setRememberKey(newValue);
      toast.success(newValue ? t('savedToKeychain') : t('removedFromKeychain'));
    } catch (err) {
      toast.error(t('operationFailed', { error: formatError(err) }));
    }
  }

  return (
    <>
      <h2 className={styles.heading}>{t('title')}</h2>

      {!encryptionEnabled ? (
        <>
          <div className={styles.warning}>
            {t('plaintextWarning')}
          </div>
          <div className={styles.actions}>
            <button
              className={styles.primary}
              onClick={() => setShowPasswordDialog("setup")}
            >
              {t('enableEncryption')}
            </button>
          </div>
        </>
      ) : !encryptionUnlocked ? (
        <>
          <div className={styles.info}>
            {t('needsPasswordInfo')}
          </div>
          <div className={styles.actions}>
            <button
              className={styles.primary}
              onClick={() => setShowPasswordDialog("unlock")}
            >
              {t('enterPassword')}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className={styles.success}>
            {t('enabledAndUnlocked')}
          </div>
          <label className={styles.toggleRow}>
            <input
              type="checkbox"
              checked={rememberKey}
              onChange={handleToggleRememberKey}
            />
            <span>{t('rememberKey')}</span>
          </label>
          <div className={styles.hint}>
            {t('rememberKeyHint')}
          </div>
          <div className={styles.actions}>
            <button
              className={styles.secondary}
              onClick={() => setShowPasswordDialog("change")}
            >
              {t('changePassword')}
            </button>
          </div>
        </>
      )}

      {showPasswordDialog && (
        <div className={styles.passwordSection}>
          <div className={styles.passwordHeader}>
            {showPasswordDialog === "setup" && t('setupPasswordTitle')}
            {showPasswordDialog === "unlock" && t('unlockPasswordTitle')}
            {showPasswordDialog === "change" && t('changePasswordTitle')}
          </div>
          <div className={styles.form}>
            {showPasswordDialog === "change" && (
              <label className={styles.label}>
                <span>{t('oldPassword')}</span>
                <input
                  type="password"
                  className={styles.input}
                  value={oldPassword}
                  onChange={(e) => setOldPassword(e.target.value)}
                />
              </label>
            )}
            <label className={styles.label}>
              <span>{showPasswordDialog === "change" ? t('newPassword') : t('password')}</span>
              <input
                type="password"
                className={styles.input}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t('passwordPlaceholder')}
              />
            </label>
            {showPasswordDialog !== "unlock" && (
              <label className={styles.label}>
                <span>{t('confirmPassword')}</span>
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
              {t('cancel')}
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
              {loading ? t('processing') : t('confirm')}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
