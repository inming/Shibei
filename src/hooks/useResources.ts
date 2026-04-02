import { useState, useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import toast from "react-hot-toast";
import type { Resource, Tag } from "@/types";
import * as cmd from "@/lib/commands";

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
      const list = await cmd.listResources(folderId, sortBy, sortOrder);
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

  // Auto-refresh when a new resource is saved via the extension
  useEffect(() => {
    let isCancelled = false;
    const unlisten = listen("resource-saved", () => {
      if (!isCancelled) refresh();
    });
    return () => {
      isCancelled = true;
      unlisten.then((fn) => fn());
    };
  }, [refresh]);

  return { resources, resourceTags, loading, refresh };
}
