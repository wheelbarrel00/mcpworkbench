import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import type { ParseError } from "jsonc-parser";
import {
  ConfigIssue,
  DiscoveredServer,
  InputDefinition,
  InputOption,
  JsonPath,
  McpSource,
  McpTransport,
  ScannedFile,
} from "./types";
import { EDITOR_NAMES, Editor, editorFor } from "./editors";
import {
  ReferenceMatch,
  expansionSuggestion,
  inputDefinition,
  isEditorVariable,
  isFolderVariable,
  isPromptedInput,
  isUnsetEnvironmentReference,
  variableReferences,
} from "./substitution";

type ConfigScope = "global" | "workspace";

interface ConfigLocation {
  source: McpSource;
  rootKey: "servers" | "mcpServers";
  resolve: (ctx: ScanContext, workspaceFolder?: string) => string | undefined;
  scoped: ConfigScope;
  includeProjects?: boolean;
  serversOptional?: boolean;
  strict?: boolean;
}

const home = os.homedir();

function appDataRoot(): string | undefined {
  if (process.platform === "win32") {
    return process.env.APPDATA;
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support");
  }
  return process.env.XDG_CONFIG_HOME || path.join(home, ".config");
}

export function claudeDesktopConfigPath(): string | undefined {
  const root = appDataRoot();
  return root ? path.join(root, "Claude", "claude_desktop_config.json") : undefined;
}

export function vscodeUserConfigPath(userDir?: string): string | undefined {
  if (userDir) {
    return path.join(userDir, "mcp.json");
  }
  const root = appDataRoot();
  return root ? path.join(root, "Code", "User", "mcp.json") : undefined;
}

const VSCODE_FAMILY_SCHEME = /^(?:vscode|vscodium|code-oss)/;
const LOCAL_STORAGE_SCHEMES = new Set(["file", "vscode-userdata"]);

interface StorageLocation {
  scheme: string;
  fsPath: string;
}

export function vscodeUserDirFromHost(globalStorage: StorageLocation, uriScheme: string): string | undefined {
  if (!VSCODE_FAMILY_SCHEME.test(uriScheme) || !LOCAL_STORAGE_SCHEMES.has(globalStorage.scheme)) {
    return undefined;
  }
  return path.dirname(path.dirname(globalStorage.fsPath)).replace(/^[a-z](?=:)/, (drive) => drive.toUpperCase());
}

const LOCATIONS: ConfigLocation[] = [
  { source: "cursor-global", rootKey: "mcpServers", scoped: "global",
    resolve: () => path.join(home, ".cursor", "mcp.json") },
  { source: "cursor-workspace", rootKey: "mcpServers", scoped: "workspace",
    resolve: (_ctx, ws) => (ws ? path.join(ws, ".cursor", "mcp.json") : undefined) },

  { source: "vscode-workspace", rootKey: "servers", scoped: "workspace",
    resolve: (_ctx, ws) => (ws ? path.join(ws, ".vscode", "mcp.json") : undefined) },
  { source: "vscode-user", rootKey: "servers", scoped: "global",
    resolve: (ctx) => vscodeUserConfigPath(ctx.vscodeUserDir) },

  { source: "claude-code-workspace", rootKey: "mcpServers", scoped: "workspace", strict: true,
    resolve: (_ctx, ws) => (ws ? path.join(ws, ".mcp.json") : undefined) },
  { source: "claude-code-user", rootKey: "mcpServers", scoped: "global", includeProjects: true, serversOptional: true, strict: true,
    resolve: () => path.join(home, ".claude.json") },

  { source: "claude-desktop", rootKey: "mcpServers", scoped: "global",
    resolve: () => claudeDesktopConfigPath() },
];

const BYTE_ORDER_MARK = 0xfeff;

class JsonParseError extends Error {
  constructor(message: string, readonly offset: number) {
    super(message);
  }
}

function parseConfig(text: string, strict: boolean): unknown {
  const source = text.charCodeAt(0) === BYTE_ORDER_MARK ? text.slice(1) : text;
  const errors: ParseError[] = [];
  const value = parseJsonc(source, errors, { allowTrailingComma: !strict, disallowComments: strict });
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

function readConfigText(p: string): string {
  const buf = fs.readFileSync(p);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(buf.subarray(2));
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(buf.subarray(2));
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.toString("utf8", 3);
  }
  return buf.toString("utf8");
}

function normalizeTransport(entry: any, scoped: ConfigScope, file: FileContext): {
  transport: McpTransport | undefined;
  issues: ConfigIssue[];
} {
  const issues: ConfigIssue[] = [];
  const { editor } = file;
  const advice = secretAdvice(scoped, editor);

  if (typeof entry?.command === "string") {
    const args = stringArgs(entry.args, issues);
    const env = stringRecord(entry.env, "env var", ["env"], issues);
    const rawArgs: unknown[] = Array.isArray(entry.args) ? entry.args : [];

    if (!entry.command.trim()) {
      issues.push({ level: "error", code: "empty-command", message: "stdio server has an empty command.", path: ["command"] });
    }
    if (baseCommandName(entry.command) === "npx" && !args.includes("-y") && !args.includes("--yes")) {
      issues.push({
        level: "warning",
        code: "npx-missing-y",
        message: "npx without -y/--yes can hang waiting for an install prompt. Add \"-y\" to args.",
        path: ["command"],
      });
    }
    addUnpinnedLauncherIssue(entry.command, args, issues);
    addSecretIssue(entry.command, ["command"], issues, advice);
    const variableFields: VariableField[] = [{ path: ["command"], value: entry.command }];
    const passedToShell = SHELLS.has(baseCommandName(entry.command));
    rawArgs.forEach((arg, i) => {
      if (typeof arg !== "string") {
        return;
      }
      addShellInjectionIssue(arg, i, issues);
      addSecretIssue(arg, ["args", i], issues, advice);
      variableFields.push({ path: ["args", i], value: arg, passedToShell });
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
      addSecretIssue(value, ["env", key], issues, advice, key);
      addCodeLoadingEnvIssue(key, value, issues);
      variableFields.push({ path: ["env", key], value });
    }
    issues.push(...variableIssues(variableFields, { ...file, remote: false }));
    return { transport: { kind: "stdio", command: entry.command, args, env }, issues };
  }

  if (typeof entry?.url === "string") {
    const headers = stringRecord(entry.headers, "header", ["headers"], issues);
    const t = String(entry.type ?? "").toLowerCase();
    const kind: "http" | "sse" = t === "sse" ? "sse" : "http";
    if (editor === "claude-code" && entry.type === undefined) {
      issues.push({
        level: "error",
        code: "missing-type",
        message: 'Claude Code reads an entry without "type" as a stdio server and skips it. Add "type": "http" (or "sse" or "ws").',
        path: ["url"],
      });
    }
    const urlChecks = urlIssues(entry.url);
    issues.push(...urlChecks);
    if (!urlChecks.some((issue) => issue.code === "credential-in-url")) {
      addSecretIssue(entry.url, ["url"], issues, advice);
    }
    const variableFields: VariableField[] = [{ path: ["url"], value: entry.url }];
    for (const [key, value] of Object.entries(headers)) {
      addSecretIssue(value, ["headers", key], issues, advice, key);
      variableFields.push({ path: ["headers", key], value });
    }
    issues.push(...variableIssues(variableFields, { ...file, remote: true }));
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

const DOWNLOADER = /\b(?:curl|wget|iwr|invoke-webrequest)\b/i;
const PIPE_TO_SHELL = /\|\s*(?:sh|bash|zsh|dash|pwsh|powershell)\b/i;

function pipesDownloadIntoShell(arg: string): boolean {
  const download = DOWNLOADER.exec(arg);
  return download !== null && PIPE_TO_SHELL.test(arg.slice(download.index + download[0].length));
}

function addShellInjectionIssue(arg: string, index: number, issues: ConfigIssue[]): void {
  if (pipesDownloadIntoShell(arg)) {
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
  { name: "OpenAI project key", re: /\bsk-proj-[A-Za-z0-9_-]{20,}/ },
  { name: "OpenAI service account key", re: /\bsk-svcacct-[A-Za-z0-9_-]{20,}/ },
  { name: "OpenAI API key", re: /\bsk-[A-Za-z0-9]{20,}/ },
  { name: "GitHub fine-grained token", re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: "GitLab token", re: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "Stripe live key", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/ },
  { name: "Google API key", re: /\bAIza[A-Za-z0-9_-]{35}/ },
  { name: "Hugging Face token", re: /\bhf_[A-Za-z0-9]{30,}/ },
  { name: "npm token", re: /\bnpm_[A-Za-z0-9]{36}/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "JSON Web Token", re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "private key", re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
];

const CREDENTIAL_WORDS = new Set(["token", "secret", "password", "passwd", "apikey", "pat", "credential", "credentials", "authorization"]);
const KEY_QUALIFIERS = new Set(["api", "access", "private", "secret"]);
const NON_SECRET_SUFFIXES = new Set([
  "path", "file", "dir", "url", "uri", "id", "name", "audience", "endpoint", "host", "type", "header", "model", "version",
]);
const CREDENTIAL_CHARACTERS = /^[A-Za-z0-9._~+\/=-]+$/;
const STANDARD_BASE64 = /^[A-Za-z0-9+\/]+={0,2}$/;
const FILE_NAME = /\.(?:json|pem|key|p12|pfx|crt|cer|txt|env|ya?ml)$/i;

const REFERENCE_SYNTAX: Record<Editor, string | undefined> = {
  "claude-code": "${VAR}",
  vscode: "${env:VAR}",
  cursor: "${env:VAR}",
  "claude-desktop": undefined,
};

function secretAdvice(scoped: ConfigScope, editor: Editor): string {
  const reference = REFERENCE_SYNTAX[editor];
  if (!reference) {
    return "It sits in plain text in this file.";
  }
  return scoped === "workspace"
    ? `Reference it from your environment as ${reference} so the secret isn't committed with the repo.`
    : `It sits in plain text in this file. Reference an environment variable as ${reference} instead.`;
}

function matchSecret(value: string): string | undefined {
  return SECRET_PATTERNS.find((p) => p.re.test(value))?.name;
}

function isCredentialField(field: string): boolean {
  const words = field
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.length === 0 || NON_SECRET_SUFFIXES.has(words[words.length - 1])) {
    return false;
  }
  return words.some((word, i) => CREDENTIAL_WORDS.has(word) || (word === "key" && KEY_QUALIFIERS.has(words[i - 1])));
}

function looksLikeCredential(value: string): boolean {
  const token = value.trim().replace(/^(?:bearer|basic|token)\s+/i, "");
  if (token.length < 16 || !CREDENTIAL_CHARACTERS.test(token) || /^[./~]/.test(token) || FILE_NAME.test(token)) {
    return false;
  }
  if (!/\d/.test(token) || !/[a-z]/i.test(token)) {
    return false;
  }
  return !token.includes("/") || STANDARD_BASE64.test(token);
}

function addSecretIssue(value: string, path: JsonPath, issues: ConfigIssue[], advice: string, field?: string): void {
  if (value.includes("${")) {
    return;
  }
  const name = matchSecret(value);
  const literalCredential = !name && field !== undefined && isCredentialField(field) && looksLikeCredential(value);
  if (!name && !literalCredential) {
    return;
  }
  const finding = name ? `Looks like a hardcoded ${name}` : `"${field}" holds a literal credential`;
  issues.push({
    level: "warning",
    code: "hardcoded-secret",
    message: `${finding}. ${advice}`,
    path,
  });
}

const PRELOAD_FLAG = /(?:^|\s)(?:--require|-r|--import|--loader|--experimental-loader)(?=[\s=]|$)/;
const JAVA_AGENT_FLAG = /-(?:javaagent|agentpath|agentlib):/;
const hasValue = (value: string) => value.trim() !== "";

function nodePreloads(value: string): boolean {
  const normalized = value.replace(/["']/g, "").replace(/--[\w-]+/g, (flag) => flag.replace(/_/g, "-"));
  return PRELOAD_FLAG.test(normalized);
}

const LOADS_CODE = "makes the runtime load extra code before the server starts, and that code runs with your permissions";
const CHANGES_REGISTRY = "points the package installer at a different registry, so the server's code can come from somewhere else";

const CODE_LOADING_ENV = new Map<string, { applies: (value: string) => boolean; effect: string }>([
  ["NODE_OPTIONS", { applies: nodePreloads, effect: LOADS_CODE }],
  ["LD_PRELOAD", { applies: hasValue, effect: LOADS_CODE }],
  ["DYLD_INSERT_LIBRARIES", { applies: hasValue, effect: LOADS_CODE }],
  ["BASH_ENV", { applies: hasValue, effect: LOADS_CODE }],
  ["DOTNET_STARTUP_HOOKS", { applies: hasValue, effect: LOADS_CODE }],
  ["PERL5OPT", { applies: (value) => /(?:^|\s)-?[MmdI]/.test(value), effect: LOADS_CODE }],
  ["RUBYOPT", { applies: (value) => /(?:^|\s)-?[rI]/.test(value), effect: LOADS_CODE }],
  ["JAVA_TOOL_OPTIONS", { applies: (value) => JAVA_AGENT_FLAG.test(value), effect: LOADS_CODE }],
  ["_JAVA_OPTIONS", { applies: (value) => JAVA_AGENT_FLAG.test(value), effect: LOADS_CODE }],
  ["JDK_JAVA_OPTIONS", { applies: (value) => JAVA_AGENT_FLAG.test(value) || /(?:^|\s)@/.test(value), effect: LOADS_CODE }],
  ["NPM_CONFIG_REGISTRY", { applies: hasValue, effect: CHANGES_REGISTRY }],
  ["PIP_INDEX_URL", { applies: hasValue, effect: CHANGES_REGISTRY }],
  ["PIP_EXTRA_INDEX_URL", { applies: hasValue, effect: CHANGES_REGISTRY }],
  ["UV_INDEX_URL", { applies: hasValue, effect: CHANGES_REGISTRY }],
  ["UV_EXTRA_INDEX_URL", { applies: hasValue, effect: CHANGES_REGISTRY }],
  ["UV_DEFAULT_INDEX", { applies: hasValue, effect: CHANGES_REGISTRY }],
]);

function addCodeLoadingEnvIssue(key: string, value: string, issues: ConfigIssue[]): void {
  const separator = key.indexOf("=");
  const name = separator > 0 ? key.slice(0, separator) : key;
  const effectiveValue = separator > 0 ? `${key.slice(separator + 1)}=${value}` : value;
  const rule = CODE_LOADING_ENV.get(name.toUpperCase());
  if (!rule?.applies(effectiveValue)) {
    return;
  }
  issues.push({
    level: "warning",
    code: "env-code-injection",
    message: `${name} ${rule.effect}. Confirm it's intentional.`,
    path: ["env", key],
  });
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
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
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
    const paramKeys = new Set([...url.searchParams.keys()].map((k) => k.toLowerCase()));
    const param = SENSITIVE_URL_PARAMS.find((p) => paramKeys.has(p));
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

interface FileContext {
  editor: Editor;
  inputs: InputDefinition[] | undefined;
  hasFolder: boolean;
}

interface VariableContext extends FileContext {
  remote: boolean;
}

interface VariableField {
  path: JsonPath;
  value: string;
  passedToShell?: boolean;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "pwsh", "powershell"]);

function variableIssues(fields: VariableField[], context: VariableContext): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const reported = new Set<string>();
  for (const { path: fieldPath, value, passedToShell } of fields) {
    for (const match of variableReferences(value, context.editor, context.remote)) {
      if (passedToShell && match.reference.kind === "literal") {
        continue;
      }
      const issue = variableIssue(match, context);
      const key = issue && `${issue.code}|${referenceKey(match)}`;
      if (!issue || !key || reported.has(key)) {
        continue;
      }
      reported.add(key);
      issues.push({ ...issue, path: fieldPath });
    }
  }
  return issues;
}

function referenceKey({ text, reference }: ReferenceMatch): string {
  if (reference.kind !== "environment" && reference.kind !== "blanked") {
    return text;
  }
  return process.platform === "win32" ? reference.name.toUpperCase() : reference.name;
}

function variableIssue({ text, body, reference }: ReferenceMatch, context: VariableContext): ConfigIssue | undefined {
  const editorName = EDITOR_NAMES[context.editor];
  switch (reference.kind) {
    case "environment":
      return isUnsetEnvironmentReference(reference)
        ? { level: "warning", code: "env-unset", message: unsetMessage(reference.name, text, context.editor) }
        : undefined;
    case "blanked":
      return {
        level: "warning",
        code: "credential-blanked",
        message: `Claude Code reads ${reference.name} as empty in a remote server's url and headers, even when it's set, so the server receives no value.`,
      };
    case "literal":
      return { level: "warning", code: "variable-not-expanded", message: notExpandedMessage(text, body, context.editor) };
    case "unsupported":
      return untestable(`Only ${editorName} can fill in ${text}`);
    case "editor":
      return isFolderVariable(reference.name) && !context.hasFolder
        ? untestable(`${editorName} fills ${text} from the open folder, but this config isn't tied to one`)
        : undefined;
    case "input":
      return inputIssue(text, reference.id, context);
  }
}

function inputIssue(text: string, id: string, context: VariableContext): ConfigIssue | undefined {
  const definition = inputDefinition(context.inputs, id);
  if (!definition) {
    return {
      level: "warning",
      code: "input-undefined",
      message: `${text} has no matching entry under "inputs" in this file, so ${EDITOR_NAMES[context.editor]} can't start this server.`,
    };
  }
  return isPromptedInput(definition.type) ? undefined : untestable(`The tester can't fill in the "${definition.type}" input behind ${text}`);
}

function untestable(reason: string): ConfigIssue {
  return { level: "info", code: "variable-unsupported", message: `${reason}, so the tester won't launch this server.` };
}

function unsetMessage(name: string, text: string, editor: Editor): string {
  if (editor === "claude-code" && isEditorVariable(name)) {
    const hint = name === "workspaceFolder" ? " Use ${CLAUDE_PROJECT_DIR:-.} for the project folder." : "";
    return `Claude Code doesn't fill in editor variables like ${text}. Claude Code reads it as an environment variable, which isn't set, so the server receives the text as written.${hint}`;
  }
  const unset = `References environment variable ${name}, which is not set in your environment`;
  if (editor === "claude-code") {
    return `${unset}, so Claude Code passes ${text} to the server as written. Set it, or add a default as \${${name}:-value}.`;
  }
  return `${unset}, so it reaches the server as an empty value.`;
}

function notExpandedMessage(text: string, body: string, editor: Editor): string {
  if (editor === "claude-desktop") {
    return `Claude Desktop doesn't expand variables, so the server receives ${text} as written.`;
  }
  const notExpanded = `${EDITOR_NAMES[editor]} doesn't expand ${text}, so the server receives it as written.`;
  const suggestion = expansionSuggestion(body, editor);
  return suggestion ? `${notExpanded} Use ${suggestion} instead.` : notExpanded;
}

function stringArgs(value: unknown, issues: ConfigIssue[]): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  value.forEach((item, i) => {
    if (typeof item === "string") {
      out.push(item);
    } else if (typeof item === "number" || typeof item === "boolean") {
      out.push(String(item));
    } else {
      issues.push({ level: "warning", code: "non-string-arg", message: `args[${i}] is not a string, number, or boolean and was ignored.`, path: ["args", i] });
    }
  });
  return out;
}

function inputDefinitions(value: unknown): InputDefinition[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const definitions: InputDefinition[] = [];
  for (const item of value) {
    if (!isPlainObject(item) || typeof item.id !== "string" || typeof item.type !== "string") {
      continue;
    }
    definitions.push({
      id: item.id,
      type: item.type,
      description: typeof item.description === "string" ? item.description : undefined,
      password: item.password === true,
      default: typeof item.default === "string" ? item.default : undefined,
      options: Array.isArray(item.options) ? item.options.flatMap(inputOption) : undefined,
    });
  }
  return definitions;
}

function inputOption(option: unknown): InputOption[] {
  if (typeof option === "string") {
    return [{ label: option, value: option }];
  }
  if (isPlainObject(option) && typeof option.value === "string") {
    return [{ label: typeof option.label === "string" ? option.label : option.value, value: option.value }];
  }
  return [];
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
  const normalized = p.replace(/[\\/]+$/, "").replace(/\\/g, "/");
  return process.platform === "linux" ? normalized : normalized.toLowerCase();
}

const SECURITY_CODES = new Set([
  "hardcoded-secret",
  "credential-in-url",
  "insecure-remote-transport",
  "risky-shell-pipe",
  "encoded-powershell",
  "env-code-injection",
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

function noServersConfigured(): ConfigIssue {
  return { level: "info", code: "no-servers", message: "No MCP servers are configured in this file." };
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

  let text: string;
  try {
    text = readConfigText(p);
  } catch (e) {
    result.fileIssues.push({
      level: "error",
      code: "read-failed",
      message: `Could not read this file: ${(e as Error).message}`,
    });
    return result;
  }

  let parsed: any;
  try {
    parsed = parseConfig(text, loc.strict ?? false);
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
    const wrongKeyPresent = isPlainObject(parsed?.[otherKey]);
    if (loc.serversOptional && parsed?.[loc.rootKey] === undefined && !wrongKeyPresent) {
      result.fileIssues.push(noServersConfigured());
      return result;
    }
    const hint = wrongKeyPresent
      ? ` Found "${otherKey}" instead — this editor expects "${loc.rootKey}".`
      : "";
    result.fileIssues.push({
      level: "error",
      code: "missing-root-key",
      message: `No "${loc.rootKey}" object at the top level; no servers will load.${hint}`,
    });
    return result;
  }

  const editor = editorFor(loc.source);
  const inputs = editor === "vscode" ? inputDefinitions(parsed?.inputs) : undefined;
  let total = 0;
  for (const { entries, scope, basePath } of blocks) {
    const hasFolder = loc.scoped === "workspace" || scope !== undefined;
    for (const [name, entry] of Object.entries(entries)) {
      total++;
      const { transport, issues } = normalizeTransport(entry, loc.scoped, { editor, inputs, hasFolder });
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
        inputs,
        raw: entry,
        issues: applySecurityPolicy(issues, ctx),
      });
    }
  }

  if (total === 0 && mainPresent) {
    result.fileIssues.push(
      loc.serversOptional
        ? noServersConfigured()
        : {
            level: "warning",
            code: "empty-root-key",
            message: `"${loc.rootKey}" is present but defines no servers.`,
            path: [loc.rootKey],
          },
    );
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
  vscodeUserDir?: string;
}

interface ScanContext {
  workspaceFolders: string[];
  showAllClaudeProjects: boolean;
  securityEnabled: boolean;
  ruleSeverity: Record<string, string>;
  vscodeUserDir?: string;
}

export function discoverAll(workspaceFolders: string[], options: DiscoverOptions = {}): ScannedFile[] {
  const ctx: ScanContext = {
    workspaceFolders,
    showAllClaudeProjects: options.showAllClaudeProjects ?? false,
    securityEnabled: options.securityEnabled ?? true,
    ruleSeverity: options.ruleSeverity ?? {},
    vscodeUserDir: options.vscodeUserDir,
  };
  const files: ScannedFile[] = [];
  for (const loc of LOCATIONS) {
    if (loc.scoped === "global") {
      const file = scanPath(loc, loc.resolve(ctx), ctx);
      assignProjectDir(file);
      files.push(file);
    } else {
      for (const ws of workspaceFolders) {
        const file = scanPath(loc, loc.resolve(ctx, ws), ctx);
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
