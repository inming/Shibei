import { useState, useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import toast from "react-hot-toast";
import type { Resource } from "@/types";
import * as cmd from "@/lib/commands";

export function useResources(folderId: string | null) {
  const [resources, setResources] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!folderId) {
      setResources([]);
      return;
    }
    setLoading(true);
    try {
      const data = await cmd.listResources(folderId);
      setResources(data);
    } catch (err) {
      console.error("Failed to load resources:", err);
      toast.error("加载资料列表失败");
    } finally {
      setLoading(false);
    }
  }, [folderId]);

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

  return { resources, loading, refresh };
}
