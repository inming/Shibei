import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTheme } from "@/hooks/useTheme";

describe("useTheme", () => {
  let matchMediaListeners: Array<(e: { matches: boolean }) => void>;
  let store: Record<string, string>;

  beforeEach(() => {
    store = {};
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        store = {};
      },
    });
    document.documentElement.removeAttribute("data-theme");
    matchMediaListeners = [];
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => {
        matchMediaListeners.push(cb);
      },
      removeEventListener: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to system mode", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.mode).toBe("system");
  });

  it("applies light theme when mode is light", () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setMode("light"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(store["shibei-theme"]).toBe("light");
  });

  it("applies dark theme when mode is dark", () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setMode("dark"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(store["shibei-theme"]).toBe("dark");
  });

  it("restores saved mode from localStorage", () => {
    store["shibei-theme"] = "dark";
    const { result } = renderHook(() => useTheme());
    expect(result.current.mode).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("system mode follows prefers-color-scheme", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.mode).toBe("system");
    // System is light (matchMedia returns false) → light theme
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    // Simulate system switching to dark
    act(() => {
      matchMediaListeners.forEach((cb) => cb({ matches: true }));
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("ignores invalid localStorage value", () => {
    store["shibei-theme"] = "invalid";
    const { result } = renderHook(() => useTheme());
    expect(result.current.mode).toBe("system");
  });
});
