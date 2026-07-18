import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "progress-fixture", version: "0.0.1" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "slow", description: "runs past the base timeout while reporting progress", inputSchema: { type: "object", properties: {} } }],
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const progressToken = request.params._meta?.progressToken;
  for (let i = 0; i < 6; i++) {
    await new Promise((resume) => setTimeout(resume, 250));
    if (progressToken !== undefined) {
      await extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress: i + 1, total: 6 },
      });
    }
  }
  return { content: [{ type: "text", text: "done" }] };
});

(async () => {
  await server.connect(new StdioServerTransport());
})();
