import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import type { ParseError } from "jsonc-parser";
import {
  ConfigIssue,
  DiscoveredServer,
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

function parseLoose(text: string): unknown {
  const source = text.charCodeAt(0) === BYTE_ORDER_MARK ? text.slice(1) : text;
  const errors: ParseError[] = [];
  const value = parseJsonc(source, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new Error(describeParseError(source, errors[0]));
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
    const env = stringRecord(entry.env, "env var", issues);

    if (!entry.command.trim()) {
      issues.push({ level: "error", code: "empty-command", message: "stdio server has an empty command." });
    }
    if (/(^|\/)npx$/.test(entry.command) && !args.includes("-y") && !args.includes("--yes")) {
      issues.push({
        level: "warning",
        code: "npx-missing-y",
        message: "npx without -y/--yes can hang waiting for an install prompt. Add \"-y\" to args.",
      });
    }
    issues.push(...missingEnvIssues(env));
    return { transport: { kind: "stdio", command: entry.command, args, env }, issues };
  }

  if (typeof entry?.url === "string") {
    const headers = stringRecord(entry.headers, "header", issues);
    const t = String(entry.type ?? "").toLowerCase();
    const kind: "http" | "sse" = t === "sse" ? "sse" : "http";
    issues.push(...missingEnvIssues(headers));
    return { transport: { kind, url: entry.url, headers }, issues };
  }

  issues.push({
    level: "error",
    code: "unknown-transport",
    message: "Entry has neither a `command` (stdio) nor a `url` (http/sse).",
  });
  return { transport: undefined, issues };
}

function missingEnvIssues(obj: Record<string, string>): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const seen = new Set<string>();
  for (const value of Object.values(obj)) {
    for (const m of value.matchAll(/\$\{(?:env:)?([A-Z0-9_]+)\}/gi)) {
      const name = m[1];
      if (process.env[name] === undefined && !seen.has(name)) {
        seen.add(name);
        issues.push({
          level: "warning",
          code: "env-unset",
          message: `References environment variable ${name}, which is not set in your environment.`,
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
      issues.push({ level: "warning", code: "non-string-arg", message: `args[${i}] is not a string and was ignored.` });
    }
  });
  return out;
}

function stringRecord(value: unknown, label: string, issues: ConfigIssue[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isPlainObject(value)) return out;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      out[key] = item;
    } else {
      issues.push({ level: "warning", code: "non-string-value", message: `${label} "${key}" is not a string and was ignored.` });
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
  for (const { entries, scope } of blocks) {
    for (const [name, entry] of Object.entries(entries)) {
      total++;
      const { transport, issues } = normalizeTransport(entry);
      result.servers.push({
        name,
        transport: transport ?? { kind: "stdio", command: "", args: [], env: {} },
        source: loc.source,
        configPath: p,
        rootKey: loc.rootKey,
        scope,
        raw: entry,
        issues,
      });
    }
  }

  if (total === 0 && mainPresent) {
    result.fileIssues.push({
      level: "warning",
      code: "empty-root-key",
      message: `"${loc.rootKey}" is present but defines no servers.`,
    });
  }
  return result;
}

interface ServerBlock {
  entries: Record<string, unknown>;
  scope?: string;
}

function collectBlocks(loc: ConfigLocation, parsed: any, ctx: ScanContext): ServerBlock[] {
  const blocks: ServerBlock[] = [];
  if (isPlainObject(parsed?.[loc.rootKey])) {
    blocks.push({ entries: parsed[loc.rootKey] });
  }
  if (loc.includeProjects && isPlainObject(parsed?.projects)) {
    const folders = new Set(ctx.workspaceFolders.map(normalizePath));
    for (const [projectPath, projectConfig] of Object.entries<any>(parsed.projects)) {
      if (!ctx.showAllClaudeProjects && !folders.has(normalizePath(projectPath))) {
        continue;
      }
      if (isPlainObject(projectConfig?.mcpServers)) {
        blocks.push({ entries: projectConfig.mcpServers, scope: projectPath });
      }
    }
  }
  return blocks;
}

export interface DiscoverOptions {
  showAllClaudeProjects?: boolean;
}

interface ScanContext {
  workspaceFolders: string[];
  showAllClaudeProjects: boolean;
}

export function discoverAll(workspaceFolders: string[], options: DiscoverOptions = {}): ScannedFile[] {
  const ctx: ScanContext = {
    workspaceFolders,
    showAllClaudeProjects: options.showAllClaudeProjects ?? false,
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
