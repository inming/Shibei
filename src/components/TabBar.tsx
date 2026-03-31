import styles from "./TabBar.module.css";

export interface TabItem {
  id: string;
  label: string;
  closable: boolean;
}

interface TabBarProps {
  tabs: TabItem[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
}

export function TabBar({ tabs, activeTabId, onSelectTab, onCloseTab }: TabBarProps) {
  return (
    <div className={styles.tabBar}>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`${styles.tab} ${activeTabId === tab.id ? styles.tabActive : ""}`}
          onClick={() => onSelectTab(tab.id)}
        >
          <span className={styles.tabLabel}>{tab.label}</span>
          {tab.closable && (
            <button
              className={styles.tabClose}
              onClick={(e) => {
                e.stopPropagation();
                onCloseTab(tab.id);
              }}
            >
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
