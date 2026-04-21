import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import QRCode from "qrcode";
import * as cmd from "@/lib/commands";
import { Modal } from "@/components/Modal";
import settingsStyles from "./Settings.module.css";
import styles from "./PairingDialog.module.css";

const PIN_VALID_SECONDS = 30;

function generatePin(): string {
  // 6-digit PIN with cryptographically secure randomness.
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  const n = buf[0] % 1_000_000;
  return n.toString().padStart(6, "0");
}

function formatPin(pin: string): string {
  return `${pin.slice(0, 3)} ${pin.slice(3)}`;
}

interface PairingDialogProps {
  onClose: () => void;
}

export function PairingDialog({ onClose }: PairingDialogProps) {
  const { t } = useTranslation("sync");
  const { t: tCommon } = useTranslation("common");

  const [pin, setPin] = useState<string>("");
  const [qrDataUrl, setQrDataUrl] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [secondsLeft, setSecondsLeft] = useState(PIN_VALID_SECONDS);
  const [expired, setExpired] = useState(false);

  // Track the latest call so a late-arriving async result from a prior
  // `regenerate` cannot clobber newer state.
  const generationId = useRef(0);

  const regenerate = useCallback(async () => {
    const myGen = ++generationId.current;
    setLoading(true);
    setError("");
    setExpired(false);
    setQrDataUrl("");
    setSecondsLeft(PIN_VALID_SECONDS);

    const nextPin = generatePin();
    setPin(nextPin);

    try {
      const envelope = await cmd.generatePairingPayload(nextPin);
      if (myGen !== generationId.current) return;
      const dataUrl = await QRCode.toDataURL(envelope, {
        errorCorrectionLevel: "M",
        margin: 1,
        width: 480,
      });
      if (myGen !== generationId.current) return;
      setQrDataUrl(dataUrl);
    } catch (e) {
      if (myGen !== generationId.current) return;
      const message = e && typeof e === "object" && "message" in e
        ? String((e as { message: string }).message)
        : String(e);
      setError(cmd.translateError(message));
    } finally {
      if (myGen === generationId.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void regenerate();
    // Cleanup: invalidate in-flight on unmount so state setters are no-ops.
    return () => {
      generationId.current++;
    };
  }, [regenerate]);

  useEffect(() => {
    if (loading || error || expired) return;
    const id = window.setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          setExpired(true);
          window.clearInterval(id);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [loading, error, expired]);

  return (
    <Modal title={t("pairing.title")} onClose={onClose}>
      <div className={styles.container}>
        <p className={styles.instructions}>{t("pairing.instructions")}</p>

        <div className={styles.qrWrap}>
          {loading && <span className={styles.qrLoading}>{t("pairing.generating")}</span>}
          {!loading && qrDataUrl && (
            <img src={qrDataUrl} alt={t("pairing.title")} data-testid="pairing-qr" />
          )}
          {expired && !loading && (
            <div className={styles.qrExpired}>{t("pairing.expired")}</div>
          )}
        </div>

        <div className={styles.pinLabel}>{t("pairing.pin")}</div>
        <div className={styles.pinValue} aria-label="PIN">
          {pin ? formatPin(pin) : "— —— ———"}
        </div>

        <div
          className={
            expired
              ? `${styles.countdown} ${styles.countdownExpired}`
              : styles.countdown
          }
        >
          {expired
            ? t("pairing.expired")
            : loading
              ? ""
              : t("pairing.expiresIn", { seconds: secondsLeft })}
        </div>

        {error && <p className={styles.error}>{error}</p>}

        <p className={styles.warning}>{t("pairing.noShareWarning")}</p>

        <div className={styles.actions}>
          <button
            type="button"
            className={settingsStyles.secondary}
            onClick={regenerate}
            disabled={loading}
          >
            {t("pairing.regenerate")}
          </button>
          <button
            type="button"
            className={settingsStyles.primary}
            onClick={onClose}
          >
            {tCommon("close")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
