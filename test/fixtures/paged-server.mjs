import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const TOTAL = 25;
const PAGE_SIZE = 10;
const endless = process.env.MCPWB_ENDLESS === "1";
const repeatsCursor = process.env.MCPWB_REPEAT === "1";
const pageDelayMs = Number(process.env.MCPWB_SLOW_MS || "0");
const withOutputSchema = process.env.MCPWB_OUTPUT_SCHEMA === "1";

const server = new Server(
  { name: "paged-fixture", version: "0.0.1" },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

async function page(cursor, make) {
  if (pageDelayMs) {
    await new Promise((resume) => setTimeout(resume, pageDelayMs));
  }
  const start = cursor && cursor !== "again" ? Number(cursor) : 0;
  if (repeatsCursor) {
    return { items: [make(start)], nextCursor: "again" };
  }
  if (endless) {
    return { items: [make(start)], nextCursor: String(start + 1) };
  }
  const end = Math.min(start + PAGE_SIZE, TOTAL);
  const items = [];
  for (let i = start; i < end; i++) {
    items.push(make(i));
  }
  return { items, nextCursor: end < TOTAL ? String(end) : undefined };
}

function tool(i) {
  const outputSchema = { type: "object", properties: { n: { type: "number" } }, required: ["n"] };
  return { name: `tool-${i}`, inputSchema: { type: "object" }, ...(withOutputSchema ? { outputSchema } : {}) };
}

server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  const { items, nextCursor } = await page(request.params?.cursor, tool);
  return { tools: items, nextCursor };
});

server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: "text", text: "not a number" }],
  structuredContent: { n: "not a number" },
}));

server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
  const { items, nextCursor } = await page(request.params?.cursor, (i) => ({ uri: `paged://resource/${i}`, name: `resource-${i}` }));
  return { resources: items, nextCursor };
});

server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
  const { items, nextCursor } = await page(request.params?.cursor, (i) => ({ uriTemplate: `paged://template/${i}/{id}`, name: `template-${i}` }));
  return { resourceTemplates: items, nextCursor };
});

server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
  const { items, nextCursor } = await page(request.params?.cursor, (i) => ({ name: `prompt-${i}` }));
  return { prompts: items, nextCursor };
});

(async () => {
  await server.connect(new StdioServerTransport());
})();
