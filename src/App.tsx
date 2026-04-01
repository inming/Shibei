import { useState, useCallback } from "react";
import type { Resource } from "@/types";
import { TabBar, type TabItem } from "@/components/TabBar";
import { LibraryView } from "@/components/Layout";
import { ReaderView } from "@/components/ReaderView";
import styles from "./App.module.css";

const LIBRARY_TAB_ID = "__library__";

interface ReaderTab {
  resource: Resource;
  initialHighlightId: string | null;
}

function App() {
  const [activeTabId, setActiveTabId] = useState(LIBRARY_TAB_ID);
  const [readerTabs, setReaderTabs] = useState<Map<string, ReaderTab>>(new Map());

  const openResource = useCallback((resource: Resource, highlightId?: string) => {
    setReaderTabs((prev) => {
      const next = new Map(prev);
      if (!next.has(resource.id)) {
        next.set(resource.id, { resource, initialHighlightId: highlightId ?? null });
      }
      return next;
    });
    setActiveTabId(resource.id);
  }, []);

  const closeTab = useCallback((id: string) => {
    setReaderTabs((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    setActiveTabId((current) => (current === id ? LIBRARY_TAB_ID : current));
  }, []);

  const tabs: TabItem[] = [
    { id: LIBRARY_TAB_ID, label: "资料库", closable: false },
    ...Array.from(readerTabs.entries()).map(([id, tab]) => ({
      id,
      label: tab.resource.title,
      closable: true,
    })),
  ];

  return (
    <div className={styles.app}>
      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={setActiveTabId}
        onCloseTab={closeTab}
      />
      <div className={styles.content}>
        {activeTabId === LIBRARY_TAB_ID ? (
          <LibraryView onOpenResource={openResource} />
        ) : (
          readerTabs.has(activeTabId) && (
            <ReaderView
              resource={readerTabs.get(activeTabId)!.resource}
              initialHighlightId={readerTabs.get(activeTabId)!.initialHighlightId}
            />
          )
        )}
      </div>
    </div>
  );
}

export default App;
