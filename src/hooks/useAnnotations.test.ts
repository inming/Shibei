import { renderHook, waitFor, act } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { mockInvoke, emitTauriEvent } from "@/test/tauriMock";
import { useAnnotations } from "./useAnnotations";
import type { Highlight, Comment } from "@/types";

const makeHighlight = (overrides?: Partial<Highlight>): Highlight => ({
  id: "h1",
  resource_id: "r1",
  text_content: "hello world",
  anchor: {
    text_position: { start: 0, end: 11 },
    text_quote: { exact: "hello world", prefix: "", suffix: "" },
  },
  color: "#ffff00",
  created_at: "2026-01-01T00:00:00Z",
  ...overrides,
});

const makeComment = (overrides?: Partial<Comment>): Comment => ({
  id: "c1",
  highlight_id: "h1",
  resource_id: "r1",
  content: "a comment",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  ...overrides,
});

describe("useAnnotations", () => {
  beforeEach(() => {
    mockInvoke(() => undefined);
  });

  it("loads highlights and comments on mount", async () => {
    const highlight = makeHighlight();
    const comment = makeComment({ highlight_id: null, id: "note1" });

    mockInvoke((cmd) => {
      if (cmd === "cmd_get_highlights") return [highlight];
      if (cmd === "cmd_get_comments") return [comment];
      return undefined;
    });

    const { result } = renderHook(() => useAnnotations("r1"));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.highlights).toEqual([highlight]);
    expect(result.current.comments).toEqual([comment]);
    expect(result.current.resourceNotes).toEqual([comment]);
  });

  it("addHighlight adds to state immediately", async () => {
    const highlight = makeHighlight();
    mockInvoke((cmd) => {
      if (cmd === "cmd_get_highlights") return [];
      if (cmd === "cmd_get_comments") return [];
      return undefined;
    });

    const { result } = renderHook(() => useAnnotations("r1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.addHighlight(highlight);
    });

    // addHighlight updates state immediately (for iframe postMessage)
    expect(result.current.highlights).toEqual([highlight]);
  });

  it("removeHighlight deletes and refreshes via event", async () => {
    const highlight = makeHighlight({ id: "h1" });
    const commentOnHighlight = makeComment({ id: "c1", highlight_id: "h1" });
    const note = makeComment({ id: "note1", highlight_id: null });

    let deleted = false;
    mockInvoke((cmd) => {
      if (cmd === "cmd_get_highlights") return deleted ? [] : [highlight];
      if (cmd === "cmd_get_comments") return deleted ? [note] : [commentOnHighlight, note];
      if (cmd === "cmd_delete_highlight") {
        deleted = true;
        return undefined;
      }
      return undefined;
    });

    const { result } = renderHook(() => useAnnotations("r1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.removeHighlight("h1");
    });

    // Backend emits data:annotation-changed which triggers refresh
    act(() => { emitTauriEvent("data:annotation-changed"); });

    await waitFor(() => expect(result.current.highlights).toEqual([]));
    expect(result.current.comments).toEqual([note]);
  });

  it("addComment calls invoke and refreshes via event", async () => {
    const newComment = makeComment({ id: "new-c", highlight_id: "h1", content: "new content" });
    let created = false;
    mockInvoke((cmd) => {
      if (cmd === "cmd_get_highlights") return [];
      if (cmd === "cmd_get_comments") return created ? [newComment] : [];
      if (cmd === "cmd_create_comment") {
        created = true;
        return newComment;
      }
      return undefined;
    });

    const { result } = renderHook(() => useAnnotations("r1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.addComment("h1", "new content");
    });

    act(() => { emitTauriEvent("data:annotation-changed"); });

    await waitFor(() => expect(result.current.comments).toHaveLength(1));
    expect(result.current.comments[0].content).toBe("new content");
  });

  it("editComment updates content via event refresh", async () => {
    const comment = makeComment({ id: "c1", content: "original" });
    let updatedContent = "original";
    mockInvoke((cmd) => {
      if (cmd === "cmd_get_highlights") return [];
      if (cmd === "cmd_get_comments")
        return [{ ...comment, content: updatedContent }];
      if (cmd === "cmd_update_comment") {
        updatedContent = "updated";
        return undefined;
      }
      return undefined;
    });

    const { result } = renderHook(() => useAnnotations("r1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.editComment("c1", "updated");
    });

    act(() => { emitTauriEvent("data:annotation-changed"); });

    await waitFor(() => expect(result.current.comments[0].content).toBe("updated"));
  });

  it("removeComment deletes via event refresh", async () => {
    const comment = makeComment({ id: "c1" });
    let deleted = false;
    mockInvoke((cmd) => {
      if (cmd === "cmd_get_highlights") return [];
      if (cmd === "cmd_get_comments") return deleted ? [] : [comment];
      if (cmd === "cmd_delete_comment") {
        deleted = true;
        return undefined;
      }
      return undefined;
    });

    const { result } = renderHook(() => useAnnotations("r1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.removeComment("c1");
    });

    act(() => { emitTauriEvent("data:annotation-changed"); });

    await waitFor(() => expect(result.current.comments).toEqual([]));
  });

  it("getCommentsForHighlight filters by highlight_id", async () => {
    const c1 = makeComment({ id: "c1", highlight_id: "h1" });
    const c2 = makeComment({ id: "c2", highlight_id: "h2" });
    const c3 = makeComment({ id: "c3", highlight_id: "h1" });

    mockInvoke((cmd) => {
      if (cmd === "cmd_get_highlights") return [];
      if (cmd === "cmd_get_comments") return [c1, c2, c3];
      return undefined;
    });

    const { result } = renderHook(() => useAnnotations("r1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const h1Comments = result.current.getCommentsForHighlight("h1");
    expect(h1Comments).toEqual([c1, c3]);

    const h2Comments = result.current.getCommentsForHighlight("h2");
    expect(h2Comments).toEqual([c2]);
  });

  it("refreshes on data:annotation-changed Tauri event", async () => {
    let callCount = 0;

    mockInvoke((cmd) => {
      if (cmd === "cmd_get_highlights") {
        callCount++;
        return [];
      }
      if (cmd === "cmd_get_comments") return [];
      return undefined;
    });

    const { result } = renderHook(() => useAnnotations("r1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const countAfterMount = callCount;

    await act(async () => {
      emitTauriEvent("data:annotation-changed");
    });

    await waitFor(() => expect(callCount).toBeGreaterThan(countAfterMount));
  });
});
