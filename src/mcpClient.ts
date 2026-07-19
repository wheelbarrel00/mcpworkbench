import * as fs from "fs";
import * as os from "os";
import { spawnSync } from "child_process";
import { StringDecoder } from "string_decoder";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DiscoveredServer } from "./types";

const CLIENT_NAME = "mcp-workbench";
const CLIENT_VERSION = "0.4.7";
const STDERR_CAP = 8192;
const CALL_TOOL_MAX_TIMEOUT = 300000;
const TERMINATE_TIMEOUT = 5000;

export interface ToolSummary {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface ResourceSummary {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface ResourceTemplateSummary {
  uriTemplate: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface PromptArgSummary {
  name: string;
  description?: string;
  required?: boolean;
}

export interface PromptSummary {
  name: string;
  title?: string;
  description?: string;
  arguments: PromptArgSummary[];
}

export interface TestSuccess {
  ok: true;
  serverInfo?: { name: string; version: string };
  instructions?: string;
  capabilities: unknown;
  tools: ToolSummary[];
  resources: ResourceSummary[];
  resourceTemplates: ResourceTemplateSummary[];
  prompts: PromptSummary[];
}

export interface TestFailure {
  ok: false;
  error: string;
  detail?: string;
}

export type TestResult = TestSuccess | TestFailure;

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  toolCount?: number;
  error?: string;
  detail?: string;
}

export interface ToolCallSuccess {
  ok: true;
  isError: boolean;
  content: unknown[];
  structuredContent?: unknown;
}

export interface ToolCallFailure {
  ok: false;
  error: string;
  detail?: string;
}

export type ToolCallResult = ToolCallSuccess | ToolCallFailure;

export interface ResourceReadSuccess {
  ok: true;
  contents: unknown[];
}

export type ResourceReadResult = ResourceReadSuccess | ToolCallFailure;

export interface PromptGetSuccess {
  ok: true;
  description?: string;
  messages: unknown[];
}

export type PromptGetResult = PromptGetSuccess | ToolCallFailure;

export interface McpSession {
  info: TestSuccess;
  callTool(name: string, args: unknown): Promise<ToolCallResult>;
  readResource(uri: string): Promise<ResourceReadResult>;
  getPrompt(name: string, args: Record<string, string>): Promise<PromptGetResult>;
  dispose(): Promise<void>;
}

export type SessionResult = { ok: true; session: McpSession } | TestFailure;

class ConnectError extends Error {
  readonly detail?: string;
  constructor(message: string, detail?: string) {
    super(message);
    this.detail = detail;
  }
}

interface Connection {
  client: Client;
  capabilities: ReturnType<Client["getServerCapabilities"]>;
  stderrTail(): string;
  close(): Promise<void>;
}

async function connect(server: DiscoveredServer, timeoutMs: number, onClosed?: () => void): Promise<Connection> {
  const transport = createTransport(server);
  const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION }, { capabilities: {} });
  let stderr = "";
  let closing = false;
  client.onerror = (e) => {
    stderr = (stderr + `[protocol] ${msg(e)}\n`).slice(-STDERR_CAP);
  };
  try {
    const connecting = client.connect(transport, { timeout: timeoutMs });
    if (transport instanceof StdioClientTransport && transport.stderr) {
      const decoder = new StringDecoder("utf8");
      transport.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + decoder.write(chunk)).slice(-STDERR_CAP);
      });
    }
    await withTimeout(connecting, timeoutMs, `Timed out after ${Math.round(timeoutMs / 1000)}s while connecting to the server.`);
  } catch (e) {
    try {
      await client.close();
    } catch {}
    throw new ConnectError(msg(e), failureDetail(e, stderr));
  }
  if (onClosed) {
    client.onclose = () => {
      if (!closing) {
        onClosed();
      }
    };
  }
  return {
    client,
    capabilities: client.getServerCapabilities(),
    stderrTail: () => stderr,
    async close() {
      closing = true;
      const pid = transport instanceof StdioClientTransport ? transport.pid : null;
      if (process.platform === "win32" && pid) {
        try {
          spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
        } catch {}
      }
      if (transport instanceof StreamableHTTPClientTransport) {
        try {
          await withTimeout(transport.terminateSession(), Math.min(timeoutMs, TERMINATE_TIMEOUT), "Timed out terminating the HTTP session.");
        } catch {}
      }
      try {
        await client.close();
      } catch {}
    },
  };
}

function connectFailure(e: unknown): TestFailure {
  return { ok: false, error: msg(e), detail: e instanceof ConnectError ? e.detail : undefined };
}

export async function openSession(server: DiscoveredServer, timeoutMs = 20000, onClosed?: () => void): Promise<SessionResult> {
  let connection: Connection;
  try {
    connection = await connect(server, timeoutMs, onClosed);
  } catch (e) {
    return connectFailure(e);
  }
  const { client, capabilities } = connection;
  try {
    const [tools, resources, resourceTemplates, prompts] = await Promise.all([
      capabilities?.tools
        ? safeList(async () => (await client.listTools(undefined, { timeout: timeoutMs })).tools.map(toSummary))
        : Promise.resolve([] as ToolSummary[]),
      capabilities?.resources
        ? safeList(async () => (await client.listResources(undefined, { timeout: timeoutMs })).resources.map(toResourceSummary))
        : Promise.resolve([] as ResourceSummary[]),
      capabilities?.resources
        ? safeList(async () => (await client.listResourceTemplates(undefined, { timeout: timeoutMs })).resourceTemplates.map(toResourceTemplateSummary))
        : Promise.resolve([] as ResourceTemplateSummary[]),
      capabilities?.prompts
        ? safeList(async () => (await client.listPrompts(undefined, { timeout: timeoutMs })).prompts.map(toPromptSummary))
        : Promise.resolve([] as PromptSummary[]),
    ]);
    const serverInfo = client.getServerVersion();
    const info: TestSuccess = {
      ok: true,
      serverInfo: serverInfo ? { name: serverInfo.name, version: serverInfo.version } : undefined,
      instructions: client.getInstructions(),
      capabilities,
      tools,
      resources,
      resourceTemplates,
      prompts,
    };
    const session: McpSession = {
      info,
      async callTool(name, args) {
        try {
          const res = await client.callTool(
            { name, arguments: (args ?? {}) as Record<string, unknown> },
            undefined,
            { timeout: timeoutMs, resetTimeoutOnProgress: true, maxTotalTimeout: CALL_TOOL_MAX_TIMEOUT, onprogress: () => {} },
          );
          return {
            ok: true,
            isError: res.isError === true,
            content: Array.isArray(res.content) ? res.content : [],
            structuredContent: res.structuredContent,
          };
        } catch (e) {
          return { ok: false, error: msg(e), detail: failureDetail(e, connection.stderrTail()) };
        }
      },
      async readResource(uri) {
        try {
          const res = await client.readResource({ uri }, { timeout: timeoutMs });
          return { ok: true, contents: Array.isArray(res.contents) ? res.contents : [] };
        } catch (e) {
          return { ok: false, error: msg(e), detail: failureDetail(e, connection.stderrTail()) };
        }
      },
      async getPrompt(name, args) {
        try {
          const res = await client.getPrompt({ name, arguments: args }, { timeout: timeoutMs });
          return {
            ok: true,
            description: typeof res.description === "string" ? res.description : undefined,
            messages: Array.isArray(res.messages) ? res.messages : [],
          };
        } catch (e) {
          return { ok: false, error: msg(e), detail: failureDetail(e, connection.stderrTail()) };
        }
      },
      async dispose() {
        await connection.close();
      },
    };
    return { ok: true, session };
  } catch (e) {
    await connection.close();
    return { ok: false, error: msg(e), detail: failureDetail(e, connection.stderrTail()) };
  }
}

export async function probe(server: DiscoveredServer, timeoutMs = 10000): Promise<ProbeResult> {
  const started = Date.now();
  let connection: Connection;
  try {
    connection = await connect(server, timeoutMs);
  } catch (e) {
    const failure = connectFailure(e);
    return { ok: false, latencyMs: Date.now() - started, error: failure.error, detail: failure.detail };
  }
  const latencyMs = Date.now() - started;
  try {
    const toolCount = connection.capabilities?.tools
      ? (await connection.client.listTools(undefined, { timeout: timeoutMs })).tools.length
      : 0;
    return { ok: true, latencyMs, toolCount };
  } catch (e) {
    return { ok: false, latencyMs, error: msg(e), detail: failureDetail(e, connection.stderrTail()) };
  } finally {
    await connection.close();
  }
}

export async function testServer(server: DiscoveredServer, timeoutMs = 20000): Promise<TestResult> {
  const opened = await openSession(server, timeoutMs);
  if (!opened.ok) {
    return opened;
  }
  try {
    return opened.session.info;
  } finally {
    await opened.session.dispose();
  }
}

export function createTransport(server: DiscoveredServer) {
  const t = server.transport;
  const substitute = (value: string) => expandEnv(replaceEditorVariables(value, server.projectDir));
  if (t.kind === "stdio") {
    if (!t.command.trim()) {
      throw new Error("This server has no command to launch.");
    }
    return new StdioClientTransport({
      command: substitute(t.command),
      args: t.args.map(substitute),
      env: mapValues(t.env, substitute),
      cwd: resolveCwd(server.projectDir),
      stderr: "pipe",
    });
  }
  const url = new URL(substitute(t.url));
  const requestInit = { headers: mapValues(t.headers, substitute) };
  return t.kind === "sse"
    ? new SSEClientTransport(url, { requestInit })
    : new StreamableHTTPClientTransport(url, { requestInit });
}

function replaceEditorVariables(value: string, projectDir: string | undefined): string {
  return value
    .replace(/\$\{workspaceFolder\}/g, () => projectDir ?? "")
    .replace(/\$\{userHome\}/g, () => os.homedir());
}

function resolveCwd(dir: string | undefined): string | undefined {
  if (!dir) {
    return undefined;
  }
  try {
    return fs.statSync(dir).isDirectory() ? dir : undefined;
  } catch {
    return undefined;
  }
}

function expandEnv(value: string): string {
  return value.replace(/\$\{(?:env:)?([A-Z0-9_()]+)\}/gi, (_whole, name: string) => {
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

async function safeList<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch {
    return [];
  }
}

function toResourceSummary(r: { uri: string; name?: string; title?: string; description?: string; mimeType?: string }): ResourceSummary {
  return { uri: r.uri, name: r.name, title: r.title, description: r.description, mimeType: r.mimeType };
}

function toResourceTemplateSummary(t: { uriTemplate: string; name?: string; title?: string; description?: string; mimeType?: string }): ResourceTemplateSummary {
  return { uriTemplate: t.uriTemplate, name: t.name, title: t.title, description: t.description, mimeType: t.mimeType };
}

function toPromptSummary(p: { name: string; title?: string; description?: string; arguments?: { name: string; description?: string; required?: boolean }[] }): PromptSummary {
  return {
    name: p.name,
    title: p.title,
    description: p.description,
    arguments: Array.isArray(p.arguments) ? p.arguments.map((a) => ({ name: a.name, description: a.description, required: a.required })) : [],
  };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function failureDetail(e: unknown, stderr: string): string | undefined {
  const parts: string[] = [];
  const code = e instanceof Error ? (e as NodeJS.ErrnoException).code : undefined;
  if (code) {
    parts.push(String(code));
  }
  if (code === "ENOENT" || /\[protocol\][^\n]*\bspawn\b[^\n]*\bENOENT\b/i.test(stderr)) {
    parts.push(
      "The command could not be found on this editor's PATH. Editors launched from the GUI don't inherit your shell's PATH, so a bare launcher like \"npx\" or \"node\" can fail here even though it works in a terminal. Point the config at an absolute path to the executable.",
    );
  }
  const tail = stderr.trim();
  if (tail) {
    parts.push(tail.length > 1000 ? tail.slice(-1000) : tail);
  }
  return parts.length ? parts.join("\n\n") : undefined;
}
