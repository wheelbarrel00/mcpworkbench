import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListResourcesRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "resources-only-fixture", version: "0.0.1" },
  { capabilities: { resources: {} } },
);

if (process.env.MCPWB_NO_RESOURCES_LIST !== "1") {
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: "only://one", name: "one" }],
  }));
}

(async () => {
  await server.connect(new StdioServerTransport());
})();
