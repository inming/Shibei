import { renderHook, waitFor } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { mockInvoke } from "@/test/tauriMock";
import { useTags } from "./useTags";
import type { Tag } from "@/types";

const TAG_A: Tag = { id: "1", name: "Research", color: "#ff0000" };
const TAG_B: Tag = { id: "2", name: "Todo", color: "#00ff00" };

describe("useTags", () => {
  it("loads tags on mount", async () => {
    mockInvoke((cmd) => {
      if (cmd === "cmd_list_tags") return [TAG_A, TAG_B];
    });

    const { result } = renderHook(() => useTags());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tags).toHaveLength(2);
    expect(result.current.tags[0].name).toBe("Research");
    expect(result.current.tags[1].name).toBe("Todo");
  });

  it("createTag calls invoke and refreshes", async () => {
    const NEW_TAG: Tag = { id: "3", name: "Ideas", color: "#0000ff" };
    const store: Tag[] = [TAG_A, TAG_B];

    mockInvoke((cmd) => {
      if (cmd === "cmd_list_tags") return [...store];
      if (cmd === "cmd_create_tag") {
        store.push(NEW_TAG);
        return NEW_TAG;
      }
    });

    const { result } = renderHook(() => useTags());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tags).toHaveLength(2);

    let returned: Tag | undefined;
    await waitFor(async () => {
      returned = await result.current.createTag("Ideas", "#0000ff");
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(returned).toEqual(NEW_TAG);
    expect(result.current.tags).toHaveLength(3);
    expect(result.current.tags[2].name).toBe("Ideas");
  });

  it("updateTag calls invoke and refreshes", async () => {
    const store: Tag[] = [{ ...TAG_A }, TAG_B];

    mockInvoke((cmd, args) => {
      if (cmd === "cmd_list_tags") return [...store];
      if (cmd === "cmd_update_tag") {
        const { id, name, color } = args as { id: string; name: string; color: string };
        const tag = store.find((t) => t.id === id);
        if (tag) { tag.name = name; tag.color = color; }
      }
    });

    const { result } = renderHook(() => useTags());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await waitFor(async () => {
      await result.current.updateTag("1", "Research Updated", "#aaaaaa");
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    const updated = result.current.tags.find((t) => t.id === "1");
    expect(updated?.name).toBe("Research Updated");
    expect(updated?.color).toBe("#aaaaaa");
  });

  it("deleteTag calls invoke and refreshes", async () => {
    const store: Tag[] = [{ ...TAG_A }, { ...TAG_B }];

    mockInvoke((cmd, args) => {
      if (cmd === "cmd_list_tags") return [...store];
      if (cmd === "cmd_delete_tag") {
        const { id } = args as { id: string };
        const idx = store.findIndex((t) => t.id === id);
        if (idx >= 0) store.splice(idx, 1);
      }
    });

    const { result } = renderHook(() => useTags());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tags).toHaveLength(2);

    await waitFor(async () => {
      await result.current.deleteTag("1");
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tags).toHaveLength(1);
    expect(result.current.tags[0].id).toBe("2");
  });
});
