import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "barrier-fixture", version: "0.0.1" },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

let arrived = 0;
const waiting = [];

function barrier() {
  arrived++;
  if (arrived >= 4) {
    waiting.forEach((resume) => resume());
    waiting.length = 0;
    return Promise.resolve();
  }
  return new Promise((resume) => waiting.push(resume));
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  await barrier();
  return { tools: [] };
});
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  await barrier();
  return { resources: [] };
});
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
  await barrier();
  return { resourceTemplates: [] };
});
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  await barrier();
  return { prompts: [] };
});

(async () => {
  await server.connect(new StdioServerTransport());
})();
