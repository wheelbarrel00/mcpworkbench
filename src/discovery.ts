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
    const args: string[] = Array.isArray(entry.args) ? entry.args.map(String) : [];
    const env: Record<string, string> = entry.env && typeof entry.env === "object" ? entry.env : {};

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
    const headers: Record<string, string> = entry.headers && typeof entry.headers === "object" ? entry.headers : {};
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
  for (const value of Object.values(obj)) {
    if (typeof value !== "string") continue;
    for (const m of value.matchAll(/\$\{(?:env:)?([A-Z0-9_]+)\}/gi)) {
      const name = m[1];
      if (process.env[name] === undefined) {
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

function scanPath(loc: ConfigLocation, p: string | undefined): ScannedFile {
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

  const blocks = collectBlocks(loc, parsed);
  if (blocks.length === 0) {
    const otherKey = loc.rootKey === "servers" ? "mcpServers" : "servers";
    const hint = parsed?.[otherKey]
      ? ` Found "${otherKey}" instead — this editor expects "${loc.rootKey}".`
      : "";
    result.fileIssues.push({
      level: "error",
      code: "missing-root-key",
      message: `No "${loc.rootKey}" object at the top level; no servers will load.${hint}`,
    });
    return result;
  }

  for (const { entries, scope } of blocks) {
    for (const [name, entry] of Object.entries(entries)) {
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
  return result;
}

interface ServerBlock {
  entries: Record<string, unknown>;
  scope?: string;
}

function collectBlocks(loc: ConfigLocation, parsed: any): ServerBlock[] {
  const blocks: ServerBlock[] = [];
  const main = parsed?.[loc.rootKey];
  if (main && typeof main === "object") {
    blocks.push({ entries: main });
  }
  if (loc.includeProjects && parsed?.projects && typeof parsed.projects === "object") {
    for (const [projectPath, projectConfig] of Object.entries<any>(parsed.projects)) {
      const projectServers = projectConfig?.mcpServers;
      if (projectServers && typeof projectServers === "object") {
        blocks.push({ entries: projectServers, scope: projectPath });
      }
    }
  }
  return blocks;
}

export function discoverAll(workspaceFolders: string[]): ScannedFile[] {
  const files: ScannedFile[] = [];
  for (const loc of LOCATIONS) {
    if (loc.scoped === "global") {
      files.push(scanPath(loc, loc.resolve()));
    } else {
      for (const ws of workspaceFolders) {
        const file = scanPath(loc, loc.resolve(ws));
        file.workspaceFolder = ws;
        files.push(file);
      }
    }
  }
  return files;
}

export function flattenServers(files: ScannedFile[]): DiscoveredServer[] {
  return files.flatMap((f) => f.servers);
}
