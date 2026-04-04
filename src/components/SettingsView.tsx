import { useState } from "react";
import { useSync } from "@/hooks/useSync";
import { SyncPage } from "@/components/Settings/SyncPage";
import { EncryptionPage } from "@/components/Settings/EncryptionPage";
import styles from "./SettingsView.module.css";

type SettingsSection = "sync" | "encryption";

const NAV_ITEMS: { id: SettingsSection; label: string }[] = [
  { id: "sync", label: "同步" },
  { id: "encryption", label: "加密" },
];

interface SettingsViewProps {
  initialSection?: SettingsSection;
}

export function SettingsView({ initialSection }: SettingsViewProps) {
  const [section, setSection] = useState<SettingsSection>(initialSection ?? "sync");
  const sync = useSync();

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
          {section === "sync" && (
            <SyncPage
              intervalMinutes={sync.intervalMinutes}
              onIntervalChange={sync.setIntervalMinutes}
            />
          )}
          {section === "encryption" && (
            <EncryptionPage />
          )}
        </div>
      </div>
    </div>
  );
}
