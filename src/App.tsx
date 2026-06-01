import { useState, useCallback, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { onOpenUrl, getCurrent as getDeepLinkCurrent } from "@tauri-apps/plugin-deep-link";
import { useTranslation } from "react-i18next";
import { Toaster } from "react-hot-toast";
import { ALL_RESOURCES_ID, INBOX_FOLDER_ID, type Resource, type Question } from "@/types";
import {
  DataEvents,
  type ResourceChangedPayload,
  type ConfigChangedPayload,
  type QuestionChangedPayload,
} from "@/lib/events";
import { TabBar, type TabItem } from "@/components/TabBar";
import { LibraryView } from "@/components/Layout";
import { ReaderView } from "@/components/ReaderView";
import { SettingsView } from "@/components/SettingsView";
import { LockScreen } from "@/components/LockScreen";
import { QuestionDetailView } from "@/components/QuestionDetail/QuestionDetailView";
import { ResourceContextMenu } from "@/components/Sidebar/ResourceContextMenu";
import { ResourceEditDialog } from "@/components/Sidebar/ResourceEditDialog";
import { useTheme } from "@/hooks/useTheme";
import * as cmd from "@/lib/commands";
import { parseShibeiDeepLink } from "@/lib/deepLink";
import {
  loadSessionState,
  saveSessionState,
  updateReaderTab,
  removeReaderTab,
  addQuestionTab,
  removeQuestionTab,
  questionTabId,
  parseQuestionTabId,
} from "@/lib/sessionState";
import styles from "./App.module.css";

const LIBRARY_TAB_ID = "__library__";
const SETTINGS_TAB_ID = "__settings__";

interface ReaderTab {
  resource: Resource;
  initialHighlightId: string | null;
  initialScrollY: number | null;
  initialPdfPage: number | null;
  initialPdfScrollFraction: number | null;
  initialPdfZoom: number | null;
}

interface FolderOpenRequest {
  folderId: string;
  ts: number;
}

function App() {
  const initialSession = useRef(loadSessionState()).current;
  const { t } = useTranslation('sidebar');
  const [activeTabId, setActiveTabId] = useState(initialSession.activeTabId);
  const [readerTabs, setReaderTabs] = useState<Map<string, ReaderTab>>(new Map());
  /** Open question detail tabs, keyed by Question.id (NOT the tab id with `q:` prefix). */
  const [questionTabs, setQuestionTabs] = useState<Map<string, Question>>(new Map());
  // Reader / question tabs are CSS-hidden when inactive (to preserve iframe
  // / fetch state) but only MOUNT on first activation to avoid paying for
  // every tab at boot.
  const [mountedTabIds, setMountedTabIds] = useState<Set<string>>(new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<"appearance" | "sync" | "encryption" | undefined>(undefined);
  const theme = useTheme();
  const [locked, setLocked] = useState(false);
  const [lockEnabled, setLockEnabled] = useState(false);
  const [folderOpenRequest, setFolderOpenRequest] = useState<FolderOpenRequest | null>(null);
  const lockTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lockTimeoutMinutesRef = useRef(10);
  const restoredRef = useRef(false);
  const deepLinkHandledRef = useRef(false);
  // Right-click context menu on a reader tab (resource tabs only).
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; resourceId: string; folderId: string } | null>(null);
  const [tabEditResource, setTabEditResource] = useState<Resource | null>(null);

  const openResource = useCallback((resource: Resource, highlightId?: string) => {
    setReaderTabs((prev) => {
      const next = new Map(prev);
      if (!next.has(resource.id)) {
        next.set(resource.id, {
          resource,
          initialHighlightId: highlightId ?? null,
          initialScrollY: null,
          initialPdfPage: null,
          initialPdfScrollFraction: null,
          initialPdfZoom: null,
        });
      } else if (highlightId) {
        const existing = next.get(resource.id)!;
        next.set(resource.id, { ...existing, initialHighlightId: highlightId });
      }
      return next;
    });
    setMountedTabIds((prev) => {
      if (prev.has(resource.id)) return prev;
      const next = new Set(prev);
      next.add(resource.id);
      return next;
    });
    setActiveTabId(resource.id);
    saveSessionState({ activeTabId: resource.id });
    // Ensure the tab is present in the persisted array; scroll fields fill in later.
    updateReaderTab(resource.id, {});
  }, []);

  const openQuestion = useCallback((question: Question) => {
    setQuestionTabs((prev) => {
      const next = new Map(prev);
      // Always refresh the snapshot — title / status may have changed.
      next.set(question.id, question);
      return next;
    });
    const tabId = questionTabId(question.id);
    setMountedTabIds((prev) => {
      if (prev.has(tabId)) return prev;
      const next = new Set(prev);
      next.add(tabId);
      return next;
    });
    setActiveTabId(tabId);
    saveSessionState({ activeTabId: tabId });
    addQuestionTab(question.id);
  }, []);

  const openSettings = useCallback((section?: "appearance" | "sync" | "encryption") => {
    setSettingsOpen(true);
    setSettingsSection(section);
    setActiveTabId(SETTINGS_TAB_ID);
    // Intentionally no saveSessionState: Settings is excluded from persistence,
    // so the last non-Settings active tab is what gets restored on next launch.
  }, []);

  const closeTab = useCallback((id: string) => {
    if (id === SETTINGS_TAB_ID) {
      setSettingsOpen(false);
      setActiveTabId((current) => (current === id ? LIBRARY_TAB_ID : current));
      saveSessionState({ activeTabId: activeTabId === id ? LIBRARY_TAB_ID : activeTabId });
      return;
    }
    const qId = parseQuestionTabId(id);
    if (qId) {
      setQuestionTabs((prev) => {
        if (!prev.has(qId)) return prev;
        const next = new Map(prev);
        next.delete(qId);
        return next;
      });
      setMountedTabIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setActiveTabId((current) => (current === id ? LIBRARY_TAB_ID : current));
      removeQuestionTab(qId);
      saveSessionState({ activeTabId: activeTabId === id ? LIBRARY_TAB_ID : activeTabId });
      return;
    }
    setReaderTabs((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    setMountedTabIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setActiveTabId((current) => (current === id ? LIBRARY_TAB_ID : current));
    removeReaderTab(id);
    saveSessionState({ activeTabId: activeTabId === id ? LIBRARY_TAB_ID : activeTabId });
  }, [activeTabId]);

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
          setMountedTabIds((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
          setActiveTabId((current) => {
            const next = current === id ? LIBRARY_TAB_ID : current;
            if (next !== current) saveSessionState({ activeTabId: next });
            return next;
          });
          removeReaderTab(id);
        }
      },
    );
    return () => { unlisten.then((f) => f()); };
  }, []);

  // Close any open question detail tab whose Question was deleted elsewhere
  // (sidebar context menu, MCP, sync from another device).
  useEffect(() => {
    const unlisten = listen<QuestionChangedPayload>(
      DataEvents.QUESTION_CHANGED,
      (event) => {
        if (event.payload.action !== "deleted") return;
        const qId = event.payload.question_id;
        if (!qId) return;
        const tabId = questionTabId(qId);
        setQuestionTabs((prev) => {
          if (!prev.has(qId)) return prev;
          const next = new Map(prev);
          next.delete(qId);
          return next;
        });
        setMountedTabIds((prev) => {
          if (!prev.has(tabId)) return prev;
          const next = new Set(prev);
          next.delete(tabId);
          return next;
        });
        setActiveTabId((current) => {
          const next = current === tabId ? LIBRARY_TAB_ID : current;
          if (next !== current) saveSessionState({ activeTabId: next });
          return next;
        });
        removeQuestionTab(qId);
      },
    );
    return () => { unlisten.then((f) => f()); };
  }, []);

  // Restore reader and question tabs from session on mount (once).
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;

    if (
      initialSession.readerTabs.length === 0 &&
      initialSession.questionTabs.length === 0
    ) {
      // Nothing to restore; any non-library active tab normalizes to library.
      if (initialSession.activeTabId !== LIBRARY_TAB_ID) {
        setActiveTabId(LIBRARY_TAB_ID);
        saveSessionState({ activeTabId: LIBRARY_TAB_ID });
      }
      return;
    }

    (async () => {
      const [readerResults, questionResults] = await Promise.all([
        Promise.all(
          initialSession.readerTabs.map(async (entry) => {
            try {
              const resource = await cmd.getResource(entry.resourceId);
              return resource ? { entry, resource } : null;
            } catch {
              return null;
            }
          }),
        ),
        Promise.all(
          initialSession.questionTabs.map(async (entry) => {
            try {
              const question = await cmd.getQuestion(entry.questionId);
              return question ? { entry, question } : null;
            } catch {
              return null;
            }
          }),
        ),
      ]);

      const nextReaderTabs = new Map<string, ReaderTab>();
      const keptReaderIds = new Set<string>();
      for (const r of readerResults) {
        if (!r) continue;
        nextReaderTabs.set(r.resource.id, {
          resource: r.resource,
          initialHighlightId: null,
          initialScrollY: typeof r.entry.scrollY === "number" ? r.entry.scrollY : null,
          initialPdfPage: typeof r.entry.pdfPage === "number" ? r.entry.pdfPage : null,
          initialPdfScrollFraction:
            typeof r.entry.pdfScrollFraction === "number" ? r.entry.pdfScrollFraction : null,
          initialPdfZoom: typeof r.entry.pdfZoom === "number" ? r.entry.pdfZoom : null,
        });
        keptReaderIds.add(r.resource.id);
      }
      const nextQuestionTabs = new Map<string, Question>();
      const keptQuestionTabIds = new Set<string>();
      for (const q of questionResults) {
        if (!q) continue;
        nextQuestionTabs.set(q.question.id, q.question);
        keptQuestionTabIds.add(questionTabId(q.question.id));
      }

      // Purge dropped tabs from session
      for (const e of initialSession.readerTabs) {
        if (!keptReaderIds.has(e.resourceId)) removeReaderTab(e.resourceId);
      }
      for (const e of initialSession.questionTabs) {
        if (!nextQuestionTabs.has(e.questionId)) removeQuestionTab(e.questionId);
      }

      // Determine final active tab:
      // - Settings tab → library (we don't restore Settings)
      // - Missing reader / question tab → library
      let finalActive = initialSession.activeTabId;
      if (finalActive === SETTINGS_TAB_ID) {
        finalActive = LIBRARY_TAB_ID;
      } else if (finalActive !== LIBRARY_TAB_ID) {
        const isReader = keptReaderIds.has(finalActive);
        const isQuestion = keptQuestionTabIds.has(finalActive);
        if (!isReader && !isQuestion) finalActive = LIBRARY_TAB_ID;
      }

      if (deepLinkHandledRef.current) {
        setReaderTabs((prev) => {
          const merged = new Map(prev);
          for (const [id, tab] of nextReaderTabs) {
            if (!merged.has(id)) merged.set(id, tab);
          }
          return merged;
        });
        setQuestionTabs((prev) => {
          const merged = new Map(prev);
          for (const [id, q] of nextQuestionTabs) {
            if (!merged.has(id)) merged.set(id, q);
          }
          return merged;
        });
        setMountedTabIds((prev) => {
          const next = new Set(prev);
          if (finalActive !== LIBRARY_TAB_ID && finalActive !== SETTINGS_TAB_ID) {
            next.add(finalActive);
          }
          return next;
        });
        return;
      }

      setReaderTabs(nextReaderTabs);
      setQuestionTabs(nextQuestionTabs);
      if (finalActive !== LIBRARY_TAB_ID) {
        setMountedTabIds(new Set([finalActive]));
      }
      setActiveTabId(finalActive);
      saveSessionState({ activeTabId: finalActive });
    })();
    // No cleanup cancel flag: StrictMode double-invokes effects, and the first
    // invocation's cleanup would set cancelled=true before the async work
    // completes — blocking the state updates entirely. The restoredRef guard
    // at the top already prevents duplicate runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pending deep link: stored when app is locked, processed after unlock
  const pendingDeepLinkRef = useRef<string | null>(null);

  const handleDeepLinkUrl = useCallback(async (url: string) => {
    const target = parseShibeiDeepLink(url);
    if (!target) return;

    if (target.kind === "folder") {
      if (target.folderId !== ALL_RESOURCES_ID && target.folderId !== INBOX_FOLDER_ID) {
        try {
          await cmd.getFolder(target.folderId);
        } catch (err) {
          console.error("Deep link: folder not found", target.folderId, err);
          setFolderOpenRequest({ folderId: target.folderId, ts: Date.now() });
          return;
        }
      }
      deepLinkHandledRef.current = true;
      setActiveTabId(LIBRARY_TAB_ID);
      saveSessionState({ activeTabId: LIBRARY_TAB_ID });
      setFolderOpenRequest({ folderId: target.folderId, ts: Date.now() });
      return;
    }

    if (target.kind === "question") {
      try {
        const question = await cmd.getQuestion(target.questionId);
        if (question) {
          deepLinkHandledRef.current = true;
          openQuestion(question);
        }
      } catch (err) {
        console.error("Deep link: question not found", target.questionId, err);
      }
      return;
    }

    try {
      const resource = await cmd.getResource(target.resourceId);
      if (resource) {
        deepLinkHandledRef.current = true;
        openResource(resource, target.highlightId);
      }
    } catch (err) {
      console.error("Deep link: resource not found", target.resourceId, err);
    }
  }, [openResource, openQuestion]);

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
            handleDeepLinkUrl(deepUrl);
          }
        }
      } catch {
        // Lock screen not available
      }
    }
    init();
    return () => { mounted = false; };
  }, [handleDeepLinkUrl]);

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

  // Deep link handler: shibei://open/resource/{id}?highlight={hlId} and shibei://open/folder/{id}
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
    ...Array.from(questionTabs.entries()).map(([qId, q]) => ({
      id: questionTabId(qId),
      label: q.title,
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
        onSelectTab={(id) => {
          if (id !== LIBRARY_TAB_ID && id !== SETTINGS_TAB_ID) {
            setMountedTabIds((prev) => {
              if (prev.has(id)) return prev;
              const next = new Set(prev);
              next.add(id);
              return next;
            });
          }
          setActiveTabId(id);
          saveSessionState({ activeTabId: id });
        }}
        onCloseTab={closeTab}
        onTabContextMenu={(e, id) => {
          // Only reader (resource) tabs get a context menu.
          const tab = readerTabs.get(id);
          if (!tab) return;
          e.preventDefault();
          setTabMenu({ x: e.clientX, y: e.clientY, resourceId: id, folderId: tab.resource.folder_id });
        }}
      />
      <div className={styles.content}>
        <div className={`${styles.tabPane} ${activeTabId !== LIBRARY_TAB_ID ? styles.tabPaneHidden : ""}`}>
          <LibraryView
            onOpenResource={openResource}
            onOpenQuestion={openQuestion}
            onOpenSettings={openSettings}
            lockEnabled={lockEnabled}
            onLock={() => setLocked(true)}
            folderOpenRequest={folderOpenRequest}
          />
        </div>
        {Array.from(readerTabs.entries()).map(([id, tab]) =>
          mountedTabIds.has(id) ? (
            <div key={id} className={`${styles.tabPane} ${activeTabId !== id ? styles.tabPaneHidden : ""}`}>
              <ReaderView
                resource={tab.resource}
                initialHighlightId={tab.initialHighlightId}
                initialScrollY={tab.initialScrollY}
                initialPdfPage={tab.initialPdfPage}
                initialPdfScrollFraction={tab.initialPdfScrollFraction}
                initialPdfZoom={tab.initialPdfZoom}
              />
            </div>
          ) : null,
        )}
        {Array.from(questionTabs.entries()).map(([qId, q]) => {
          const tabId = questionTabId(qId);
          return mountedTabIds.has(tabId) ? (
            <div
              key={tabId}
              className={`${styles.tabPane} ${activeTabId !== tabId ? styles.tabPaneHidden : ""}`}
            >
              <QuestionDetailView
                question={q}
                onOpenResource={openResource}
                onClose={() => closeTab(tabId)}
              />
            </div>
          ) : null;
        })}
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
      {tabMenu && (
        <ResourceContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          resourceIds={[tabMenu.resourceId]}
          currentFolderId={tabMenu.folderId}
          isSingleSelect={true}
          showDelete={false}
          onEdit={() => {
            const tab = readerTabs.get(tabMenu.resourceId);
            setTabEditResource(tab?.resource ?? null);
            setTabMenu(null);
          }}
          onMove={async (folderId) => {
            const id = tabMenu.resourceId;
            setTabMenu(null);
            try {
              await cmd.moveResource(id, folderId);
              // Keep the open tab's folder context fresh for later menus.
              setReaderTabs((prev) => {
                const tab = prev.get(id);
                if (!tab) return prev;
                const next = new Map(prev);
                next.set(id, { ...tab, resource: { ...tab.resource, folder_id: folderId } });
                return next;
              });
            } catch {
              /* moveResource surfaces errors via the resource-changed event flow */
            }
          }}
          onTagsChanged={() => {}}
          onClose={() => setTabMenu(null)}
        />
      )}
      {tabEditResource && (
        <ResourceEditDialog
          resource={tabEditResource}
          onSave={() => {
            const id = tabEditResource.id;
            // Refresh the open tab so its label/URL reflect the edit.
            cmd.getResource(id)
              .then((fresh) => {
                setReaderTabs((prev) => {
                  const tab = prev.get(id);
                  if (!tab) return prev;
                  const next = new Map(prev);
                  next.set(id, { ...tab, resource: fresh });
                  return next;
                });
              })
              .catch(() => { /* ignore: stale label is harmless */ });
          }}
          onClose={() => setTabEditResource(null)}
        />
      )}
    </div>
  );
}

export default App;
