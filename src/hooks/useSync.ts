import { useState, useEffect, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import * as cmd from "@/lib/commands";
import toast from "react-hot-toast";
import { DataEvents, SyncEvents } from "@/lib/events";
import type { ConfigChangedPayload, SyncFailedPayload } from "@/lib/events";

export type SyncStatusType = "idle" | "syncing" | "success" | "error";

export function useSync() {
  const [status, setStatus] = useState<SyncStatusType>("idle");
  const [lastSyncAt, setLastSyncAt] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [intervalMinutes, setIntervalMinutes] = useState(0);
  const syncingRef = useRef(false);
  const [encryptionEnabled, setEncryptionEnabled] = useState(false);
  const [encryptionUnlocked, setEncryptionUnlocked] = useState(false);
  const [autoUnlockPending, setAutoUnlockPending] = useState(false);

  // Refs for initial sync coordination
  const configLoadedRef = useRef(false);
  const encryptionResolvedRef = useRef(false);
  const initialSyncDoneRef = useRef(false);

  // Load config on mount
  useEffect(() => {
    const tryInitialSync = () => {
      if (configLoadedRef.current && encryptionResolvedRef.current && !initialSyncDoneRef.current) {
        initialSyncDoneRef.current = true;
        // Small delay to ensure UI is ready
        setTimeout(() => {
          if (!syncingRef.current) {
            syncingRef.current = true;
            cmd.syncNow().catch(() => { syncingRef.current = false; });
          }
        }, 500);
      }
    };

    cmd.getSyncConfig().then((c) => {
      if (c.last_sync_at) setLastSyncAt(c.last_sync_at);
      setIntervalMinutes(c.sync_interval ?? 5);
      configLoadedRef.current = c.has_credentials;
      tryInitialSync();
    }).catch(() => {});

    cmd.getEncryptionStatus().then(async (es) => {
      setEncryptionEnabled(es.enabled);

      if (es.enabled && !es.unlocked) {
        setAutoUnlockPending(true);
        try {
          const result = await cmd.autoUnlockEncryption();
          switch (result) {
            case "unlocked":
            case "unlocked_unverified":
              setEncryptionUnlocked(true);
              encryptionResolvedRef.current = true;
              tryInitialSync();
              break;
            case "keychain_error":
              toast("系统钥匙串不可用，请手动输入密码", { icon: "ℹ️" });
              break;
            case "key_mismatch":
              toast("加密密钥已变更，请重新输入密码", { icon: "⚠️" });
              break;
            case "no_stored_key":
              break;
          }
        } finally {
          setAutoUnlockPending(false);
        }
      } else {
        setEncryptionUnlocked(es.unlocked);
        encryptionResolvedRef.current = true;
        tryInitialSync();
      }
    }).catch(() => {});
  }, []);

  // Listen for sync and config events
  useEffect(() => {
    const u1 = listen(DataEvents.SYNC_COMPLETED, () => {
      setStatus("success");
      setLastSyncAt(new Date().toISOString());
      setError("");
      syncingRef.current = false;
    });
    const u2 = listen<SyncFailedPayload>(SyncEvents.FAILED, (event) => {
      setStatus("error");
      setError(event.payload.message);
      syncingRef.current = false;
    });
    const u3 = listen(SyncEvents.STARTED, () => {
      setStatus("syncing");
    });
    const u4 = listen<ConfigChangedPayload>(DataEvents.CONFIG_CHANGED, (event) => {
      if (event.payload.scope === "encryption") {
        cmd.getEncryptionStatus().then((es) => {
          setEncryptionEnabled(es.enabled);
          setEncryptionUnlocked(es.unlocked);
        }).catch(() => {});
      }
    });

    return () => {
      u1.then((f) => f());
      u2.then((f) => f());
      u3.then((f) => f());
      u4.then((f) => f());
    };
  }, []);

  const doSync = useCallback(async () => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    try {
      await cmd.syncNow();
    } catch (err: unknown) {
      const msg = err && typeof err === "object" && "message" in err
        ? String((err as { message: string }).message)
        : String(err);
      toast.error(`同步失败: ${msg}`);
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

  const refreshEncryptionStatus = useCallback(() => {
    cmd.getEncryptionStatus().then((es) => {
      setEncryptionEnabled(es.enabled);
      setEncryptionUnlocked(es.unlocked);
    }).catch(() => {});
  }, []);

  return { status, lastSyncAt, error, intervalMinutes, setIntervalMinutes, triggerSync: doSync, encryptionEnabled, encryptionUnlocked, autoUnlockPending, refreshEncryptionStatus };
}
