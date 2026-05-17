import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ShibeiClient } from "../client.js";

export function registerSyncTools(server: McpServer, client: ShibeiClient) {
  server.tool(
    "sync_now",
    "Trigger a full sync cycle: upload local changes to S3 and download/apply remote changes. Same effect as clicking the sync button in the desktop app. Requires S3 to be configured.",
    {},
    async () => {
      const result = await client.post<{ uploaded: number; downloaded: number; applied: number }>("/api/sync");
      const parts: string[] = [];
      if (result.uploaded > 0) parts.push(`${result.uploaded} uploaded`);
      if (result.downloaded > 0) parts.push(`${result.downloaded} downloaded`);
      if (result.applied > 0) parts.push(`${result.applied} applied`);
      const summary = parts.length > 0 ? parts.join(", ") : "no changes";
      return { content: [{ type: "text" as const, text: `Sync completed: ${summary}.` }] };
    }
  );
}
