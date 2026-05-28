import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import * as cmd from "@/lib/commands";
import type { Question } from "@/types";
import { DataEvents, type QuestionChangedPayload } from "@/lib/events";

/**
 * Fetches a single question by id and keeps it in sync with
 * `data:question-changed`. Returns null while loading, or if the id is null,
 * or if the question doesn't exist / was deleted.
 *
 * Unlike `useQuestions` (which fetches the full active+archived list),
 * `useQuestion` only fetches the one row needed for a single Question
 * surface (Tab pane, PreviewPanel preview, etc.) — cheaper for "I just want
 * to render this one question" callers.
 */
export function useQuestion(id: string | null): Question | null {
  const [question, setQuestion] = useState<Question | null>(null);

  useEffect(() => {
    if (!id) {
      setQuestion(null);
      return;
    }
    let cancelled = false;
    cmd.getQuestion(id)
      .then((q) => {
        if (!cancelled) setQuestion(q);
      })
      .catch(() => {
        if (!cancelled) setQuestion(null);
      });
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const unlisten = listen<QuestionChangedPayload>(DataEvents.QUESTION_CHANGED, async (event) => {
      if (event.payload.question_id !== id) return;
      if (event.payload.action === "deleted") {
        setQuestion(null);
        return;
      }
      try {
        const fresh = await cmd.getQuestion(id);
        setQuestion(fresh);
      } catch {
        setQuestion(null);
      }
    });
    return () => { unlisten.then((f) => f()); };
  }, [id]);

  return question;
}
