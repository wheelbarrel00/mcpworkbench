import * as os from "os";

const VARIABLE_REFERENCE = /\$\{(env:)?([A-Z0-9_()]+)\}/gi;
const EDITOR_VARIABLE_NAMES = new Set(["workspaceFolder", "userHome"]);

export type MissingVariable = "throw" | "keep";

export function substituteVariables(value: string, projectDir: string | undefined, missing: MissingVariable): string {
  return value.replace(VARIABLE_REFERENCE, (reference: string, prefix: string | undefined, name: string) => {
    if (prefix === undefined && name === "workspaceFolder") {
      return projectDir ?? "";
    }
    if (prefix === undefined && name === "userHome") {
      return os.homedir();
    }
    const resolved = process.env[name];
    if (resolved !== undefined) {
      return resolved;
    }
    if (missing === "keep") {
      return reference;
    }
    throw new Error(`Environment variable ${name} is referenced but not set.`);
  });
}

export function referencedEnvironmentVariables(value: string): string[] {
  const names: string[] = [];
  for (const [, prefix, name] of value.matchAll(VARIABLE_REFERENCE)) {
    if (prefix !== undefined || !EDITOR_VARIABLE_NAMES.has(name)) {
      names.push(name);
    }
  }
  return names;
}

export function referencedEditorVariables(value: string): string[] {
  const names: string[] = [];
  for (const [, prefix, name] of value.matchAll(VARIABLE_REFERENCE)) {
    if (prefix === undefined && EDITOR_VARIABLE_NAMES.has(name)) {
      names.push(name);
    }
  }
  return names;
}
