import { useState, useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import * as cmd from "@/lib/commands";
import type { QuestionLink } from "@/types";
import { DataEvents, type QuestionLinkChangedPayload } from "@/lib/events";

/**
 * Subscribes to QUESTION_LINK_CHANGED events scoped to `questionId` and
 * keeps the link list current. Ignores events for other questions to avoid
 * needless refetches across many open detail tabs.
 */
export function useQuestionLinks(questionId: string | null) {
  const [links, setLinks] = useState<QuestionLink[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!questionId) return;
    try {
      setLoading(true);
      const list = await cmd.listQuestionLinks(questionId);
      setLinks(list);
    } catch (err) {
      console.error("Failed to load question links:", err);
    } finally {
      setLoading(false);
    }
  }, [questionId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!questionId) return;
    const u1 = listen<QuestionLinkChangedPayload>(
      DataEvents.QUESTION_LINK_CHANGED,
      (event) => {
        if (event.payload.question_id === questionId) refresh();
      },
    );
    const u2 = listen(DataEvents.SYNC_COMPLETED, () => { refresh(); });
    return () => {
      u1.then((f) => f());
      u2.then((f) => f());
    };
  }, [questionId, refresh]);

  return { links, loading, refresh };
}
