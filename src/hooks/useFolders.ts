import { useState, useEffect, useCallback } from "react";
import type { Folder } from "@/types";
import * as cmd from "@/lib/commands";

export function useFolders(parentId: string) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await cmd.listFolders(parentId);
      setFolders(data);
    } catch (err) {
      console.error("Failed to load folders:", err);
    } finally {
      setLoading(false);
    }
  }, [parentId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { folders, loading, refresh };
}
