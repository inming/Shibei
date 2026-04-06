import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ShibeiClient } from "./client.js";
import { registerSearchTools } from "./tools/search.js";
import { registerResourceTools } from "./tools/resource.js";
import { registerAnnotationTools } from "./tools/annotations.js";
import { registerFolderTools } from "./tools/folders.js";
import { registerTagTools } from "./tools/tags.js";

const server = new McpServer({
  name: "shibei",
  version: "1.0.0",
});

const client = new ShibeiClient();

registerSearchTools(server, client);
registerResourceTools(server, client);
registerAnnotationTools(server, client);
registerFolderTools(server, client);
registerTagTools(server, client);

const transport = new StdioServerTransport();
await server.connect(transport);
