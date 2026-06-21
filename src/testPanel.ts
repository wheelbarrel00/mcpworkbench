import * as vscode from "vscode";
import { DiscoveredServer } from "./types";
import { testServer, TestResult, TestSuccess, ToolSummary } from "./mcpClient";

let panel: vscode.WebviewPanel | undefined;
let activeServer: DiscoveredServer | undefined;

export async function showTester(server: DiscoveredServer): Promise<void> {
  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      "mcpWorkbench.tester",
      "MCP Server Tester",
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: false, retainContextWhenHidden: true },
    );
    panel.onDidDispose(() => {
      panel = undefined;
      activeServer = undefined;
    });
  }

  activeServer = server;
  panel.title = `Test: ${server.name}`;
  panel.reveal(vscode.ViewColumn.Active);
  panel.webview.html = page(server, header(server, `<p class="status">Connecting…</p>`));

  const result = await testServer(server);
  if (!panel || activeServer !== server) {
    return;
  }
  panel.webview.html = page(server, body(server, result));
}

function body(server: DiscoveredServer, result: TestResult): string {
  if (!result.ok) {
    return (
      header(server, `<p class="status fail">✗ Connection failed</p>`) +
      `<section class="error"><p>${esc(result.error)}</p>` +
      (result.detail ? `<pre class="detail">${esc(result.detail)}</pre>` : "") +
      `</section>` +
      `<p class="hint">Confirm the command or URL is correct, any referenced environment variables are set, and the server starts cleanly on its own.</p>`
    );
  }
  return header(server, `<p class="status ok">✓ Connected</p>`) + serverSection(result) + toolsSection(result.tools);
}

function header(server: DiscoveredServer, status: string): string {
  return `<header>
  <h1>${esc(server.name)}</h1>
  <div class="badges">
    <span class="badge">${esc(server.transport.kind)}</span>
    <span class="badge">${esc(server.source)}</span>
  </div>
  <code class="target">${esc(target(server))}</code>
  ${status}
</header>`;
}

function serverSection(result: TestSuccess): string {
  const info = result.serverInfo;
  const caps = result.capabilities && typeof result.capabilities === "object"
    ? Object.keys(result.capabilities as Record<string, unknown>)
    : [];
  return `<section>
  <h2>Server</h2>
  <dl>
    <dt>Name</dt><dd>${info ? esc(info.name) : "—"}</dd>
    <dt>Version</dt><dd>${info ? esc(info.version) : "—"}</dd>
    <dt>Capabilities</dt><dd>${caps.length ? caps.map((c) => `<span class="badge">${esc(c)}</span>`).join(" ") : "—"}</dd>
  </dl>
  ${result.instructions ? `<details><summary>Instructions</summary><pre>${esc(result.instructions)}</pre></details>` : ""}
</section>`;
}

function toolsSection(tools: ToolSummary[]): string {
  if (!tools.length) {
    return `<section><h2>Tools</h2><p class="muted">This server exposes no tools.</p></section>`;
  }
  const items = tools
    .map(
      (t) => `<li>
      <div class="tool-name">${esc(t.name)}</div>
      ${t.description ? `<div class="tool-desc">${esc(t.description)}</div>` : ""}
      <details><summary>Input schema</summary><pre>${esc(stringify(t.inputSchema))}</pre></details>
    </li>`,
    )
    .join("");
  return `<section><h2>Tools <span class="count">${tools.length}</span></h2><ul class="tools">${items}</ul></section>`;
}

function target(server: DiscoveredServer): string {
  const t = server.transport;
  return t.kind === "stdio" ? [t.command, ...t.args].join(" ").trim() : t.url;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

function page(server: DiscoveredServer, content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<title>Test: ${esc(server.name)}</title>
<style>${STYLE}</style>
</head>
<body>${content}</body>
</html>`;
}

const STYLE = `
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 16px 24px; }
header { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 12px; margin-bottom: 16px; }
h1 { font-size: 1.4em; margin: 16px 0 8px; }
h2 { font-size: 1.05em; margin: 22px 0 8px; }
.badges { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
.badge { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 4px; padding: 1px 8px; font-size: 0.8em; }
.target { display: block; color: var(--vscode-descriptionForeground); font-size: 0.85em; word-break: break-all; }
.status { font-weight: 600; margin: 10px 0 0; }
.status.ok { color: var(--vscode-charts-green, #3fb950); }
.status.fail { color: var(--vscode-errorForeground); }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; }
dt { color: var(--vscode-descriptionForeground); }
dd { margin: 0; }
.error { border-left: 3px solid var(--vscode-errorForeground); padding: 8px 12px; background: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,0.06)); }
.detail { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin: 6px 0 0; }
.hint, .muted { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
.tools { list-style: none; padding: 0; margin: 0; }
.tools li { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px 12px; margin-bottom: 8px; }
.tool-name { font-weight: 600; font-family: var(--vscode-editor-font-family); }
.tool-desc { color: var(--vscode-descriptionForeground); margin: 4px 0; font-size: 0.9em; }
.count { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 8px; padding: 0 8px; font-size: 0.75em; vertical-align: middle; }
pre { background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.1)); padding: 10px; border-radius: 4px; overflow-x: auto; font-family: var(--vscode-editor-font-family); font-size: 0.85em; }
summary { cursor: pointer; color: var(--vscode-textLink-foreground); }
`;
