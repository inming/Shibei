import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ShibeiClient } from "../client.js";
import type { Resource } from "../types.js";

export function registerSearchTools(server: McpServer, client: ShibeiClient) {
  server.tool(
    "search_resources",
    "Search and browse the Shibei resource library. Returns a list of saved web resources. All parameters are optional — omit all to list everything.",
    {
      query: z.string().optional().describe("Search keyword (>= 2 characters)"),
      folder_id: z.string().optional().describe("Filter by folder ID"),
      tag_ids: z.array(z.string()).optional().describe("Filter by tag IDs (OR logic)"),
      sort_by: z.enum(["created_at", "annotated_at"]).optional().describe("Sort field (default: created_at)"),
      sort_order: z.enum(["asc", "desc"]).optional().describe("Sort direction (default: desc)"),
    },
    async (params) => {
      const queryParts: string[] = [];
      if (params.folder_id) queryParts.push(`folder_id=${encodeURIComponent(params.folder_id)}`);
      if (params.tag_ids?.length) queryParts.push(`tag_ids=${params.tag_ids.join(",")}`);
      if (params.sort_by) queryParts.push(`sort_by=${params.sort_by}`);
      if (params.sort_order) queryParts.push(`sort_order=${params.sort_order}`);
      if (params.query) queryParts.push(`query=${encodeURIComponent(params.query)}`);
      const qs = queryParts.length > 0 ? `?${queryParts.join("&")}` : "";
      const resources = await client.get<Resource[]>(`/api/resources${qs}`);
      const text = resources
        .map(
          (r) =>
            `- [${r.title}] (id: ${r.id})\n  URL: ${r.url}\n  Folder: ${r.folder_id}\n  Saved: ${r.created_at}${r.description ? `\n  Description: ${r.description}` : ""}`
        )
        .join("\n\n");
      return {
        content: [{
          type: "text" as const,
          text: resources.length > 0 ? `Found ${resources.length} resource(s):\n\n${text}` : "No resources found.",
        }],
      };
    }
  );
}
