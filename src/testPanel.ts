import * as vscode from "vscode";
import { randomBytes } from "crypto";
import { DiscoveredServer } from "./types";
import { openSession, McpSession, TestFailure, TestSuccess, ToolSummary } from "./mcpClient";

let panel: vscode.WebviewPanel | undefined;
let session: McpSession | undefined;
let seq = 0;

export async function showTester(server: DiscoveredServer): Promise<void> {
  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      "mcpWorkbench.tester",
      "MCP Server Tester",
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.onDidDispose(() => {
      panel = undefined;
      void disposeSession();
    });
    panel.webview.onDidReceiveMessage((message) => void handleMessage(message));
  }

  const myId = ++seq;
  await disposeSession();
  if (!panel || myId !== seq) {
    return;
  }
  panel.title = `Test: ${server.name}`;
  panel.reveal(vscode.ViewColumn.Active);
  panel.webview.html = page(server.name, header(server, `<p class="status">Connecting…</p>`));

  const opened = await openSession(server);
  if (!panel || myId !== seq) {
    if (opened.ok) {
      await opened.session.dispose();
    }
    return;
  }
  if (!opened.ok) {
    panel.webview.html = page(server.name, failureBody(server, opened));
    return;
  }

  session = opened.session;
  const info = opened.session.info;
  panel.webview.html = page(
    server.name,
    header(server, `<p class="status ok">✓ Connected</p>`) +
      serverSection(info) +
      toolsSection(info.tools) +
      resourcesSection(info) +
      promptsSection(info),
    nonce(),
  );
}

async function disposeSession(): Promise<void> {
  if (!session) {
    return;
  }
  const current = session;
  session = undefined;
  await current.dispose();
}

async function handleMessage(message: any): Promise<void> {
  if (!message || typeof message.type !== "string") {
    return;
  }
  const current = session;
  const target = panel;
  if (!current || !target) {
    return;
  }
  if (message.type === "call") {
    await handleCall(current, target, message);
  } else if (message.type === "read") {
    await handleRead(current, target, message);
  } else if (message.type === "getPrompt") {
    await handleGetPrompt(current, target, message);
  }
}

async function handleCall(current: McpSession, target: vscode.WebviewPanel, message: any): Promise<void> {
  const idx = message.idx;
  if (!current.info.tools.some((t) => t.name === message.tool)) {
    target.webview.postMessage({ type: "result", idx, ok: false, error: "Unknown tool." });
    return;
  }

  let args: unknown;
  try {
    const raw = typeof message.args === "string" ? message.args.trim() : "";
    args = raw ? JSON.parse(raw) : {};
  } catch (e) {
    target.webview.postMessage({ type: "result", idx, ok: false, error: `Invalid JSON arguments: ${errorText(e)}` });
    return;
  }
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    target.webview.postMessage({ type: "result", idx, ok: false, error: "Arguments must be a JSON object." });
    return;
  }

  const result = await current.callTool(message.tool, args);
  if (session !== current || panel !== target) {
    return;
  }
  if (result.ok) {
    target.webview.postMessage({
      type: "result",
      idx,
      ok: true,
      isError: result.isError,
      blocks: result.content,
      structured: result.structuredContent,
    });
  } else {
    target.webview.postMessage({ type: "result", idx, ok: false, error: result.error, detail: result.detail });
  }
}

async function handleRead(current: McpSession, target: vscode.WebviewPanel, message: any): Promise<void> {
  const ridx = message.ridx;
  const uri = typeof message.uri === "string" ? message.uri.trim() : "";
  if (!uri) {
    target.webview.postMessage({ type: "readResult", ridx, ok: false, error: "No resource URI." });
    return;
  }
  const result = await current.readResource(uri);
  if (session !== current || panel !== target) {
    return;
  }
  if (result.ok) {
    target.webview.postMessage({ type: "readResult", ridx, ok: true, contents: result.contents });
  } else {
    target.webview.postMessage({ type: "readResult", ridx, ok: false, error: result.error, detail: result.detail });
  }
}

async function handleGetPrompt(current: McpSession, target: vscode.WebviewPanel, message: any): Promise<void> {
  const pidx = message.pidx;
  const name = typeof message.name === "string" ? message.name : "";
  if (!name || !current.info.prompts.some((p) => p.name === name)) {
    target.webview.postMessage({ type: "promptResult", pidx, ok: false, error: "Unknown prompt." });
    return;
  }
  const result = await current.getPrompt(name, stringRecord(message.args));
  if (session !== current || panel !== target) {
    return;
  }
  if (result.ok) {
    target.webview.postMessage({ type: "promptResult", pidx, ok: true, description: result.description, messages: result.messages });
  } else {
    target.webview.postMessage({ type: "promptResult", pidx, ok: false, error: result.error, detail: result.detail });
  }
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item === "string") {
        out[key] = item;
      }
    }
  }
  return out;
}

function failureBody(server: DiscoveredServer, result: TestFailure): string {
  return (
    header(server, `<p class="status fail">✗ Connection failed</p>`) +
    `<section class="error"><p>${esc(result.error)}</p>` +
    (result.detail ? `<pre class="detail">${esc(result.detail)}</pre>` : "") +
    `</section>` +
    `<p class="hint">Confirm the command or URL is correct, any referenced environment variables are set, and the server starts cleanly on its own.</p>`
  );
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
      (t, i) => `<li class="tool" data-idx="${i}" data-tool="${esc(t.name)}">
      <div class="tool-name">${esc(t.name)}</div>
      ${t.description ? `<div class="tool-desc">${esc(t.description)}</div>` : ""}
      <details><summary>Input schema</summary><pre>${esc(stringify(t.inputSchema))}</pre></details>
      <div class="call-row">
        <textarea class="args" rows="5" spellcheck="false" aria-label="Arguments for ${esc(t.name)}">${esc(argTemplate(t.inputSchema))}</textarea>
        <button class="call" type="button">Call tool</button>
      </div>
      <div class="result" hidden></div>
    </li>`,
    )
    .join("");
  return `<section><h2>Tools <span class="count">${tools.length}</span></h2>
  <p class="muted">Edit the arguments as JSON, then run the tool against the live server.</p>
  <ul class="tools">${items}</ul></section>`;
}

function resourcesSection(info: TestSuccess): string {
  const { resources, resourceTemplates } = info;
  if (!resources.length && !resourceTemplates.length) {
    return "";
  }
  const fixed = resources
    .map(
      (r, i) => `<li class="resource" data-ridx="r${i}" data-uri="${esc(r.uri)}">
      <div class="tool-name">${esc(r.title || r.name || r.uri)}</div>
      <code class="target">${esc(r.uri)}</code>
      ${r.description ? `<div class="tool-desc">${esc(r.description)}</div>` : ""}
      ${r.mimeType ? `<div class="muted">${esc(r.mimeType)}</div>` : ""}
      <div class="call-row"><button class="read" type="button">Read</button></div>
      <div class="result" hidden></div>
    </li>`,
    )
    .join("");
  const templates = resourceTemplates
    .map(
      (t, i) => `<li class="resource" data-ridx="t${i}">
      <div class="tool-name">${esc(t.title || t.name || t.uriTemplate)} <span class="count">template</span></div>
      ${t.description ? `<div class="tool-desc">${esc(t.description)}</div>` : ""}
      <div class="call-row">
        <input class="uri" type="text" spellcheck="false" value="${esc(t.uriTemplate)}" aria-label="Resource URI">
        <button class="read" type="button">Read</button>
      </div>
      <div class="result" hidden></div>
    </li>`,
    )
    .join("");
  const count = resources.length + resourceTemplates.length;
  return `<section><h2>Resources <span class="count">${count}</span></h2>
  <p class="muted">Read a resource's contents from the live server. Fill in any variables in a template URI before reading.</p>
  <ul class="tools">${fixed}${templates}</ul></section>`;
}

function promptsSection(info: TestSuccess): string {
  if (!info.prompts.length) {
    return "";
  }
  const items = info.prompts
    .map((p, i) => {
      const args = p.arguments
        .map(
          (a) => `<label class="parg-row"><span class="parg-name">${esc(a.name)}${a.required ? ' <span class="req">*</span>' : ""}</span>
        <input class="parg" data-arg="${esc(a.name)}" data-required="${a.required ? "true" : "false"}" type="text" spellcheck="false"${a.description ? ` placeholder="${esc(a.description)}"` : ""}></label>`,
        )
        .join("");
      return `<li class="prompt" data-pidx="${i}" data-name="${esc(p.name)}">
      <div class="tool-name">${esc(p.title || p.name)}</div>
      ${p.description ? `<div class="tool-desc">${esc(p.description)}</div>` : ""}
      ${args ? `<div class="pargs">${args}</div>` : ""}
      <div class="call-row"><button class="get" type="button">Get prompt</button></div>
      <div class="result" hidden></div>
    </li>`;
    })
    .join("");
  return `<section><h2>Prompts <span class="count">${info.prompts.length}</span></h2>
  <p class="muted">Fetch a prompt's messages from the live server, filling in any arguments.</p>
  <ul class="tools">${items}</ul></section>`;
}

function argTemplate(schema: unknown): string {
  if (!schema || typeof schema !== "object") {
    return "{}";
  }
  const props = (schema as { properties?: unknown }).properties;
  if (!props || typeof props !== "object") {
    return "{}";
  }
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(props as Record<string, unknown>)) {
    out[key] = sampleValue(def);
  }
  return stringify(out);
}

function sampleValue(def: unknown): unknown {
  if (!def || typeof def !== "object") {
    return null;
  }
  const d = def as { enum?: unknown[]; default?: unknown; type?: string };
  if (Array.isArray(d.enum) && d.enum.length) {
    return d.enum[0];
  }
  if (d.default !== undefined) {
    return d.default;
  }
  switch (d.type) {
    case "string":
      return "";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return null;
  }
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

function nonce(): string {
  return randomBytes(16).toString("hex");
}

function page(titleName: string, content: string, scriptNonce?: string): string {
  const csp = scriptNonce
    ? `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}';`
    : `default-src 'none'; style-src 'unsafe-inline';`;
  const script = scriptNonce ? `<script nonce="${scriptNonce}">${SCRIPT}</script>` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Test: ${esc(titleName)}</title>
<style>${STYLE}</style>
</head>
<body>${content}${script}</body>
</html>`;
}

const SCRIPT = `
const vscode = acquireVsCodeApi();
const MAX_OUTPUT = 100000;
function pre(text) {
  const el = document.createElement('pre');
  el.textContent = text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) + '  …(truncated, ' + text.length + ' characters)' : text;
  return el;
}
function note(cls, text) { const el = document.createElement('div'); el.className = cls; el.textContent = text; return el; }
function approxBytes(data) { return typeof data === 'string' ? Math.floor(data.length * 3 / 4) + ' bytes' : 'unknown size'; }
function renderBlock(out, block) {
  if (!block || typeof block !== 'object') { out.appendChild(pre(JSON.stringify(block, null, 2))); return; }
  if (block.type === 'text' && typeof block.text === 'string') { out.appendChild(pre(block.text)); return; }
  if (block.type === 'image' || block.type === 'audio') {
    out.appendChild(note('result-label', '[' + block.type + (block.mimeType ? ' · ' + block.mimeType : '') + ' · ' + approxBytes(block.data) + ']'));
    return;
  }
  if (block.type === 'resource' && block.resource && typeof block.resource === 'object') {
    const r = block.resource;
    out.appendChild(note('result-label', 'resource' + (r.uri ? ' · ' + r.uri : '') + (r.mimeType ? ' · ' + r.mimeType : '')));
    if (typeof r.text === 'string') { out.appendChild(pre(r.text)); }
    else { out.appendChild(note('muted', '[binary · ' + approxBytes(r.blob) + ']')); }
    return;
  }
  out.appendChild(pre(JSON.stringify(block, null, 2)));
}
function startResult(li, button) {
  const out = li.querySelector('.result');
  out.hidden = false;
  out.textContent = '';
  out.appendChild(note('running', button.dataset.busy || 'Working…'));
  button.disabled = true;
  return out;
}
function ready(li, buttonSelector) {
  const out = li.querySelector('.result');
  const button = li.querySelector(buttonSelector);
  if (button) { button.disabled = false; }
  out.hidden = false;
  out.textContent = '';
  return out;
}
for (const button of document.querySelectorAll('button.call')) {
  button.dataset.busy = 'Calling…';
  button.addEventListener('click', () => {
    const li = button.closest('.tool');
    startResult(li, button);
    vscode.postMessage({ type: 'call', idx: li.dataset.idx, tool: li.dataset.tool, args: li.querySelector('textarea.args').value });
  });
}
for (const button of document.querySelectorAll('button.read')) {
  button.dataset.busy = 'Reading…';
  button.addEventListener('click', () => {
    const li = button.closest('.resource');
    const input = li.querySelector('input.uri');
    const uri = input ? input.value.trim() : li.dataset.uri;
    startResult(li, button);
    vscode.postMessage({ type: 'read', ridx: li.dataset.ridx, uri: uri });
  });
}
for (const button of document.querySelectorAll('button.get')) {
  button.dataset.busy = 'Getting…';
  button.addEventListener('click', () => {
    const li = button.closest('.prompt');
    const args = {};
    let missing = null;
    for (const input of li.querySelectorAll('input.parg')) {
      const value = input.value;
      if (input.dataset.required === 'true' && !value.trim()) { missing = missing || input.dataset.arg; }
      if (value !== '') { args[input.dataset.arg] = value; }
    }
    if (missing) {
      const out = li.querySelector('.result');
      out.hidden = false; out.textContent = '';
      out.appendChild(note('result-error', 'Missing required argument: ' + missing));
      return;
    }
    startResult(li, button);
    vscode.postMessage({ type: 'getPrompt', pidx: li.dataset.pidx, name: li.dataset.name, args: args });
  });
}
window.addEventListener('message', (event) => {
  const m = event.data;
  if (!m) { return; }
  if (m.type === 'result') {
    const li = document.querySelector('.tool[data-idx="' + m.idx + '"]');
    if (!li) { return; }
    const out = ready(li, 'button.call');
    if (!m.ok) {
      out.appendChild(note('result-error', m.error || 'Call failed'));
      if (m.detail) { out.appendChild(pre(m.detail)); }
      return;
    }
    if (m.isError) { out.appendChild(note('result-error', 'Tool reported isError = true')); }
    const blocks = Array.isArray(m.blocks) ? m.blocks : [];
    if (!blocks.length && m.structured === undefined) {
      out.appendChild(note('muted', 'Tool returned no content.'));
    }
    for (const block of blocks) { renderBlock(out, block); }
    if (m.structured !== undefined) {
      out.appendChild(note('result-label', 'structuredContent'));
      out.appendChild(pre(JSON.stringify(m.structured, null, 2)));
    }
    return;
  }
  if (m.type === 'readResult') {
    const li = document.querySelector('.resource[data-ridx="' + m.ridx + '"]');
    if (!li) { return; }
    const out = ready(li, 'button.read');
    if (!m.ok) {
      out.appendChild(note('result-error', m.error || 'Read failed'));
      if (m.detail) { out.appendChild(pre(m.detail)); }
      return;
    }
    const contents = Array.isArray(m.contents) ? m.contents : [];
    if (!contents.length) { out.appendChild(note('muted', 'Resource is empty.')); }
    for (const content of contents) { renderBlock(out, { type: 'resource', resource: content }); }
    return;
  }
  if (m.type === 'promptResult') {
    const li = document.querySelector('.prompt[data-pidx="' + m.pidx + '"]');
    if (!li) { return; }
    const out = ready(li, 'button.get');
    if (!m.ok) {
      out.appendChild(note('result-error', m.error || 'Get failed'));
      if (m.detail) { out.appendChild(pre(m.detail)); }
      return;
    }
    if (m.description) { out.appendChild(note('result-label', m.description)); }
    const messages = Array.isArray(m.messages) ? m.messages : [];
    if (!messages.length) { out.appendChild(note('muted', 'Prompt returned no messages.')); }
    for (const message of messages) {
      out.appendChild(note('result-label', message && message.role ? message.role : 'message'));
      renderBlock(out, message ? message.content : null);
    }
    return;
  }
});
`;

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
.call-row { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
textarea.args, input.uri, input.parg { width: 100%; box-sizing: border-box; font-family: var(--vscode-editor-font-family); font-size: 0.85em; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; padding: 6px; }
textarea.args { resize: vertical; }
.pargs { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.parg-row { display: flex; flex-direction: column; gap: 2px; }
.parg-name { font-size: 0.8em; color: var(--vscode-descriptionForeground); }
.req { color: var(--vscode-errorForeground); }
button.call, button.read, button.get { align-self: flex-start; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; padding: 4px 14px; cursor: pointer; font-size: 0.85em; }
button.call:hover, button.read:hover, button.get:hover { background: var(--vscode-button-hoverBackground); }
button.call:disabled, button.read:disabled, button.get:disabled { opacity: 0.6; cursor: default; }
.result { margin-top: 10px; border-top: 1px solid var(--vscode-panel-border); padding-top: 8px; }
.running { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
.result-error { color: var(--vscode-errorForeground); font-weight: 600; margin-bottom: 6px; }
.result-label { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin: 8px 0 4px; }
pre { background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.1)); padding: 10px; border-radius: 4px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family); font-size: 0.85em; }
summary { cursor: pointer; color: var(--vscode-textLink-foreground); }
`;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
