import type { Anchor, QuestionLink, QuestionTargetType, Resource } from "@/types";

/**
 * A question link with its target resolved to a parent resource plus an
 * optional snippet. Produced by `useResolvedQuestionLinks` and consumed by the
 * resource-grouped detail UI.
 */
export interface ResolvedLink {
  link: QuestionLink;
  kind: QuestionTargetType;
  /** Parent resource id (self for resource links, null when unresolvable). */
  resourceId: string | null;
  resource: Resource | null;
  /** Highlight text / comment content; null for resource links or missing targets. */
  snippet: string | null;
  /** Forwarded to openResource so the reader jumps to the right highlight. */
  highlightId?: string;
  /** Highlight color, used as a left accent on evidence rows. */
  color?: string;
  /** Document position for ordering evidence within a resource group. */
  sortKey: number;
}

/**
 * One resource and all the question links that point into it: the resource-level
 * link itself (if the whole article was linked) plus every highlight/comment
 * (evidence) under it. Lets the detail view show each source exactly once.
 */
export interface ResourceGroup {
  /** Grouping key — resource id, or a synthetic key for unresolvable links. */
  key: string;
  resource: Resource | null;
  /** The target_type='resource' link, when the article itself is linked. */
  resourceLink: ResolvedLink | null;
  /** highlight + comment links, sorted by position in the document. */
  evidence: ResolvedLink[];
}

/** Notes/comments have no document position; park them after all highlights. */
const NOTE_SORT_KEY = Number.MAX_SAFE_INTEGER;

/**
 * Derive an ordering key from a highlight anchor so evidence reads top-to-bottom
 * the way it appears in the source (HTML offset / PDF page+char / audio seconds).
 */
export function anchorSortKey(anchor: Anchor | undefined): number {
  if (anchor && typeof anchor === "object") {
    const a = anchor as Record<string, unknown>;
    if (a.type === "pdf") {
      const page = typeof a.page === "number" ? a.page : 0;
      const charIndex = typeof a.charIndex === "number" ? a.charIndex : 0;
      return page * 1e7 + charIndex;
    }
    if (a.type === "audio") {
      return typeof a.start === "number" ? a.start : 0;
    }
    const tp = a.text_position as { start?: number } | undefined;
    if (tp && typeof tp.start === "number") return tp.start;
  }
  return 0;
}

/**
 * Group resolved links by parent resource. Groups whose article was directly
 * linked come first; the rest (surfaced only via highlights/notes) follow.
 * Within a group, evidence is sorted by document position. The relative order of
 * first appearance is preserved as a stable tiebreak, so the result is
 * deterministic for a given input order.
 */
export function groupResolvedLinks(resolved: ResolvedLink[]): ResourceGroup[] {
  const map = new Map<string, ResourceGroup>();
  const order: string[] = [];

  for (const r of resolved) {
    // Unresolvable targets (deleted resource, etc.) can't share a group; give
    // each its own synthetic key so they render as standalone "unavailable" cards.
    const key = r.resourceId ?? `__unresolved__:${r.link.id}`;
    let group = map.get(key);
    if (!group) {
      group = { key, resource: r.resource, resourceLink: null, evidence: [] };
      map.set(key, group);
      order.push(key);
    }
    if (!group.resource && r.resource) group.resource = r.resource;
    if (r.kind === "resource") {
      group.resourceLink = r;
    } else {
      group.evidence.push(r);
    }
  }

  const groups = order.map((k) => map.get(k)!);
  for (const g of groups) {
    g.evidence.sort((a, b) => a.sortKey - b.sortKey);
  }
  // Stable partition: directly-linked resources first, original order otherwise.
  return groups
    .map((g, i) => ({ g, i }))
    .sort((a, b) => {
      const aDirect = a.g.resourceLink ? 0 : 1;
      const bDirect = b.g.resourceLink ? 0 : 1;
      if (aDirect !== bDirect) return aDirect - bDirect;
      return a.i - b.i;
    })
    .map((x) => x.g);
}

export { NOTE_SORT_KEY };
