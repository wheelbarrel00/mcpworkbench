import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { claudeDesktopConfigPath } from "./discovery";
import { ServersProvider, serverId, isWorkspaceScoped } from "./serversTree";
import { showTester, disposeTester } from "./testPanel";
import { McpDiagnostics } from "./diagnostics";
import { probe } from "./mcpClient";
import { HealthStore, recordFromProbe, rollup, statusBarSeverity, statusBarText, statusBarTooltip } from "./health";
import { DiscoveredServer, ScannedFile } from "./types";

const WATCH_GLOB = "**/{.cursor/mcp.json,.vscode/mcp.json,.mcp.json}";

const PROBE_TIMEOUT_MS = 10000;
const REFRESH_DEBOUNCE_MS = 300;
const TRUST_LAUNCH_KEY = "trustWorkspaceLaunch";
const BACKGROUND_BY_SEVERITY: Record<"error" | "warning", string> = {
  error: "statusBarItem.errorBackground",
  warning: "statusBarItem.warningBackground",
};

const HOME = os.homedir();
const claudeDesktopConfig = claudeDesktopConfigPath();
const GLOBAL_WATCH_TARGETS: Array<{ dir: string; file: string }> = [
  { dir: HOME, file: ".claude.json" },
  { dir: path.join(HOME, ".cursor"), file: "mcp.json" },
  ...(claudeDesktopConfig
    ? [{ dir: path.dirname(claudeDesktopConfig), file: path.basename(claudeDesktopConfig) }]
    : []),
];

export function activate(context: vscode.ExtensionContext) {
  console.log("[MCP Workbench] activated");

  const provider = new ServersProvider();
  const diagnostics = new McpDiagnostics();
  const health = new HealthStore(context.workspaceState);
  provider.setHealthProvider((id) => health.get(id));

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "mcpWorkbench.servers.focus";
  const updateStatusBar = (files: ScannedFile[]) => {
    const counts = rollup(files);
    statusBar.text = statusBarText(counts);
    statusBar.tooltip = statusBarTooltip(counts);
    const severity = statusBarSeverity(counts);
    statusBar.backgroundColor =
      severity === "none" ? undefined : new vscode.ThemeColor(BACKGROUND_BY_SEVERITY[severity]);
    statusBar.show();
  };

  const probing = new Set<string>();

  context.subscriptions.push(
    diagnostics,
    statusBar,
    provider.onDidScan((files) => {
      void diagnostics.publish(files);
      void health.prune(new Set(files.filter((f) => f.exists).flatMap((f) => f.servers.map(serverId))));
      updateStatusBar(files);
    }),
    vscode.window.registerTreeDataProvider("mcpWorkbench.servers", provider),
    vscode.commands.registerCommand("mcpWorkbench.refresh", () => provider.refresh()),
    vscode.commands.registerCommand("mcpWorkbench.openConfig", async (arg: unknown) => {
      const server = resolveServer(arg);
      if (!server?.configPath) {
        return;
      }
      try {
        await vscode.window.showTextDocument(vscode.Uri.file(server.configPath));
      } catch (e) {
        vscode.window.showErrorMessage(`MCP Workbench: could not open ${server.configPath}: ${errorText(e)}`);
      }
    }),
    vscode.commands.registerCommand("mcpWorkbench.testServer", async (arg: unknown) => {
      const server = resolveServer(arg);
      if (!server || !(await confirmLaunch(context, server))) {
        return;
      }
      showTester(server).catch((e) =>
        vscode.window.showErrorMessage(`MCP Workbench: could not open the tester: ${errorText(e)}`),
      );
    }),
    vscode.commands.registerCommand("mcpWorkbench.testConnection", async (arg: unknown) => {
      const server = resolveServer(arg);
      if (!server || !(await confirmLaunch(context, server))) {
        return;
      }
      const id = serverId(server);
      if (probing.has(id)) {
        return;
      }
      probing.add(id);
      try {
        const result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `MCP Workbench: testing ${server.name}…` },
          () => probe(server, PROBE_TIMEOUT_MS),
        );
        await health.set(id, recordFromProbe(result, Date.now()));
        provider.redraw();
        if (result.ok) {
          const count = result.toolCount ?? 0;
          const tools = `${count} ${count === 1 ? "tool" : "tools"}`;
          vscode.window.showInformationMessage(
            `MCP Workbench: ${server.name} responded in ${result.latencyMs}ms with ${tools}.`,
          );
        } else {
          await showProbeError(server.name, result.error, result.detail);
        }
      } finally {
        probing.delete(id);
      }
    }),
  );

  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const refreshSoon = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => provider.refresh(), REFRESH_DEBOUNCE_MS);
  };
  context.subscriptions.push({ dispose: () => clearTimeout(refreshTimer) });

  let watcher: vscode.FileSystemWatcher | undefined;
  const syncWatcher = () => {
    watcher?.dispose();
    watcher = undefined;
    if ((vscode.workspace.workspaceFolders ?? []).length === 0) {
      return;
    }
    watcher = vscode.workspace.createFileSystemWatcher(WATCH_GLOB);
    watcher.onDidChange(refreshSoon);
    watcher.onDidCreate(refreshSoon);
    watcher.onDidDelete(refreshSoon);
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
    globalWatcher.onDidChange(refreshSoon);
    globalWatcher.onDidCreate(refreshSoon);
    globalWatcher.onDidDelete(refreshSoon);
    context.subscriptions.push(globalWatcher);
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("mcpWorkbench")) {
        provider.refresh();
      }
    }),
  );

  syncWatcher();
  provider.refresh();
}

export function deactivate() {
  return disposeTester();
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function launchTarget(server: DiscoveredServer): string {
  const t = server.transport;
  return t.kind === "stdio" ? [t.command, ...t.args].join(" ").trim() : t.url;
}

async function confirmLaunch(context: vscode.ExtensionContext, server: DiscoveredServer): Promise<boolean> {
  if (!isWorkspaceScoped(server.source) || context.workspaceState.get<boolean>(TRUST_LAUNCH_KEY)) {
    return true;
  }
  const choice = await vscode.window.showWarningMessage(
    `MCP Workbench: launch ${server.name} from this workspace?`,
    { modal: true, detail: `This runs a command defined in the workspace config.\n\n${launchTarget(server)}` },
    "Launch",
    "Always allow in this workspace",
  );
  if (choice === "Always allow in this workspace") {
    await context.workspaceState.update(TRUST_LAUNCH_KEY, true);
    return true;
  }
  return choice === "Launch";
}

async function showProbeError(name: string, error?: string, detail?: string): Promise<void> {
  const message = `MCP Workbench: ${name} did not respond — ${error ?? "unknown error"}`;
  if (!detail) {
    void vscode.window.showErrorMessage(message);
    return;
  }
  const choice = await vscode.window.showErrorMessage(message, "Show details");
  if (choice === "Show details") {
    void vscode.window.showErrorMessage(`${name} — details`, { modal: true, detail });
  }
}

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
