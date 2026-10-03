import * as fs from "fs";
import { ResolvedExecutable, resolveWindowsExecutable } from "./executable";
import { Unfillable, VariableScope, substituteVariables } from "./substitution";
import { StdioTransport } from "./types";

export interface StdioLaunchPlan {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string | undefined;
  executable: ResolvedExecutable | undefined;
}

export function planStdioLaunch(transport: StdioTransport, scope: VariableScope, unfillable: Unfillable): StdioLaunchPlan {
  const substitute = (value: string) => substituteVariables(value, scope, unfillable);
  const command = substitute(transport.command);
  const args = transport.args.map(substitute);
  const env = mapValues(transport.env, substitute);
  const cwd = existingDirectory(scope.projectDir);
  return { command, args, env, cwd, executable: resolveWindowsExecutable(command, env, cwd) };
}

export function mapValues(record: Record<string, string>, fn: (value: string) => string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = fn(value);
  }
  return out;
}

function existingDirectory(dir: string | undefined): string | undefined {
  if (!dir) {
    return undefined;
  }
  try {
    return fs.statSync(dir).isDirectory() ? dir : undefined;
  } catch {
    return undefined;
  }
}
