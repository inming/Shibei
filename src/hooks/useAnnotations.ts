import { useState, useEffect, useCallback } from "react";
import type { Highlight, Comment } from "@/types";
import * as cmd from "@/lib/commands";

export function useAnnotations(resourceId: string) {
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [hl, cm] = await Promise.all([
        cmd.getHighlights(resourceId),
        cmd.getComments(resourceId),
      ]);
      setHighlights(hl);
      setComments(cm);
    } catch (err) {
      console.error("Failed to load annotations:", err);
    } finally {
      setLoading(false);
    }
  }, [resourceId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-refresh when annotations change in another component (e.g. ReaderView)
  useEffect(() => {
    function handleChange(e: Event) {
      const detail = (e as CustomEvent<string>).detail;
      if (detail === resourceId) refresh();
    }
    window.addEventListener("shibei:annotations-changed", handleChange);
    return () => window.removeEventListener("shibei:annotations-changed", handleChange);
  }, [resourceId, refresh]);

  function notifyChange(): void {
    window.dispatchEvent(new CustomEvent("shibei:annotations-changed", { detail: resourceId }));
  }

  const addHighlight = useCallback(
    (highlight: Highlight) => {
      setHighlights((prev) => [...prev, highlight]);
      notifyChange();
    },
    [resourceId],
  );

  const removeHighlight = useCallback(
    async (id: string) => {
      try {
        await cmd.deleteHighlight(id);
        setHighlights((prev) => prev.filter((h) => h.id !== id));
        setComments((prev) => prev.filter((c) => c.highlight_id !== id));
        notifyChange();
      } catch (err) {
        console.error("Failed to delete highlight:", err);
      }
    },
    [resourceId],
  );

  const addComment = useCallback(
    async (highlightId: string | null, content: string) => {
      try {
        const comment = await cmd.createComment(resourceId, highlightId, content);
        setComments((prev) => [...prev, comment]);
        notifyChange();
        return comment;
      } catch (err) {
        console.error("Failed to create comment:", err);
        return null;
      }
    },
    [resourceId],
  );

  const removeComment = useCallback(
    async (id: string) => {
      try {
        await cmd.deleteComment(id);
        setComments((prev) => prev.filter((c) => c.id !== id));
        notifyChange();
      } catch (err) {
        console.error("Failed to delete comment:", err);
      }
    },
    [resourceId],
  );

  const editComment = useCallback(
    async (id: string, content: string) => {
      try {
        await cmd.updateComment(id, content);
        setComments((prev) =>
          prev.map((c) =>
            c.id === id ? { ...c, content, updated_at: new Date().toISOString() } : c,
          ),
        );
        notifyChange();
      } catch (err) {
        console.error("Failed to update comment:", err);
      }
    },
    [resourceId],
  );

  const getCommentsForHighlight = useCallback(
    (highlightId: string) => {
      return comments.filter((c) => c.highlight_id === highlightId);
    },
    [comments],
  );

  const resourceNotes = comments.filter((c) => c.highlight_id === null);

  return {
    highlights,
    comments,
    resourceNotes,
    loading,
    refresh,
    addHighlight,
    removeHighlight,
    addComment,
    removeComment,
    editComment,
    getCommentsForHighlight,
  };
}
