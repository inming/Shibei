import { describe, expect, it } from "vitest";
import type { Anchor, QuestionLink, QuestionTargetType, Resource } from "@/types";
import {
  anchorSortKey,
  groupResolvedLinks,
  NOTE_SORT_KEY,
  type ResolvedLink,
} from "@/lib/questionLinks";

function resource(id: string): Resource {
  return {
    id,
    title: `Title ${id}`,
    url: "",
    domain: null,
    author: null,
    description: null,
    folder_id: "__inbox__",
    resource_type: "html",
    file_path: "",
    created_at: "2026-01-01",
    captured_at: "2026-01-01",
    selection_meta: null,
    content_time: null,
  };
}

let seq = 0;
function link(targetType: QuestionTargetType, targetId: string): QuestionLink {
  seq += 1;
  return {
    id: `link-${seq}`,
    question_id: "q1",
    target_type: targetType,
    target_id: targetId,
    reason: null,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
  };
}

function resolvedResource(resId: string): ResolvedLink {
  return {
    link: link("resource", resId),
    kind: "resource",
    resourceId: resId,
    resource: resource(resId),
    snippet: null,
    sortKey: -1,
  };
}

function resolvedHighlight(resId: string, sortKey: number): ResolvedLink {
  return {
    link: link("highlight", `hl-${seq}`),
    kind: "highlight",
    resourceId: resId,
    resource: resource(resId),
    snippet: `highlight in ${resId}`,
    highlightId: `hl-${seq}`,
    color: "#ffeb3b",
    sortKey,
  };
}

function resolvedNote(resId: string): ResolvedLink {
  return {
    link: link("comment", `cm-${seq}`),
    kind: "comment",
    resourceId: resId,
    resource: resource(resId),
    snippet: `note in ${resId}`,
    sortKey: NOTE_SORT_KEY,
  };
}

describe("groupResolvedLinks", () => {
  it("collapses highlights of the same resource into one group", () => {
    // The screenshot scenario: resource A linked directly + 2 highlights from A.
    const groups = groupResolvedLinks([
      resolvedResource("A"),
      resolvedHighlight("A", 100),
      resolvedHighlight("A", 50),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].resource?.id).toBe("A");
    expect(groups[0].resourceLink).not.toBeNull();
    expect(groups[0].evidence).toHaveLength(2);
  });

  it("sorts evidence within a group by document position", () => {
    const groups = groupResolvedLinks([
      resolvedHighlight("A", 300),
      resolvedHighlight("A", 100),
      resolvedHighlight("A", 200),
    ]);
    expect(groups[0].evidence.map((e) => e.sortKey)).toEqual([100, 200, 300]);
  });

  it("orders notes after highlights", () => {
    const groups = groupResolvedLinks([
      resolvedNote("A"),
      resolvedHighlight("A", 500),
    ]);
    expect(groups[0].evidence.map((e) => e.kind)).toEqual(["highlight", "comment"]);
  });

  it("puts directly-linked resources before highlight-only ones", () => {
    // B appears first but is highlight-only; A is directly linked → A first.
    const groups = groupResolvedLinks([
      resolvedHighlight("B", 10),
      resolvedResource("A"),
      resolvedHighlight("A", 10),
    ]);
    expect(groups.map((g) => g.resource?.id)).toEqual(["A", "B"]);
    expect(groups[1].resourceLink).toBeNull(); // B surfaced only via highlight
  });

  it("preserves first-appearance order among same-tier groups", () => {
    const groups = groupResolvedLinks([
      resolvedHighlight("C", 1),
      resolvedHighlight("B", 1),
      resolvedHighlight("A", 1),
    ]);
    expect(groups.map((g) => g.resource?.id)).toEqual(["C", "B", "A"]);
  });

  it("gives each unresolvable link its own group", () => {
    const dead1: ResolvedLink = {
      link: link("highlight", "gone-1"),
      kind: "highlight",
      resourceId: null,
      resource: null,
      snippet: null,
      sortKey: 0,
    };
    const dead2: ResolvedLink = {
      link: link("highlight", "gone-2"),
      kind: "highlight",
      resourceId: null,
      resource: null,
      snippet: null,
      sortKey: 0,
    };
    const groups = groupResolvedLinks([dead1, dead2]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.resource === null)).toBe(true);
  });
});

describe("anchorSortKey", () => {
  it("uses text_position.start for HTML anchors", () => {
    const anchor: Anchor = {
      text_position: { start: 42, end: 50 },
      text_quote: { exact: "x", prefix: "", suffix: "" },
    };
    expect(anchorSortKey(anchor)).toBe(42);
  });

  it("orders PDF anchors by page then char index", () => {
    const p0: Anchor = { type: "pdf", page: 0, charIndex: 900, length: 1, textQuote: { exact: "", prefix: "", suffix: "" } };
    const p1: Anchor = { type: "pdf", page: 1, charIndex: 10, length: 1, textQuote: { exact: "", prefix: "", suffix: "" } };
    expect(anchorSortKey(p0)).toBeLessThan(anchorSortKey(p1));
  });

  it("uses start seconds for audio anchors", () => {
    const anchor: Anchor = { type: "audio", start: 12.5, end: 20 };
    expect(anchorSortKey(anchor)).toBe(12.5);
  });

  it("falls back to 0 for unknown anchors", () => {
    expect(anchorSortKey(undefined)).toBe(0);
    expect(anchorSortKey({} as Anchor)).toBe(0);
  });
});
