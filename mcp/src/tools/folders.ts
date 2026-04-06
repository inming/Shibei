import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ShibeiClient } from "../client.js";
import type { FolderNode } from "../types.js";

export function registerFolderTools(server: McpServer, client: ShibeiClient) {
  server.tool(
    "list_folders",
    "Get the folder tree structure of the resource library, including resource counts per folder.",
    {},
    async () => {
      const [folders, counts] = await Promise.all([
        client.get<FolderNode[]>("/api/folders"),
        client.get<Record<string, number>>("/api/folder-counts"),
      ]);
      function formatTree(nodes: FolderNode[], indent: number): string {
        return nodes.map((n) => {
          const prefix = "  ".repeat(indent);
          const count = counts[n.id] ?? 0;
          const line = `${prefix}- ${n.name} (id: ${n.id}, ${count} resources)`;
          const children = n.children.length > 0 ? "\n" + formatTree(n.children, indent + 1) : "";
          return line + children;
        }).join("\n");
      }
      const text = folders.length > 0 ? `Folder tree:\n${formatTree(folders, 0)}` : "No folders found.";
      return { content: [{ type: "text" as const, text }] };
    }
  );
}
