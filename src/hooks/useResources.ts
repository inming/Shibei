import { useState, useEffect, useCallback } from "react";
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
    } finally {
      setLoading(false);
    }
  }, [folderId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { resources, loading, refresh };
}
