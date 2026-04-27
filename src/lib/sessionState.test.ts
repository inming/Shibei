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
  clearSessionState,
  STORAGE_KEY,
  DEFAULT_STATE,
  type SessionState,
  type LibraryState,
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
      library: { selectedFolderId: "__inbox__", selectedTagIds: ["t1"], filterTagIds: [], selectedResourceId: "r1" },
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
      version: 1,
      activeTabId: "r1",
      readerTabs: [{ resourceId: "r1", pdfZoom: 1.5 }],
      library: { selectedFolderId: null, selectedTagIds: [], filterTagIds: [], selectedResourceId: null },
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
