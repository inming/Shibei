import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useSync } from "@/hooks/useSync";
import { AppearancePage } from "@/components/Settings/AppearancePage";
import { SyncPage } from "@/components/Settings/SyncPage";
import { EncryptionPage } from "@/components/Settings/EncryptionPage";
import { LockScreenPage } from "@/components/Settings/LockScreenPage";
import { DataPage } from "@/components/Settings/DataPage";
import type { ThemeMode } from "@/hooks/useTheme";
import styles from "./SettingsView.module.css";

type SettingsSection = "appearance" | "sync" | "encryption" | "security" | "data";

const NAV_KEYS = [
  { id: "appearance", key: "navAppearance" },
  { id: "sync", key: "navSync" },
  { id: "encryption", key: "navEncryption" },
  { id: "security", key: "navSecurity" },
  { id: "data", key: "navData" },
] as const;

interface SettingsViewProps {
  initialSection?: SettingsSection;
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
}

export function SettingsView({ initialSection, themeMode, onThemeModeChange }: SettingsViewProps) {
  const [section, setSection] = useState<SettingsSection>(initialSection ?? "appearance");
  const { t } = useTranslation('settings');
  const sync = useSync();

  useEffect(() => {
    if (initialSection) setSection(initialSection);
  }, [initialSection]);

  return (
    <div className={styles.container}>
      <nav className={styles.nav}>
        {NAV_KEYS.map((item) => (
          <button
            key={item.id}
            className={`${styles.navItem} ${section === item.id ? styles.navItemActive : ""}`}
            onClick={() => setSection(item.id)}
          >
            {t(item.key)}
          </button>
        ))}
      </nav>
      <div className={styles.content}>
        <div className={styles.page}>
          {section === "appearance" && (
            <AppearancePage themeMode={themeMode} onThemeModeChange={onThemeModeChange} />
          )}
          {section === "sync" && (
            <SyncPage
              intervalMinutes={sync.intervalMinutes}
              onIntervalChange={sync.setIntervalMinutes}
            />
          )}
          {section === "encryption" && (
            <EncryptionPage />
          )}
          {section === "security" && (
            <LockScreenPage />
          )}
          {section === "data" && <DataPage />}
        </div>
      </div>
    </div>
  );
}
