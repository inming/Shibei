import { afterEach, beforeEach, beforeAll, describe, expect, test, vi } from "vitest";

// Node 25 ships a native localStorage that lacks .clear()/.setItem()/.getItem().
// Vitest jsdom environment should override it but doesn't when Node 25 provides it
// as a non-writable global. Stub it here so the tests can run in any Node version.
beforeAll(() => {
  let store: Record<string, string> = {};
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  });
});
import {
  loadSessionState,
  saveSessionState,
  updateReaderTab,
  removeReaderTab,
  addQuestionTab,
  removeQuestionTab,
  questionTabId,
  parseQuestionTabId,
  clearSessionState,
  STORAGE_KEY,
  DEFAULT_STATE,
  type SessionState,
  type LibraryState,
} from "./sessionState";

beforeEach(() => {
  localStorage.clear();
  // sessionState keeps an in-memory mirror that survives storage clears,
  // so wipe it too — otherwise state leaks between tests when a previous
  // test populated `mirror` via add*/update* helpers (which read mirror
  // before storage).
  clearSessionState();
});

afterEach(() => {
  localStorage.clear();
  clearSessionState();
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

  test("returns parsed state when valid (v2)", () => {
    const state: SessionState = {
      version: 2,
      activeTabId: "r1",
      readerTabs: [{ resourceId: "r1", scrollY: 120 }],
      questionTabs: [],
      library: {
        mode: "resources",
        selectedFolderId: "__inbox__",
        selectedTagIds: ["t1"],
        filterTagIds: [],
        selectedResourceId: "r1",
        questionFilter: "active",
        selectedQuestionId: null,
      },
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    expect(loadSessionState()).toEqual(state);
  });

  test("treats missing questionTabs in stored v1 state as empty (back-compat)", () => {
    // Simulates a session written before the questions system shipped.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        activeTabId: "__library__",
        readerTabs: [{ resourceId: "r1" }],
        library: { selectedFolderId: "__all__", filterTagIds: [], selectedResourceId: null },
      }),
    );
    const loaded = loadSessionState();
    expect(loaded.questionTabs).toEqual([]);
    expect(loaded.readerTabs).toEqual([{ resourceId: "r1" }]);
  });

  test("fills missing optional fields with defaults", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, activeTabId: "__library__" }));
    const loaded = loadSessionState();
    expect(loaded.readerTabs).toEqual([]);
    expect(loaded.library).toEqual(DEFAULT_STATE.library);
  });
});

describe("loadSessionState v1 → v2 migration", () => {
  test("migrates v1 state to v2 with defaulted question-mode fields", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        activeTabId: "__library__",
        readerTabs: [],
        questionTabs: [],
        library: {
          selectedFolderId: "__inbox__",
          filterTagIds: [],
          selectedResourceId: null,
          listScrollTop: 120,
        },
      }),
    );
    const state = loadSessionState();
    expect(state.version).toBe(2);
    expect(state.library.mode).toBe("resources");
    expect(state.library.resourceListScrollTop).toBe(120);
    expect(state.library.questionFilter).toBe("active");
    expect(state.library.selectedQuestionId).toBeNull();
    expect(state.library.questionListScrollTop).toBeUndefined();
  });

  test("v1 migration preserves selectedTagIds and selectedResourceId", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        activeTabId: "r1",
        readerTabs: [{ resourceId: "r1" }],
        library: {
          selectedFolderId: "f1",
          selectedTagIds: ["t1", "t2"],
          filterTagIds: ["t1"],
          selectedResourceId: "r1",
        },
      }),
    );
    const state = loadSessionState();
    expect(state.library.selectedFolderId).toBe("f1");
    expect(state.library.selectedTagIds).toEqual(["t1", "t2"]);
    expect(state.library.filterTagIds).toEqual(["t1"]);
    expect(state.library.selectedResourceId).toBe("r1");
  });
});

describe("loadSessionState defensive enum validation", () => {
  test("falls back to active when stored questionFilter value is invalid", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        activeTabId: "__library__",
        readerTabs: [],
        questionTabs: [],
        library: { ...DEFAULT_STATE.library, questionFilter: "garbage" },
      }),
    );
    expect(loadSessionState().library.questionFilter).toBe("active");
  });

  test("falls back to resources when stored mode value is invalid", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        activeTabId: "__library__",
        readerTabs: [],
        questionTabs: [],
        library: { ...DEFAULT_STATE.library, mode: "x" },
      }),
    );
    expect(loadSessionState().library.mode).toBe("resources");
  });

  test("preserves valid mode and questionFilter", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        activeTabId: "__library__",
        readerTabs: [],
        questionTabs: [],
        library: { ...DEFAULT_STATE.library, mode: "questions", questionFilter: "archived" },
      }),
    );
    const loaded = loadSessionState();
    expect(loaded.library.mode).toBe("questions");
    expect(loaded.library.questionFilter).toBe("archived");
  });

  test("selectedQuestionId persists across reload", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        activeTabId: "__library__",
        readerTabs: [],
        questionTabs: [],
        library: { ...DEFAULT_STATE.library, selectedQuestionId: "q-1" },
      }),
    );
    expect(loadSessionState().library.selectedQuestionId).toBe("q-1");
  });

  test("questionListScrollTop persists across reload", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        activeTabId: "__library__",
        readerTabs: [],
        questionTabs: [],
        library: { ...DEFAULT_STATE.library, questionListScrollTop: 240 },
      }),
    );
    expect(loadSessionState().library.questionListScrollTop).toBe(240);
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

  test("writes current version even when patch omits it", () => {
    saveSessionState({ activeTabId: "r1" });
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(raw.version).toBe(2);
  });

  test("library partial merge: setting mode preserves other library fields", () => {
    saveSessionState({
      library: {
        ...DEFAULT_STATE.library,
        selectedFolderId: "f1",
        selectedResourceId: "r1",
      },
    });
    saveSessionState({ library: { mode: "questions" } as Partial<LibraryState> as LibraryState });
    const loaded = loadSessionState();
    expect(loaded.library.mode).toBe("questions");
    expect(loaded.library.selectedFolderId).toBe("f1");
    expect(loaded.library.selectedResourceId).toBe("r1");
  });

  test("library partial merge: setting selectedQuestionId preserves mode", () => {
    saveSessionState({ library: { mode: "questions" } as Partial<LibraryState> as LibraryState });
    saveSessionState({
      library: { selectedQuestionId: "q-1" } as Partial<LibraryState> as LibraryState,
    });
    const loaded = loadSessionState();
    expect(loaded.library.mode).toBe("questions");
    expect(loaded.library.selectedQuestionId).toBe("q-1");
  });

  test("shallow-merges library sub-object without clobbering siblings", () => {
    saveSessionState({
      library: {
        selectedFolderId: "f1",
        selectedTagIds: ["t1", "t2"],
        filterTagIds: [],
        selectedResourceId: "r1",
      },
    });
    saveSessionState({ library: { selectedFolderId: "f2" } as Partial<LibraryState> as LibraryState });
    const loaded = loadSessionState();
    expect(loaded.library.selectedFolderId).toBe("f2");
    expect(loaded.library.selectedTagIds).toEqual(["t1", "t2"]);
    expect(loaded.library.selectedResourceId).toBe("r1");
  });

  test("silently ignores localStorage.setItem throwing", () => {
    const orig = localStorage.setItem;
    localStorage.setItem = () => { throw new Error("quota"); };
    try {
      expect(() => saveSessionState({ activeTabId: "x" })).not.toThrow();
    } finally {
      localStorage.setItem = orig;
    }
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

describe("pdfZoom persistence", () => {
  test("updateReaderTab stores pdfZoom", () => {
    updateReaderTab("r1", { pdfZoom: 1.25 });
    expect(loadSessionState().readerTabs[0]).toMatchObject({
      resourceId: "r1",
      pdfZoom: 1.25,
    });
  });

  test("loadSessionState preserves pdfZoom from storage", () => {
    const state: SessionState = {
      version: 2,
      activeTabId: "r1",
      readerTabs: [{ resourceId: "r1", pdfZoom: 1.5 }],
      questionTabs: [],
      library: {
        mode: "resources",
        selectedFolderId: null,
        selectedTagIds: [],
        filterTagIds: [],
        selectedResourceId: null,
        questionFilter: "active",
        selectedQuestionId: null,
      },
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    expect(loadSessionState().readerTabs[0].pdfZoom).toBe(1.5);
  });

  test("missing pdfZoom falls through as undefined", () => {
    updateReaderTab("r2", { scrollY: 100 });
    const tabs = loadSessionState().readerTabs;
    const r2Tab = tabs.find((t) => t.resourceId === "r2");
    expect(r2Tab?.pdfZoom).toBeUndefined();
  });
});

describe("questionTabs", () => {
  test("addQuestionTab is idempotent", () => {
    addQuestionTab("q1");
    addQuestionTab("q1");
    expect(loadSessionState().questionTabs).toEqual([{ questionId: "q1" }]);
  });

  test("addQuestionTab preserves order", () => {
    addQuestionTab("q1");
    addQuestionTab("q2");
    addQuestionTab("q3");
    expect(loadSessionState().questionTabs.map((t) => t.questionId)).toEqual([
      "q1",
      "q2",
      "q3",
    ]);
  });

  test("removeQuestionTab drops the matching id", () => {
    addQuestionTab("q1");
    addQuestionTab("q2");
    removeQuestionTab("q1");
    expect(loadSessionState().questionTabs).toEqual([{ questionId: "q2" }]);
  });

  test("removeQuestionTab is a no-op for unknown id", () => {
    addQuestionTab("q1");
    removeQuestionTab("q-missing");
    expect(loadSessionState().questionTabs).toEqual([{ questionId: "q1" }]);
  });

  test("questionTabId / parseQuestionTabId roundtrip", () => {
    expect(questionTabId("abc")).toBe("q:abc");
    expect(parseQuestionTabId("q:abc")).toBe("abc");
    expect(parseQuestionTabId("abc")).toBeNull();
    // The id portion may itself contain colons (UUIDs don't, but be safe).
    expect(parseQuestionTabId("q:a:b:c")).toBe("a:b:c");
  });

  test("loadSessionState ignores malformed questionTabs entries", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        activeTabId: "__library__",
        readerTabs: [],
        questionTabs: [{ questionId: "ok" }, { bogus: "no" }, null, "weird"],
        library: DEFAULT_STATE.library,
      }),
    );
    expect(loadSessionState().questionTabs).toEqual([{ questionId: "ok" }]);
  });
});
