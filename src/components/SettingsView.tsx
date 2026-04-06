import { useState, useEffect } from "react";
import { useSync } from "@/hooks/useSync";
import { AppearancePage } from "@/components/Settings/AppearancePage";
import { SyncPage } from "@/components/Settings/SyncPage";
import { EncryptionPage } from "@/components/Settings/EncryptionPage";
import { LockScreenPage } from "@/components/Settings/LockScreenPage";
import type { ThemeMode } from "@/hooks/useTheme";
import styles from "./SettingsView.module.css";

type SettingsSection = "appearance" | "sync" | "encryption" | "security";

const NAV_ITEMS: { id: SettingsSection; label: string }[] = [
  { id: "appearance", label: "外观" },
  { id: "sync", label: "同步" },
  { id: "encryption", label: "加密" },
  { id: "security", label: "安全" },
];

interface SettingsViewProps {
  initialSection?: SettingsSection;
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
}

export function SettingsView({ initialSection, themeMode, onThemeModeChange }: SettingsViewProps) {
  const [section, setSection] = useState<SettingsSection>(initialSection ?? "appearance");
  const sync = useSync();

  useEffect(() => {
    if (initialSection) setSection(initialSection);
  }, [initialSection]);

  return (
    <div className={styles.container}>
      <nav className={styles.nav}>
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            className={`${styles.navItem} ${section === item.id ? styles.navItemActive : ""}`}
            onClick={() => setSection(item.id)}
          >
            {item.label}
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
        </div>
      </div>
    </div>
  );
}
