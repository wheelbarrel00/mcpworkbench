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
interface SourceNode { kind: "source"; label: string; file: ScannedFile; id: string; }
interface ServerNode { kind: "server"; server: DiscoveredServer; id: string; }
interface NoteNode { kind: "note"; text: string; level: "info" | "error" | "warning"; id: string; }

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
      const existing = this.files.filter((f) => f.exists);
      const perSource = new Map<McpSource, number>();
      for (const f of existing) {
        perSource.set(f.source, (perSource.get(f.source) ?? 0) + 1);
      }
      return existing.map((file) => ({
        kind: "source",
        file,
        id: `source|${file.path}`,
        label: sourceLabel(file, (perSource.get(file.source) ?? 0) > 1),
      }));
    }
    if (node.kind === "source") {
      const servers: Node[] = node.file.servers.map((server) => ({
        kind: "server",
        server,
        id: serverId(server),
      }));
      const issues: Node[] = node.file.fileIssues.map((issue, i) => ({
        kind: "note",
        text: issue.message,
        level: issue.level,
        id: `note|${node.file.path}|${i}`,
      }));
      const children = [...servers, ...issues];
      return children.length
        ? children
        : [{ kind: "note", text: "No servers found", level: "info", id: `empty|${node.file.path}` }];
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "source") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = node.id;
      item.iconPath = new vscode.ThemeIcon("server-environment");
      item.tooltip = homePath(node.file.path);
      return item;
    }
    if (node.kind === "note") {
      const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
      item.id = node.id;
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
    item.id = node.id;
    item.description = server.scope
      ? `${server.transport.kind} · ${baseName(server.scope)}`
      : server.transport.kind;
    item.iconPath = new vscode.ThemeIcon(errors ? "error" : warnings ? "warning" : "pass");
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

function sourceLabel(file: ScannedFile, disambiguate: boolean): string {
  const base = SOURCE_LABELS[file.source];
  return disambiguate && file.workspaceFolder ? `${base} · ${baseName(file.workspaceFolder)}` : base;
}

function serverId(server: DiscoveredServer): string {
  return `server|${server.source}|${server.configPath}|${server.scope ?? ""}|${server.name}`;
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function homePath(p: string): string {
  return p.toLowerCase().startsWith(HOME.toLowerCase()) ? "~" + p.slice(HOME.length) : p;
}
