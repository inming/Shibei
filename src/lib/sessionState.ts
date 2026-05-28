export const STORAGE_KEY = "shibei-session-state";
const CURRENT_VERSION = 2;

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

export type LibraryMode = "resources" | "questions";
export type QuestionFilter = "active" | "archived" | "all";

const LIBRARY_MODES: readonly LibraryMode[] = ["resources", "questions"];
const QUESTION_FILTERS: readonly QuestionFilter[] = ["active", "archived", "all"];

export interface LibraryState {
  /** Which list the middle column renders. Drives Sidebar entry highlight too. */
  mode: LibraryMode;
  // ---- resources mode ----
  selectedFolderId: string | null;
  /** @deprecated kept for backward compat with stored data; new code uses filterTagIds */
  selectedTagIds?: string[];
  filterTagIds: string[];
  selectedResourceId: string | null;
  /** Resource list scroll position. Optional; consumers use `?? 0`. Renamed from v1's `listScrollTop`. */
  resourceListScrollTop?: number;
  // ---- questions mode ----
  /** Question-list filter chip selection. Defaults to "active". */
  questionFilter: QuestionFilter;
  selectedQuestionId: string | null;
  /** Question list scroll position. Optional; consumers use `?? 0`. */
  questionListScrollTop?: number;
}

export interface SessionState {
  version: 2;
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
    mode: "resources",
    selectedFolderId: "__all__",
    selectedTagIds: [],
    filterTagIds: [],
    selectedResourceId: null,
    questionFilter: "active",
    selectedQuestionId: null,
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

function validateEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function loadFromStorage(): SessionState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return cloneDefault();
    // Type loosely as Record so we can compare against legacy version numbers
    // (SessionState.version is literally 2, so a strict Partial<SessionState>
    // would narrow `version` and forbid comparing to 1).
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Only v1 (legacy, migrates here) and v2 (current) are accepted. Anything
    // else — including absent version — falls back to default to avoid loading
    // foreign / corrupted blobs.
    const versionNum = typeof parsed.version === "number" ? (parsed.version as number) : null;
    if (versionNum !== 1 && versionNum !== 2) return cloneDefault();

    const lib = (parsed.library ?? {}) as Record<string, unknown>;

    // v1 → v2: `listScrollTop` was renamed to `resourceListScrollTop`. Accept
    // either spelling; prefer the new one if both are present.
    const legacyScroll = typeof (lib as { listScrollTop?: unknown }).listScrollTop === "number"
      ? (lib as { listScrollTop: number }).listScrollTop
      : undefined;
    const resourceScrollRaw = typeof lib.resourceListScrollTop === "number"
      ? (lib.resourceListScrollTop as number)
      : legacyScroll;

    const mode = validateEnum(lib.mode, LIBRARY_MODES, "resources");
    const questionFilter = validateEnum(lib.questionFilter, QUESTION_FILTERS, "active");

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
        mode,
        selectedFolderId:
          "selectedFolderId" in lib
            ? (lib.selectedFolderId as string | null)
            : DEFAULT_STATE.library.selectedFolderId,
        selectedTagIds: Array.isArray(lib.selectedTagIds) ? (lib.selectedTagIds as string[]) : [],
        filterTagIds: Array.isArray(lib.filterTagIds) ? (lib.filterTagIds as string[]) : [],
        selectedResourceId:
          "selectedResourceId" in lib ? (lib.selectedResourceId as string | null) : null,
        resourceListScrollTop: resourceScrollRaw,
        questionFilter,
        selectedQuestionId:
          typeof lib.selectedQuestionId === "string" ? (lib.selectedQuestionId as string) : null,
        questionListScrollTop:
          typeof lib.questionListScrollTop === "number"
            ? (lib.questionListScrollTop as number)
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

type SessionStatePatch = Partial<Omit<SessionState, "library">> & {
  library?: Partial<LibraryState>;
};

export function saveSessionState(patch: SessionStatePatch): void {
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
