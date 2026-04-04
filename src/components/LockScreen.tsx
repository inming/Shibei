import { useState, useCallback, useEffect, useRef } from "react";
import * as cmd from "@/lib/commands";
import styles from "./LockScreen.module.css";

interface LockScreenProps {
  onUnlock: () => void;
}

export function LockScreen({ onUnlock }: LockScreenProps) {
  const [pin, setPin] = useState("");
  const [errorCount, setErrorCount] = useState(0);
  const [verifying, setVerifying] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = useCallback(async () => {
    if (pin.length !== 4 || verifying) return;
    setVerifying(true);
    try {
      const ok = await cmd.verifyLockPin(pin);
      if (ok) {
        onUnlock();
      } else {
        setErrorCount((c) => c + 1);
        setPin("");
        inputRef.current?.focus();
      }
    } catch {
      setErrorCount((c) => c + 1);
      setPin("");
      inputRef.current?.focus();
    } finally {
      setVerifying(false);
    }
  }, [pin, verifying, onUnlock]);

  useEffect(() => {
    if (pin.length === 4) {
      handleSubmit();
    }
  }, [pin, handleSubmit]);

  return (
    <div className={styles.overlay} onClick={() => inputRef.current?.focus()}>
      <div className={styles.card}>
        <div className={styles.icon} aria-hidden="true" />
        <h2 className={styles.title}>拾贝已锁定</h2>
        <p className={styles.subtitle}>请输入 PIN 码解锁</p>
        <div key={errorCount} className={styles.dots}>
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className={`${styles.dot} ${i < pin.length ? styles.dotFilled : ""} ${errorCount > 0 && pin.length === 0 ? styles.dotError : ""}`}
            />
          ))}
        </div>
        <input
          ref={inputRef}
          className={styles.hiddenInput}
          type="password"
          inputMode="numeric"
          maxLength={4}
          value={pin}
          onChange={(e) => {
            setPin(e.target.value.replace(/\D/g, "").slice(0, 4));
          }}
          onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
          autoFocus
        />
        {errorCount > 0 && pin.length === 0 && <p className={styles.error}>PIN 码不正确</p>}
      </div>
    </div>
  );
}
