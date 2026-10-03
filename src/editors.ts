import { McpSource } from "./types";

export type Editor = "claude-code" | "vscode" | "cursor" | "claude-desktop";

const EDITOR_BY_SOURCE: Record<McpSource, Editor> = {
  "cursor-global": "cursor",
  "cursor-workspace": "cursor",
  "vscode-workspace": "vscode",
  "vscode-user": "vscode",
  "claude-code-workspace": "claude-code",
  "claude-code-user": "claude-code",
  "claude-desktop": "claude-desktop",
};

export const EDITOR_NAMES: Record<Editor, string> = {
  "claude-code": "Claude Code",
  vscode: "VS Code",
  cursor: "Cursor",
  "claude-desktop": "Claude Desktop",
};

export function editorFor(source: McpSource): Editor {
  return EDITOR_BY_SOURCE[source];
}

export function inheritsEnvironment(editor: Editor): boolean {
  return editor !== "claude-desktop";
}
