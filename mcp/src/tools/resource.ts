import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ShibeiClient } from "../client.js";
import type { ResourceWithTags, ContentResponse } from "../types.js";

export function registerResourceTools(server: McpServer, client: ShibeiClient) {
  server.tool(
    "get_resource",
    "Get detailed information about a specific resource, including its metadata and tags.",
    { resource_id: z.string().describe("The resource ID") },
    async (params) => {
      const data = await client.get<ResourceWithTags>(`/api/resources/${encodeURIComponent(params.resource_id)}`);
      const tagNames = data.tags.map((t) => t.name).join(", ") || "(none)";
      const text = [
        `Title: ${data.title}`,
        `URL: ${data.url}`,
        `Domain: ${data.domain || "(unknown)"}`,
        `Folder: ${data.folder_id}`,
        `Type: ${data.resource_type}`,
        `Saved: ${data.created_at}`,
        `Tags: ${tagNames}`,
        data.description ? `Description: ${data.description}` : null,
        data.author ? `Author: ${data.author}` : null,
      ].filter(Boolean).join("\n");
      return { content: [{ type: "text" as const, text }] };
    }
  );

  server.tool(
    "get_resource_content",
    "Read the plain text content of a saved web resource. Supports pagination for long documents.",
    {
      resource_id: z.string().describe("The resource ID"),
      offset: z.number().optional().describe("Character offset to start reading from (default: 0)"),
      max_length: z.number().optional().describe("Maximum number of characters to return (default: 50000)"),
    },
    async (params) => {
      const queryParts: string[] = [];
      if (params.offset !== undefined) queryParts.push(`offset=${params.offset}`);
      if (params.max_length !== undefined) queryParts.push(`max_length=${params.max_length}`);
      const qs = queryParts.length > 0 ? `?${queryParts.join("&")}` : "";
      const data = await client.get<ContentResponse>(`/api/resources/${encodeURIComponent(params.resource_id)}/content${qs}`);
      const header = `[Content: ${data.total_length} chars total${data.has_more ? ", more available" : ""}]\n\n`;
      return { content: [{ type: "text" as const, text: header + data.content }] };
    }
  );

  server.tool(
    "update_resource",
    "Edit a resource's metadata or move it to a different folder. Only provide the fields you want to change.",
    {
      resource_id: z.string().describe("The resource ID"),
      title: z.string().optional().describe("New title"),
      description: z.string().optional().describe("New description"),
      folder_id: z.string().optional().describe("Target folder ID to move the resource to"),
    },
    async (params) => {
      const body: Record<string, string> = {};
      if (params.title !== undefined) body.title = params.title;
      if (params.description !== undefined) body.description = params.description;
      if (params.folder_id !== undefined) body.folder_id = params.folder_id;
      await client.put(`/api/resources/${encodeURIComponent(params.resource_id)}`, body);
      return { content: [{ type: "text" as const, text: "Resource updated successfully." }] };
    }
  );
}
