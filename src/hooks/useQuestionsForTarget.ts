import { useState, useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import * as cmd from "@/lib/commands";
import type { Question, QuestionTargetType } from "@/types";
import {
  DataEvents,
  type QuestionLinkChangedPayload,
  type QuestionChangedPayload,
} from "@/lib/events";

/**
 * Reverse lookup: which alive questions reference this (target_type, target_id)
 * pair. Both active and archived questions are returned (sorted by recency in
 * the backend); the caller decides how to visually distinguish status.
 *
 * Live-updates on:
 *   - QUESTION_LINK_CHANGED for this specific target, OR for the question-
 *     level cascade case where `target_type` is absent on the payload (e.g.
 *     `delete_question` fans out one link-level event with the bulk-cascade
 *     coordinate elided)
 *   - QUESTION_CHANGED (any) — handles archive/unarchive/delete that flips
 *     which rows the backend would return without firing a link event
 *   - SYNC_COMPLETED — covers remote changes applied off the event bus
 */
export function useQuestionsForTarget(
  targetType: QuestionTargetType,
  targetId: string | null,
) {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!targetId) {
      setQuestions([]);
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      const list = await cmd.listQuestionsForTarget(targetType, targetId);
      setQuestions(list);
    } catch (err) {
      console.error("Failed to load questions for target:", err);
      setQuestions([]);
    } finally {
      setLoading(false);
    }
  }, [targetType, targetId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!targetId) return;
    const u1 = listen<QuestionLinkChangedPayload>(
      DataEvents.QUESTION_LINK_CHANGED,
      (event) => {
        const p = event.payload;
        // Refresh if the event matches this target, OR if target coordinates
        // are missing (question-level cascade) — we don't know if it touched
        // us so we have to assume yes.
        const matchesTarget =
          p.target_type === undefined ||
          (p.target_type === targetType && p.target_id === targetId);
        if (matchesTarget) refresh();
      },
    );
    const u2 = listen<QuestionChangedPayload>(
      DataEvents.QUESTION_CHANGED,
      () => {
        // archive/unarchive/delete may flip which questions the backend
        // returns; we can't filter without remembering ids ourselves.
        refresh();
      },
    );
    const u3 = listen(DataEvents.SYNC_COMPLETED, () => { refresh(); });
    return () => {
      u1.then((f) => f());
      u2.then((f) => f());
      u3.then((f) => f());
    };
  }, [targetType, targetId, refresh]);

  return { questions, loading, refresh };
}
