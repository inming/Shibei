import { useState, useCallback, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import * as cmd from "@/lib/commands";
import type { Tag } from "@/types";
import { DataEvents } from "@/lib/events";

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

  // Auto-refresh on domain events
  useEffect(() => {
    const u1 = listen(DataEvents.TAG_CHANGED, () => { refresh(); });
    const u2 = listen(DataEvents.SYNC_COMPLETED, () => { refresh(); });
    return () => {
      u1.then((f) => f());
      u2.then((f) => f());
    };
  }, [refresh]);

  const createTag = useCallback(async (name: string, color: string) => {
    return cmd.createTag(name, color);
  }, []);

  const updateTag = useCallback(async (id: string, name: string, color: string) => {
    await cmd.updateTag(id, name, color);
  }, []);

  const deleteTag = useCallback(async (id: string) => {
    await cmd.deleteTag(id);
  }, []);

  return { tags, loading, refresh, createTag, updateTag, deleteTag };
}
