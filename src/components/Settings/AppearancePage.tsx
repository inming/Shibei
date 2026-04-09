import { useTranslation } from "react-i18next";
import type { ThemeMode } from "@/hooks/useTheme";
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

  return (
    <>
      <h2 className={settingsStyles.heading}>{t("title")}</h2>
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
    </>
  );
}
