import * as vscode from "vscode";
import * as os from "os";
import { discoverAll } from "./discovery";
import { DiscoveredServer, McpSource, ScannedFile } from "./types";

const HOME = os.homedir();

const SOURCE_LABELS: Record<McpSource, string> = {
  "cursor-global": "Cursor (global)",
  "cursor-workspace": "Cursor (workspace)",
  "vscode-workspace": "VS Code (workspace)",
  "claude-code-workspace": "Claude Code (workspace)",
  "claude-code-user": "Claude Code (user)",
  "claude-desktop": "Claude Desktop",
};

type Node = SourceNode | ServerNode | NoteNode;
interface SourceNode { kind: "source"; source: McpSource; files: ScannedFile[]; }
interface ServerNode { kind: "server"; server: DiscoveredServer; }
interface NoteNode { kind: "note"; text: string; level: "info" | "error" | "warning"; }

export class ServersProvider implements vscode.TreeDataProvider<Node> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private files: ScannedFile[] = [];

  refresh(): void {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    this.files = discoverAll(folders);
    this._onDidChange.fire();
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const sources = [...new Set(this.files.filter((f) => f.exists).map((f) => f.source))];
      return sources.map((source) => ({
        kind: "source",
        source,
        files: this.files.filter((f) => f.source === source),
      }));
    }
    if (node.kind === "source") {
      const servers: Node[] = node.files
        .flatMap((f) => f.servers)
        .map((server) => ({ kind: "server", server }));
      const issues: Node[] = node.files
        .flatMap((f) => f.fileIssues)
        .map((issue) => ({ kind: "note", text: issue.message, level: issue.level }));
      const children = [...servers, ...issues];
      return children.length ? children : [{ kind: "note", text: "No servers found", level: "info" }];
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "source") {
      const item = new vscode.TreeItem(SOURCE_LABELS[node.source], vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon("server-environment");
      return item;
    }
    if (node.kind === "note") {
      const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon(
        node.level === "error" ? "error" : node.level === "warning" ? "warning" : "info",
      );
      item.tooltip = node.text;
      return item;
    }
    const { server } = node;
    const errors = server.issues.filter((i) => i.level === "error").length;
    const warnings = server.issues.filter((i) => i.level === "warning").length;
    const item = new vscode.TreeItem(server.name, vscode.TreeItemCollapsibleState.None);
    item.description = server.scope
      ? `${server.transport.kind} · ${projectName(server.scope)}`
      : server.transport.kind;
    item.iconPath = new vscode.ThemeIcon(
      errors ? "error" : warnings ? "warning" : "pass",
    );
    item.tooltip = new vscode.MarkdownString(
      [
        `**${server.name}** · \`${server.transport.kind}\``,
        `Source: ${SOURCE_LABELS[server.source]}`,
        ...(server.scope ? [`Project: \`${server.scope}\``] : []),
        `Config: \`${homePath(server.configPath)}\``,
        ...server.issues.map((i) => `- ${i.level === "error" ? "❌" : "⚠️"} ${i.message}`),
      ].join("\n\n"),
    );
    item.contextValue = "mcpServer";
    return item;
  }
}

function projectName(scope: string): string {
  const parts = scope.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? scope;
}

function homePath(p: string): string {
  return p.toLowerCase().startsWith(HOME.toLowerCase()) ? "~" + p.slice(HOME.length) : p;
}
