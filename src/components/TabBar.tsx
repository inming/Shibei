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
  /** Right-click on a tab. The handler decides whether to show a menu
   *  (e.g. only for reader tabs) and is responsible for preventDefault. */
  onTabContextMenu?: (e: React.MouseEvent, id: string) => void;
}

export function TabBar({ tabs, activeTabId, onSelectTab, onCloseTab, onTabContextMenu }: TabBarProps) {
  return (
    <div className={styles.tabBar}>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`${styles.tab} ${activeTabId === tab.id ? styles.tabActive : ""}`}
          onClick={() => onSelectTab(tab.id)}
          onContextMenu={(e) => onTabContextMenu?.(e, tab.id)}
        >
          <span className={styles.tabLabel} title={tab.label}>{tab.label}</span>
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
