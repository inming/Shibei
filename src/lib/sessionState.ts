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

/**
 * Tab state for an open QuestionDetailView. Kept minimal — questions have no
 * scroll/zoom semantics worth restoring across launches.
 *
 * Stored alongside `readerTabs` as a parallel array rather than via a tagged
 * union: this avoids forcing a v1→v2 migration of users' existing session
 * files, since v1 readers simply don't read this field.
 */
export interface QuestionTabState {
  questionId: string;
}

export interface LibraryState {
  selectedFolderId: string | null;
  selectedTagIds?: string[]; // deprecated, kept for backward compat with stored data
  filterTagIds: string[];
  selectedResourceId: string | null;
  listScrollTop?: number;
}

export interface SessionState {
  version: 1;
  activeTabId: string;
  readerTabs: ReaderTabState[];
  /** v2026-05-27: question detail tabs. Missing in older session files. */
  questionTabs: QuestionTabState[];
  library: LibraryState;
}

export const DEFAULT_STATE: SessionState = {
  version: CURRENT_VERSION,
  activeTabId: "__library__",
  readerTabs: [],
  questionTabs: [],
  library: {
    selectedFolderId: "__all__",
    selectedTagIds: [],
    filterTagIds: [],
    selectedResourceId: null,
  },
};

/** Tab id prefix used to distinguish question detail tabs from resource ids. */
export const QUESTION_TAB_PREFIX = "q:";

export function questionTabId(questionId: string): string {
  return `${QUESTION_TAB_PREFIX}${questionId}`;
}

export function parseQuestionTabId(id: string): string | null {
  return id.startsWith(QUESTION_TAB_PREFIX) ? id.slice(QUESTION_TAB_PREFIX.length) : null;
}

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
      questionTabs: Array.isArray(parsed.questionTabs)
        ? parsed.questionTabs.filter(
            (t): t is QuestionTabState => !!t && typeof (t as QuestionTabState).questionId === "string",
          )
        : [],
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
    questionTabs: [],
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

export function addQuestionTab(questionId: string): void {
  const current = getMirror();
  if (current.questionTabs.some((t) => t.questionId === questionId)) return;
  mirror = { ...current, questionTabs: [...current.questionTabs, { questionId }] };
  flush();
}

export function removeQuestionTab(questionId: string): void {
  const current = getMirror();
  const next = current.questionTabs.filter((t) => t.questionId !== questionId);
  if (next.length === current.questionTabs.length) return;
  mirror = { ...current, questionTabs: next };
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
