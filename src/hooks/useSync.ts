import { useState, useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import * as cmd from "@/lib/commands";
import toast from "react-hot-toast";

export type SyncStatusType = "idle" | "syncing" | "success" | "error";

export function useSync() {
  const [status, setStatus] = useState<SyncStatusType>("idle");
  const [lastSyncAt, setLastSyncAt] = useState<string>("");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    cmd.getSyncConfig().then((c) => {
      if (c.last_sync_at) setLastSyncAt(c.last_sync_at);
    }).catch(() => {});

    const unlistenCompleted = listen("sync-completed", () => {
      setStatus("success");
      setLastSyncAt(new Date().toISOString());
      setError("");
    });
    const unlistenFailed = listen<string>("sync-failed", (event) => {
      setStatus("error");
      setError(event.payload);
    });
    const unlistenStarted = listen("sync-started", () => {
      setStatus("syncing");
    });

    return () => {
      unlistenCompleted.then((f) => f());
      unlistenFailed.then((f) => f());
      unlistenStarted.then((f) => f());
    };
  }, []);

  const triggerSync = useCallback(async () => {
    setStatus("syncing");
    try {
      await cmd.syncNow();
      setStatus("success");
      setLastSyncAt(new Date().toISOString());
      setError("");
    } catch (err: unknown) {
      setStatus("error");
      const msg = err && typeof err === "object" && "message" in err
        ? String((err as { message: string }).message)
        : String(err);
      setError(msg);
      toast.error(`同步失败: ${msg}`);
    }
  }, []);

  return { status, lastSyncAt, error, triggerSync };
}
