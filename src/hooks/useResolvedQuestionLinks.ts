import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import * as cmd from "@/lib/commands";
import type { ResolvedQuestionLink } from "@/types";
import { DataEvents, type QuestionLinkChangedPayload } from "@/lib/events";
import {
  anchorSortKey,
  groupResolvedLinks,
  NOTE_SORT_KEY,
  type ResolvedLink,
  type ResourceGroup,
} from "@/lib/questionLinks";

/** Map the backend's resolved link to the client shape, deriving the
 *  document-position sort key from kind + anchor (the one piece the backend
 *  leaves to the client so ordering logic stays in a single place). */
function toResolvedLink(r: ResolvedQuestionLink): ResolvedLink {
  const kind = r.link.target_type;
  let sortKey: number;
  if (kind === "highlight") sortKey = anchorSortKey(r.anchor ?? undefined);
  else if (kind === "comment") sortKey = NOTE_SORT_KEY;
  else sortKey = -1;
  return {
    link: r.link,
    kind,
    resourceId: r.resource?.id ?? null,
    resource: r.resource,
    snippet: r.snippet,
    highlightId: r.highlight_id ?? undefined,
    color: r.highlight_color ?? undefined,
    sortKey,
  };
}

/**
 * Fetch a question's links pre-resolved to parent resource + snippet in one
 * backend round-trip (`cmd_list_resolved_question_links`), then group them by
 * resource for the detail view. Subscribes to QUESTION_LINK_CHANGED (scoped to
 * this question) and SYNC_COMPLETED so the view stays fresh.
 *
 * Returns the grouped resources plus the raw counts the header/delete-confirm
 * need, so the detail view needs only this one hook.
 */
export function useResolvedQuestionLinks(questionId: string | null): {
  groups: ResourceGroup[];
  totalLinks: number;
  evidenceCount: number;
  loading: boolean;
} {
  const [resolved, setResolved] = useState<ResolvedLink[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!questionId) return;
    try {
      setLoading(true);
      const list = await cmd.listResolvedQuestionLinks(questionId);
      setResolved(list.map(toResolvedLink));
    } catch (err) {
      console.error("Failed to load resolved question links:", err);
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

  const groups = useMemo(() => groupResolvedLinks(resolved), [resolved]);
  const evidenceCount = useMemo(
    () => resolved.filter((r) => r.kind !== "resource").length,
    [resolved],
  );

  return { groups, totalLinks: resolved.length, evidenceCount, loading };
}
