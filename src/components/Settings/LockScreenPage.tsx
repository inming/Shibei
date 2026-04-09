import { useState, useEffect, useCallback } from "react";
import { emit } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import * as cmd from "@/lib/commands";
import styles from "../Settings/Settings.module.css";
import lockStyles from "./LockScreenPage.module.css";

export function LockScreenPage() {
  const { t } = useTranslation('lock');
  const [enabled, setEnabled] = useState(false);
  const [timeoutMinutes, setTimeoutMinutes] = useState(10);
  const [loading, setLoading] = useState(true);

  // Setup dialog state
  const [showSetup, setShowSetup] = useState(false);
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [setupStep, setSetupStep] = useState<"enter" | "confirm">("enter");

  // Disable dialog state
  const [showDisable, setShowDisable] = useState(false);
  const [disablePin, setDisablePin] = useState("");

  const TIMEOUT_OPTIONS = [
    { value: 2, label: t('timeoutMinutes', { count: 2 }) },
    { value: 5, label: t('timeoutMinutes', { count: 5 }) },
    { value: 10, label: t('timeoutMinutes', { count: 10 }) },
    { value: 15, label: t('timeoutMinutes', { count: 15 }) },
    { value: 30, label: t('timeoutMinutes', { count: 30 }) },
    { value: 60, label: t('timeoutMinutes', { count: 60 }) },
  ];

  const loadStatus = useCallback(async () => {
    try {
      const status = await cmd.getLockStatus();
      setEnabled(status.enabled);
      setTimeoutMinutes(status.timeout_minutes);
    } catch (err) {
      console.error("Failed to load lock status:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const handleSetupSubmit = useCallback(async () => {
    if (setupStep === "enter") {
      if (pin.length !== 4) {
        toast.error(t('pinLengthError'));
        return;
      }
      setSetupStep("confirm");
      setConfirmPin("");
      return;
    }
    if (confirmPin !== pin) {
      toast.error(t('pinMismatch'));
      setSetupStep("enter");
      setPin("");
      setConfirmPin("");
      return;
    }
    try {
      await cmd.setupLockPin(pin);
      await emit("data:config-changed", { scope: "lock_screen" });
      toast.success(t('pinSetSuccess'));
      setEnabled(true);
      setShowSetup(false);
      setPin("");
      setConfirmPin("");
      setSetupStep("enter");
    } catch (err) {
      toast.error(t('pinSetFailed'));
    }
  }, [setupStep, pin, confirmPin, t]);

  const handleDisable = useCallback(async () => {
    try {
      await cmd.disableLockPin(disablePin);
      await emit("data:config-changed", { scope: "lock_screen" });
      toast.success(t('lockDisabled'));
      setEnabled(false);
      setShowDisable(false);
      setDisablePin("");
    } catch {
      toast.error(t('pinIncorrect'));
      setDisablePin("");
    }
  }, [disablePin, t]);

  const handleTimeoutChange = useCallback(async (value: number) => {
    try {
      await cmd.setLockTimeout(value);
      await emit("data:config-changed", { scope: "lock_screen" });
      setTimeoutMinutes(value);
    } catch {
      toast.error(t('timeoutSetFailed'));
    }
  }, [t]);

  if (loading) return null;

  return (
    <div>
      <h2 className={styles.heading}>{t('title')}</h2>

      {!enabled ? (
        <div>
          <p className={`${styles.hint} ${lockStyles.hintSpaced}`}>
            {t('description')}
          </p>
          <button
            className={styles.primary}
            onClick={() => { setShowSetup(true); setPin(""); setConfirmPin(""); setSetupStep("enter"); }}
          >
            {t('setupPin')}
          </button>
        </div>
      ) : (
        <div className={styles.form}>
          <div className={styles.info}>
            <span>{t('lockEnabled')}</span>
          </div>

          <label className={styles.label}>
            <span>{t('autoLockTimeout')}</span>
            <select
              className={styles.input}
              value={timeoutMinutes}
              onChange={(e) => handleTimeoutChange(Number(e.target.value))}
            >
              {TIMEOUT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </label>

          <div className={styles.actions}>
            <button className={styles.secondary} onClick={() => { setShowDisable(true); setDisablePin(""); }}>
              {t('disableLock')}
            </button>
          </div>
        </div>
      )}

      {showSetup && (
        <div className={styles.passwordSection}>
          <h3 className={styles.passwordHeader}>
            {setupStep === "enter" ? t('setupPinTitle') : t('confirmPinTitle')}
          </h3>
          <div className={styles.warning}>
            {t('pinWarning')}
          </div>
          <div className={styles.form}>
            <label className={styles.label}>
              <span>{setupStep === "enter" ? t('enterPin') : t('reenterPin')}</span>
              <input
                className={`${styles.input} ${lockStyles.pinInput}`}
                type="password"
                inputMode="numeric"
                maxLength={4}
                pattern="[0-9]*"
                value={setupStep === "enter" ? pin : confirmPin}
                onChange={(e) => {
                  const val = e.target.value.replace(/\D/g, "").slice(0, 4);
                  if (setupStep === "enter") setPin(val); else setConfirmPin(val);
                }}
                autoFocus
                onKeyDown={(e) => { if (e.key === "Enter") handleSetupSubmit(); }}
              />
            </label>
            <div className={styles.actions}>
              <button className={styles.secondary} onClick={() => { setShowSetup(false); setPin(""); setConfirmPin(""); setSetupStep("enter"); }}>
                {t('cancel')}
              </button>
              <button className={styles.primary} onClick={handleSetupSubmit}>
                {setupStep === "enter" ? t('nextStep') : t('confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showDisable && (
        <div className={styles.passwordSection}>
          <h3 className={styles.passwordHeader}>{t('disableLockTitle')}</h3>
          <div className={styles.form}>
            <label className={styles.label}>
              <span>{t('enterCurrentPin')}</span>
              <input
                className={`${styles.input} ${lockStyles.pinInput}`}
                type="password"
                inputMode="numeric"
                maxLength={4}
                pattern="[0-9]*"
                value={disablePin}
                onChange={(e) => setDisablePin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                autoFocus
                onKeyDown={(e) => { if (e.key === "Enter") handleDisable(); }}
              />
            </label>
            <div className={styles.actions}>
              <button className={styles.secondary} onClick={() => { setShowDisable(false); setDisablePin(""); }}>
                {t('cancel')}
              </button>
              <button className={styles.primary} onClick={handleDisable}>
                {t('confirmDisable')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
