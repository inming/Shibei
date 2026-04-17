# Session Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the user's tab list, active tab, scroll positions (HTML + PDF), and library selections (folder/tags/preview) across app restarts. Add lazy mounting for Reader tabs to avoid startup cost when many tabs are restored.

**Architecture:** A single `localStorage` key `shibei-session-state` stores a versioned JSON blob. A small `sessionState.ts` module owns the in-memory mirror and serialization, exposing fine-grained APIs (`saveSessionState`, `updateReaderTab`, `removeReaderTab`). Components read once on mount and write on changes (immediate for structural changes, 500ms debounced for scroll). HTML scroll restore goes through a new `shibei:restore-scroll` inbound iframe message; PDF scroll restore reuses `pdfScrollRequest` via a new `kind: "position"` variant.

**Tech Stack:** TypeScript + React 19, Vitest + React Testing Library. No backend changes, no new npm deps.

**Spec:** [docs/superpowers/specs/2026-04-17-session-persistence-design.md](../specs/2026-04-17-session-persistence-design.md)

---

## File Map

**Create:**
- `src/lib/sessionState.ts` — pure module: types + load/save/update/remove APIs
- `src/lib/sessionState.test.ts` — unit tests for the module

**Modify:**
- `src/annotator/annotator.ts` — add inbound `shibei:restore-scroll` message (regenerates `src-tauri/src/annotator.js` via `npm run build:annotator`)
- `src/App.tsx` — read session on mount, restore readerTabs + activeTabId, write on mutations, lazy mount Reader tabs, purge session on resource deletion
- `src/components/Layout.tsx` — read/write `library` section of session state; validate folder existence; react to folder/tag delete events
- `src/components/ReaderView.tsx` — accept initial scroll props; send `shibei:restore-scroll` on annotator-ready; debounce-write scroll to session; extend `pdfScrollRequest` to support position kind
- `src/components/PDFReader.tsx` — support `kind: "position"` scroll request; add `onScrollPosition({page, fraction})` callback for continuous position reporting

**No changes:** Rust backend, DB schema, MCP, tests outside `src/lib/sessionState.test.ts` (existing tests stay green).

---

## Task 1: Session state module and tests

**Files:**
- Create: `src/lib/sessionState.ts`
- Create: `src/lib/sessionState.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/sessionState.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  loadSessionState,
  saveSessionState,
  updateReaderTab,
  removeReaderTab,
  clearSessionState,
  STORAGE_KEY,
  DEFAULT_STATE,
  type SessionState,
} from "./sessionState";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("loadSessionState", () => {
  test("returns default when key missing", () => {
    expect(loadSessionState()).toEqual(DEFAULT_STATE);
  });

  test("returns default when JSON is malformed", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    expect(loadSessionState()).toEqual(DEFAULT_STATE);
  });

  test("returns default when version mismatches", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 999, activeTabId: "__library__", readerTabs: [], library: DEFAULT_STATE.library }),
    );
    expect(loadSessionState()).toEqual(DEFAULT_STATE);
  });

  test("returns parsed state when valid", () => {
    const state: SessionState = {
      version: 1,
      activeTabId: "r1",
      readerTabs: [{ resourceId: "r1", scrollY: 120 }],
      library: { selectedFolderId: "__inbox__", selectedTagIds: ["t1"], selectedResourceId: "r1" },
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    expect(loadSessionState()).toEqual(state);
  });

  test("fills missing optional fields with defaults", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, activeTabId: "__library__" }));
    const loaded = loadSessionState();
    expect(loaded.readerTabs).toEqual([]);
    expect(loaded.library).toEqual(DEFAULT_STATE.library);
  });
});

describe("saveSessionState", () => {
  test("shallow-merges top-level fields", () => {
    saveSessionState({ activeTabId: "r1" });
    saveSessionState({ readerTabs: [{ resourceId: "r1" }] });
    const loaded = loadSessionState();
    expect(loaded.activeTabId).toBe("r1");
    expect(loaded.readerTabs).toEqual([{ resourceId: "r1" }]);
  });

  test("writes version 1 even when patch omits it", () => {
    saveSessionState({ activeTabId: "r1" });
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(raw.version).toBe(1);
  });

  test("silently ignores localStorage.setItem throwing", () => {
    const orig = localStorage.setItem;
    localStorage.setItem = () => { throw new Error("quota"); };
    expect(() => saveSessionState({ activeTabId: "x" })).not.toThrow();
    localStorage.setItem = orig;
  });
});

describe("updateReaderTab", () => {
  test("appends new tab when id not present", () => {
    updateReaderTab("r1", { scrollY: 200 });
    expect(loadSessionState().readerTabs).toEqual([{ resourceId: "r1", scrollY: 200 }]);
  });

  test("merges fields on existing tab without touching others", () => {
    saveSessionState({
      readerTabs: [
        { resourceId: "r1", scrollY: 100 },
        { resourceId: "r2", pdfPage: 3, pdfScrollFraction: 0.2 },
      ],
    });
    updateReaderTab("r2", { pdfScrollFraction: 0.7 });
    const tabs = loadSessionState().readerTabs;
    expect(tabs).toEqual([
      { resourceId: "r1", scrollY: 100 },
      { resourceId: "r2", pdfPage: 3, pdfScrollFraction: 0.7 },
    ]);
  });

  test("preserves array order when updating", () => {
    saveSessionState({
      readerTabs: [
        { resourceId: "a" },
        { resourceId: "b" },
        { resourceId: "c" },
      ],
    });
    updateReaderTab("b", { scrollY: 99 });
    expect(loadSessionState().readerTabs.map((t) => t.resourceId)).toEqual(["a", "b", "c"]);
  });
});

describe("removeReaderTab", () => {
  test("removes tab by id", () => {
    saveSessionState({
      readerTabs: [{ resourceId: "a" }, { resourceId: "b" }, { resourceId: "c" }],
    });
    removeReaderTab("b");
    expect(loadSessionState().readerTabs.map((t) => t.resourceId)).toEqual(["a", "c"]);
  });

  test("no-op when id not present", () => {
    saveSessionState({ readerTabs: [{ resourceId: "a" }] });
    removeReaderTab("zzz");
    expect(loadSessionState().readerTabs.map((t) => t.resourceId)).toEqual(["a"]);
  });
});

describe("clearSessionState", () => {
  test("removes the key entirely", () => {
    saveSessionState({ activeTabId: "r1" });
    clearSessionState();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(loadSessionState()).toEqual(DEFAULT_STATE);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- sessionState`
Expected: FAIL with module not found / exports missing.

- [ ] **Step 3: Implement the module**

Create `src/lib/sessionState.ts`:

```ts
export const STORAGE_KEY = "shibei-session-state";
const CURRENT_VERSION = 1;

export interface ReaderTabState {
  resourceId: string;
  scrollY?: number;
  pdfPage?: number;
  pdfScrollFraction?: number;
}

export interface LibraryState {
  selectedFolderId: string | null;
  selectedTagIds: string[];
  selectedResourceId: string | null;
}

export interface SessionState {
  version: 1;
  activeTabId: string;
  readerTabs: ReaderTabState[];
  library: LibraryState;
}

export const DEFAULT_STATE: SessionState = {
  version: CURRENT_VERSION,
  activeTabId: "__library__",
  readerTabs: [],
  library: {
    selectedFolderId: "__all__",
    selectedTagIds: [],
    selectedResourceId: null,
  },
};

let mirror: SessionState | null = null;

function getMirror(): SessionState {
  if (mirror) return mirror;
  mirror = loadFromStorage();
  return mirror;
}

function loadFromStorage(): SessionState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return cloneDefault();
    const parsed = JSON.parse(raw) as Partial<SessionState> & { version?: number };
    if (parsed.version !== CURRENT_VERSION) return cloneDefault();
    return {
      version: CURRENT_VERSION,
      activeTabId: typeof parsed.activeTabId === "string" ? parsed.activeTabId : DEFAULT_STATE.activeTabId,
      readerTabs: Array.isArray(parsed.readerTabs) ? parsed.readerTabs : [],
      library: {
        selectedFolderId:
          parsed.library && "selectedFolderId" in parsed.library
            ? (parsed.library.selectedFolderId as string | null)
            : DEFAULT_STATE.library.selectedFolderId,
        selectedTagIds: Array.isArray(parsed.library?.selectedTagIds)
          ? (parsed.library!.selectedTagIds as string[])
          : [],
        selectedResourceId:
          parsed.library && "selectedResourceId" in parsed.library
            ? (parsed.library.selectedResourceId as string | null)
            : null,
      },
    };
  } catch {
    return cloneDefault();
  }
}

function cloneDefault(): SessionState {
  return {
    ...DEFAULT_STATE,
    readerTabs: [],
    library: { ...DEFAULT_STATE.library, selectedTagIds: [] },
  };
}

function flush(): void {
  if (!mirror) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(mirror));
  } catch {
    // quota / disabled storage — silent
  }
}

export function loadSessionState(): SessionState {
  // Always re-read from storage; tests clear localStorage between cases.
  mirror = loadFromStorage();
  return mirror;
}

export function saveSessionState(patch: Partial<SessionState>): void {
  const current = getMirror();
  mirror = {
    ...current,
    ...patch,
    version: CURRENT_VERSION,
    library: patch.library ? { ...current.library, ...patch.library } : current.library,
  };
  flush();
}

export function updateReaderTab(resourceId: string, patch: Partial<ReaderTabState>): void {
  const current = getMirror();
  const idx = current.readerTabs.findIndex((t) => t.resourceId === resourceId);
  const next = current.readerTabs.slice();
  if (idx === -1) {
    next.push({ resourceId, ...patch });
  } else {
    next[idx] = { ...next[idx], ...patch, resourceId };
  }
  mirror = { ...current, readerTabs: next };
  flush();
}

export function removeReaderTab(resourceId: string): void {
  const current = getMirror();
  const next = current.readerTabs.filter((t) => t.resourceId !== resourceId);
  if (next.length === current.readerTabs.length) return;
  mirror = { ...current, readerTabs: next };
  flush();
}

export function clearSessionState(): void {
  mirror = cloneDefault();
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // silent
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- sessionState`
Expected: all `sessionState` tests PASS, no other tests touched.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sessionState.ts src/lib/sessionState.test.ts
git commit -m "feat(session): add versioned session state store

Implements load/save/update/remove APIs over a single
shibei-session-state localStorage key. Used in subsequent
tasks to restore tabs, scroll positions, and library
selections across app restarts."
```

---

## Task 2: Lazy-mount Reader tabs in App.tsx (no persistence yet)

**Files:**
- Modify: `src/App.tsx` (lines 20-70, 224-272)

**Why first:** Doing lazy mount before wiring session restore keeps each change reviewable and testable independently. Without this, Task 3's restore would still mount every restored tab at boot, defeating the point.

- [ ] **Step 1: Add `mountedTabIds` state and gate tab-pane rendering**

In `src/App.tsx`, inside `function App()`, just after the existing `const [readerTabs, setReaderTabs] = useState<Map<string, ReaderTab>>(new Map());` line (around line 28), add:

```tsx
  // Reader tabs are CSS-hidden when inactive (to preserve iframe state),
  // but we only MOUNT them on first activation to avoid paying for every
  // tab at boot.
  const [mountedTabIds, setMountedTabIds] = useState<Set<string>>(new Set());
```

Replace `openResource` (lines 37-49) with:

```tsx
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
    setMountedTabIds((prev) => {
      if (prev.has(resource.id)) return prev;
      const next = new Set(prev);
      next.add(resource.id);
      return next;
    });
    setActiveTabId(resource.id);
  }, []);
```

Replace `closeTab` (lines 57-69) with:

```tsx
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
    setMountedTabIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setActiveTabId((current) => (current === id ? LIBRARY_TAB_ID : current));
  }, []);
```

In the resource-deleted listener (lines 71-89), inside the existing `setReaderTabs` handler, also clean `mountedTabIds`. Replace the listener body with:

```tsx
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
          setActiveTabId((current) => (current === id ? LIBRARY_TAB_ID : current));
        }
      },
    );
    return () => { unlisten.then((f) => f()); };
  }, []);
```

Replace the reader-tabs render loop (lines 253-260) with:

```tsx
        {Array.from(readerTabs.entries()).map(([id, tab]) =>
          mountedTabIds.has(id) ? (
            <div key={id} className={`${styles.tabPane} ${activeTabId !== id ? styles.tabPaneHidden : ""}`}>
              <ReaderView
                resource={tab.resource}
                initialHighlightId={tab.initialHighlightId}
              />
            </div>
          ) : null,
        )}
```

Also add a handler for `setActiveTabId` coming from the TabBar clicking a reader tab. The TabBar calls `onSelectTab={setActiveTabId}`. That path needs to mount the tab if it isn't mounted yet (can happen after Task 3's restore). Replace the `TabBar` invocation (line 238-243) with:

```tsx
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
        }}
        onCloseTab={closeTab}
      />
```

- [ ] **Step 2: Run type check and existing tests**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run test`
Expected: all existing tests still pass (including `src/App.test.tsx`).

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "refactor(tabs): lazy-mount reader tabs on first activation

Prepares for session restore. With many restored tabs, mounting
every ReaderView iframe at boot is expensive; now we mount only
the active tab plus anything the user subsequently clicks."
```

---

## Task 3: Restore tabs + activeTabId in App.tsx

**Files:**
- Modify: `src/App.tsx` (add restore effect + write hooks)

- [ ] **Step 1: Write the failing test**

In `src/App.test.tsx`, append (keep existing test):

```tsx
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { mockInvoke } from "@/test/tauriMock";
import { STORAGE_KEY } from "@/lib/sessionState";
import App from "./App";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  cleanup();
});

test("restores reader tabs from session state, skipping resources that no longer exist", async () => {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      version: 1,
      activeTabId: "r-gone",
      readerTabs: [
        { resourceId: "r-alive", scrollY: 100 },
        { resourceId: "r-gone", scrollY: 50 },
      ],
      library: { selectedFolderId: "__all__", selectedTagIds: [], selectedResourceId: null },
    }),
  );

  const alive = {
    id: "r-alive",
    title: "Alive Resource",
    url: "https://example.com/alive",
    folder_id: "__inbox__",
    resource_type: "webpage",
    created_at: "2026-04-17T00:00:00Z",
    updated_at: "2026-04-17T00:00:00Z",
    hlc: "0",
    deleted_at: null,
    description: null,
    plain_text: null,
    annotated_at: null,
  };

  mockInvoke((cmd, args) => {
    if (cmd === "cmd_get_resource") {
      const id = (args as { id: string }).id;
      if (id === "r-alive") return alive;
      return null;
    }
    if (cmd === "cmd_get_lock_status") return { enabled: false, timeout_minutes: 10 };
    return [];
  });

  render(<App />);

  // Active tab should fall back to library because r-gone was dropped
  const tab = await screen.findByText("Alive Resource");
  expect(tab).toBeInTheDocument();
  expect(screen.queryByText("r-gone")).toBeNull();

  // r-alive should still be present in the restored session mirror
  await act(async () => { /* allow restore microtasks to flush */ });
  const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
  expect(raw.readerTabs.map((t: { resourceId: string }) => t.resourceId)).toEqual(["r-alive"]);
});
```

Run: `npm run test -- App.test`
Expected: new test FAILs (Alive Resource tab not found, because App doesn't restore yet).

- [ ] **Step 2: Implement restore**

In `src/App.tsx`:

Add imports near the top (after existing imports):

```tsx
import {
  loadSessionState,
  saveSessionState,
  removeReaderTab,
} from "@/lib/sessionState";
```

Extend `ReaderTab` to carry restore hints:

```tsx
interface ReaderTab {
  resource: Resource;
  initialHighlightId: string | null;
  initialScrollY: number | null;
  initialPdfPage: number | null;
  initialPdfScrollFraction: number | null;
}
```

Change the `readerTabs` initial state and active tab initial state to derive from session. Replace the top of `function App()` (lines 27-34) with:

```tsx
  const initialSession = useRef(loadSessionState()).current;
  const { t } = useTranslation('sidebar');
  const [activeTabId, setActiveTabId] = useState(initialSession.activeTabId);
  const [readerTabs, setReaderTabs] = useState<Map<string, ReaderTab>>(new Map());
  const [mountedTabIds, setMountedTabIds] = useState<Set<string>>(new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<"appearance" | "sync" | "encryption" | undefined>(undefined);
  const theme = useTheme();
  const [locked, setLocked] = useState(false);
  const [lockEnabled, setLockEnabled] = useState(false);
  const lockTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lockTimeoutMinutesRef = useRef(10);
  const restoredRef = useRef(false);
```

Add a restore effect (insert it right before the existing `// Lock screen: check status on mount` effect, around line 91):

```tsx
  // Restore reader tabs from session on mount (once).
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    if (initialSession.readerTabs.length === 0) {
      // Normalize activeTabId if nothing to restore
      if (
        initialSession.activeTabId !== LIBRARY_TAB_ID &&
        initialSession.activeTabId !== SETTINGS_TAB_ID
      ) {
        setActiveTabId(LIBRARY_TAB_ID);
      } else if (initialSession.activeTabId === SETTINGS_TAB_ID) {
        setActiveTabId(LIBRARY_TAB_ID);
      }
      return;
    }

    let cancelled = false;
    (async () => {
      const results = await Promise.all(
        initialSession.readerTabs.map(async (entry) => {
          try {
            const resource = await cmd.getResource(entry.resourceId);
            return resource ? { entry, resource } : null;
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) return;

      const nextTabs = new Map<string, ReaderTab>();
      const keptIds = new Set<string>();
      for (const r of results) {
        if (!r) continue;
        nextTabs.set(r.resource.id, {
          resource: r.resource,
          initialHighlightId: null,
          initialScrollY: typeof r.entry.scrollY === "number" ? r.entry.scrollY : null,
          initialPdfPage: typeof r.entry.pdfPage === "number" ? r.entry.pdfPage : null,
          initialPdfScrollFraction:
            typeof r.entry.pdfScrollFraction === "number" ? r.entry.pdfScrollFraction : null,
        });
        keptIds.add(r.resource.id);
      }

      // Purge dropped tabs from session
      for (const e of initialSession.readerTabs) {
        if (!keptIds.has(e.resourceId)) removeReaderTab(e.resourceId);
      }

      // Determine final active tab
      let finalActive = initialSession.activeTabId;
      if (finalActive === SETTINGS_TAB_ID) finalActive = LIBRARY_TAB_ID;
      else if (finalActive !== LIBRARY_TAB_ID && !keptIds.has(finalActive)) finalActive = LIBRARY_TAB_ID;

      setReaderTabs(nextTabs);
      if (finalActive !== LIBRARY_TAB_ID) {
        setMountedTabIds(new Set([finalActive]));
      }
      setActiveTabId(finalActive);
      // Persist normalized active tab
      saveSessionState({ activeTabId: finalActive });
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

Now thread the initial-scroll props through to `ReaderView` in the render loop (replace the block changed in Task 2 step 1, with the extra props):

```tsx
        {Array.from(readerTabs.entries()).map(([id, tab]) =>
          mountedTabIds.has(id) ? (
            <div key={id} className={`${styles.tabPane} ${activeTabId !== id ? styles.tabPaneHidden : ""}`}>
              <ReaderView
                resource={tab.resource}
                initialHighlightId={tab.initialHighlightId}
                initialScrollY={tab.initialScrollY}
                initialPdfPage={tab.initialPdfPage}
                initialPdfScrollFraction={tab.initialPdfScrollFraction}
              />
            </div>
          ) : null,
        )}
```

Add mutation-side writes. We never rewrite the full `readerTabs` array at once — we use `updateReaderTab` (append/merge one entry) and `removeReaderTab` (delete one entry), plus `saveSessionState({ activeTabId })` for the active-tab pointer. That keeps writes small and avoids needing a `readerTabs` ref mirror.

Update the import line added earlier to also bring in `updateReaderTab`:

```tsx
import {
  loadSessionState,
  saveSessionState,
  updateReaderTab,
  removeReaderTab,
} from "@/lib/sessionState";
```

Inside `openResource`, after `setActiveTabId(resource.id);` append:

```tsx
    saveSessionState({ activeTabId: resource.id });
    // Ensure the tab is present in the persisted array; scroll fields fill in later.
    updateReaderTab(resource.id, {});
```

Inside `closeTab`, after `setActiveTabId(...)` append:

```tsx
    if (id !== SETTINGS_TAB_ID) removeReaderTab(id);
    // saveSessionState active will reflect the fallback in the setState callback;
    // call it after, since React state updates are async we mirror the same logic:
    saveSessionState({ activeTabId: activeTabId === id ? LIBRARY_TAB_ID : activeTabId });
```

(The `activeTabId` captured here is the value at the time of the call — acceptable because immediately after the closure runs, the state setter resolves consistently.)

In the `onSelectTab` handler (from Task 2 step 1), after `setActiveTabId(id)` add:

```tsx
          saveSessionState({ activeTabId: id });
```

In the resource-deleted listener, inside the `if (event.payload.action === "deleted")` block, after `setActiveTabId(...)`, add:

```tsx
          removeReaderTab(id);
```

- [ ] **Step 3: Run the new test**

Run: `npm run test -- App.test`
Expected: the new restore test now PASSes; the original test still passes.

- [ ] **Step 4: Run full test suite and type check**

Run: `npx tsc --noEmit`
Expected: no errors (the new `ReaderView` props `initialScrollY` etc. won't exist yet — **this will fail**. Defer the type check to the end of Task 5 when ReaderView is updated. For now, run only the session + app tests).

Run: `npm run test -- sessionState App.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/App.test.tsx
git commit -m "feat(session): restore open tabs and active tab on startup

Reads shibei-session-state on mount, resolves each resource_id
via cmd_get_resource (silently dropping ones that no longer
exist), and mounts only the restored active tab. Persists
active tab and tab set on every mutation."
```

---

## Task 4: Persist and restore HTML scroll position

**Files:**
- Modify: `src/annotator/annotator.ts`
- Modify: `src/components/ReaderView.tsx`

- [ ] **Step 1: Add `RestoreScrollMsg` to annotator**

In `src/annotator/annotator.ts`, add a new inbound message type. Insert after the existing `UpdateHighlightColorMsg` interface (around line 61):

```ts
  interface RestoreScrollMsg {
    type: "shibei:restore-scroll";
    source: "shibei";
    scrollY: number;
  }
```

Update the `InboundMessage` union (around line 63):

```ts
  type InboundMessage =
    | RenderHighlightsMsg
    | AddHighlightMsg
    | RemoveHighlightMsg
    | ScrollToHighlightMsg
    | UpdateHighlightColorMsg
    | RestoreScrollMsg;
```

In the message `switch` (around line 704), add a new case after `shibei:scroll-to-highlight`:

```ts
      case "shibei:restore-scroll":
        if (typeof msg.scrollY === "number") {
          window.scrollTo(0, msg.scrollY);
        }
        break;
```

Rebuild annotator:

```bash
npm run build:annotator
```

Verify `src-tauri/src/annotator.js` updated:

```bash
grep -c "shibei:restore-scroll" src-tauri/src/annotator.js
```

Expected: `1`.

- [ ] **Step 2: Add scroll props to `ReaderView` and wire restore on ready**

In `src/components/ReaderView.tsx`:

Update `ReaderViewProps` (around line 19):

```tsx
interface ReaderViewProps {
  resource: Resource;
  initialHighlightId: string | null;
  initialScrollY?: number | null;
  initialPdfPage?: number | null;
  initialPdfScrollFraction?: number | null;
}
```

Destructure in the signature (around line 30):

```tsx
export function ReaderView({
  resource,
  initialHighlightId,
  initialScrollY,
  initialPdfPage,
  initialPdfScrollFraction,
}: ReaderViewProps) {
```

Add import at top:

```tsx
import { updateReaderTab } from "@/lib/sessionState";
```

Add a ref guarding one-shot restore (near other `useRef` declarations, after `didScrollToInitial`):

```tsx
  const didRestoreScroll = useRef(false);
```

Inside the existing `handleMessage` switch, update the `shibei:annotator-ready` case to also trigger scroll restore when applicable. Replace:

```tsx
        case "shibei:annotator-ready":
          setIframeReady(true);
          break;
```

with:

```tsx
        case "shibei:annotator-ready":
          setIframeReady(true);
          if (
            resource.resource_type !== "pdf" &&
            !didRestoreScroll.current &&
            !initialHighlightId &&
            typeof initialScrollY === "number" &&
            initialScrollY > 0 &&
            iframeRef.current?.contentWindow
          ) {
            didRestoreScroll.current = true;
            iframeRef.current.contentWindow.postMessage(
              { type: "shibei:restore-scroll", source: "shibei", scrollY: initialScrollY },
              "*",
            );
          }
          break;
```

Note the guard `!initialHighlightId`: when a deep link or preview-panel-click asks us to jump to a highlight, the highlight wins over the remembered scroll position.

- [ ] **Step 3: Write saved scroll on scroll events**

Still in `ReaderView.tsx`, add a debounced write in the `shibei:scroll` case. Find the existing block (around lines 134-157):

```tsx
        case "shibei:scroll": {
          // ...existing code...
          break;
        }
```

Add before the `break;` at the end of the case:

```tsx
          if (typeof scrollY === "number" && resource.resource_type !== "pdf") {
            if (scrollPersistTimer.current) clearTimeout(scrollPersistTimer.current);
            const id = resource.id;
            const y = scrollY;
            scrollPersistTimer.current = setTimeout(() => {
              updateReaderTab(id, { scrollY: y });
            }, 500);
          }
```

Add the timer ref near the other refs (e.g. after `didScrollToInitial`):

```tsx
  const scrollPersistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
```

Add a cleanup effect so pending writes aren't lost when the component unmounts (tab close mid-debounce):

```tsx
  useEffect(() => () => {
    if (scrollPersistTimer.current) clearTimeout(scrollPersistTimer.current);
  }, []);
```

Reset the restore guard if the resource changes (should not normally happen for same `<ReaderView>`, but defensive):

```tsx
  useEffect(() => {
    didRestoreScroll.current = false;
  }, [resource.id]);
```

- [ ] **Step 4: Type check and tests**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run test`
Expected: all tests pass.

- [ ] **Step 5: Manual verification**

Start: `VITE_DEBUG=1 npm run tauri dev`
- Open an HTML resource, scroll to ~half page, wait 1 second
- Close the app (Cmd+Q)
- Reopen → tab should restore with the same scroll position

Report result in commit message; proceed only if green.

- [ ] **Step 6: Commit**

```bash
git add src/annotator/annotator.ts src-tauri/src/annotator.js src/components/ReaderView.tsx
git commit -m "feat(session): persist and restore HTML reader scroll position

Adds shibei:restore-scroll inbound iframe message; React side
sends it once on annotator-ready when session has a saved
scrollY and no highlight was requested. Scroll events
debounce-write to session every 500ms."
```

---

## Task 5: Persist and restore PDF scroll position

**Files:**
- Modify: `src/components/PDFReader.tsx`
- Modify: `src/components/ReaderView.tsx`

- [ ] **Step 1: Extend `scrollToHighlightRequest` to a tagged union**

In `src/components/PDFReader.tsx`:

Replace the prop type (line 44) with a new union. Rename the prop to `scrollRequest`:

```tsx
export type PdfScrollRequest =
  | { kind: "highlight"; id: string; ts: number }
  | { kind: "position"; page: number; fraction: number; ts: number };

interface PDFReaderProps {
  resourceId: string;
  highlights: Highlight[];
  activeHighlightId: string | null;
  onSelection: (info: { text: string; anchor: PdfAnchor; rect: DOMRect }) => void;
  onClearSelection: () => void;
  onHighlightClick: (id: string) => void;
  onHighlightContextMenu: (id: string, position: { top: number; left: number }) => void;
  onScroll: (info: { scrollPercent: number; direction: "up" | "down" }) => void;
  onScrollPosition: (info: { page: number; fraction: number }) => void;
  onReady: () => void;
  scrollRequest: PdfScrollRequest | null;
}
```

Destructure the new prop (around line 60):

```tsx
export function PDFReader({
  resourceId,
  highlights,
  activeHighlightId,
  onSelection,
  onClearSelection,
  onHighlightClick,
  onHighlightContextMenu,
  onScroll,
  onScrollPosition,
  onReady,
  scrollRequest,
}: PDFReaderProps) {
```

- [ ] **Step 2: Handle position-kind requests**

Replace the existing "Scroll to highlight on request" effect (around lines 533-552) with a version that handles both kinds:

```tsx
  // ── Handle scroll requests (highlight or saved position) ──

  useEffect(() => {
    if (!scrollRequest) return;
    const container = containerRef.current;
    if (!container) return;

    if (scrollRequest.kind === "highlight") {
      const hl = highlights.find((h) => h.id === scrollRequest.id);
      if (!hl) return;
      const anchor = hl.anchor as PdfAnchor;
      if (anchor.type !== "pdf") return;

      const pageDiv = pageContainerMapRef.current.get(anchor.page);
      if (!pageDiv) return;

      const hlDiv = pageDiv.querySelector(
        `[data-highlight-id="${scrollRequest.id}"]`,
      ) as HTMLElement | null;
      if (hlDiv) {
        hlDiv.scrollIntoView({ behavior: "smooth", block: "center" });
      } else {
        pageDiv.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      return;
    }

    // kind === "position"
    const offsets = getPageOffsets();
    const heights = getPageHeights();
    const pageIdx = Math.max(0, Math.min(scrollRequest.page, heights.length - 1));
    if (offsets.length <= pageIdx || heights.length <= pageIdx) return;
    const target = offsets[pageIdx] + heights[pageIdx] * scrollRequest.fraction;
    container.scrollTop = target;
  }, [scrollRequest, highlights, getPageHeights, getPageOffsets]);
```

- [ ] **Step 3: Report `{page, fraction}` from scroll handler**

In the scroll handler (around lines 374-389), after the existing `onScroll({ scrollPercent, direction });` add:

```tsx
      // Report page + in-page fraction for session persistence
      const hs = getPageHeights();
      const os = getPageOffsets();
      if (hs.length > 0) {
        let pageIdx = 0;
        for (let i = 0; i < os.length; i++) {
          if (os[i] <= scrollTop) pageIdx = i;
          else break;
        }
        const pageTop = os[pageIdx];
        const pageH = hs[pageIdx] || 1;
        const fraction = Math.max(0, Math.min(1, (scrollTop - pageTop) / pageH));
        onScrollPosition({ page: pageIdx, fraction });
      }
```

Extend the effect's dependency array:

```tsx
  }, [pageInfos, onScroll, onScrollPosition, renderVisiblePages, getPageHeights, getPageOffsets]);
```

- [ ] **Step 4: Wire PDFReader into ReaderView (rename + initial position)**

In `src/components/ReaderView.tsx`:

Replace the `pdfScrollRequest` state type and initial value (around line 54):

```tsx
  const [pdfScrollRequest, setPdfScrollRequest] = useState<
    | { kind: "highlight"; id: string; ts: number }
    | { kind: "position"; page: number; fraction: number; ts: number }
    | null
  >(null);
```

Update the existing "PDF counterpart: auto-scroll" effect (around line 258) to use the new shape:

```tsx
  useEffect(() => {
    if (resource.resource_type !== "pdf") return;
    if (
      initialHighlightId &&
      !iframeLoading &&
      highlights.length > 0 &&
      !didScrollToInitial.current
    ) {
      didScrollToInitial.current = true;
      setActiveHighlightId(initialHighlightId);
      setPdfScrollRequest({ kind: "highlight", id: initialHighlightId, ts: Date.now() });
    }
  }, [initialHighlightId, iframeLoading, highlights, resource.resource_type]);
```

Add a new effect for position restore (right after the one above):

```tsx
  const didRestorePdfPosition = useRef(false);
  useEffect(() => {
    if (resource.resource_type !== "pdf") return;
    if (didRestorePdfPosition.current) return;
    if (initialHighlightId) return; // highlight wins
    if (iframeLoading) return; // wait for onReady
    if (typeof initialPdfPage !== "number") return;
    didRestorePdfPosition.current = true;
    setPdfScrollRequest({
      kind: "position",
      page: initialPdfPage,
      fraction: typeof initialPdfScrollFraction === "number" ? initialPdfScrollFraction : 0,
      ts: Date.now(),
    });
  }, [resource.resource_type, initialPdfPage, initialPdfScrollFraction, initialHighlightId, iframeLoading]);

  // Reset guards when resource changes
  useEffect(() => {
    didRestorePdfPosition.current = false;
  }, [resource.id]);
```

Find the `<PDFReader ... />` invocation and update prop names. Search in the current render JSX of `ReaderView.tsx`; the component is invoked with `scrollToHighlightRequest={pdfScrollRequest}`. Replace that prop with `scrollRequest={pdfScrollRequest}` and add an `onScrollPosition` callback.

Add the debounce timer for PDF persistence near the other refs:

```tsx
  const pdfPersistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
```

Add cleanup alongside the HTML scroll timer cleanup (merge if helpful):

```tsx
  useEffect(() => () => {
    if (pdfPersistTimer.current) clearTimeout(pdfPersistTimer.current);
  }, []);
```

Also update `handlePanelClickHighlight` (around line 391-395) to use the new tagged shape. Replace:

```tsx
      setPdfScrollRequest({ id, ts: Date.now() });
```

with:

```tsx
      setPdfScrollRequest({ kind: "highlight", id, ts: Date.now() });
```

In the render, find the `<PDFReader ... />` invocation (around line 436-470) and replace the last line from:

```tsx
            scrollToHighlightRequest={pdfScrollRequest}
          />
```

to:

```tsx
            onScrollPosition={({ page, fraction }) => {
              if (pdfPersistTimer.current) clearTimeout(pdfPersistTimer.current);
              const id = resource.id;
              pdfPersistTimer.current = setTimeout(() => {
                updateReaderTab(id, { pdfPage: page, pdfScrollFraction: fraction });
              }, 500);
            }}
            scrollRequest={pdfScrollRequest}
          />
```

- [ ] **Step 5: Type check and tests**

Run: `npx tsc --noEmit`
Expected: no errors. If errors mention `PdfScrollRequest` not exported from `PDFReader`, add `export type { PdfScrollRequest } from "./PDFReader";` or inline the type in `ReaderView.tsx` as shown in step 4.

Run: `npm run test`
Expected: all tests pass.

- [ ] **Step 6: Manual verification**

Start: `VITE_DEBUG=1 npm run tauri dev`
- Open a PDF resource, scroll to e.g. page 5 middle, wait 1 second
- Close and reopen the app
- Same tab should reopen at page 5 middle
- Deep link `shibei://open/resource/<id>?highlight=<hlId>` still jumps to the highlight (not the saved position)

- [ ] **Step 7: Commit**

```bash
git add src/components/PDFReader.tsx src/components/ReaderView.tsx
git commit -m "feat(session): persist and restore PDF scroll position

Extends PDFReader's scroll request to a tagged union supporting
{ kind: 'highlight' } (existing) and { kind: 'position' } (new).
ReaderView debounces page+fraction writes to session every 500ms
and restores on first onReady when no highlight jump was queued."
```

---

## Task 6: Persist and restore library selections

**Files:**
- Modify: `src/components/Layout.tsx`

- [ ] **Step 1: Read session on mount**

In `src/components/Layout.tsx`:

Add imports:

```tsx
import { loadSessionState, saveSessionState } from "@/lib/sessionState";
import { INBOX_FOLDER_ID } from "@/types";
import { DataEvents, type FolderChangedPayload, type TagChangedPayload } from "@/lib/events";
```

(Adjust: `DataEvents`, `ResourceChangedPayload` already imported; add what's missing.)

Inside `LibraryView`, replace the three relevant state initializers (around lines 29-33) with lazy initializers from session:

```tsx
  const initialLibrary = useRef(loadSessionState().library).current;
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(
    initialLibrary.selectedFolderId ?? ALL_RESOURCES_ID,
  );
  const [selectedResourceIds, setSelectedResourceIds] = useState<Set<string>>(new Set());
  const [lastClickedResourceId, setLastClickedResourceId] = useState<string | null>(null);
  const [selectedResource, setSelectedResource] = useState<Resource | null>(null);
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set(initialLibrary.selectedTagIds));
```

Add a mount effect to validate folder and hydrate selected resource:

```tsx
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Validate folder (skip virtuals)
      const fid = initialLibrary.selectedFolderId;
      if (fid && fid !== ALL_RESOURCES_ID && fid !== INBOX_FOLDER_ID) {
        try {
          await cmd.getFolder(fid);
        } catch {
          if (cancelled) return;
          setSelectedFolderId(INBOX_FOLDER_ID);
          saveSessionState({ library: { ...initialLibrary, selectedFolderId: INBOX_FOLDER_ID } });
        }
      }
      // Hydrate selected resource for preview
      const rid = initialLibrary.selectedResourceId;
      if (rid) {
        try {
          const r = await cmd.getResource(rid);
          if (r && !cancelled) setSelectedResource(r);
        } catch { /* ignore — resource gone */ }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

- [ ] **Step 2: Write on changes**

Add a helper near the top of the component body (after the state declarations):

```tsx
  const persistLibrary = useCallback(() => {
    saveSessionState({
      library: {
        selectedFolderId,
        selectedTagIds: Array.from(selectedTagIds),
        selectedResourceId: selectedResource?.id ?? null,
      },
    });
  }, [selectedFolderId, selectedTagIds, selectedResource]);

  useEffect(() => {
    persistLibrary();
  }, [persistLibrary]);
```

This one effect covers all three: any change to folder id, tag set, or selected resource re-persists. Cheap and correct.

- [ ] **Step 3: React to folder/tag delete events**

Add after the existing `useEffect` listeners in `LibraryView`:

```tsx
  useEffect(() => {
    const unlisten = listen<FolderChangedPayload>(DataEvents.FOLDER_CHANGED, (event) => {
      if (event.payload.action !== "deleted") return;
      const deletedId = event.payload.folder_id;
      if (!deletedId) return;
      setSelectedFolderId((current) => (current === deletedId ? INBOX_FOLDER_ID : current));
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  useEffect(() => {
    const unlisten = listen<TagChangedPayload>(DataEvents.TAG_CHANGED, (event) => {
      if (event.payload.action !== "deleted") return;
      const deletedId = event.payload.tag_id;
      if (!deletedId) return;
      setSelectedTagIds((prev) => {
        if (!prev.has(deletedId)) return prev;
        const next = new Set(prev);
        next.delete(deletedId);
        return next;
      });
    });
    return () => { unlisten.then((f) => f()); };
  }, []);
```

`listen` is already imported at the top of `Layout.tsx` (line 3). `FolderChangedPayload` and `TagChangedPayload` are exported from `src/lib/events.ts:31` / `:37` and carry `action` + `folder_id` / `tag_id` fields.

- [ ] **Step 4: Type check and tests**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run test`
Expected: all tests pass.

- [ ] **Step 5: Manual verification**

Start: `VITE_DEBUG=1 npm run tauri dev`
- Select a folder, pick 2 tags, click a resource in preview
- Close and reopen → same folder, same tags, same preview resource
- Select a non-system folder → delete it via context menu → selection falls back to Inbox
- Delete one of the selected tags → the chip disappears from filter

- [ ] **Step 6: Commit**

```bash
git add src/components/Layout.tsx
git commit -m "feat(session): persist and restore library selections

Saves selectedFolderId, selectedTagIds, selectedResourceId.
Validates folder existence on restore (falls back to Inbox).
Cleans up stale IDs when folders or tags are deleted."
```

---

## Task 7: End-to-end manual verification

**Files:** none changed.

- [ ] **Step 1: Run full checklist**

Start: `npm run test` — all tests PASS.
Start: `npx tsc --noEmit` — no errors.
Start: `npm run tauri dev`

Verify:

1. **Multi-tab restore**: open 2 HTML resources + 1 PDF, scroll each to different spots. Quit (Cmd+Q) → reopen. All 3 tabs present in original order, active tab preserved, all 3 scrolled to saved positions.
2. **Settings not restored**: open Settings, leave it active, quit. Reopen → active tab is Library, Settings tab is not present.
3. **Deleted resource dropped**: open 2 tabs, quit. Via the app or SQLite CLI, soft-delete one resource (`UPDATE resources SET deleted_at = '2026-04-17T00:00:00Z' WHERE id = 'X'`). Reopen → only the alive tab restores; no error in console.
4. **Lock screen**: enable lock screen. Quit with 3 tabs open → reopen → lock screen shows; unlock → tabs present.
5. **Library state**: select a non-inbox folder + 2 tags + click a preview resource. Quit → reopen → same state.
6. **Deleted folder fallback**: restart with a folder selected → delete that folder from the tree → selection drops to Inbox.
7. **Lazy mount**: prepare a session with 5 tabs; at startup, open DevTools → Elements → only 1 `<iframe>` is in the DOM for reader tabs. Click another tab → its iframe mounts.
8. **Deep link beats saved scroll**: note the saved scrollY for an HTML tab; trigger a `shibei://open/resource/<id>?highlight=<hlId>` → it jumps to the highlight, not to the saved scrollY.

- [ ] **Step 2: Commit manual-verification notes if any issues found**

If everything passes, no commit. If issues are found, fix them in a targeted commit referencing the failing scenario.

---

## Validation summary

| Spec requirement | Task |
|---|---|
| Single versioned localStorage key | Task 1 |
| `saveSessionState` / `updateReaderTab` / `removeReaderTab` APIs | Task 1 |
| Version mismatch / bad JSON → defaults | Task 1 |
| Lazy mount Reader tabs | Task 2 |
| Restore readerTabs + activeTabId on boot, drop missing | Task 3 |
| Persist active tab + tab membership on mutations | Task 3 |
| Purge session entry on resource-deleted event | Task 3 |
| HTML scroll restore via `shibei:restore-scroll` | Task 4 |
| HTML scroll debounced write | Task 4 |
| Highlight wins over saved scroll | Task 4 (guard), Task 5 (guard) |
| PDF scroll restore via `kind: "position"` | Task 5 |
| PDF scroll debounced write (page + fraction) | Task 5 |
| Library selections (folder / tags / preview) restore | Task 6 |
| Folder existence validated, fallback to Inbox | Task 6 |
| Folder/tag delete cleans session | Task 6 |
| Settings tab not restored | Task 3 (normalization logic) |
| Lock screen still wins visually | Task 3 (restore is unconditional; LockScreen renders on top) |
