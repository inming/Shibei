import { useState, useEffect, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import * as cmd from "@/lib/commands";
import toast from "react-hot-toast";

export type SyncStatusType = "idle" | "syncing" | "success" | "error";

export function useSync() {
  const [status, setStatus] = useState<SyncStatusType>("idle");
  const [lastSyncAt, setLastSyncAt] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [intervalMinutes, setIntervalMinutes] = useState(0);
  const syncingRef = useRef(false);

  // Load config on mount
  useEffect(() => {
    cmd.getSyncConfig().then((c) => {
      if (c.last_sync_at) setLastSyncAt(c.last_sync_at);
      setIntervalMinutes(c.sync_interval ?? 5);
    }).catch(() => {});
  }, []);

  // Listen for sync events
  useEffect(() => {
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

  const doSync = useCallback(async () => {
    if (syncingRef.current) return;
    syncingRef.current = true;
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
    } finally {
      syncingRef.current = false;
    }
  }, []);

  // Auto-sync timer
  useEffect(() => {
    if (intervalMinutes <= 0) return;
    const ms = intervalMinutes * 60 * 1000;
    const timer = setInterval(() => {
      doSync();
    }, ms);
    return () => clearInterval(timer);
  }, [intervalMinutes, doSync]);

  return { status, lastSyncAt, error, intervalMinutes, setIntervalMinutes, triggerSync: doSync };
}
