import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DiscoveredServer } from "./types";

const CLIENT_NAME = "mcp-workbench";
const CLIENT_VERSION = "0.1.0";

export interface ToolSummary {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface TestSuccess {
  ok: true;
  serverInfo?: { name: string; version: string };
  instructions?: string;
  capabilities: unknown;
  tools: ToolSummary[];
}

export interface TestFailure {
  ok: false;
  error: string;
  detail?: string;
}

export type TestResult = TestSuccess | TestFailure;

export async function testServer(server: DiscoveredServer, timeoutMs = 20000): Promise<TestResult> {
  let transport;
  try {
    transport = createTransport(server);
  } catch (e) {
    return { ok: false, error: msg(e) };
  }

  const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION }, { capabilities: {} });
  let stderr = "";
  try {
    const connecting = client.connect(transport, { timeout: timeoutMs });
    if (transport instanceof StdioClientTransport && transport.stderr) {
      transport.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
    }
    await withTimeout(connecting, timeoutMs, `Timed out after ${Math.round(timeoutMs / 1000)}s while connecting to the server.`);
    const capabilities = client.getServerCapabilities();
    const tools = capabilities?.tools
      ? (await client.listTools(undefined, { timeout: timeoutMs })).tools.map(toSummary)
      : [];
    const serverInfo = client.getServerVersion();
    return {
      ok: true,
      serverInfo: serverInfo ? { name: serverInfo.name, version: serverInfo.version } : undefined,
      instructions: client.getInstructions(),
      capabilities,
      tools,
    };
  } catch (e) {
    return { ok: false, error: msg(e), detail: failureDetail(e, stderr) };
  } finally {
    try {
      await client.close();
    } catch {}
  }
}

export function createTransport(server: DiscoveredServer) {
  const t = server.transport;
  if (t.kind === "stdio") {
    if (!t.command.trim()) {
      throw new Error("This server has no command to launch.");
    }
    return new StdioClientTransport({
      command: t.command,
      args: t.args.map(expandEnv),
      env: mapValues(t.env, expandEnv),
      stderr: "pipe",
    });
  }
  const url = new URL(t.url);
  const requestInit = { headers: mapValues(t.headers, expandEnv) };
  return t.kind === "sse"
    ? new SSEClientTransport(url, { requestInit })
    : new StreamableHTTPClientTransport(url, { requestInit });
}

function expandEnv(value: string): string {
  return value.replace(/\$\{(?:env:)?([A-Z0-9_]+)\}/gi, (_whole, name: string) => {
    const resolved = process.env[name];
    if (resolved === undefined) {
      throw new Error(`Environment variable ${name} is referenced but not set.`);
    }
    return resolved;
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function mapValues(obj: Record<string, string>, fn: (value: string) => string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = fn(v);
  }
  return out;
}

function toSummary(tool: { name: string; description?: string; inputSchema: unknown }): ToolSummary {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function failureDetail(e: unknown, stderr: string): string | undefined {
  const parts: string[] = [];
  if (e instanceof Error) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code) {
      parts.push(String(code));
    }
  }
  const tail = stderr.trim();
  if (tail) {
    parts.push(tail.length > 1000 ? tail.slice(-1000) : tail);
  }
  return parts.length ? parts.join("\n\n") : undefined;
}
