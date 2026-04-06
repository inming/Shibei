import type { ThemeMode } from "@/hooks/useTheme";
import settingsStyles from "./Settings.module.css";
import styles from "./AppearancePage.module.css";

interface AppearancePageProps {
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
}

const THEME_OPTIONS: { id: ThemeMode; label: string; icon: string }[] = [
  { id: "light", label: "浅色", icon: "☀️" },
  { id: "dark", label: "深色", icon: "🌙" },
  { id: "system", label: "跟随系统", icon: "💻" },
];

export function AppearancePage({ themeMode, onThemeModeChange }: AppearancePageProps) {
  return (
    <>
      <h2 className={settingsStyles.heading}>外观</h2>
      <div className={styles.themeOptions}>
        {THEME_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            className={`${styles.themeBtn} ${themeMode === opt.id ? styles.themeBtnActive : ""}`}
            onClick={() => onThemeModeChange(opt.id)}
          >
            <span className={styles.themeIcon}>{opt.icon}</span>
            {opt.label}
          </button>
        ))}
      </div>
    </>
  );
}
