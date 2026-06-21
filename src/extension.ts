import * as vscode from "vscode";
import { ServersProvider } from "./serversTree";
import { DiscoveredServer } from "./types";

const WATCH_GLOB = "**/{.cursor/mcp.json,.vscode/mcp.json,.mcp.json}";

export function activate(context: vscode.ExtensionContext) {
  console.log("[MCP Workbench] activated");

  const provider = new ServersProvider();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("mcpWorkbench.servers", provider),
    vscode.commands.registerCommand("mcpWorkbench.refresh", () => provider.refresh()),
    vscode.commands.registerCommand("mcpWorkbench.openConfig", (server: DiscoveredServer) => {
      if (server?.configPath) {
        vscode.window.showTextDocument(vscode.Uri.file(server.configPath));
      }
    }),
    vscode.commands.registerCommand("mcpWorkbench.testServer", (server: DiscoveredServer) => {
      vscode.window.showInformationMessage(
        `Tester coming next: would connect to "${server?.name}" (${server?.transport.kind}).`,
      );
    }),
  );

  let watcher: vscode.FileSystemWatcher | undefined;
  const syncWatcher = () => {
    watcher?.dispose();
    watcher = undefined;
    if ((vscode.workspace.workspaceFolders ?? []).length === 0) {
      return;
    }
    watcher = vscode.workspace.createFileSystemWatcher(WATCH_GLOB);
    watcher.onDidChange(() => provider.refresh());
    watcher.onDidCreate(() => provider.refresh());
    watcher.onDidDelete(() => provider.refresh());
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      syncWatcher();
      provider.refresh();
    }),
    { dispose: () => watcher?.dispose() },
  );

  syncWatcher();
  provider.refresh();
}

export function deactivate() {}
