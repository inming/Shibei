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
        data.resource_type === "audio" && data.abs_path
          ? `Audio file: ${data.abs_path}\n(Transcribe this file, then call set_transcript with the segments.)`
          : null,
      ].filter(Boolean).join("\n");
      return { content: [{ type: "text" as const, text }] };
    }
  );

  server.tool(
    "set_transcript",
    "Store a transcript for an audio resource. Writes per-segment timestamps and makes the audio full-text searchable. Workflow: call get_resource to get the audio file path, transcribe it with your own speech-to-text, then call this. Overwrites any existing transcript.",
    {
      resource_id: z.string().describe("The audio resource ID"),
      text: z.string().optional().describe("Full transcript text. If omitted, derived by joining segment texts."),
      language: z.string().optional().describe("BCP-47 language code, e.g. 'en' or 'zh'"),
      segments: z
        .array(
          z.object({
            start: z.number().describe("Segment start time in seconds"),
            end: z.number().describe("Segment end time in seconds"),
            text: z.string().describe("Segment text"),
          })
        )
        .describe("Time-stamped transcript segments (in order)"),
    },
    async (params) => {
      const res = await client.post<{ ok: boolean; segments: number }>(
        `/api/resources/${encodeURIComponent(params.resource_id)}/transcript`,
        { text: params.text, language: params.language, segments: params.segments }
      );
      return {
        content: [{ type: "text" as const, text: `Transcript saved (${res.segments} segment(s)).` }],
      };
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
      if (params.title !== undefined && params.title !== "") body.title = params.title;
      if (params.description !== undefined && params.description !== "") body.description = params.description;
      if (params.folder_id !== undefined && params.folder_id !== "") body.folder_id = params.folder_id;
      await client.put(`/api/resources/${encodeURIComponent(params.resource_id)}`, body);
      return { content: [{ type: "text" as const, text: "Resource updated successfully." }] };
    }
  );
}
