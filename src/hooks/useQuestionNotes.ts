import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import * as cmd from "@/lib/commands";
import type { QuestionNote } from "@/types";
import { DataEvents, type QuestionNoteChangedPayload } from "@/lib/events";

/**
 * A question's research notes (newest first), with auto-refresh. Subscribes to
 * QUESTION_NOTE_CHANGED scoped to this question (so note edits made from
 * another surface — or by an MCP agent — show up live) and SYNC_COMPLETED (so
 * notes pulled from a remote device appear). Backend already orders by
 * created_at desc, so no client-side sort is needed.
 */
export function useQuestionNotes(questionId: string | null): {
  notes: QuestionNote[];
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const [notes, setNotes] = useState<QuestionNote[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!questionId) return;
    try {
      setLoading(true);
      const list = await cmd.listQuestionNotes(questionId);
      setNotes(list);
    } catch (err) {
      console.error("Failed to load question notes:", err);
    } finally {
      setLoading(false);
    }
  }, [questionId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!questionId) return;
    const u1 = listen<QuestionNoteChangedPayload>(
      DataEvents.QUESTION_NOTE_CHANGED,
      (event) => {
        if (event.payload.question_id === questionId) refresh();
      },
    );
    const u2 = listen(DataEvents.SYNC_COMPLETED, () => {
      refresh();
    });
    return () => {
      u1.then((f) => f());
      u2.then((f) => f());
    };
  }, [questionId, refresh]);

  return { notes, loading, refresh };
}
