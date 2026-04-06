import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ShibeiClient } from "../client.js";
import type { Tag } from "../types.js";

const PRESET_COLORS = ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink"];

export function registerTagTools(server: McpServer, client: ShibeiClient) {
  server.tool(
    "list_tags",
    "Get all tags in the resource library. Use this to find tag IDs before filtering or tagging resources.",
    {},
    async () => {
      const tags = await client.get<Tag[]>("/api/tags");
      const text = tags.length > 0
        ? tags.map((t) => `- ${t.name} (id: ${t.id}, color: ${t.color})`).join("\n")
        : "No tags found.";
      return { content: [{ type: "text" as const, text }] };
    }
  );

  server.tool(
    "manage_tags",
    `Manage tags: create new tags or add/remove tags from resources. Preset colors: ${PRESET_COLORS.join(", ")}.`,
    {
      action: z.enum(["create", "add", "remove"]).describe("'create' new tag, 'add' tag to resource, 'remove' tag from resource"),
      name: z.string().optional().describe("Tag name (required for 'create')"),
      color: z.string().optional().describe(`Tag color (required for 'create'). One of: ${PRESET_COLORS.join(", ")}`),
      resource_id: z.string().optional().describe("Resource ID (required for 'add'/'remove')"),
      tag_id: z.string().optional().describe("Tag ID (required for 'add'/'remove')"),
    },
    async (params) => {
      if (params.action === "create") {
        if (!params.name || !params.color) {
          return { content: [{ type: "text" as const, text: "Error: name and color are required for creating a tag." }], isError: true };
        }
        const result = await client.post<{ tag_id: string }>("/api/tags", { name: params.name, color: params.color });
        return { content: [{ type: "text" as const, text: `Tag "${params.name}" created (id: ${result.tag_id}).` }] };
      } else if (params.action === "add") {
        if (!params.resource_id || !params.tag_id) {
          return { content: [{ type: "text" as const, text: "Error: resource_id and tag_id are required for adding a tag." }], isError: true };
        }
        await client.post(`/api/resources/${encodeURIComponent(params.resource_id)}/tags/${encodeURIComponent(params.tag_id)}`);
        return { content: [{ type: "text" as const, text: "Tag added to resource." }] };
      } else {
        if (!params.resource_id || !params.tag_id) {
          return { content: [{ type: "text" as const, text: "Error: resource_id and tag_id are required for removing a tag." }], isError: true };
        }
        await client.delete(`/api/resources/${encodeURIComponent(params.resource_id)}/tags/${encodeURIComponent(params.tag_id)}`);
        return { content: [{ type: "text" as const, text: "Tag removed from resource." }] };
      }
    }
  );
}
