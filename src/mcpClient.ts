import { spawnSync } from "child_process";
import { StringDecoder } from "string_decoder";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { DEFAULT_INHERITED_ENV_VARS, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError, Tool } from "@modelcontextprotocol/sdk/types.js";
import { editorFor, inheritsEnvironment } from "./editors";
import { spawnableCommand } from "./executable";
import { mapValues, planStdioLaunch } from "./launchPlan";
import { substituteVariables, variableScope } from "./substitution";
import { DiscoveredServer, InputValues, McpTransport } from "./types";

const CLIENT_NAME = "mcp-workbench";
const CLIENT_VERSION = "0.4.9";
const STDERR_CAP = 8192;
const CALL_TOOL_MAX_TIMEOUT = 300000;
const TERMINATE_TIMEOUT = 5000;
const MAX_LIST_PAGES = 50;
const MAX_LIST_ITEMS = 2000;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const EDITOR_HOST_ONLY_VARIABLES = new Set(["ELECTRON_RUN_AS_NODE"]);
const TASKKILL_TIMEOUT = 5000;
const DOWNLOADING_LAUNCHER = /(?:^|[\\/])(?:npx|bunx|uvx|pnpm|yarn)(?:\.cmd|\.exe)?$/i;
const LAUNCHER_TIMEOUT_HINT =
  "Launchers like npx download the package on the first run, which can take longer than the test allows. Run the command once in a terminal, then test again.";

const SDK_DEFAULT_SPELLING = new Map(DEFAULT_INHERITED_ENV_VARS.map((name) => [name.toUpperCase(), name]));

type TransportKind = McpTransport["kind"];
type ListName = "tools" | "resources" | "resourceTemplates" | "prompts";

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

export interface ListProblem {
  error?: string;
  truncated: boolean;
}

export interface TestSuccess {
  ok: true;
  serverInfo?: { name: string; version: string };
  instructions?: string;
  capabilities: unknown;
  connectedOver: TransportKind;
  tools: ToolSummary[];
  resources: ResourceSummary[];
  resourceTemplates: ResourceTemplateSummary[];
  prompts: PromptSummary[];
  listProblems: Partial<Record<ListName, ListProblem>>;
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
  connectedOver?: TransportKind;
  toolCount?: number;
  toolsTruncated?: boolean;
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

interface SessionOptions {
  onClosed?: () => void;
  inputs?: InputValues;
}

type McpClientTransport = StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport;

class ConnectError extends Error {
  readonly detail?: string;
  readonly httpStatus?: number;
  constructor(message: string, detail?: string, httpStatus?: number) {
    super(message);
    this.detail = detail;
    this.httpStatus = httpStatus;
  }
}

interface Connection {
  client: Client;
  capabilities: ReturnType<Client["getServerCapabilities"]>;
  connectedOver: TransportKind;
  stderrTail(): string;
  close(): Promise<void>;
}

interface Page<T> {
  items: T[];
  nextCursor?: string;
}

interface Listing<T> {
  items: T[];
  truncated: boolean;
  failure?: unknown;
}

type PageFetcher<T> = (client: Client, cursor: string | undefined, timeoutMs: number) => Promise<Page<T>>;

async function connect(server: DiscoveredServer, timeoutMs: number, options: SessionOptions = {}): Promise<Connection> {
  const deadline = Date.now() + timeoutMs;
  const transport = createTransport(server, options.inputs);
  try {
    return await attempt(transport, server.transport.kind, timeoutMs, options.onClosed);
  } catch (e) {
    const remaining = deadline - Date.now();
    if (server.transport.kind !== "http" || !refusedStreamableHttp(e) || remaining <= 0) {
      throw withLauncherHint(e, server);
    }
    try {
      return await attempt(createTransport(server, options.inputs, "sse"), "sse", remaining, options.onClosed);
    } catch (fallbackError) {
      throw new ConnectError(msg(e), sseFallbackDetail(e, fallbackError));
    }
  }
}

async function attempt(transport: McpClientTransport, kind: TransportKind, timeoutMs: number, onClosed?: () => void): Promise<Connection> {
  const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION }, { capabilities: {} });
  let stderr = "";
  let closing = false;
  let exited = false;
  client.onerror = (e) => {
    stderr = (stderr + `[protocol] ${msg(e)}\n`).slice(-STDERR_CAP);
  };
  transport.onclose = () => {
    exited = true;
  };
  const connecting = client.connect(transport, { timeout: timeoutMs });
  const pid = transport instanceof StdioClientTransport ? transport.pid : null;
  const killTree = () => {
    if (!exited) {
      killProcessTree(pid);
    }
  };
  try {
    if (transport instanceof StdioClientTransport && transport.stderr) {
      const decoder = new StringDecoder("utf8");
      transport.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + decoder.write(chunk)).slice(-STDERR_CAP);
      });
    }
    await withTimeout(connecting, timeoutMs, `Timed out after ${seconds(timeoutMs)}s while connecting to the server.`);
  } catch (e) {
    killTree();
    try {
      await client.close();
    } catch {}
    const refusedBeforeInitialize = e instanceof StreamableHTTPError && !client.getServerVersion();
    throw new ConnectError(msg(e), failureDetail(e, stderr), refusedBeforeInitialize ? e.code : undefined);
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
    connectedOver: kind,
    stderrTail: () => stderr,
    async close() {
      closing = true;
      killTree();
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

function killProcessTree(pid: number | null): void {
  if (process.platform !== "win32" || !pid) {
    return;
  }
  try {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, timeout: TASKKILL_TIMEOUT });
  } catch {}
}

function withLauncherHint(e: unknown, server: DiscoveredServer): unknown {
  const t = server.transport;
  const timedOut = e instanceof ConnectError && /timed out/i.test(e.message);
  if (!timedOut || t.kind !== "stdio" || !DOWNLOADING_LAUNCHER.test(t.command.trim())) {
    return e;
  }
  return new ConnectError(e.message, [LAUNCHER_TIMEOUT_HINT, e.detail].filter(Boolean).join("\n\n"), e.httpStatus);
}

export function fellBackToSse(server: DiscoveredServer, connectedOver: TransportKind | undefined): boolean {
  return connectedOver === "sse" && server.transport.kind === "http";
}

function refusedStreamableHttp(e: unknown): boolean {
  const status = e instanceof ConnectError ? e.httpStatus : undefined;
  return status !== undefined && status >= 400 && status < 500 && status !== HTTP_UNAUTHORIZED && status !== HTTP_FORBIDDEN;
}

function sseFallbackDetail(first: unknown, fallback: unknown): string {
  const firstDetail = first instanceof ConnectError ? first.detail : undefined;
  const fallbackDetail = fallback instanceof ConnectError ? fallback.detail : undefined;
  return [
    `The server refused Streamable HTTP, so the tester retried over SSE the way editors do. That failed too: ${msg(fallback)}`,
    fallbackDetail,
    firstDetail,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function connectFailure(e: unknown): TestFailure {
  return { ok: false, error: msg(e), detail: e instanceof ConnectError ? e.detail : undefined };
}

export async function openSession(server: DiscoveredServer, timeoutMs = 20000, options: SessionOptions = {}): Promise<SessionResult> {
  let connection: Connection;
  try {
    connection = await connect(server, timeoutMs, options);
  } catch (e) {
    return connectFailure(e);
  }
  const { client, capabilities } = connection;
  const requestOptions = { timeout: timeoutMs };
  try {
    const [tools, resources, resourceTemplates, prompts] = await Promise.all([
      listIf(capabilities?.tools, client, toolPage, timeoutMs),
      listIf(capabilities?.resources, client, resourcePage, timeoutMs),
      listIf(capabilities?.resources, client, templatePage, timeoutMs),
      listIf(capabilities?.prompts, client, promptPage, timeoutMs),
    ]);
    if (capabilities?.tools) {
      cacheOutputSchemasFromAllPages(client, tools.items);
    }
    const serverInfo = client.getServerVersion();
    const info: TestSuccess = {
      ok: true,
      serverInfo: serverInfo ? { name: serverInfo.name, version: serverInfo.version } : undefined,
      instructions: client.getInstructions(),
      capabilities,
      connectedOver: connection.connectedOver,
      tools: tools.items.map(toSummary),
      resources: resources.items,
      resourceTemplates: resourceTemplates.items,
      prompts: prompts.items,
      listProblems: listProblems({ tools, resources, resourceTemplates, prompts }),
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
          const res = await client.readResource({ uri }, requestOptions);
          return { ok: true, contents: Array.isArray(res.contents) ? res.contents : [] };
        } catch (e) {
          return { ok: false, error: msg(e), detail: failureDetail(e, connection.stderrTail()) };
        }
      },
      async getPrompt(name, args) {
        try {
          const res = await client.getPrompt({ name, arguments: args }, requestOptions);
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

export async function probe(server: DiscoveredServer, timeoutMs = 10000, inputs?: InputValues): Promise<ProbeResult> {
  const started = Date.now();
  let connection: Connection;
  try {
    connection = await connect(server, timeoutMs, { inputs });
  } catch (e) {
    const failure = connectFailure(e);
    return { ok: false, latencyMs: Date.now() - started, error: failure.error, detail: failure.detail };
  }
  const latencyMs = Date.now() - started;
  const { client, capabilities, connectedOver } = connection;
  try {
    const tools = await listIf(capabilities?.tools, client, toolPage, timeoutMs);
    if (tools.failure !== undefined) {
      return { ok: false, latencyMs, connectedOver, error: msg(tools.failure), detail: failureDetail(tools.failure, connection.stderrTail()) };
    }
    return { ok: true, latencyMs, connectedOver, toolCount: tools.items.length, toolsTruncated: tools.truncated };
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

export function createTransport(server: DiscoveredServer, inputs?: InputValues, remoteKind?: "http" | "sse"): McpClientTransport {
  const scope = variableScope(server, inputs);
  const t = server.transport;
  if (t.kind === "stdio") {
    if (!t.command.trim()) {
      throw new Error("This server has no command to launch.");
    }
    const plan = planStdioLaunch(t, scope, "throw");
    if (plan.command.includes("${")) {
      throw new Error(`MCP Workbench won't run "${plan.command}" because it still contains "\${" after variables are filled in.`);
    }
    return new StdioClientTransport({
      command: spawnableCommand(plan.command, plan.executable, plan.cwd),
      args: plan.args,
      env: serverEnvironment(server, plan.env),
      cwd: plan.cwd,
      stderr: "pipe",
    });
  }
  const substitute = (value: string) => substituteVariables(value, scope, "throw");
  const url = new URL(substitute(t.url));
  const requestInit = { headers: mapValues(t.headers, substitute) };
  return (remoteKind ?? t.kind) === "sse"
    ? new SSEClientTransport(url, { requestInit })
    : new StreamableHTTPClientTransport(url, { requestInit });
}

function serverEnvironment(server: DiscoveredServer, configured: Record<string, string>): Record<string, string> {
  const editor = editorFor(server.source);
  if (!inheritsEnvironment(editor)) {
    return layerEnvironments([configured]);
  }
  return layerEnvironments([hostEnvironment(), editorProvidedEnvironment(server), configured]);
}

function editorProvidedEnvironment(server: DiscoveredServer): Record<string, string> {
  if (editorFor(server.source) !== "claude-code") {
    return {};
  }
  return server.projectDir ? { CLAUDECODE: "1", CLAUDE_PROJECT_DIR: server.projectDir } : { CLAUDECODE: "1" };
}

function hostEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !EDITOR_HOST_ONLY_VARIABLES.has(key.toUpperCase())) {
      env[key] = value;
    }
  }
  return env;
}

function layerEnvironments(layers: Record<string, string>[]): Record<string, string> {
  if (process.platform !== "win32") {
    return Object.assign({}, ...layers);
  }
  const byName = new Map<string, [string, string]>();
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      const name = key.toUpperCase();
      byName.set(name, [SDK_DEFAULT_SPELLING.get(name) ?? key, value]);
    }
  }
  return Object.fromEntries(byName.values());
}

function listIf<T>(supported: unknown, client: Client, fetchPage: PageFetcher<T>, timeoutMs: number): Promise<Listing<T>> {
  return supported ? listAll(client, fetchPage, timeoutMs) : Promise.resolve({ items: [], truncated: false });
}

async function listAll<T>(client: Client, fetchPage: PageFetcher<T>, timeoutMs: number): Promise<Listing<T>> {
  const deadline = Date.now() + timeoutMs;
  const items: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let overflowed = false;
  try {
    for (let page = 0; page < MAX_LIST_PAGES && items.length < MAX_LIST_ITEMS; page++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Listing took longer than ${seconds(timeoutMs)}s, so it stopped early.`);
      }
      const result = await fetchPage(client, cursor, remaining);
      const room = MAX_LIST_ITEMS - items.length;
      items.push(...result.items.slice(0, room));
      overflowed = result.items.length > room;
      cursor = result.nextCursor || undefined;
      if (!cursor || overflowed) {
        break;
      }
      if (seenCursors.has(cursor)) {
        throw new Error("The server sent the same page cursor twice, so listing stopped.");
      }
      seenCursors.add(cursor);
    }
  } catch (e) {
    return { items, truncated: false, failure: e };
  }
  return { items, truncated: overflowed || cursor !== undefined };
}

async function toolPage(client: Client, cursor: string | undefined, timeoutMs: number): Promise<Page<Tool>> {
  const page = await client.listTools(cursorParams(cursor), { timeout: timeoutMs });
  return { items: page.tools, nextCursor: page.nextCursor };
}

async function resourcePage(client: Client, cursor: string | undefined, timeoutMs: number): Promise<Page<ResourceSummary>> {
  return emptyIfUnimplemented(async () => {
    const page = await client.listResources(cursorParams(cursor), { timeout: timeoutMs });
    return { items: page.resources.map(toResourceSummary), nextCursor: page.nextCursor };
  });
}

async function templatePage(client: Client, cursor: string | undefined, timeoutMs: number): Promise<Page<ResourceTemplateSummary>> {
  return emptyIfUnimplemented(async () => {
    const page = await client.listResourceTemplates(cursorParams(cursor), { timeout: timeoutMs });
    return { items: page.resourceTemplates.map(toResourceTemplateSummary), nextCursor: page.nextCursor };
  });
}

async function emptyIfUnimplemented<T>(fetchPage: () => Promise<Page<T>>): Promise<Page<T>> {
  try {
    return await fetchPage();
  } catch (e) {
    if (e instanceof McpError && e.code === ErrorCode.MethodNotFound) {
      return { items: [] };
    }
    throw e;
  }
}

async function promptPage(client: Client, cursor: string | undefined, timeoutMs: number): Promise<Page<PromptSummary>> {
  const page = await client.listPrompts(cursorParams(cursor), { timeout: timeoutMs });
  return { items: page.prompts.map(toPromptSummary), nextCursor: page.nextCursor };
}

function cacheOutputSchemasFromAllPages(client: Client, tools: Tool[]): void {
  client["cacheToolMetadata"](tools);
}

function cursorParams(cursor: string | undefined): { cursor: string } | undefined {
  return cursor ? { cursor } : undefined;
}

function listProblems(listings: Record<ListName, Listing<unknown>>): Partial<Record<ListName, ListProblem>> {
  const problems: Partial<Record<ListName, ListProblem>> = {};
  for (const [name, listing] of Object.entries(listings) as [ListName, Listing<unknown>][]) {
    if (listing.failure !== undefined || listing.truncated) {
      problems[name] = { error: listing.failure === undefined ? undefined : msg(listing.failure), truncated: listing.truncated };
    }
  }
  return problems;
}

function seconds(ms: number): number {
  return Math.max(1, Math.round(ms / 1000));
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function toSummary(tool: { name: string; description?: string; inputSchema: unknown }): ToolSummary {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
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
  if (typeof code === "string" && code) {
    parts.push(code);
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
