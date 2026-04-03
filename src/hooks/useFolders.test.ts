import { renderHook, waitFor, act } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { mockInvoke, emitTauriEvent } from "@/test/tauriMock";
import { useFolders } from "./useFolders";
import type { Folder } from "@/types";

function makeFolder(id: string, parentId: string, name: string): Folder {
  return {
    id,
    name,
    parent_id: parentId,
    sort_order: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

describe("useFolders", () => {
  beforeEach(() => {
    mockInvoke(() => []);
  });

  it("loads folders for a parent on mount", async () => {
    const parentFolders = [
      makeFolder("f1", "root", "Folder One"),
      makeFolder("f2", "root", "Folder Two"),
    ];

    mockInvoke((cmd, args) => {
      if (cmd === "cmd_list_folders" && args?.parentId === "root") {
        return parentFolders;
      }
      return [];
    });

    const { result } = renderHook(() => useFolders("root"));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.folders).toHaveLength(2);
    expect(result.current.folders[0].id).toBe("f1");
    expect(result.current.folders[1].id).toBe("f2");
  });

  it("reloads when parentId changes", async () => {
    const foldersForA = [makeFolder("a1", "parent-a", "A Folder")];
    const foldersForB = [
      makeFolder("b1", "parent-b", "B Folder One"),
      makeFolder("b2", "parent-b", "B Folder Two"),
    ];

    mockInvoke((cmd, args) => {
      if (cmd !== "cmd_list_folders") return [];
      if (args?.parentId === "parent-a") return foldersForA;
      if (args?.parentId === "parent-b") return foldersForB;
      return [];
    });

    const { result, rerender } = renderHook(
      ({ parentId }: { parentId: string }) => useFolders(parentId),
      { initialProps: { parentId: "parent-a" } }
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.folders).toHaveLength(1);
    expect(result.current.folders[0].id).toBe("a1");

    rerender({ parentId: "parent-b" });

    await waitFor(() => expect(result.current.folders).toHaveLength(2));
    expect(result.current.folders[0].id).toBe("b1");
    expect(result.current.folders[1].id).toBe("b2");
  });

  it("refresh reloads data", async () => {
    const initialFolders = [makeFolder("f1", "root", "Initial Folder")];
    const updatedFolders = [
      makeFolder("f1", "root", "Initial Folder"),
      makeFolder("f2", "root", "New Folder"),
    ];

    let callCount = 0;
    mockInvoke((cmd, args) => {
      if (cmd === "cmd_list_folders" && args?.parentId === "root") {
        callCount += 1;
        return callCount === 1 ? initialFolders : updatedFolders;
      }
      return [];
    });

    const { result } = renderHook(() => useFolders("root"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.folders).toHaveLength(1);

    await result.current.refresh();

    await waitFor(() => expect(result.current.folders).toHaveLength(2));
    expect(result.current.folders[1].id).toBe("f2");
  });

  it("refreshes on data:folder-changed Tauri event", async () => {
    const folder1 = makeFolder("f1", "root", "Folder One");
    const folder2 = makeFolder("f2", "root", "Folder Two");
    let callCount = 0;

    mockInvoke((cmd, args) => {
      if (cmd === "cmd_list_folders" && args?.parentId === "root") {
        callCount++;
        return callCount === 1 ? [folder1] : [folder1, folder2];
      }
      return [];
    });

    const { result } = renderHook(() => useFolders("root"));

    await waitFor(() => {
      expect(result.current.folders).toHaveLength(1);
    });

    act(() => {
      emitTauriEvent("data:folder-changed");
    });

    await waitFor(() => {
      expect(result.current.folders).toHaveLength(2);
    });

    expect(result.current.folders).toEqual([folder1, folder2]);
  });
});
