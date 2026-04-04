import { useState, useCallback, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { Toaster } from "react-hot-toast";
import type { Resource } from "@/types";
import { DataEvents, type ResourceChangedPayload } from "@/lib/events";
import { TabBar, type TabItem } from "@/components/TabBar";
import { LibraryView } from "@/components/Layout";
import { ReaderView } from "@/components/ReaderView";
import { SettingsView } from "@/components/SettingsView";
import styles from "./App.module.css";

const LIBRARY_TAB_ID = "__library__";
const SETTINGS_TAB_ID = "__settings__";

interface ReaderTab {
  resource: Resource;
  initialHighlightId: string | null;
}

function App() {
  const [activeTabId, setActiveTabId] = useState(LIBRARY_TAB_ID);
  const [readerTabs, setReaderTabs] = useState<Map<string, ReaderTab>>(new Map());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<"sync" | "encryption" | undefined>(undefined);

  const openResource = useCallback((resource: Resource, highlightId?: string) => {
    setReaderTabs((prev) => {
      const next = new Map(prev);
      if (!next.has(resource.id)) {
        next.set(resource.id, { resource, initialHighlightId: highlightId ?? null });
      } else if (highlightId) {
        const existing = next.get(resource.id)!;
        next.set(resource.id, { ...existing, initialHighlightId: highlightId });
      }
      return next;
    });
    setActiveTabId(resource.id);
  }, []);

  const openSettings = useCallback((section?: "sync" | "encryption") => {
    setSettingsOpen(true);
    setSettingsSection(section);
    setActiveTabId(SETTINGS_TAB_ID);
  }, []);

  const closeTab = useCallback((id: string) => {
    if (id === SETTINGS_TAB_ID) {
      setSettingsOpen(false);
      setActiveTabId((current) => (current === id ? LIBRARY_TAB_ID : current));
      return;
    }
    setReaderTabs((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    setActiveTabId((current) => (current === id ? LIBRARY_TAB_ID : current));
  }, []);

  useEffect(() => {
    const unlisten = listen<ResourceChangedPayload>(
      DataEvents.RESOURCE_CHANGED,
      (event) => {
        if (event.payload.action === "deleted") {
          const id = event.payload.resource_id;
          if (!id) return;
          setReaderTabs((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Map(prev);
            next.delete(id);
            return next;
          });
          setActiveTabId((current) => (current === id ? LIBRARY_TAB_ID : current));
        }
      },
    );
    return () => { unlisten.then((f) => f()); };
  }, []);

  const tabs: TabItem[] = [
    { id: LIBRARY_TAB_ID, label: "资料库", closable: false },
    ...Array.from(readerTabs.entries()).map(([id, tab]) => ({
      id,
      label: tab.resource.title,
      closable: true,
    })),
    ...(settingsOpen ? [{ id: SETTINGS_TAB_ID, label: "设置", closable: true }] : []),
  ];

  return (
    <div className={styles.app}>
      <Toaster position="bottom-right" />
      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={setActiveTabId}
        onCloseTab={closeTab}
      />
      <div className={styles.content}>
        <div className={`${styles.tabPane} ${activeTabId !== LIBRARY_TAB_ID ? styles.tabPaneHidden : ""}`}>
          <LibraryView onOpenResource={openResource} onOpenSettings={openSettings} />
        </div>
        {Array.from(readerTabs.entries()).map(([id, tab]) => (
          <div key={id} className={`${styles.tabPane} ${activeTabId !== id ? styles.tabPaneHidden : ""}`}>
            <ReaderView
              resource={tab.resource}
              initialHighlightId={tab.initialHighlightId}
            />
          </div>
        ))}
        {settingsOpen && (
          <div className={`${styles.tabPane} ${activeTabId !== SETTINGS_TAB_ID ? styles.tabPaneHidden : ""}`}>
            <SettingsView initialSection={settingsSection} />
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
