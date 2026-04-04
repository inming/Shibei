import { useState, useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import toast from "react-hot-toast";
import { ALL_RESOURCES_ID, type Resource, type Tag } from "@/types";
import * as cmd from "@/lib/commands";
import { DataEvents } from "@/lib/events";

export function useResources(
  folderId: string | null,
  sortBy: "created_at" | "annotated_at" = "created_at",
  sortOrder: "asc" | "desc" = "desc",
) {
  const [resources, setResources] = useState<Resource[]>([]);
  const [resourceTags, setResourceTags] = useState<Record<string, Tag[]>>({});
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!folderId) {
      setResources([]);
      setResourceTags({});
      return;
    }
    setLoading(true);
    try {
      const list = folderId === ALL_RESOURCES_ID
        ? await cmd.listAllResources(sortBy, sortOrder)
        : await cmd.listResources(folderId, sortBy, sortOrder);
      setResources(list);
      // Fetch tags for all resources in parallel
      const tagEntries = await Promise.all(
        list.map(async (r) => {
          const tags = await cmd.getTagsForResource(r.id);
          return [r.id, tags] as const;
        }),
      );
      setResourceTags(Object.fromEntries(tagEntries));
    } catch (err) {
      console.error("Failed to load resources:", err);
      toast.error("加载资料列表失败");
    } finally {
      setLoading(false);
    }
  }, [folderId, sortBy, sortOrder]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-refresh on domain events
  useEffect(() => {
    const u1 = listen(DataEvents.RESOURCE_CHANGED, () => { refresh(); });
    const u2 = listen(DataEvents.TAG_CHANGED, () => { refresh(); });
    const u3 = listen(DataEvents.SYNC_COMPLETED, () => { refresh(); });
    return () => {
      u1.then((f) => f());
      u2.then((f) => f());
      u3.then((f) => f());
    };
  }, [refresh]);

  return { resources, resourceTags, loading, refresh };
}
