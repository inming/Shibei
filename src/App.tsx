import { useState, useCallback, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { onOpenUrl, getCurrent as getDeepLinkCurrent } from "@tauri-apps/plugin-deep-link";
import { useTranslation } from "react-i18next";
import { Toaster } from "react-hot-toast";
import type { Resource } from "@/types";
import { DataEvents, type ResourceChangedPayload, type ConfigChangedPayload } from "@/lib/events";
import { TabBar, type TabItem } from "@/components/TabBar";
import { LibraryView } from "@/components/Layout";
import { ReaderView } from "@/components/ReaderView";
import { SettingsView } from "@/components/SettingsView";
import { LockScreen } from "@/components/LockScreen";
import { useTheme } from "@/hooks/useTheme";
import * as cmd from "@/lib/commands";
import styles from "./App.module.css";

const LIBRARY_TAB_ID = "__library__";
const SETTINGS_TAB_ID = "__settings__";

interface ReaderTab {
  resource: Resource;
  initialHighlightId: string | null;
}

function App() {
  const { t } = useTranslation('sidebar');
  const [activeTabId, setActiveTabId] = useState(LIBRARY_TAB_ID);
  const [readerTabs, setReaderTabs] = useState<Map<string, ReaderTab>>(new Map());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<"appearance" | "sync" | "encryption" | undefined>(undefined);
  const theme = useTheme();
  const [locked, setLocked] = useState(false);
  const [lockEnabled, setLockEnabled] = useState(false);
  const lockTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lockTimeoutMinutesRef = useRef(10);

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

  const openSettings = useCallback((section?: "appearance" | "sync" | "encryption") => {
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

  // Lock screen: check status on mount + check cold-start deep link
  useEffect(() => {
    let mounted = true;
    async function init() {
      try {
        const status = await cmd.getLockStatus();
        if (!mounted) return;
        setLockEnabled(status.enabled);
        lockTimeoutMinutesRef.current = status.timeout_minutes;
        if (status.enabled) {
          setLocked(true);
        }

        // Check for cold-start deep link URL
        const initialUrls = await getDeepLinkCurrent();
        if (!mounted) return;
        const deepUrl = initialUrls?.find(u => u.startsWith("shibei://"));
        if (deepUrl) {
          if (status.enabled) {
            // App is locked — queue for after unlock
            pendingDeepLinkRef.current = deepUrl;
          } else {
            // App is not locked — open immediately
            const match = deepUrl.match(/shibei:\/\/open\/resource\/([^?]+)(?:\?highlight=(.+))?/);
            if (match) {
              try {
                const resource = await cmd.getResource(match[1]);
                if (resource && mounted) openResource(resource, match[2]);
              } catch { /* ignore */ }
            }
          }
        }
      } catch {
        // Lock screen not available
      }
    }
    init();
    return () => { mounted = false; };
  }, [openResource]);

  // Inactivity timer
  useEffect(() => {
    if (!lockEnabled || locked) {
      if (lockTimeoutRef.current) clearTimeout(lockTimeoutRef.current);
      return;
    }

    function resetTimer() {
      if (lockTimeoutRef.current) clearTimeout(lockTimeoutRef.current);
      lockTimeoutRef.current = setTimeout(() => {
        setLocked(true);
      }, lockTimeoutMinutesRef.current * 60 * 1000);
    }

    resetTimer();
    const events = ["mousemove", "mousedown", "keydown", "scroll", "touchstart"];
    events.forEach((e) => document.addEventListener(e, resetTimer, { passive: true }));

    return () => {
      if (lockTimeoutRef.current) clearTimeout(lockTimeoutRef.current);
      events.forEach((e) => document.removeEventListener(e, resetTimer));
    };
  }, [lockEnabled, locked]);

  // Listen for config changes (user enables/disables lock in settings)
  useEffect(() => {
    const unlisten = listen<ConfigChangedPayload>(DataEvents.CONFIG_CHANGED, async (event) => {
      if (event.payload.scope === "lock_screen") {
        try {
          const status = await cmd.getLockStatus();
          setLockEnabled(status.enabled);
          lockTimeoutMinutesRef.current = status.timeout_minutes;
        } catch { /* ignore */ }
      }
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  // Pending deep link: stored when app is locked, processed after unlock
  const pendingDeepLinkRef = useRef<string | null>(null);

  const handleDeepLinkUrl = useCallback(async (url: string) => {
    const match = url.match(/shibei:\/\/open\/resource\/([^?]+)(?:\?highlight=(.+))?/);
    if (!match) return;
    const resourceId = match[1];
    const highlightId = match[2] || undefined;
    try {
      const resource = await cmd.getResource(resourceId);
      if (resource) {
        openResource(resource, highlightId);
      }
    } catch (err) {
      console.error("Deep link: resource not found", resourceId, err);
    }
  }, [openResource]);

  // Deep link handler: shibei://open/resource/{id}?highlight={hlId}
  useEffect(() => {
    // From tauri-plugin-deep-link (cold start)
    const u1 = onOpenUrl((urls: string[]) => {
      for (const url of urls) {
        if (locked) {
          pendingDeepLinkRef.current = url;
        } else {
          handleDeepLinkUrl(url);
        }
      }
    });
    // From tauri-plugin-single-instance (second instance forwarding)
    const u2 = listen<string>("deep-link-received", (event) => {
      const url = event.payload;
      if (locked) {
        pendingDeepLinkRef.current = url;
      } else {
        handleDeepLinkUrl(url);
      }
    });
    return () => {
      u1.then((f) => f());
      u2.then((f) => f());
    };
  }, [openResource, locked, handleDeepLinkUrl]);

  const handleUnlock = useCallback(() => {
    setLocked(false);
    // Process any deep link that arrived while locked
    if (pendingDeepLinkRef.current) {
      const url = pendingDeepLinkRef.current;
      pendingDeepLinkRef.current = null;
      handleDeepLinkUrl(url);
    }
  }, [handleDeepLinkUrl]);

  const tabs: TabItem[] = [
    { id: LIBRARY_TAB_ID, label: t('libraryTab'), closable: false },
    ...Array.from(readerTabs.entries()).map(([id, tab]) => ({
      id,
      label: tab.resource.title,
      closable: true,
    })),
    ...(settingsOpen ? [{ id: SETTINGS_TAB_ID, label: t('settingsTab'), closable: true }] : []),
  ];

  return (
    <div className={styles.app}>
      {locked && <LockScreen onUnlock={handleUnlock} />}
      <Toaster position="bottom-right" />
      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={setActiveTabId}
        onCloseTab={closeTab}
      />
      <div className={styles.content}>
        <div className={`${styles.tabPane} ${activeTabId !== LIBRARY_TAB_ID ? styles.tabPaneHidden : ""}`}>
          <LibraryView
            onOpenResource={openResource}
            onOpenSettings={openSettings}
            lockEnabled={lockEnabled}
            onLock={() => setLocked(true)}
          />
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
            <SettingsView
              initialSection={settingsSection}
              themeMode={theme.mode}
              onThemeModeChange={theme.setMode}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
