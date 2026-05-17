import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
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

  server.tool(
    "manage_folders",
    "Manage folders: create, rename, or delete. Deleting requires the folder subtree to contain no resources; empty descendant folders are deleted recursively.",
    {
      action: z.enum(["create", "rename", "delete"]).describe("'create' new folder, 'rename' existing, 'delete' empty folder"),
      name: z.string().optional().describe("Folder name (required for 'create' and 'rename')"),
      folder_id: z.string().optional().describe("Folder ID (required for 'rename' and 'delete')"),
      parent_id: z.string().optional().describe("Parent folder ID (required for 'create')"),
    },
    async (params) => {
      if (params.action === "create") {
        if (!params.name || !params.parent_id) {
          return { content: [{ type: "text" as const, text: "Error: name and parent_id are required for creating a folder." }], isError: true };
        }
        const result = await client.post<{ folder_id: string }>("/api/folders", { name: params.name, parent_id: params.parent_id });
        return { content: [{ type: "text" as const, text: `Folder "${params.name}" created (id: ${result.folder_id}).` }] };
      } else if (params.action === "rename") {
        if (!params.folder_id || !params.name) {
          return { content: [{ type: "text" as const, text: "Error: folder_id and name are required for renaming a folder." }], isError: true };
        }
        await client.put(`/api/folders/${encodeURIComponent(params.folder_id)}`, { name: params.name });
        return { content: [{ type: "text" as const, text: `Folder renamed to "${params.name}".` }] };
      } else {
        if (!params.folder_id) {
          return { content: [{ type: "text" as const, text: "Error: folder_id is required for deleting a folder." }], isError: true };
        }
        await client.delete(`/api/folders/${encodeURIComponent(params.folder_id)}`);
        return { content: [{ type: "text" as const, text: "Folder deleted successfully." }] };
      }
    }
  );
}
