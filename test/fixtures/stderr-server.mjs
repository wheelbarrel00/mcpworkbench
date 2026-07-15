import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "stderr-fixture", version: "0.0.1" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "hang", description: "writes a split multibyte char to stderr, then never replies", inputSchema: { type: "object", properties: {} } }],
}));

server.setRequestHandler(CallToolRequestSchema, async () => {
  process.stderr.write(Buffer.from([0xe2, 0x82]));
  await new Promise((r) => setTimeout(r, 60));
  process.stderr.write(Buffer.from([0xac]));
  return new Promise(() => {});
});

(async () => {
  await server.connect(new StdioServerTransport());
})();
