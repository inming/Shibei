import { useState, useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import type { Folder } from "@/types";
import * as cmd from "@/lib/commands";
import { DataEvents } from "@/lib/events";

export function useFolders(parentId: string) {
  const { t } = useTranslation('lock');
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await cmd.listFolders(parentId);
      setFolders(data);
    } catch (err) {
      console.error("Failed to load folders:", err);
      toast.error(t('loadFoldersFailed'));
    } finally {
      setLoading(false);
    }
  }, [parentId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-refresh on domain events
  useEffect(() => {
    const u1 = listen(DataEvents.FOLDER_CHANGED, () => { refresh(); });
    const u2 = listen(DataEvents.SYNC_COMPLETED, () => { refresh(); });
    return () => {
      u1.then((f) => f());
      u2.then((f) => f());
    };
  }, [refresh]);

  return { folders, loading, refresh };
}
