export const STORAGE_KEY = "shibei-session-state";
const CURRENT_VERSION = 1;

export interface ReaderTabState {
  resourceId: string;
  scrollY?: number;
  /** 0-based page index (matches PDFReader's internal pageIdx). */
  pdfPage?: number;
  pdfScrollFraction?: number;
  /** PDF zoom factor. 1.0 = fit-to-width. Range clamped at read time. */
  pdfZoom?: number;
}

export interface LibraryState {
  selectedFolderId: string | null;
  selectedTagIds: string[];
  filterTagIds: string[];
  selectedResourceId: string | null;
  listScrollTop?: number;
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
    filterTagIds: [],
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
        filterTagIds: Array.isArray(parsed.library?.filterTagIds)
          ? (parsed.library!.filterTagIds as string[])
          : [],
        selectedResourceId:
          parsed.library && "selectedResourceId" in parsed.library
            ? (parsed.library.selectedResourceId as string | null)
            : null,
        listScrollTop:
          typeof parsed.library?.listScrollTop === "number"
            ? parsed.library.listScrollTop
            : undefined,
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
