import * as vscode from "vscode";
import { discoverAll, flattenServers } from "./discovery";
import { DiscoveredServer, McpSource, ScannedFile } from "./types";

const SOURCE_LABELS: Record<McpSource, string> = {
  "cursor-global": "Cursor (global)",
  "cursor-workspace": "Cursor (workspace)",
  "vscode-workspace": "VS Code (workspace)",
  "claude-code-workspace": "Claude Code (workspace)",
  "claude-code-user": "Claude Code (user)",
  "claude-desktop": "Claude Desktop",
};

type Node = SourceNode | ServerNode;
interface SourceNode { kind: "source"; source: McpSource; files: ScannedFile[]; }
interface ServerNode { kind: "server"; server: DiscoveredServer; }

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
      return node.files.flatMap((f) => f.servers).map((server) => ({ kind: "server", server }));
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "source") {
      const item = new vscode.TreeItem(SOURCE_LABELS[node.source], vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon("server-environment");
      return item;
    }
    const { server } = node;
    const errors = server.issues.filter((i) => i.level === "error").length;
    const warnings = server.issues.filter((i) => i.level === "warning").length;
    const item = new vscode.TreeItem(server.name, vscode.TreeItemCollapsibleState.None);
    item.description = server.transport.kind;
    item.iconPath = new vscode.ThemeIcon(
      errors ? "error" : warnings ? "warning" : "pass",
    );
    item.tooltip = new vscode.MarkdownString(
      [
        `**${server.name}** · \`${server.transport.kind}\``,
        `Source: ${SOURCE_LABELS[server.source]}`,
        `Config: \`${server.configPath}\``,
        ...server.issues.map((i) => `- ${i.level === "error" ? "❌" : "⚠️"} ${i.message}`),
      ].join("\n\n"),
    );
    item.contextValue = "mcpServer";
    item.command = { command: "mcpWorkbench.testServer", title: "Test", arguments: [server] };
    return item;
  }
}
