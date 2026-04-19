import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import type { ThemeMode } from "@/hooks/useTheme";
import { getAutoLaunchEnabled, setAutoLaunchEnabled } from "@/lib/autostart";
import settingsStyles from "./Settings.module.css";
import styles from "./AppearancePage.module.css";

interface AppearancePageProps {
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
}

const THEME_OPTIONS = [
  { id: "light" as ThemeMode, icon: "☀️", labelKey: "themeLight" as const },
  { id: "dark" as ThemeMode, icon: "🌙", labelKey: "themeDark" as const },
  { id: "system" as ThemeMode, icon: "💻", labelKey: "themeSystem" as const },
];

const LANGUAGE_OPTIONS = [
  { value: "zh", label: "中文" },
  { value: "en", label: "English" },
];

export function AppearancePage({ themeMode, onThemeModeChange }: AppearancePageProps) {
  const { t, i18n } = useTranslation("settings");
  const [autoLaunch, setAutoLaunch] = useState<boolean | null>(null);

  useEffect(() => {
    getAutoLaunchEnabled()
      .then((on) => setAutoLaunch(on))
      .catch((err) => {
        console.error("Failed to read auto-launch state:", err);
        setAutoLaunch(false);
      });
  }, []);

  const handleToggleAutoLaunch = async () => {
    if (autoLaunch === null) return;
    const next = !autoLaunch;
    try {
      await setAutoLaunchEnabled(next);
      setAutoLaunch(next);
      toast.success(next ? t("autoLaunchEnabled") : t("autoLaunchDisabled"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(t("autoLaunchFailed", { message: msg }));
      const actual = await getAutoLaunchEnabled().catch((resyncErr) => {
        console.error("Failed to resync auto-launch state:", resyncErr);
        return false;
      });
      setAutoLaunch(actual);
    }
  };

  return (
    <>
      <h2 className={settingsStyles.heading}>{t("title")}</h2>

      <div className={settingsStyles.form}>
        <h3 className={settingsStyles.subheading}>{t("theme")}</h3>
        <div className={styles.themeOptions}>
          {THEME_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              className={`${styles.themeBtn} ${themeMode === opt.id ? styles.themeBtnActive : ""}`}
              onClick={() => onThemeModeChange(opt.id)}
            >
              <span className={styles.themeIcon}>{opt.icon}</span>
              {t(opt.labelKey)}
            </button>
          ))}
        </div>
      </div>

      <div className={settingsStyles.passwordSection}>
        <h3 className={settingsStyles.subheading}>{t("language")}</h3>
        <div className={styles.themeOptions}>
          {LANGUAGE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              className={`${styles.themeBtn} ${i18n.language === opt.value ? styles.themeBtnActive : ""}`}
              onClick={() => i18n.changeLanguage(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className={settingsStyles.passwordSection}>
        <h3 className={settingsStyles.subheading}>{t("startup")}</h3>
        <label className={settingsStyles.toggleRow}>
          <input
            type="checkbox"
            checked={autoLaunch === true}
            disabled={autoLaunch === null}
            onChange={handleToggleAutoLaunch}
          />
          <span>{t("autoLaunch")}</span>
        </label>
        <div className={settingsStyles.hint}>{t("autoLaunchDescription")}</div>
      </div>
    </>
  );
}
