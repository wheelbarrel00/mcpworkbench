import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { ServersProvider } from "./serversTree";
import { showTester } from "./testPanel";
import { DiscoveredServer } from "./types";

const WATCH_GLOB = "**/{.cursor/mcp.json,.vscode/mcp.json,.mcp.json}";

const HOME = os.homedir();
const GLOBAL_WATCH_TARGETS: Array<{ dir: string; file: string }> = [
  { dir: HOME, file: ".claude.json" },
  { dir: path.join(HOME, ".cursor"), file: "mcp.json" },
  { dir: path.join(HOME, ".claude"), file: "claude_desktop_config.json" },
];

export function activate(context: vscode.ExtensionContext) {
  console.log("[MCP Workbench] activated");

  const provider = new ServersProvider();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("mcpWorkbench.servers", provider),
    vscode.commands.registerCommand("mcpWorkbench.refresh", () => provider.refresh()),
    vscode.commands.registerCommand("mcpWorkbench.openConfig", (arg: unknown) => {
      const server = resolveServer(arg);
      if (server?.configPath) {
        vscode.window.showTextDocument(vscode.Uri.file(server.configPath));
      }
    }),
    vscode.commands.registerCommand("mcpWorkbench.testServer", (arg: unknown) => {
      const server = resolveServer(arg);
      if (server) {
        void showTester(server);
      }
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

  for (const { dir, file } of GLOBAL_WATCH_TARGETS) {
    const globalWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, file));
    globalWatcher.onDidChange(() => provider.refresh());
    globalWatcher.onDidCreate(() => provider.refresh());
    globalWatcher.onDidDelete(() => provider.refresh());
    context.subscriptions.push(globalWatcher);
  }

  syncWatcher();
  provider.refresh();
}

export function deactivate() {}

function resolveServer(arg: unknown): DiscoveredServer | undefined {
  if (!arg || typeof arg !== "object") {
    return undefined;
  }
  const node = arg as { server?: DiscoveredServer; transport?: unknown };
  if (node.server) {
    return node.server;
  }
  return node.transport ? (arg as DiscoveredServer) : undefined;
}
