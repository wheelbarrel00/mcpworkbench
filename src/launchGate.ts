import * as vscode from "vscode";
import { isWithinFolder } from "./executable";
import { isWorkspaceScoped, serverId } from "./serversTree";
import { LaunchTrustStore, displayName, launchAction, launchesWorkspaceFile, launchPreview, launchQuestion } from "./launchTrust";
import { DiscoveredServer } from "./types";

export const ALWAYS_ALLOW = "Always allow this configuration";
export const MANAGE_TRUST = "Manage Workspace Trust";
const LEGACY_TRUST_LAUNCH_KEY = "trustWorkspaceLaunch";

export async function confirmLaunch(launchTrust: LaunchTrustStore, server: DiscoveredServer): Promise<boolean> {
  const definedByWorkspace = isWorkspaceScoped(server.source);
  if (!definedByWorkspace && !runsInOpenWorkspace(server)) {
    return true;
  }
  if (!vscode.workspace.isTrusted) {
    const choice = await vscode.window.showWarningMessage(restrictedModeMessage(server), MANAGE_TRUST);
    if (choice === MANAGE_TRUST) {
      void vscode.commands.executeCommand("workbench.trust.manage");
    }
    return false;
  }
  if (!definedByWorkspace && !launchesWorkspaceFile(server)) {
    return true;
  }
  const id = serverId(server);
  if (launchTrust.isTrusted(id, server)) {
    return true;
  }
  const action = launchAction(server);
  const choice = await vscode.window.showWarningMessage(
    `MCP Workbench: ${launchQuestion(server)}`,
    {
      modal: true,
      detail: `${launchPreview(server)}\n\n"${ALWAYS_ALLOW}" skips this prompt until this entry changes.`,
    },
    action,
    ALWAYS_ALLOW,
  );
  if (choice === ALWAYS_ALLOW) {
    await launchTrust.trust(id, server);
    return true;
  }
  return choice === action;
}

export async function resetLaunchTrust(launchTrust: LaunchTrustStore): Promise<string> {
  const count = launchTrust.size;
  await launchTrust.reset();
  if (count === 0) {
    return "MCP Workbench: there were no trusted launch configurations in this workspace to clear.";
  }
  return `MCP Workbench: cleared ${count} trusted launch ${count === 1 ? "configuration" : "configurations"} in this workspace.`;
}

export function forgetLegacyLaunchTrust(memento: vscode.Memento): Thenable<void> | undefined {
  return memento.get(LEGACY_TRUST_LAUNCH_KEY) === undefined ? undefined : memento.update(LEGACY_TRUST_LAUNCH_KEY, undefined);
}

function runsInOpenWorkspace(server: DiscoveredServer): boolean {
  const dir = server.projectDir;
  if (server.transport.kind !== "stdio" || !dir) {
    return false;
  }
  return (vscode.workspace.workspaceFolders ?? []).some((folder) => isWithinFolder(dir, folder.uri.fsPath));
}

function restrictedModeMessage(server: DiscoveredServer): string {
  const name = displayName(server);
  return server.transport.kind === "stdio"
    ? `MCP Workbench: ${name} would run code from this workspace, which is open in Restricted Mode. Trust the workspace to launch it.`
    : `MCP Workbench: ${name} is defined by this workspace, which is open in Restricted Mode. Trust the workspace to connect to it.`;
}
