import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import type { ParseError } from "jsonc-parser";
import {
  ConfigIssue,
  DiscoveredServer,
  JsonPath,
  McpSource,
  McpTransport,
  ScannedFile,
} from "./types";

interface ConfigLocation {
  source: McpSource;
  rootKey: "servers" | "mcpServers";
  resolve: (workspaceFolder?: string) => string | undefined;
  scoped: "global" | "workspace";
  includeProjects?: boolean;
}

const home = os.homedir();

const LOCATIONS: ConfigLocation[] = [
  { source: "cursor-global", rootKey: "mcpServers", scoped: "global",
    resolve: () => path.join(home, ".cursor", "mcp.json") },
  { source: "cursor-workspace", rootKey: "mcpServers", scoped: "workspace",
    resolve: (ws) => (ws ? path.join(ws, ".cursor", "mcp.json") : undefined) },

  { source: "vscode-workspace", rootKey: "servers", scoped: "workspace",
    resolve: (ws) => (ws ? path.join(ws, ".vscode", "mcp.json") : undefined) },

  { source: "claude-code-workspace", rootKey: "mcpServers", scoped: "workspace",
    resolve: (ws) => (ws ? path.join(ws, ".mcp.json") : undefined) },
  { source: "claude-code-user", rootKey: "mcpServers", scoped: "global", includeProjects: true,
    resolve: () => path.join(home, ".claude.json") },

  { source: "claude-desktop", rootKey: "mcpServers", scoped: "global",
    resolve: () => path.join(home, ".claude", "claude_desktop_config.json") },
];

const BYTE_ORDER_MARK = 0xfeff;

class JsonParseError extends Error {
  constructor(message: string, readonly offset: number) {
    super(message);
  }
}

function parseLoose(text: string): unknown {
  const source = text.charCodeAt(0) === BYTE_ORDER_MARK ? text.slice(1) : text;
  const errors: ParseError[] = [];
  const value = parseJsonc(source, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new JsonParseError(describeParseError(source, errors[0]), errors[0].offset);
  }
  return value;
}

function describeParseError(text: string, error: ParseError): string {
  const before = text.slice(0, error.offset);
  const line = before.split("\n").length;
  const column = error.offset - before.lastIndexOf("\n");
  return `${printParseErrorCode(error.error)} at line ${line}, column ${column}`;
}

function normalizeTransport(entry: any): {
  transport: McpTransport | undefined;
  issues: ConfigIssue[];
} {
  const issues: ConfigIssue[] = [];

  if (typeof entry?.command === "string") {
    const args = stringArgs(entry.args, issues);
    const env = stringRecord(entry.env, "env var", ["env"], issues);
    const rawArgs: unknown[] = Array.isArray(entry.args) ? entry.args : [];

    if (!entry.command.trim()) {
      issues.push({ level: "error", code: "empty-command", message: "stdio server has an empty command.", path: ["command"] });
    }
    if (/(^|\/)npx$/.test(entry.command) && !args.includes("-y") && !args.includes("--yes")) {
      issues.push({
        level: "warning",
        code: "npx-missing-y",
        message: "npx without -y/--yes can hang waiting for an install prompt. Add \"-y\" to args.",
        path: ["command"],
      });
    }
    addUnpinnedLauncherIssue(entry.command, args, issues);
    rawArgs.forEach((arg, i) => {
      if (typeof arg !== "string") {
        return;
      }
      addShellInjectionIssue(arg, i, issues);
      addSecretIssue(arg, ["args", i], issues);
    });
    if (isEncodedPowerShell(entry.command, args)) {
      const idx = rawArgs.findIndex((a) => typeof a === "string" && /^-e(nc(odedcommand)?)?$/i.test(a));
      issues.push({
        level: "warning",
        code: "encoded-powershell",
        message: "PowerShell is invoked with an encoded command (-enc); encoded payloads hide what runs. Review it before trusting this server.",
        path: idx >= 0 ? ["args", idx] : ["command"],
      });
    }
    for (const [key, value] of Object.entries(env)) {
      addSecretIssue(value, ["env", key], issues);
    }
    issues.push(...missingEnvIssues(env, ["env"]));
    return { transport: { kind: "stdio", command: entry.command, args, env }, issues };
  }

  if (typeof entry?.url === "string") {
    const headers = stringRecord(entry.headers, "header", ["headers"], issues);
    const t = String(entry.type ?? "").toLowerCase();
    const kind: "http" | "sse" = t === "sse" ? "sse" : "http";
    issues.push(...urlIssues(entry.url));
    for (const [key, value] of Object.entries(headers)) {
      addSecretIssue(value, ["headers", key], issues);
    }
    issues.push(...missingEnvIssues(headers, ["headers"]));
    return { transport: { kind, url: entry.url, headers }, issues };
  }

  issues.push({
    level: "error",
    code: "unknown-transport",
    message: "Entry has neither a `command` (stdio) nor a `url` (http/sse).",
  });
  return { transport: undefined, issues };
}

function baseCommandName(command: string): string {
  const file = command.replace(/\\/g, "/").split("/").pop() ?? command;
  return file.replace(/\.(cmd|exe|bat|ps1)$/i, "").toLowerCase();
}

const PIN_LAUNCHERS = new Set(["npx", "bunx"]);

function addUnpinnedLauncherIssue(command: string, args: string[], issues: ConfigIssue[]): void {
  const base = baseCommandName(command);
  let pkgArgs = args;
  let launcher = "";
  if (PIN_LAUNCHERS.has(base)) {
    launcher = base;
  } else if ((base === "pnpm" || base === "yarn") && args[0] === "dlx") {
    launcher = `${base} dlx`;
    pkgArgs = args.slice(1);
  } else if (base === "npm" && args[0] === "exec") {
    launcher = "npm exec";
    pkgArgs = args.slice(1);
  } else {
    return;
  }
  const pkg = firstPackageToken(pkgArgs);
  if (!pkg || /^[.\/~]/.test(pkg) || /@\d/.test(pkg)) {
    return;
  }
  issues.push({
    level: "info",
    code: "unpinned-launcher",
    message: `${launcher} runs "${pkg}" without a pinned version; a future release could change behavior. Pin it as ${pkg}@<version>.`,
    path: ["command"],
  });
}

function firstPackageToken(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--" || a === "--package" || a === "-p") {
      return args[i + 1];
    }
    if (a.startsWith("-")) {
      continue;
    }
    return a;
  }
  return undefined;
}

const SHELL_PIPE = /\b(?:curl|wget|iwr|invoke-webrequest)\b[\s\S]*\|\s*(?:sh|bash|zsh|dash|pwsh|powershell)\b/i;

function addShellInjectionIssue(arg: string, index: number, issues: ConfigIssue[]): void {
  if (SHELL_PIPE.test(arg)) {
    issues.push({
      level: "warning",
      code: "risky-shell-pipe",
      message: "Argument pipes a downloaded script straight into a shell; this runs remote code at launch. Review it before trusting this server.",
      path: ["args", index],
    });
  }
}

function isEncodedPowerShell(command: string, args: string[]): boolean {
  const base = baseCommandName(command);
  if (base !== "powershell" && base !== "pwsh") {
    return false;
  }
  return args.some((a) => /^-e(nc(odedcommand)?)?$/i.test(a));
}

const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "OpenAI API key", re: /\bsk-[A-Za-z0-9]{20,}/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "private key", re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
];

function matchSecret(value: string): string | undefined {
  return SECRET_PATTERNS.find((p) => p.re.test(value))?.name;
}

function addSecretIssue(value: string, path: JsonPath, issues: ConfigIssue[]): void {
  if (value.includes("${")) {
    return;
  }
  const name = matchSecret(value);
  if (name) {
    issues.push({
      level: "warning",
      code: "hardcoded-secret",
      message: `Looks like a hardcoded ${name}; store it in an environment variable and reference it as \${VAR} instead of committing the literal.`,
      path,
    });
  }
}

const SENSITIVE_URL_PARAMS = ["token", "secret", "apikey", "api_key", "access_token", "key", "password", "auth"];

function urlIssues(rawUrl: string): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return issues;
  }
  const host = url.hostname.toLowerCase();
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");

  if (url.protocol === "http:" && !isLocal) {
    issues.push({
      level: "warning",
      code: "insecure-remote-transport",
      message: "Uses http:// to a non-local host, so traffic and any credentials travel unencrypted. Prefer https://.",
      path: ["url"],
    });
  }
  if (url.username || url.password) {
    issues.push({
      level: "warning",
      code: "credential-in-url",
      message: "URL embeds credentials (user:password@…); these are easily leaked in logs. Move them to the headers field.",
      path: ["url"],
    });
  } else {
    const param = SENSITIVE_URL_PARAMS.find((p) => url.searchParams.has(p));
    if (param) {
      issues.push({
        level: "warning",
        code: "credential-in-url",
        message: `URL query string includes a "${param}" parameter; secrets in URLs are easily leaked. Move it to the headers field.`,
        path: ["url"],
      });
    }
  }
  if (host === "169.254.169.254") {
    issues.push({
      level: "warning",
      code: "metadata-endpoint",
      message: "URL targets the cloud metadata address (169.254.169.254), a common SSRF target. Confirm this is intentional.",
      path: ["url"],
    });
  }
  return issues;
}

function missingEnvIssues(obj: Record<string, string>, basePath: JsonPath): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(obj)) {
    for (const m of value.matchAll(/\$\{(?:env:)?([A-Z0-9_]+)\}/gi)) {
      const name = m[1];
      if (process.env[name] === undefined && !seen.has(name)) {
        seen.add(name);
        issues.push({
          level: "warning",
          code: "env-unset",
          message: `References environment variable ${name}, which is not set in your environment.`,
          path: [...basePath, key],
        });
      }
    }
  }
  return issues;
}

function stringArgs(value: unknown, issues: ConfigIssue[]): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  value.forEach((item, i) => {
    if (typeof item === "string") {
      out.push(item);
    } else {
      issues.push({ level: "warning", code: "non-string-arg", message: `args[${i}] is not a string and was ignored.`, path: ["args", i] });
    }
  });
  return out;
}

function stringRecord(value: unknown, label: string, basePath: JsonPath, issues: ConfigIssue[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isPlainObject(value)) return out;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      out[key] = item;
    } else {
      issues.push({ level: "warning", code: "non-string-value", message: `${label} "${key}" is not a string and was ignored.`, path: [...basePath, key] });
    }
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePath(p: string): string {
  return p.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
}

const SECURITY_CODES = new Set([
  "hardcoded-secret",
  "credential-in-url",
  "insecure-remote-transport",
  "risky-shell-pipe",
  "encoded-powershell",
  "metadata-endpoint",
  "unpinned-launcher",
]);

function applySecurityPolicy(issues: ConfigIssue[], ctx: ScanContext): ConfigIssue[] {
  const out: ConfigIssue[] = [];
  for (const issue of issues) {
    if (!SECURITY_CODES.has(issue.code)) {
      out.push(issue);
      continue;
    }
    if (!ctx.securityEnabled) {
      continue;
    }
    const override = ctx.ruleSeverity[issue.code];
    if (override === "off") {
      continue;
    }
    if (override === "info" || override === "warning" || override === "error") {
      issue.level = override;
    }
    out.push(issue);
  }
  return out;
}

function scanPath(loc: ConfigLocation, p: string | undefined, ctx: ScanContext): ScannedFile {
  const result: ScannedFile = {
    path: p ?? "(unresolved)",
    source: loc.source,
    exists: false,
    fileIssues: [],
    servers: [],
  };
  if (!p || !fs.existsSync(p)) return result;
  result.exists = true;

  let parsed: any;
  try {
    parsed = parseLoose(fs.readFileSync(p, "utf8"));
  } catch (e) {
    result.fileIssues.push({
      level: "error",
      code: "bad-json",
      message: `Could not parse JSON: ${(e as Error).message}`,
      offset: e instanceof JsonParseError ? e.offset : undefined,
    });
    return result;
  }

  const blocks = collectBlocks(loc, parsed, ctx);
  const mainPresent = isPlainObject(parsed?.[loc.rootKey]);
  const hasProjects = !!loc.includeProjects && isPlainObject(parsed?.projects);

  if (blocks.length === 0) {
    if (hasProjects) {
      if (!ctx.showAllClaudeProjects) {
        result.fileIssues.push({
          level: "info",
          code: "projects-filtered",
          message: `No servers recorded for this workspace. Enable "MCP Workbench: Show All Claude Projects" to list servers from your other projects.`,
        });
      }
      return result;
    }
    const otherKey = loc.rootKey === "servers" ? "mcpServers" : "servers";
    const hint = isPlainObject(parsed?.[otherKey])
      ? ` Found "${otherKey}" instead — this editor expects "${loc.rootKey}".`
      : "";
    result.fileIssues.push({
      level: "error",
      code: "missing-root-key",
      message: `No "${loc.rootKey}" object at the top level; no servers will load.${hint}`,
    });
    return result;
  }

  let total = 0;
  for (const { entries, scope, basePath } of blocks) {
    for (const [name, entry] of Object.entries(entries)) {
      total++;
      const { transport, issues } = normalizeTransport(entry);
      const serverPath: JsonPath = [...basePath, name];
      for (const issue of issues) {
        issue.path = issue.path ? [...serverPath, ...issue.path] : serverPath;
      }
      result.servers.push({
        name,
        transport: transport ?? { kind: "stdio", command: "", args: [], env: {} },
        source: loc.source,
        configPath: p,
        rootKey: loc.rootKey,
        scope,
        raw: entry,
        issues: applySecurityPolicy(issues, ctx),
      });
    }
  }

  if (total === 0 && mainPresent) {
    result.fileIssues.push({
      level: "warning",
      code: "empty-root-key",
      message: `"${loc.rootKey}" is present but defines no servers.`,
      path: [loc.rootKey],
    });
  }
  return result;
}

interface ServerBlock {
  entries: Record<string, unknown>;
  scope?: string;
  basePath: JsonPath;
}

function collectBlocks(loc: ConfigLocation, parsed: any, ctx: ScanContext): ServerBlock[] {
  const blocks: ServerBlock[] = [];
  if (isPlainObject(parsed?.[loc.rootKey])) {
    blocks.push({ entries: parsed[loc.rootKey], basePath: [loc.rootKey] });
  }
  if (loc.includeProjects && isPlainObject(parsed?.projects)) {
    const folders = new Set(ctx.workspaceFolders.map(normalizePath));
    for (const [projectPath, projectConfig] of Object.entries<any>(parsed.projects)) {
      if (!ctx.showAllClaudeProjects && !folders.has(normalizePath(projectPath))) {
        continue;
      }
      if (isPlainObject(projectConfig?.mcpServers)) {
        blocks.push({ entries: projectConfig.mcpServers, scope: projectPath, basePath: ["projects", projectPath, "mcpServers"] });
      }
    }
  }
  return blocks;
}

export interface DiscoverOptions {
  showAllClaudeProjects?: boolean;
  securityEnabled?: boolean;
  ruleSeverity?: Record<string, string>;
}

interface ScanContext {
  workspaceFolders: string[];
  showAllClaudeProjects: boolean;
  securityEnabled: boolean;
  ruleSeverity: Record<string, string>;
}

export function discoverAll(workspaceFolders: string[], options: DiscoverOptions = {}): ScannedFile[] {
  const ctx: ScanContext = {
    workspaceFolders,
    showAllClaudeProjects: options.showAllClaudeProjects ?? false,
    securityEnabled: options.securityEnabled ?? true,
    ruleSeverity: options.ruleSeverity ?? {},
  };
  const files: ScannedFile[] = [];
  for (const loc of LOCATIONS) {
    if (loc.scoped === "global") {
      const file = scanPath(loc, loc.resolve(), ctx);
      assignProjectDir(file);
      files.push(file);
    } else {
      for (const ws of workspaceFolders) {
        const file = scanPath(loc, loc.resolve(ws), ctx);
        file.workspaceFolder = ws;
        assignProjectDir(file, ws);
        files.push(file);
      }
    }
  }
  return files;
}

function assignProjectDir(file: ScannedFile, workspaceFolder?: string): void {
  for (const server of file.servers) {
    server.projectDir = server.scope ?? workspaceFolder;
  }
}

export function flattenServers(files: ScannedFile[]): DiscoveredServer[] {
  return files.flatMap((f) => f.servers);
}
