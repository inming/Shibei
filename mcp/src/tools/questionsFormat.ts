import type { Resource, ResolvedQuestionLink } from "../types.js";

/** Collapse whitespace and cap length so a snippet/reason stays one tidy line
 *  in the summary listing. The agent can call get_resource for the full text. */
export function clip(s: string, max = 280): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

type Group = {
  resource: Resource | null;
  resourceLink: ResolvedQuestionLink | null;
  evidence: ResolvedQuestionLink[];
};

/**
 * Render a question's resolved links as the "linked evidence" section of the
 * get_question(include_linked) output. Groups by parent resource so evidence
 * reads source-by-source — the shape a stage summary wants. A resource surfaced
 * only via a highlight/comment still gets its own heading; unresolvable targets
 * fall under "(source unavailable)". Returns markdown lines (caller joins).
 */
export function formatLinkedEvidence(links: ResolvedQuestionLink[]): string[] {
  if (links.length === 0) {
    return ["", "No linked items."];
  }

  const groups = new Map<string, Group>();
  const order: string[] = [];
  for (const r of links) {
    const key = r.resource?.id ?? `__unresolved__:${r.link.id}`;
    let g = groups.get(key);
    if (!g) {
      g = { resource: r.resource, resourceLink: null, evidence: [] };
      groups.set(key, g);
      order.push(key);
    }
    if (!g.resource && r.resource) g.resource = r.resource;
    if (r.link.target_type === "resource") g.resourceLink = r;
    else g.evidence.push(r);
  }

  const lines: string[] = [];
  lines.push("");
  lines.push(`## Linked evidence (${groups.size} resource(s), ${links.length} link(s))`);
  for (const key of order) {
    const g = groups.get(key)!;
    lines.push("");
    if (g.resource) {
      lines.push(`### 📄 ${g.resource.title} (resource id: ${g.resource.id})`);
      lines.push(`  url: ${g.resource.url}`);
    } else {
      lines.push("### (source unavailable)");
    }
    if (g.resourceLink) {
      lines.push(`  whole-article link id: ${g.resourceLink.link.id}`);
      if (g.resourceLink.link.reason) {
        lines.push(`  reason: ${clip(g.resourceLink.link.reason)}`);
      }
    }
    for (const e of g.evidence) {
      const label = e.link.target_type === "highlight" ? "🖍 highlight" : "💬 comment";
      const snippet = e.snippet ? ` "${clip(e.snippet)}"` : "";
      lines.push(`  - ${label}${snippet} (link id: ${e.link.id})`);
      if (e.link.reason) lines.push(`    reason: ${clip(e.link.reason)}`);
    }
  }
  return lines;
}
