import { createHash } from "crypto";
import type { Memento } from "vscode";
import { editorFor, inheritsEnvironment } from "./editors";
import { ResolvedExecutable } from "./executable";
import { StdioLaunchPlan, planStdioLaunch } from "./launchPlan";
import {
  filledEnvironmentNames,
  inputDefinition,
  inputIds,
  localPathNames,
  unsetEnvironmentNames,
  unsetNotice,
  variableScope,
} from "./substitution";
import { DiscoveredServer, InputValues } from "./types";

const STORE_KEY = "mcpWorkbench.trustedLaunches";
const FINGERPRINT_VERSION = 2;
const VALUE_LIMIT = 200;
const NAME_LIMIT = 80;
const ENTRY_LIMIT = 40;
const HIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}ᅟᅠㅤﾠ]/gu;

export class LaunchTrustStore {
  private readonly fingerprints = new Map<string, string>();

  constructor(private readonly memento: Memento) {
    const raw = memento.get<unknown>(STORE_KEY);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [id, fingerprint] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof fingerprint === "string") {
          this.fingerprints.set(id, fingerprint);
        }
      }
    }
  }

  get size(): number {
    return this.fingerprints.size;
  }

  isTrusted(id: string, server: DiscoveredServer): boolean {
    return this.fingerprints.get(id) === launchFingerprint(server);
  }

  trust(id: string, server: DiscoveredServer): Thenable<void> {
    this.fingerprints.set(id, launchFingerprint(server));
    return this.persist();
  }

  reset(): Thenable<void> {
    this.fingerprints.clear();
    return this.persist();
  }

  private persist(): Thenable<void> {
    return this.memento.update(STORE_KEY, Object.fromEntries(this.fingerprints));
  }
}

export function launchFingerprint(server: DiscoveredServer): string {
  const t = server.transport;
  const launch =
    t.kind === "stdio"
      ? [t.kind, t.command, launchedExecutable(server)?.path ?? null, t.args, sortedEntries(t.env)]
      : [t.kind, t.url, sortedEntries(t.headers)];
  return createHash("sha256").update(JSON.stringify([FINGERPRINT_VERSION, ...launch, referencedInputs(server)])).digest("hex");
}

export function launchedExecutable(server: DiscoveredServer, inputs?: InputValues): ResolvedExecutable | undefined {
  return stdioPlan(server, inputs)?.executable;
}

export function launchesWorkspaceFile(server: DiscoveredServer): boolean {
  return launchedExecutable(server)?.fromWorkingDir === true;
}

export function enteredValuesWarning(server: DiscoveredServer, inputs: InputValues): string | undefined {
  const entered = inputs.size ? launchedExecutable(server, inputs) : undefined;
  if (!entered?.fromWorkingDir || entered.path === launchedExecutable(server)?.path) {
    return undefined;
  }
  return `With the values you entered, this runs ${new PreviewWriter().value(entered.path)}, which was found through this workspace folder, not on your PATH.`;
}

function referencedInputs(server: DiscoveredServer): unknown[] {
  return inputIds(server).map((id) => {
    const input = inputDefinition(server.inputs, id);
    return input ? [id, input.type, input.default ?? null, input.password === true, input.options ?? null] : [id, null];
  });
}

function stdioPlan(server: DiscoveredServer, inputs?: InputValues): StdioLaunchPlan | undefined {
  const t = server.transport;
  return t.kind === "stdio" ? planStdioLaunch(t, variableScope(server, inputs), "keep") : undefined;
}

export function launchAction(server: DiscoveredServer): "Launch" | "Connect" {
  return server.transport.kind === "stdio" ? "Launch" : "Connect";
}

export function displayName(server: DiscoveredServer): string {
  return displayText(server.name, NAME_LIMIT);
}

export function displayText(raw: string, limit = VALUE_LIMIT): string {
  return clip(escapeHidden(raw), limit).text;
}

export function launchQuestion(server: DiscoveredServer): string {
  return server.transport.kind === "stdio"
    ? `Launch ${displayName(server)} from this workspace?`
    : `Connect to ${displayName(server)} from this workspace?`;
}

export function launchPreview(server: DiscoveredServer): string {
  const t = server.transport;
  const preview = new PreviewWriter();
  preview.section(launchSummary(server));
  const fromHost = hostVariables(server);
  if (fromHost.length) {
    preview.section(`Filled in from your machine: ${preview.list(fromHost.map((name) => preview.key(name)), ", ")}`);
  }
  const unset = unsetEnvironmentNames(server);
  if (unset.length) {
    const names = preview.list(unset.map((name) => preview.key(name)), ", ");
    preview.section(unsetNotice(names, unset.length, editorFor(server.source)));
  }
  if (t.kind === "stdio") {
    const program = [`Program: ${preview.value(t.command)}`];
    const resolution = resolutionLine(server, preview);
    if (resolution) {
      program.push(resolution);
    }
    preview.section(program.join("\n"));
    if (t.args.length) {
      preview.section(`Arguments:\n${preview.list(t.args.map((arg) => `  ${preview.value(arg)}`), "\n")}`);
    }
    const env = Object.entries(t.env);
    if (env.length) {
      preview.section(`Environment:\n${preview.list(env.map(([key, value]) => `  ${preview.key(key)} = ${preview.value(value)}`), "\n")}`);
    }
  } else {
    preview.section(`URL: ${preview.value(t.url)}`);
    const headers = Object.entries(t.headers);
    if (headers.length) {
      preview.section(
        `Headers sent with every request:\n${preview.list(headers.map(([key, value]) => `  ${preview.key(key)}: ${preview.value(value)}`), "\n")}`,
      );
    }
  }
  if (preview.shortened) {
    preview.section("Some values are shortened here. Open the config file to review them in full.");
  }
  return preview.text();
}

export function hostVariables(server: DiscoveredServer): string[] {
  const filled = filledEnvironmentNames(server);
  return server.transport.kind === "stdio" ? filled : [...new Set([...filled, ...localPathNames(server)])];
}

function launchSummary(server: DiscoveredServer): string {
  if (server.transport.kind !== "stdio") {
    return "This connects to a remote server.";
  }
  const program = "This starts a program on your machine with your permissions.";
  return inheritsEnvironment(editorFor(server.source))
    ? `${program} It also inherits your environment variables, including any keys or tokens set there.`
    : program;
}

function resolutionLine(server: DiscoveredServer, preview: PreviewWriter): string | undefined {
  const plan = stdioPlan(server);
  if (plan?.executable) {
    const origin = plan.executable.fromWorkingDir ? " (found through this workspace folder, not on your PATH)" : "";
    return `Resolves to: ${preview.value(plan.executable.path)}${origin}`;
  }
  const command = plan?.command.trim() ?? "";
  if (command.includes("${input:") && editorFor(server.source) === "vscode") {
    return "Resolves to: not known until you enter the values it asks for";
  }
  if (command.includes("${")) {
    return 'Resolves to: nothing. The command still contains "${" after variables are filled in, so it won\'t launch.';
  }
  if (process.platform === "win32" && command && !/[\\/:]/.test(command)) {
    return "Resolves to: nothing on your PATH";
  }
  return undefined;
}

class PreviewWriter {
  private readonly sections: string[] = [];
  shortened = false;

  section(text: string): void {
    this.sections.push(text);
  }

  value(raw: string): string {
    const { text, omitted } = clip(escapeHidden(raw), VALUE_LIMIT);
    if (omitted === 0) {
      return `"${text}"`;
    }
    this.shortened = true;
    return `"${text}"… (+${omitted} more characters)`;
  }

  key(raw: string): string {
    const { text, omitted } = clip(escapeHidden(raw), NAME_LIMIT);
    if (omitted > 0) {
      this.shortened = true;
    }
    return text;
  }

  list(items: string[], separator: string): string {
    if (items.length <= ENTRY_LIMIT) {
      return items.join(separator);
    }
    this.shortened = true;
    return [...items.slice(0, ENTRY_LIMIT), `…and ${items.length - ENTRY_LIMIT} more`].join(separator);
  }

  text(): string {
    return this.sections.join("\n\n");
  }
}

function escapeHidden(value: string): string {
  return value.replace(HIDDEN_CHARACTERS, (c) => {
    const code = c.codePointAt(0) ?? 0;
    return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

function clip(value: string, limit: number): { text: string; omitted: number } {
  return value.length <= limit ? { text: value, omitted: 0 } : { text: value.slice(0, limit), omitted: value.length - limit };
}

function sortedEntries(record: Record<string, string>): [string, string][] {
  return Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
