import { useState, useCallback, useEffect, useRef } from "react";
import * as cmd from "@/lib/commands";
import styles from "./LockScreen.module.css";

interface LockScreenProps {
  onUnlock: () => void;
}

export function LockScreen({ onUnlock }: LockScreenProps) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = useCallback(async () => {
    if (pin.length !== 4 || verifying) return;
    setVerifying(true);
    setError(false);
    try {
      const ok = await cmd.verifyLockPin(pin);
      if (ok) {
        onUnlock();
      } else {
        setError(true);
        setPin("");
        inputRef.current?.focus();
      }
    } catch {
      setError(true);
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
        <div className={styles.icon}>🔒</div>
        <h2 className={styles.title}>拾贝已锁定</h2>
        <p className={styles.subtitle}>请输入 PIN 码解锁</p>
        <div className={styles.dots}>
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className={`${styles.dot} ${i < pin.length ? styles.dotFilled : ""} ${error ? styles.dotError : ""}`}
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
            setError(false);
            setPin(e.target.value.replace(/\D/g, "").slice(0, 4));
          }}
          onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
          autoFocus
        />
        {error && <p className={styles.error}>PIN 码不正确</p>}
      </div>
    </div>
  );
}
