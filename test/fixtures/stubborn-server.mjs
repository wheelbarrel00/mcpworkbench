import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const pidFile = process.env.MCPWB_PID_FILE;
if (pidFile) {
  writeFileSync(pidFile, String(process.pid));
}

const childPidFile = process.env.MCPWB_CHILD_PID_FILE;
if (childPidFile) {
  const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1 << 30);"], {
    stdio: "ignore",
  });
  writeFileSync(childPidFile, String(grandchild.pid));
}

const server = new Server(
  { name: "stubborn-fixture", version: "0.0.1" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));

const keepAlive = setInterval(() => {}, 1 << 30);

process.stdin.on("end", () => {});
process.stdin.on("close", () => {});

(async () => {
  await server.connect(new StdioServerTransport());
})();

void keepAlive;
