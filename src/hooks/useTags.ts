import { useState, useCallback, useEffect } from "react";
import * as cmd from "@/lib/commands";
import type { Tag } from "@/types";

export function useTags() {
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      const list = await cmd.listTags();
      setTags(list);
    } catch (err) {
      console.error("Failed to load tags:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const createTag = useCallback(
    async (name: string, color: string) => {
      const tag = await cmd.createTag(name, color);
      await refresh();
      return tag;
    },
    [refresh],
  );

  const updateTag = useCallback(
    async (id: string, name: string, color: string) => {
      await cmd.updateTag(id, name, color);
      await refresh();
    },
    [refresh],
  );

  const deleteTag = useCallback(
    async (id: string) => {
      await cmd.deleteTag(id);
      await refresh();
    },
    [refresh],
  );

  return { tags, loading, refresh, createTag, updateTag, deleteTag };
}
