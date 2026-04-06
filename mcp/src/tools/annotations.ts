import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ShibeiClient } from "../client.js";
import type { AnnotationsResponse } from "../types.js";

export function registerAnnotationTools(server: McpServer, client: ShibeiClient) {
  server.tool(
    "get_annotations",
    "Get all highlights and comments/notes for a resource.",
    { resource_id: z.string().describe("The resource ID") },
    async (params) => {
      const data = await client.get<AnnotationsResponse>(`/api/resources/${encodeURIComponent(params.resource_id)}/annotations`);
      const parts: string[] = [];
      if (data.highlights.length > 0) {
        parts.push("## Highlights\n");
        for (const h of data.highlights) {
          parts.push(`- [${h.color}] "${h.text_content}" (id: ${h.id})`);
          const relatedComments = data.comments.filter((c) => c.highlight_id === h.id);
          for (const c of relatedComments) {
            parts.push(`  Comment (id: ${c.id}): ${c.content}`);
          }
        }
      }
      const notes = data.comments.filter((c) => c.highlight_id === null);
      if (notes.length > 0) {
        parts.push("\n## Notes\n");
        for (const n of notes) {
          parts.push(`- (id: ${n.id}, ${n.updated_at}): ${n.content}`);
        }
      }
      const text = parts.length > 0 ? parts.join("\n") : "No annotations found for this resource.";
      return { content: [{ type: "text" as const, text }] };
    }
  );

  server.tool(
    "manage_notes",
    "Create a new resource-level note or update an existing comment/note. Notes support Markdown formatting.",
    {
      action: z.enum(["create", "update"]).describe("'create' for new note, 'update' to edit existing"),
      resource_id: z.string().optional().describe("Resource ID (required for 'create')"),
      comment_id: z.string().optional().describe("Comment ID to update (required for 'update')"),
      content: z.string().describe("Note content in Markdown format"),
    },
    async (params) => {
      if (params.action === "create") {
        if (!params.resource_id) {
          return { content: [{ type: "text" as const, text: "Error: resource_id is required for creating a note." }], isError: true };
        }
        const result = await client.post<{ comment_id: string }>(`/api/resources/${encodeURIComponent(params.resource_id)}/comments`, { content: params.content });
        return { content: [{ type: "text" as const, text: `Note created successfully (id: ${result.comment_id}).` }] };
      } else {
        if (!params.comment_id) {
          return { content: [{ type: "text" as const, text: "Error: comment_id is required for updating a note." }], isError: true };
        }
        await client.put(`/api/comments/${encodeURIComponent(params.comment_id)}`, { content: params.content });
        return { content: [{ type: "text" as const, text: "Note updated successfully." }] };
      }
    }
  );
}
