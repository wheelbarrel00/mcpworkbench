import * as os from "os";
import * as path from "path";
import { EDITOR_NAMES, Editor, editorFor } from "./editors";
import { DiscoveredServer, InputDefinition, InputValues, McpTransport } from "./types";

const REFERENCE = /\$\{([^{}]+)\}/g;
const CLAUDE_CODE_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
const ENV_PREFIX = "env:";
const INPUT_PREFIX = "input:";

const CLAUDE_CODE_REMOTE_BLANKED = new Set(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "HTTPS_PROXY", "NPM_TOKEN"]);

const EDITOR_VARIABLES = new Map<string, (projectDir: string | undefined) => string | undefined>([
  ["workspaceFolder", (projectDir) => projectDir],
  ["workspaceFolderBasename", (projectDir) => projectDir && path.basename(projectDir)],
  ["userHome", () => os.homedir()],
  ["pathSeparator", () => path.sep],
  ["/", () => path.sep],
]);
const VSCODE_ALIASES = new Map([
  ["workspaceRoot", "workspaceFolder"],
  ["workspaceRootFolderName", "workspaceFolderBasename"],
]);
const FOLDER_VARIABLES = new Set(["workspaceFolder", "workspaceFolderBasename"]);
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_()]*$/;
const CLAUDE_CODE_ENV_SPELLING = /^env:([A-Za-z_][A-Za-z0-9_]*)$/;
const LOCAL_PATH_VARIABLES = new Set(["workspaceFolder", "workspaceFolderBasename", "userHome"]);
const PROMPTED_INPUT_TYPES = new Set(["promptString", "pickString"]);

const VSCODE_ONLY_VARIABLES = new Set([
  "file",
  "fileWorkspaceFolder",
  "fileWorkspaceFolderBasename",
  "relativeFile",
  "relativeFileDirname",
  "fileBasename",
  "fileBasenameNoExtension",
  "fileExtname",
  "fileDirname",
  "fileDirnameBasename",
  "cwd",
  "lineNumber",
  "columnNumber",
  "selectedText",
  "execPath",
  "execInstallFolder",
  "defaultBuildTask",
]);
const VSCODE_ONLY_PREFIXES = ["config:", "command:", "workspaceFolder:", "workspaceFolderBasename:", "extensionInstallFolder:"];

export type VariableReference =
  | { kind: "environment"; name: string; fallback?: string }
  | { kind: "blanked"; name: string }
  | { kind: "editor"; name: string }
  | { kind: "input"; id: string }
  | { kind: "unsupported" }
  | { kind: "literal" };

export interface ReferenceMatch {
  text: string;
  body: string;
  reference: VariableReference;
}

export interface VariableScope {
  editor: Editor;
  remote: boolean;
  projectDir: string | undefined;
  inputs: InputValues;
}

export type Unfillable = "throw" | "keep";

const LITERAL: VariableReference = { kind: "literal" };
const UNSUPPORTED: VariableReference = { kind: "unsupported" };
const NO_INPUTS: InputValues = new Map();

export function variableScope(server: DiscoveredServer, inputs: InputValues = NO_INPUTS): VariableScope {
  return { editor: editorFor(server.source), remote: server.transport.kind !== "stdio", projectDir: server.projectDir, inputs };
}

export function substituteVariables(value: string, scope: VariableScope, unfillable: Unfillable): string {
  const claudeCode = scope.editor === "claude-code";
  const [searched, rest] = splitAfterLastBrace(value);
  const substituted = searched.replace(claudeCode ? CLAUDE_CODE_REFERENCE : REFERENCE, (text: string, first: string, second: unknown) => {
    const reference = claudeCode
      ? claudeCodeReference(first, typeof second === "string" ? second : undefined, scope.remote)
      : classifyReference(first, scope.editor);
    const filled = fill(text, reference, scope);
    if (filled !== undefined) {
      return filled;
    }
    if (unfillable === "keep") {
      return text;
    }
    throw new Error(unfillableMessage(text, reference, scope.editor));
  });
  return substituted + rest;
}

export function variableReferences(value: string, editor: Editor, remote: boolean): ReferenceMatch[] {
  const [searched] = splitAfterLastBrace(value);
  if (editor !== "claude-code") {
    return [...searched.matchAll(REFERENCE)].map(([text, body]) => ({ text, body, reference: classifyReference(body, editor) }));
  }
  const expanded = [...searched.matchAll(CLAUDE_CODE_REFERENCE)];
  const literals = withoutOverlaps([...searched.matchAll(REFERENCE)], expanded).map(([text, body]) => ({ text, body, reference: LITERAL }));
  return [
    ...expanded.map(([text, name, fallback]) => ({ text, body: text.slice(2, -1), reference: claudeCodeReference(name, fallback, remote) })),
    ...literals,
  ];
}

export function expansionSuggestion(body: string, editor: Editor): string | undefined {
  if (editor === "claude-desktop") {
    return undefined;
  }
  if (editor === "claude-code") {
    const name = CLAUDE_CODE_ENV_SPELLING.exec(body)?.[1];
    return name ? `\${${name}}` : undefined;
  }
  const editorVariable = VSCODE_ALIASES.get(body) ?? editorVariableSpelledLike(body);
  if (editorVariable) {
    return `\${${editorVariable}}`;
  }
  return ENVIRONMENT_NAME.test(body) && !VSCODE_ONLY_VARIABLES.has(body) ? `\${env:${body}}` : undefined;
}

export function unsetNotice(names: string, count: number, editor: Editor): string {
  const reaches = count === 1 ? "It reaches" : "They reach";
  const outcome = editor === "claude-code" ? "as written" : "as an empty value";
  return `Not set in your environment: ${names}. ${reaches} the server ${outcome}.`;
}

export function isEditorVariable(name: string): boolean {
  return EDITOR_VARIABLES.has(name);
}

export function isFolderVariable(name: string): boolean {
  return FOLDER_VARIABLES.has(name);
}

function editorVariableSpelledLike(body: string): string | undefined {
  const lower = body.toLowerCase();
  return [...EDITOR_VARIABLES.keys()].find((name) => name.toLowerCase() === lower);
}

export function isPromptedInput(type: string): boolean {
  return PROMPTED_INPUT_TYPES.has(type);
}

export function inputDefinition(inputs: InputDefinition[] | undefined, id: string): InputDefinition | undefined {
  return inputs?.filter((input) => input.id === id).pop();
}

export function isUnsetEnvironmentReference(reference: VariableReference): reference is { kind: "environment"; name: string } {
  return reference.kind === "environment" && reference.fallback === undefined && environmentValue(reference.name) === undefined;
}

export function filledEnvironmentNames(server: DiscoveredServer): string[] {
  return unique(
    serverReferences(server).flatMap((reference) =>
      reference.kind === "environment" && environmentValue(reference.name) !== undefined ? [reference.name] : [],
    ),
  );
}

export function unsetEnvironmentNames(server: DiscoveredServer): string[] {
  return unique(serverReferences(server).flatMap((reference) => (isUnsetEnvironmentReference(reference) ? [reference.name] : [])));
}

export function localPathNames(server: DiscoveredServer): string[] {
  return unique(
    serverReferences(server).flatMap((reference) =>
      reference.kind === "editor" && LOCAL_PATH_VARIABLES.has(reference.name) ? [reference.name] : [],
    ),
  );
}

export function inputIds(server: DiscoveredServer): string[] {
  return unique(serverReferences(server).flatMap((reference) => (reference.kind === "input" ? [reference.id] : [])));
}

function claudeCodeReference(name: string, fallback: string | undefined, remote: boolean): VariableReference {
  return remote && CLAUDE_CODE_REMOTE_BLANKED.has(name) ? { kind: "blanked", name } : { kind: "environment", name, fallback };
}

function classifyReference(body: string, editor: Editor): VariableReference {
  if (editor === "claude-desktop" || editor === "claude-code") {
    return LITERAL;
  }
  if (body.startsWith(ENV_PREFIX) && body.length > ENV_PREFIX.length) {
    return { kind: "environment", name: body.slice(ENV_PREFIX.length) };
  }
  if (EDITOR_VARIABLES.has(body)) {
    return { kind: "editor", name: body };
  }
  if (editor !== "vscode") {
    return LITERAL;
  }
  const alias = VSCODE_ALIASES.get(body);
  if (alias) {
    return { kind: "editor", name: alias };
  }
  if (body.startsWith(INPUT_PREFIX) && body.length > INPUT_PREFIX.length) {
    return { kind: "input", id: body.slice(INPUT_PREFIX.length) };
  }
  if (VSCODE_ONLY_VARIABLES.has(body) || VSCODE_ONLY_PREFIXES.some((prefix) => body.startsWith(prefix))) {
    return UNSUPPORTED;
  }
  return LITERAL;
}

function fill(text: string, reference: VariableReference, scope: VariableScope): string | undefined {
  switch (reference.kind) {
    case "literal":
      return text;
    case "environment":
      return environmentValue(reference.name) ?? reference.fallback ?? (scope.editor === "claude-code" ? text : "");
    case "blanked":
      return "";
    case "editor":
      return EDITOR_VARIABLES.get(reference.name)?.(scope.projectDir);
    case "input":
      return scope.inputs.get(reference.id);
    case "unsupported":
      return undefined;
  }
}

function unfillableMessage(text: string, reference: VariableReference, editor: Editor): string {
  if (reference.kind === "input") {
    return `${text} has no value. MCP Workbench asks for promptString and pickString inputs defined under "inputs" in this file.`;
  }
  if (reference.kind === "editor") {
    return `This config isn't tied to a project folder, so MCP Workbench can't fill in ${text} and won't launch this server.`;
  }
  return `Only ${EDITOR_NAMES[editor]} can fill in ${text}, so MCP Workbench won't launch this server.`;
}

function splitAfterLastBrace(value: string): [string, string] {
  const end = value.lastIndexOf("}") + 1;
  return [value.slice(0, end), value.slice(end)];
}

function withoutOverlaps(matches: RegExpMatchArray[], taken: RegExpMatchArray[]): RegExpMatchArray[] {
  const kept: RegExpMatchArray[] = [];
  let next = 0;
  for (const match of matches) {
    const start = match.index ?? 0;
    while (next < taken.length && (taken[next].index ?? 0) + taken[next][0].length <= start) {
      next++;
    }
    const overlapping = next < taken.length && (taken[next].index ?? 0) < start + match[0].length;
    if (!overlapping) {
      kept.push(match);
    }
  }
  return kept;
}

function environmentValue(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === "string" ? value : undefined;
}

function expandableValues(transport: McpTransport): string[] {
  return transport.kind === "stdio"
    ? [transport.command, ...transport.args, ...Object.values(transport.env)]
    : [transport.url, ...Object.values(transport.headers)];
}

function serverReferences(server: DiscoveredServer): VariableReference[] {
  const editor = editorFor(server.source);
  const remote = server.transport.kind !== "stdio";
  return expandableValues(server.transport).flatMap((value) => variableReferences(value, editor, remote).map((match) => match.reference));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
