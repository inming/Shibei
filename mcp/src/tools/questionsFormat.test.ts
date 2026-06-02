import { describe, expect, it } from "vitest";
import type { QuestionLink, Resource, ResolvedQuestionLink } from "../types.js";
import { clip, formatLinkedEvidence } from "./questionsFormat.js";

let seq = 0;

function resource(id: string, title = `Title ${id}`): Resource {
  return {
    id,
    title,
    url: `https://example.com/${id}`,
    domain: "example.com",
    author: null,
    description: null,
    folder_id: "__inbox__",
    resource_type: "webpage",
    file_path: `${id}.html`,
    created_at: "2026-01-01",
    captured_at: "2026-01-01",
    selection_meta: null,
  };
}

function link(
  targetType: QuestionLink["target_type"],
  targetId: string,
  reason: string | null = null,
): QuestionLink {
  seq += 1;
  return {
    id: `link-${seq}`,
    question_id: "q1",
    target_type: targetType,
    target_id: targetId,
    reason,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
  };
}

function resourceLink(res: Resource, reason: string | null = null): ResolvedQuestionLink {
  return {
    link: link("resource", res.id, reason),
    resource: res,
    snippet: null,
    highlight_id: null,
    highlight_color: null,
    anchor: null,
  };
}

function highlightLink(
  res: Resource,
  snippet: string,
  reason: string | null = null,
): ResolvedQuestionLink {
  seq += 1;
  return {
    link: link("highlight", `hl-${seq}`, reason),
    resource: res,
    snippet,
    highlight_id: `hl-${seq}`,
    highlight_color: "#ffeb3b",
    anchor: { text_position: { start: 0, end: 5 } },
  };
}

function noteLink(res: Resource, snippet: string): ResolvedQuestionLink {
  seq += 1;
  return {
    link: link("comment", `cm-${seq}`),
    resource: res,
    snippet,
    highlight_id: null,
    highlight_color: null,
    anchor: null,
  };
}

describe("clip", () => {
  it("collapses whitespace", () => {
    expect(clip("a\n\n  b   c")).toBe("a b c");
  });

  it("truncates past the limit with an ellipsis", () => {
    expect(clip("abcdef", 3)).toBe("abc…");
  });

  it("leaves short strings untouched", () => {
    expect(clip("short", 10)).toBe("short");
  });
});

describe("formatLinkedEvidence", () => {
  it("returns a no-items line when there are no links", () => {
    expect(formatLinkedEvidence([])).toEqual(["", "No linked items."]);
  });

  it("groups a resource link with its highlights under one heading", () => {
    const a = resource("A", "Article A");
    const out = formatLinkedEvidence([
      resourceLink(a, "whole article matters"),
      highlightLink(a, "first highlight", "key evidence"),
      highlightLink(a, "second highlight"),
    ]).join("\n");

    // One resource, three links.
    expect(out).toContain("## Linked evidence (1 resource(s), 3 link(s))");
    // Single heading for the resource.
    expect(out.match(/### 📄 Article A/g)?.length).toBe(1);
    expect(out).toContain("(resource id: A)");
    expect(out).toContain("url: https://example.com/A");
    // Whole-article link + its reason.
    expect(out).toContain("whole-article link id:");
    expect(out).toContain("reason: whole article matters");
    // Highlights with snippets nested as bullets.
    expect(out).toContain('🖍 highlight "first highlight"');
    expect(out).toContain('🖍 highlight "second highlight"');
    expect(out).toContain("reason: key evidence");
  });

  it("gives a heading to a resource surfaced only via a highlight", () => {
    const b = resource("B", "Article B");
    const out = formatLinkedEvidence([highlightLink(b, "lone highlight")]).join("\n");
    expect(out).toContain("### 📄 Article B");
    // No whole-article link line, since the resource itself was not linked.
    expect(out).not.toContain("whole-article link id:");
    expect(out).toContain('🖍 highlight "lone highlight"');
  });

  it("labels comment links as notes", () => {
    const c = resource("C");
    const out = formatLinkedEvidence([noteLink(c, "a note body")]).join("\n");
    expect(out).toContain('💬 comment "a note body"');
  });

  it("renders unresolvable targets under '(source unavailable)'", () => {
    const dead: ResolvedQuestionLink = {
      link: link("highlight", "gone"),
      resource: null,
      snippet: null,
      highlight_id: null,
      highlight_color: null,
      anchor: null,
    };
    const out = formatLinkedEvidence([dead]).join("\n");
    expect(out).toContain("### (source unavailable)");
  });

  it("keeps multiple resources as separate groups in first-seen order", () => {
    const a = resource("A", "Article A");
    const b = resource("B", "Article B");
    const out = formatLinkedEvidence([
      highlightLink(b, "from B"),
      highlightLink(a, "from A"),
    ]).join("\n");
    expect(out).toContain("## Linked evidence (2 resource(s), 2 link(s))");
    expect(out.indexOf("Article B")).toBeLessThan(out.indexOf("Article A"));
  });
});
