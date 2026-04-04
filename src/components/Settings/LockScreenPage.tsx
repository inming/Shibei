import { useState, useEffect, useCallback } from "react";
import { emit } from "@tauri-apps/api/event";
import toast from "react-hot-toast";
import * as cmd from "@/lib/commands";
import styles from "../Settings/Settings.module.css";
import lockStyles from "./LockScreenPage.module.css";

const TIMEOUT_OPTIONS = [
  { value: 2, label: "2 分钟" },
  { value: 5, label: "5 分钟" },
  { value: 10, label: "10 分钟" },
  { value: 15, label: "15 分钟" },
  { value: 30, label: "30 分钟" },
  { value: 60, label: "60 分钟" },
];

export function LockScreenPage() {
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
        toast.error("请输入 4 位数字 PIN");
        return;
      }
      setSetupStep("confirm");
      setConfirmPin("");
      return;
    }
    if (confirmPin !== pin) {
      toast.error("两次输入的 PIN 不一致");
      setSetupStep("enter");
      setPin("");
      setConfirmPin("");
      return;
    }
    try {
      await cmd.setupLockPin(pin);
      await emit("data:config-changed", { scope: "lock_screen" });
      toast.success("锁屏 PIN 已设置");
      setEnabled(true);
      setShowSetup(false);
      setPin("");
      setConfirmPin("");
      setSetupStep("enter");
    } catch (err) {
      toast.error("设置 PIN 失败");
    }
  }, [setupStep, pin, confirmPin]);

  const handleDisable = useCallback(async () => {
    try {
      await cmd.disableLockPin(disablePin);
      await emit("data:config-changed", { scope: "lock_screen" });
      toast.success("锁屏已关闭");
      setEnabled(false);
      setShowDisable(false);
      setDisablePin("");
    } catch {
      toast.error("PIN 不正确");
      setDisablePin("");
    }
  }, [disablePin]);

  const handleTimeoutChange = useCallback(async (value: number) => {
    try {
      await cmd.setLockTimeout(value);
      await emit("data:config-changed", { scope: "lock_screen" });
      setTimeoutMinutes(value);
    } catch {
      toast.error("设置超时时间失败");
    }
  }, []);

  if (loading) return null;

  return (
    <div>
      <h2 className={styles.heading}>锁屏</h2>

      {!enabled ? (
        <div>
          <p className={`${styles.hint} ${lockStyles.hintSpaced}`}>
            启用锁屏后，应用在一段时间无操作后会自动锁定，需要输入 PIN 码解锁。
          </p>
          <button
            className={styles.primary}
            onClick={() => { setShowSetup(true); setPin(""); setConfirmPin(""); setSetupStep("enter"); }}
          >
            设置 PIN 码
          </button>
        </div>
      ) : (
        <div className={styles.form}>
          <div className={styles.info}>
            <span>锁屏已启用</span>
          </div>

          <label className={styles.label}>
            <span>自动锁屏时间</span>
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
              关闭锁屏
            </button>
          </div>
        </div>
      )}

      {showSetup && (
        <div className={styles.passwordSection}>
          <h3 className={styles.passwordHeader}>
            {setupStep === "enter" ? "设置 PIN 码" : "确认 PIN 码"}
          </h3>
          <div className={styles.warning}>
            ⚠️ 请务必记住您的 PIN 码，忘记后无法重置。
          </div>
          <div className={styles.form}>
            <label className={styles.label}>
              <span>{setupStep === "enter" ? "输入 4 位数字 PIN" : "再次输入 PIN 码"}</span>
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
                取消
              </button>
              <button className={styles.primary} onClick={handleSetupSubmit}>
                {setupStep === "enter" ? "下一步" : "确认"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showDisable && (
        <div className={styles.passwordSection}>
          <h3 className={styles.passwordHeader}>关闭锁屏</h3>
          <div className={styles.form}>
            <label className={styles.label}>
              <span>输入当前 PIN 码</span>
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
                取消
              </button>
              <button className={styles.primary} onClick={handleDisable}>
                确认关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
