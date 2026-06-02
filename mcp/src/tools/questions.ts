import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ShibeiClient } from "../client.js";
import type { Question, ResolvedQuestionLink } from "../types.js";
import { formatLinkedEvidence } from "./questionsFormat.js";

/**
 * Questions = user-tracked research focus areas with polymorphic links to
 * resources / highlights / comments. The AI uses these tools to:
 *   - Discover what the user is currently investigating (list_questions)
 *   - Pull the full set of evidence the user has gathered for a topic
 *     (get_question with include_linked) — the primary input for stage
 *     summaries
 *   - Suggest and establish links between newly captured material and
 *     existing questions (link_to_question)
 */
export function registerQuestionTools(server: McpServer, client: ShibeiClient) {
  server.tool(
    "list_questions",
    "List research questions the user is tracking. By default returns active questions; pass status='archived' to see resolved/parked ones.",
    {
      status: z
        .enum(["active", "archived"])
        .optional()
        .describe("Filter by lifecycle status. Omit to return both (active first)."),
    },
    async (params) => {
      const path = params.status
        ? `/api/questions?status=${encodeURIComponent(params.status)}`
        : "/api/questions";
      const questions = await client.get<Question[]>(path);
      if (questions.length === 0) {
        return { content: [{ type: "text" as const, text: "No questions found." }] };
      }
      const text = questions
        .map((q) => {
          const status = q.status === "archived" ? " [archived]" : "";
          const desc = q.description ? ` — ${q.description.split("\n")[0]}` : "";
          return `- ${q.title}${status} (id: ${q.id})${desc}`;
        })
        .join("\n");
      return { content: [{ type: "text" as const, text }] };
    },
  );

  server.tool(
    "get_question",
    "Get a question's full detail, optionally expanding its linked resources / highlights / comments so the AI can summarize evidence in one round-trip. Pass include_linked=true for the stage-summary workflow.",
    {
      id: z.string().describe("Question ID"),
      include_linked: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "When true, also resolve every alive link's target — resource title/url for 'resource' links, highlight text for 'highlight' links, comment content for 'comment' links — plus the per-link 'reason' note the user wrote.",
        ),
    },
    async (params) => {
      const question = await client.get<Question>(
        `/api/questions/${encodeURIComponent(params.id)}`,
      );

      const lines: string[] = [];
      lines.push(`# ${question.title}`);
      lines.push(`Status: ${question.status}${question.archived_at ? ` (archived at ${question.archived_at})` : ""}`);
      if (question.description) {
        lines.push("");
        lines.push(question.description);
      }

      if (params.include_linked) {
        // One round-trip: each link arrives with its parent resource + snippet.
        const links = await client.get<ResolvedQuestionLink[]>(
          `/api/questions/${encodeURIComponent(params.id)}/links/resolved`,
        );
        lines.push(...formatLinkedEvidence(links));
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  server.tool(
    "manage_questions",
    "Create, edit, archive, unarchive, or delete a research question. For granular link operations use link_to_question / unlink_from_question.",
    {
      action: z
        .enum(["create", "update", "archive", "unarchive", "delete"])
        .describe("Lifecycle operation to perform."),
      id: z.string().optional().describe("Question ID (required for everything except create)."),
      title: z.string().optional().describe("Question title (required for create; optional for update)."),
      description: z
        .string()
        .optional()
        .describe("Markdown description. Pass empty string to clear on update."),
    },
    async (params) => {
      if (params.action === "create") {
        if (!params.title) {
          return {
            content: [{ type: "text" as const, text: "Error: title is required for creating a question." }],
            isError: true,
          };
        }
        const created = await client.post<{ question_id: string }>("/api/questions", {
          title: params.title,
          description: params.description ?? null,
        });
        return {
          content: [
            { type: "text" as const, text: `Question "${params.title}" created (id: ${created.question_id}).` },
          ],
        };
      }
      if (!params.id) {
        return {
          content: [{ type: "text" as const, text: `Error: id is required for ${params.action}.` }],
          isError: true,
        };
      }
      switch (params.action) {
        case "update": {
          const body: Record<string, unknown> = {};
          if (params.title !== undefined && params.title !== "") body.title = params.title;
          if (params.description !== undefined && params.description !== "") body.description = params.description;
          await client.put(`/api/questions/${encodeURIComponent(params.id)}`, body);
          return { content: [{ type: "text" as const, text: "Question updated." }] };
        }
        case "archive": {
          await client.put(`/api/questions/${encodeURIComponent(params.id)}`, { status: "archived" });
          return { content: [{ type: "text" as const, text: "Question archived." }] };
        }
        case "unarchive": {
          await client.put(`/api/questions/${encodeURIComponent(params.id)}`, { status: "active" });
          return { content: [{ type: "text" as const, text: "Question unarchived." }] };
        }
        case "delete": {
          await client.delete(`/api/questions/${encodeURIComponent(params.id)}`);
          return {
            content: [
              {
                type: "text" as const,
                text: "Question deleted. Linked resources / highlights / comments themselves are not affected, but their link rows were soft-deleted.",
              },
            ],
          };
        }
      }
    },
  );

  server.tool(
    "link_to_question",
    "Link a resource / highlight / comment to a question. Idempotent: re-linking the same (question, target) pair returns the existing link instead of erroring. Use the optional 'reason' field to record WHY this evidence matters for the question — it materially improves the quality of later summaries.",
    {
      question_id: z.string().describe("Question ID"),
      target_type: z.enum(["resource", "highlight", "comment"]).describe("What kind of entity to link"),
      target_id: z.string().describe("Resource ID, highlight ID, or comment ID matching target_type"),
      reason: z
        .string()
        .optional()
        .describe("Optional Markdown explanation of why this evidence matters for the question."),
    },
    async (params) => {
      const result = await client.post<{ link_id: string }>(
        `/api/questions/${encodeURIComponent(params.question_id)}/links`,
        {
          target_type: params.target_type,
          target_id: params.target_id,
          reason: params.reason ?? null,
        },
      );
      return {
        content: [
          {
            type: "text" as const,
            text: `Linked ${params.target_type} ${params.target_id} → question ${params.question_id} (link id: ${result.link_id}).`,
          },
        ],
      };
    },
  );

  server.tool(
    "unlink_from_question",
    "Remove a link between a question and one of its targets. Pass the link_id returned by get_question(include_linked=true) or link_to_question.",
    {
      link_id: z.string().describe("Question link ID"),
    },
    async (params) => {
      await client.delete(`/api/question-links/${encodeURIComponent(params.link_id)}`);
      return { content: [{ type: "text" as const, text: "Link removed." }] };
    },
  );
}

/**
 * Resolve a link's target to a single human-readable summary line. Falls back
 * to `null` if the target can't be loaded (deleted, etc.).
 */

