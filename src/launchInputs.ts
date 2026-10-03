import * as vscode from "vscode";
import { displayName, displayText } from "./launchTrust";
import { inputDefinition, inputIds, isPromptedInput } from "./substitution";
import { DiscoveredServer, InputDefinition, InputValues } from "./types";

const lastEntered = new Map<string, string>();

export async function promptForInputs(server: DiscoveredServer): Promise<InputValues | undefined> {
  const values = new Map<string, string>();
  for (const id of inputIds(server)) {
    const input = inputDefinition(server.inputs, id);
    if (!input || !isPromptedInput(input.type)) {
      continue;
    }
    const value = await ask(server, input);
    if (value === undefined) {
      return undefined;
    }
    values.set(id, value);
  }
  return values;
}

async function ask(server: DiscoveredServer, input: InputDefinition): Promise<string | undefined> {
  const title = `MCP Workbench: ${displayName(server)}`;
  const prompt = displayText(input.description ?? input.id);
  if (input.type === "pickString") {
    const options = input.options ?? [];
    const items = [...options.filter((option) => option.value === input.default), ...options.filter((option) => option.value !== input.default)].map(
      (option) => ({
        label: displayText(option.label),
        description: option.label === option.value ? undefined : displayText(option.value),
        value: option.value,
      }),
    );
    const picked = await vscode.window.showQuickPick(items, { title, placeHolder: prompt, ignoreFocusOut: true });
    return picked?.value;
  }
  const key = `${server.configPath}|${input.id}`;
  const value = await vscode.window.showInputBox({
    title,
    prompt,
    password: input.password === true,
    value: (input.password ? undefined : lastEntered.get(key)) ?? input.default,
    ignoreFocusOut: true,
  });
  if (value !== undefined && !input.password) {
    lastEntered.set(key, value);
  }
  return value;
}
