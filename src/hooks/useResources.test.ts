import { renderHook, waitFor, act } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { mockInvoke, emitTauriEvent } from "@/test/tauriMock";
import { useResources } from "./useResources";
import type { Resource, Tag } from "@/types";

const makeResource = (id: string, folderId: string): Resource => ({
  id,
  title: `Resource ${id}`,
  url: `https://example.com/${id}`,
  domain: "example.com",
  author: null,
  description: null,
  folder_id: folderId,
  resource_type: "webpage",
  file_path: `/path/${id}.html`,
  created_at: "2026-01-01T00:00:00Z",
  captured_at: "2026-01-01T00:00:00Z",
  selection_meta: null,
});

const makeTag = (id: string, name: string): Tag => ({
  id,
  name,
  color: "#ff0000",
});

describe("useResources", () => {
  beforeEach(() => {
    mockInvoke(() => undefined);
  });

  it("returns empty when folderId is null", async () => {
    const { result } = renderHook(() => useResources(null));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.resources).toEqual([]);
    expect(result.current.resourceTags).toEqual({});
  });

  it("loads resources and their tags for a folder", async () => {
    const folderId = "folder-1";
    const resource1 = makeResource("r1", folderId);
    const resource2 = makeResource("r2", folderId);
    const tag1 = makeTag("t1", "important");

    mockInvoke((cmd, args) => {
      if (cmd === "cmd_list_resources") {
        return [resource1, resource2];
      }
      if (cmd === "cmd_get_tags_for_resource") {
        if ((args as { resourceId: string }).resourceId === "r1") {
          return [tag1];
        }
        return [];
      }
      return undefined;
    });

    const { result } = renderHook(() => useResources(folderId));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.resources).toEqual([resource1, resource2]);
    expect(result.current.resourceTags["r1"]).toEqual([tag1]);
    expect(result.current.resourceTags["r2"]).toEqual([]);
  });

  it("passes sort parameters to invoke", async () => {
    const folderId = "folder-2";
    let capturedArgs: Record<string, unknown> | undefined;

    mockInvoke((cmd, args) => {
      if (cmd === "cmd_list_resources") {
        capturedArgs = args;
        return [];
      }
      if (cmd === "cmd_get_tags_for_resource") {
        return [];
      }
      return undefined;
    });

    const { result } = renderHook(() =>
      useResources(folderId, "annotated_at", "asc"),
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(capturedArgs).toEqual({
      folderId,
      sortBy: "annotated_at",
      sortOrder: "asc",
    });
  });

  it("refreshes on data:resource-changed Tauri event", async () => {
    const folderId = "folder-3";
    const resource1 = makeResource("r1", folderId);
    const resource2 = makeResource("r2", folderId);
    let callCount = 0;

    mockInvoke((cmd) => {
      if (cmd === "cmd_list_resources") {
        callCount++;
        return callCount === 1 ? [resource1] : [resource1, resource2];
      }
      if (cmd === "cmd_get_tags_for_resource") {
        return [];
      }
      return undefined;
    });

    const { result } = renderHook(() => useResources(folderId));

    await waitFor(() => {
      expect(result.current.resources).toHaveLength(1);
    });

    act(() => {
      emitTauriEvent("data:resource-changed");
    });

    await waitFor(() => {
      expect(result.current.resources).toHaveLength(2);
    });

    expect(result.current.resources).toEqual([resource1, resource2]);
  });

  it("calls cmd_list_all_resources when folderId is __all__", async () => {
    const resource1 = makeResource("r1", "folder-a");
    const resource2 = makeResource("r2", "folder-b");
    let calledCmd: string | undefined;

    mockInvoke((cmd, _args) => {
      if (cmd === "cmd_list_all_resources") {
        calledCmd = cmd;
        return [resource1, resource2];
      }
      if (cmd === "cmd_get_tags_for_resource") {
        return [];
      }
      return undefined;
    });

    const { result } = renderHook(() => useResources("__all__"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(calledCmd).toBe("cmd_list_all_resources");
    expect(result.current.resources).toEqual([resource1, resource2]);
  });
});
