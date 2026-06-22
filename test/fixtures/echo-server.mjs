import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "echo-fixture", version: "0.0.1" },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo back the provided message.",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const message = request.params.arguments?.message ?? "";
  return { content: [{ type: "text", text: `echo: ${message}` }] };
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [{ uri: "echo://greeting", name: "greeting", mimeType: "text/plain" }],
}));

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [{ uriTemplate: "echo://item/{id}", name: "item" }],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
  contents: [{ uri: request.params.uri, mimeType: "text/plain", text: "hello from resource" }],
}));

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    {
      name: "greet",
      description: "Greet someone by name.",
      arguments: [{ name: "name", description: "Who to greet", required: true }],
    },
  ],
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const name = request.params.arguments?.name ?? "world";
  return { messages: [{ role: "user", content: { type: "text", text: `Hello, ${name}` } }] };
});

(async () => {
  await server.connect(new StdioServerTransport());
})();
