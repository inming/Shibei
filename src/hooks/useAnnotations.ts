import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import toast from "react-hot-toast";
import type { Highlight, Comment } from "@/types";
import * as cmd from "@/lib/commands";
import { DataEvents } from "@/lib/events";

export function useAnnotations(resourceId: string) {
  const { t } = useTranslation('annotation');
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
      toast.error(t('loadAnnotationsFailed'));
    } finally {
      setLoading(false);
    }
  }, [resourceId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-refresh on domain events
  useEffect(() => {
    const u1 = listen(DataEvents.ANNOTATION_CHANGED, () => { refresh(); });
    const u2 = listen(DataEvents.SYNC_COMPLETED, () => { refresh(); });
    return () => {
      u1.then((f) => f());
      u2.then((f) => f());
    };
  }, [refresh]);

  // Keep immediate optimistic update for addHighlight — ReaderView needs the
  // highlight object right away to postMessage back to the iframe.
  const addHighlight = useCallback(
    (highlight: Highlight) => {
      setHighlights((prev) => [...prev, highlight]);
    },
    [],
  );

  const updateHighlightColor = useCallback(
    async (id: string, color: string) => {
      try {
        const updated = await cmd.updateHighlightColor(id, resourceId, color);
        setHighlights((prev) => prev.map((h) => (h.id === id ? updated : h)));
        return updated;
      } catch (err) {
        console.error("Failed to update highlight color:", err);
        toast.error(t('updateColorFailed'));
        return null;
      }
    },
    [resourceId],
  );

  const removeHighlight = useCallback(
    async (id: string) => {
      try {
        await cmd.deleteHighlight(id, resourceId);
      } catch (err) {
        console.error("Failed to delete highlight:", err);
        toast.error(t('deleteHighlightFailed'));
      }
    },
    [resourceId],
  );

  const addComment = useCallback(
    async (highlightId: string | null, content: string) => {
      try {
        const comment = await cmd.createComment(resourceId, highlightId, content);
        return comment;
      } catch (err) {
        console.error("Failed to create comment:", err);
        toast.error(t('createCommentFailed'));
        return null;
      }
    },
    [resourceId],
  );

  const removeComment = useCallback(
    async (id: string) => {
      try {
        await cmd.deleteComment(id, resourceId);
      } catch (err) {
        console.error("Failed to delete comment:", err);
        toast.error(t('deleteCommentFailed'));
      }
    },
    [resourceId],
  );

  const editComment = useCallback(
    async (id: string, content: string) => {
      try {
        await cmd.updateComment(id, content, resourceId);
      } catch (err) {
        console.error("Failed to update comment:", err);
        toast.error(t('editCommentFailed'));
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
    updateHighlightColor,
    removeHighlight,
    addComment,
    removeComment,
    editComment,
    getCommentsForHighlight,
  };
}
