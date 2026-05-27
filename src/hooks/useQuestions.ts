import { useState, useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import * as cmd from "@/lib/commands";
import type { Question } from "@/types";
import { DataEvents } from "@/lib/events";

/**
 * Fetches the active and archived questions in parallel and keeps them in
 * sync with `data:question-changed` and `data:sync-completed`. The two lists
 * are returned separately because the sidebar renders them in distinct
 * collapsible groups; combining them would force every consumer to refilter.
 */
export function useQuestions() {
  const [active, setActive] = useState<Question[]>([]);
  const [archived, setArchived] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      const [a, b] = await Promise.all([
        cmd.listQuestions("active"),
        cmd.listQuestions("archived"),
      ]);
      setActive(a);
      setArchived(b);
    } catch (err) {
      console.error("Failed to load questions:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const u1 = listen(DataEvents.QUESTION_CHANGED, () => { refresh(); });
    const u2 = listen(DataEvents.SYNC_COMPLETED, () => { refresh(); });
    return () => {
      u1.then((f) => f());
      u2.then((f) => f());
    };
  }, [refresh]);

  return { active, archived, loading, refresh };
}
