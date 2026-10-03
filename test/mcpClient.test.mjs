import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { createRequire } from "node:module";
import { build } from "esbuild";

const tempDirs = [];

function mkTemp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const require = createRequire(import.meta.url);

const bundlePath = path.join(mkTemp("mcpwb-client-"), "mcpClient.cjs");
await build({
  entryPoints: [path.resolve("src/mcpClient.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: bundlePath,
  logLevel: "silent",
});

const { createTransport, testServer, openSession, probe } = require(bundlePath);

const echoServerPath = path.join(mkTemp("mcpwb-echo-"), "echo-server.cjs");
await build({
  entryPoints: [path.resolve("test/fixtures/echo-server.mjs")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: echoServerPath,
  logLevel: "silent",
});

const stubbornServerPath = path.join(mkTemp("mcpwb-stubborn-"), "stubborn-server.cjs");
await build({
  entryPoints: [path.resolve("test/fixtures/stubborn-server.mjs")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: stubbornServerPath,
  logLevel: "silent",
});

const stderrServerPath = path.join(mkTemp("mcpwb-stderr-"), "stderr-server.cjs");
await build({
  entryPoints: [path.resolve("test/fixtures/stderr-server.mjs")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: stderrServerPath,
  logLevel: "silent",
});

async function buildFixture(name) {
  const outfile = path.join(mkTemp(`mcpwb-${name}-`), `${name}.cjs`);
  await build({
    entryPoints: [path.resolve(`test/fixtures/${name}.mjs`)],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node18",
    outfile,
    logLevel: "silent",
  });
  return outfile;
}

const toolsErrorServerPath = await buildFixture("tools-error-server");
const barrierServerPath = await buildFixture("barrier-server");
const progressServerPath = await buildFixture("progress-server");
const pagedServerPath = await buildFixture("paged-server");
const resourcesOnlyServerPath = await buildFixture("resources-only-server");

function pagedTarget(name, env) {
  const target = stdioTarget(name, pagedServerPath);
  target.transport.env = env;
  return target;
}

function stdioTarget(name, serverPath) {
  return {
    name,
    transport: { kind: "stdio", command: process.execPath, args: [serverPath], env: {} },
    source: "cursor-workspace",
    configPath: path.join(os.tmpdir(), "mcp.json"),
    rootKey: "mcpServers",
    raw: {},
    issues: [],
  };
}

function stdioServer(env) {
  return {
    name: "demo",
    transport: { kind: "stdio", command: "node", args: ["--version"], env },
    source: "cursor-workspace",
    configPath: path.join(os.tmpdir(), "mcp.json"),
    rootKey: "mcpServers",
    raw: {},
    issues: [],
  };
}

test("the server inherits the host environment, with its configured env layered on top", () => {
  process.env.MCPWB_TOKEN = "tok";
  process.env.MCPWB_SECRET = "from-host";
  process.env.MCPWB_HOST_ONLY = "host";
  try {
    const transport = createTransport(stdioServer({ API_KEY: "${env:MCPWB_TOKEN}", LITERAL: "plain", MCPWB_SECRET: "from-config" }));
    const passed = transport._serverParams.env;
    assert.equal(passed.API_KEY, "tok");
    assert.equal(passed.LITERAL, "plain");
    assert.equal(passed.MCPWB_SECRET, "from-config");
    assert.equal(passed.MCPWB_HOST_ONLY, "host");
    assert.ok(Object.keys(passed).some((key) => key.toUpperCase() === "PATH"), "the host PATH is passed through");
  } finally {
    delete process.env.MCPWB_SECRET;
    delete process.env.MCPWB_HOST_ONLY;
  }
});

test("a Claude Desktop server gets only its configured env on top of the SDK's minimal set", () => {
  process.env.MCPWB_SECRET = "should-not-leak";
  try {
    const transport = createTransport({ ...stdioServer({ A: "1" }), source: "claude-desktop" });
    assert.deepEqual(transport._serverParams.env, { A: "1" });
  } finally {
    delete process.env.MCPWB_SECRET;
  }
});

test("a Claude Code server is told its project folder through CLAUDE_PROJECT_DIR unless the config sets it", () => {
  const project = mkTemp("mcpwb-proj-");
  const claude = { ...stdioServer({}), source: "claude-code-workspace", projectDir: project };
  assert.equal(createTransport(claude)._serverParams.env.CLAUDE_PROJECT_DIR, project);
  assert.equal(createTransport(claude)._serverParams.env.CLAUDECODE, "1");

  const overridden = { ...stdioServer({ CLAUDE_PROJECT_DIR: "/elsewhere" }), source: "claude-code-workspace", projectDir: project };
  assert.equal(createTransport(overridden)._serverParams.env.CLAUDE_PROJECT_DIR, "/elsewhere");

  const cursor = { ...stdioServer({}), projectDir: project };
  assert.notEqual(createTransport(cursor)._serverParams.env.CLAUDE_PROJECT_DIR, project);
});

test("on Windows a configured variable replaces the host's under any casing and leaves one entry", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  process.env.MCPWB_MIXED = "host";
  try {
    const passed = createTransport(stdioServer({ path: "C:/only", MCPWB_mixed: "config" }))._serverParams.env;
    const pathKeys = Object.keys(passed).filter((key) => key.toUpperCase() === "PATH");
    assert.deepEqual(pathKeys, ["PATH"], "the SDK adds PATH in upper case, so the override must use that spelling");
    assert.equal(passed.PATH, "C:/only");
    const mixedKeys = Object.keys(passed).filter((key) => key.toUpperCase() === "MCPWB_MIXED");
    assert.deepEqual(mixedKeys, ["MCPWB_mixed"]);
    assert.equal(passed.MCPWB_mixed, "config");
  } finally {
    Object.defineProperty(process, "platform", platform);
    delete process.env.MCPWB_MIXED;
  }
});

test("the editor's own ELECTRON_RUN_AS_NODE is not passed on to the server", () => {
  process.env.ELECTRON_RUN_AS_NODE = "1";
  try {
    const passed = createTransport(stdioServer({}))._serverParams.env;
    assert.equal(Object.keys(passed).some((key) => key.toUpperCase() === "ELECTRON_RUN_AS_NODE"), false);
  } finally {
    delete process.env.ELECTRON_RUN_AS_NODE;
  }
});

test("on Windows a Claude Desktop config's own Path is the one the server gets", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    const passed = createTransport({ ...stdioServer({ Path: "C:/desk" }), source: "claude-desktop" })._serverParams.env;
    assert.deepEqual(passed, { PATH: "C:/desk" });
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});

test("a command that still contains a variable after filling in is never run", async () => {
  delete process.env.MCPWB_UNSET_TOOLS;
  const server = {
    ...stdioServer({}),
    source: "claude-code-workspace",
    projectDir: mkTemp("mcpwb-proj-"),
    transport: { kind: "stdio", command: "${MCPWB_UNSET_TOOLS}/helper", args: [], env: {} },
  };
  const result = await testServer(server, 400);
  assert.equal(result.ok, false);
  assert.match(result.error, /won't run "\$\{MCPWB_UNSET_TOOLS\}\/helper" because it still contains "\$\{" after variables are filled in/);
});

test("Claude Code expands only identifier names, and a default runs to the first closing brace", () => {
  process.env.MCPWB_CC_SET = "set-value";
  delete process.env.MCPWB_CC_UNSET;
  try {
    const server = {
      ...stdioServer({}),
      source: "claude-code-workspace",
      transport: {
        kind: "stdio",
        command: "node",
        args: ["${MCPWB_CC(x86)}", '${MCPWB_CC_UNSET:-{"a":1}}', "${MCPWB_CC_UNSET:-${MCPWB_CC_SET}}", "${my-var}", "${MCPWB_CC_SET}"],
        env: {},
      },
    };
    assert.deepEqual(createTransport(server)._serverParams.args, ["${MCPWB_CC(x86)}", '{"a":1}', "${MCPWB_CC_SET}", "${my-var}", "set-value"]);
  } finally {
    delete process.env.MCPWB_CC_SET;
  }
});

test("Claude Code reads its documented credentials as empty in a remote server's url and headers, but not for a local program", () => {
  process.env.NPM_TOKEN = "npm_real";
  process.env.ANTHROPIC_API_KEY = "sk-ant-real";
  try {
    const remote = createTransport({
      name: "remote",
      source: "claude-code-workspace",
      configPath: path.join(os.tmpdir(), ".mcp.json"),
      rootKey: "mcpServers",
      raw: {},
      issues: [],
      transport: { kind: "http", url: "https://mcp.example.com/mcp?k=${ANTHROPIC_API_KEY:-none}", headers: { Authorization: "Bearer ${NPM_TOKEN}" } },
    });
    assert.equal(remote._url.searchParams.get("k"), "");
    assert.equal(remote._requestInit.headers.Authorization, "Bearer ");

    const local = createTransport({ ...stdioServer({ T: "${NPM_TOKEN}" }), source: "claude-code-workspace" });
    assert.equal(local._serverParams.env.T, "npm_real");
  } finally {
    delete process.env.NPM_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test("a spawned server actually sees a variable it inherited from the host", { timeout: 10000 }, async () => {
  const script = path.join(mkTemp("mcpwb-envprobe-"), "env-probe.cjs");
  fs.writeFileSync(script, "process.stderr.write('inherited=' + process.env.MCPWB_INHERITED_ONLY + '\\n');\nsetTimeout(() => process.exit(1), 50);\n");
  process.env.MCPWB_INHERITED_ONLY = "yes";
  try {
    const result = await testServer(stdioTarget("env-probe", script), 3000);
    assert.equal(result.ok, false);
    assert.match(result.detail, /inherited=yes/);
  } finally {
    delete process.env.MCPWB_INHERITED_ONLY;
  }
});

test("an unset variable reaches the server as written for Claude Code and as an empty value for VS Code", () => {
  delete process.env.MCPWB_UNSET_ANYWHERE;
  const claude = createTransport({ ...stdioServer({ A: "${MCPWB_UNSET_ANYWHERE}", B: "${MCPWB_UNSET_ANYWHERE:-fallback}" }), source: "claude-code-workspace" });
  assert.equal(claude._serverParams.env.A, "${MCPWB_UNSET_ANYWHERE}");
  assert.equal(claude._serverParams.env.B, "fallback");

  const vscode = createTransport({ ...stdioServer({ A: "${env:MCPWB_UNSET_ANYWHERE}", B: "${MCPWB_UNSET_ANYWHERE}" }), source: "vscode-workspace" });
  assert.equal(vscode._serverParams.env.A, "");
  assert.equal(vscode._serverParams.env.B, "${MCPWB_UNSET_ANYWHERE}");
});

test("each editor expands only its own syntax", () => {
  process.env.MCPWB_SYNTAX = "value";
  try {
    const values = ["${MCPWB_SYNTAX}", "${env:MCPWB_SYNTAX}"];
    const expand = (source) => createTransport({ ...stdioServer({}), transport: { kind: "stdio", command: "node", args: values, env: {} }, source })._serverParams.args;
    assert.deepEqual(expand("claude-code-workspace"), ["value", "${env:MCPWB_SYNTAX}"]);
    assert.deepEqual(expand("vscode-workspace"), ["${MCPWB_SYNTAX}", "value"]);
    assert.deepEqual(expand("cursor-workspace"), ["${MCPWB_SYNTAX}", "value"]);
    assert.deepEqual(expand("claude-desktop"), values);
  } finally {
    delete process.env.MCPWB_SYNTAX;
  }
});

test("a VS Code input is filled from the values given at launch and fails clearly without one", async () => {
  const server = { ...stdioServer({ KEY: "${input:api-key}" }), source: "vscode-workspace" };
  assert.equal(createTransport(server, new Map([["api-key", "s3cret"]]))._serverParams.env.KEY, "s3cret");
  const result = await testServer(server, 400);
  assert.equal(result.ok, false);
  assert.match(result.error, /\$\{input:api-key\} has no value/);
});

test("a variable only VS Code can resolve stops the launch with a clear error", async () => {
  const server = { ...stdioServer({}), transport: { kind: "stdio", command: "node", args: ["${command:pick}"], env: {} }, source: "vscode-workspace" };
  const result = await testServer(server, 400);
  assert.equal(result.ok, false);
  assert.match(result.error, /Only VS Code can fill in \$\{command:pick\}, so MCP Workbench won't launch this server/);
});

test("Cursor fills in the workspace folder name and the path separator", () => {
  const project = path.join(mkTemp("mcpwb-proj-"), "my-proj");
  fs.mkdirSync(project);
  const server = {
    ...stdioServer({}),
    transport: { kind: "stdio", command: "node", args: ["${workspaceFolderBasename}", "a${pathSeparator}b${/}c"], env: {} },
    projectDir: project,
  };
  assert.deepEqual(createTransport(server)._serverParams.args, ["my-proj", `a${path.sep}b${path.sep}c`]);
});

test("editor variables expand across command, args, and env for the tester", () => {
  const proj = mkTemp("mcpwb-proj-");
  const server = {
    name: "demo",
    transport: {
      kind: "stdio",
      command: "${workspaceFolder}/bin/node",
      args: ["${workspaceFolder}/server.js", "${userHome}/cfg"],
      env: { WS: "${workspaceFolder}" },
    },
    projectDir: proj,
    source: "cursor-workspace",
    configPath: path.join(os.tmpdir(), "mcp.json"),
    rootKey: "mcpServers",
    raw: {},
    issues: [],
  };
  const transport = createTransport(server);
  assert.equal(transport._serverParams.command, proj + "/bin/node");
  assert.deepEqual(transport._serverParams.args, [proj + "/server.js", os.homedir() + "/cfg"]);
  assert.equal(transport._serverParams.env.WS, proj);
});

test("dollar sequences in the workspace path are substituted literally, not as replacement patterns", () => {
  const proj = "C:/dev/a$$b$&c$`d$'e";
  const server = {
    name: "demo",
    transport: { kind: "stdio", command: "${workspaceFolder}/node", args: ["${workspaceFolder}/server.js"], env: { WS: "${workspaceFolder}" } },
    projectDir: proj,
    source: "cursor-workspace",
    configPath: path.join(os.tmpdir(), "mcp.json"),
    rootKey: "mcpServers",
    raw: {},
    issues: [],
  };
  const transport = createTransport(server);
  assert.equal(transport._serverParams.command, proj + "/node");
  assert.deepEqual(transport._serverParams.args, [proj + "/server.js"]);
  assert.equal(transport._serverParams.env.WS, proj);
});

test("${workspaceFolder} in a config with no project folder stops the launch instead of becoming empty", async () => {
  const server = {
    name: "demo",
    transport: { kind: "stdio", command: "node", args: ["${workspaceFolder}/x.js"], env: {} },
    source: "cursor-global",
    configPath: path.join(os.tmpdir(), "mcp.json"),
    rootKey: "mcpServers",
    raw: {},
    issues: [],
  };
  const result = await testServer(server, 400);
  assert.equal(result.ok, false);
  assert.match(result.error, /isn't tied to a project folder, so MCP Workbench can't fill in \$\{workspaceFolder\}/);
});

test("VS Code's older workspaceRoot names are filled in like their current ones", () => {
  const project = path.join(mkTemp("mcpwb-proj-"), "legacy");
  fs.mkdirSync(project);
  const server = {
    ...stdioServer({}),
    source: "vscode-workspace",
    projectDir: project,
    transport: { kind: "stdio", command: "node", args: ["${workspaceRoot}", "${workspaceRootFolderName}"], env: {} },
  };
  assert.deepEqual(createTransport(server)._serverParams.args, [project, "legacy"]);
});

test("an env var name with parentheses expands in the command", () => {
  process.env["MCPWB_PF(x86)"] = "C:/PF86";
  const server = {
    name: "demo",
    transport: { kind: "stdio", command: "${env:MCPWB_PF(x86)}/app", args: [], env: {} },
    source: "cursor-workspace",
    configPath: path.join(os.tmpdir(), "mcp.json"),
    rootKey: "mcpServers",
    raw: {},
    issues: [],
  };
  const transport = createTransport(server);
  assert.equal(transport._serverParams.command, "C:/PF86/app");
});

test("editor variables expand inside a remote server url", () => {
  process.env.MCPWB_HOST = "example.com";
  const server = {
    name: "demo",
    transport: { kind: "http", url: "https://${env:MCPWB_HOST}/mcp", headers: {} },
    source: "cursor-workspace",
    configPath: path.join(os.tmpdir(), "mcp.json"),
    rootKey: "mcpServers",
    raw: {},
    issues: [],
  };
  const transport = createTransport(server);
  assert.equal(transport._url.href, "https://example.com/mcp");
});

test("the spawned server cwd defaults to an existing project dir", () => {
  const dir = mkTemp("mcpwb-proj-");
  const transport = createTransport({ ...stdioServer({}), projectDir: dir });
  assert.equal(transport._serverParams.cwd, dir);
});

test("a non-existent project dir is ignored, leaving cwd unset", () => {
  const transport = createTransport({ ...stdioServer({}), projectDir: path.join(os.tmpdir(), "mcpwb-missing-zzz-99") });
  assert.equal(transport._serverParams.cwd, undefined);
});

test("openSession lists tools and a live tools/call returns the result", { timeout: 15000 }, async () => {
  const server = {
    name: "echo",
    transport: { kind: "stdio", command: process.execPath, args: [echoServerPath], env: {} },
    source: "cursor-workspace",
    configPath: path.join(os.tmpdir(), "mcp.json"),
    rootKey: "mcpServers",
    raw: {},
    issues: [],
  };
  const opened = await openSession(server, 12000);
  assert.equal(opened.ok, true);
  try {
    assert.ok(opened.session.info.tools.some((t) => t.name === "echo"));
    const result = await opened.session.callTool("echo", { message: "hello world" });
    assert.equal(result.ok, true);
    assert.equal(result.isError, false);
    const text = result.content.map((b) => (b && b.type === "text" ? b.text : "")).join("");
    assert.match(text, /echo: hello world/);
  } finally {
    await opened.session.dispose();
  }
});

test("openSession lists resources and prompts and can read and get them", { timeout: 15000 }, async () => {
  const server = {
    name: "echo",
    transport: { kind: "stdio", command: process.execPath, args: [echoServerPath], env: {} },
    source: "cursor-workspace",
    configPath: path.join(os.tmpdir(), "mcp.json"),
    rootKey: "mcpServers",
    raw: {},
    issues: [],
  };
  const opened = await openSession(server, 12000);
  assert.equal(opened.ok, true);
  try {
    const info = opened.session.info;
    assert.ok(info.resources.some((r) => r.uri === "echo://greeting"));
    assert.ok(info.resourceTemplates.some((t) => t.uriTemplate === "echo://item/{id}"));
    assert.ok(info.prompts.some((p) => p.name === "greet"));

    const read = await opened.session.readResource("echo://greeting");
    assert.equal(read.ok, true);
    const text = read.contents.map((c) => (c && typeof c.text === "string" ? c.text : "")).join("");
    assert.match(text, /hello from resource/);

    const prompt = await opened.session.getPrompt("greet", { name: "Ada" });
    assert.equal(prompt.ok, true);
    const messageText = prompt.messages
      .map((m) => (m && m.content && m.content.type === "text" ? m.content.text : ""))
      .join("");
    assert.match(messageText, /Hello, Ada/);
  } finally {
    await opened.session.dispose();
  }
});

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

async function waitUntilDead(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

test("disposing a session terminates a server that ignores stdin-EOF", { timeout: 20000 }, async () => {
  const pidFile = path.join(mkTemp("mcpwb-pid-"), "pid");
  const server = {
    name: "stubborn",
    transport: { kind: "stdio", command: process.execPath, args: [stubbornServerPath], env: { MCPWB_PID_FILE: pidFile } },
    source: "cursor-workspace",
    configPath: path.join(os.tmpdir(), "mcp.json"),
    rootKey: "mcpServers",
    raw: {},
    issues: [],
  };
  const opened = await openSession(server, 12000);
  assert.equal(opened.ok, true);

  const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  assert.ok(Number.isInteger(pid) && pid > 0);
  assert.equal(isAlive(pid), true, "server child should be running before dispose");

  await opened.session.dispose();

  assert.equal(await waitUntilDead(pid, 8000), true, "server child must not be orphaned after dispose");
});

test("on Windows, disposing a session kills the whole process tree, not just the direct child", { timeout: 20000, skip: process.platform !== "win32" }, async () => {
  const dir = mkTemp("mcpwb-tree-");
  const pidFile = path.join(dir, "pid");
  const childPidFile = path.join(dir, "child-pid");
  const server = {
    name: "tree",
    transport: {
      kind: "stdio",
      command: process.execPath,
      args: [stubbornServerPath],
      env: { MCPWB_PID_FILE: pidFile, MCPWB_CHILD_PID_FILE: childPidFile },
    },
    source: "cursor-workspace",
    configPath: path.join(os.tmpdir(), "mcp.json"),
    rootKey: "mcpServers",
    raw: {},
    issues: [],
  };
  const opened = await openSession(server, 12000);
  assert.equal(opened.ok, true);

  const grandchildPid = Number(fs.readFileSync(childPidFile, "utf8").trim());
  assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);
  assert.equal(isAlive(grandchildPid), true, "grandchild should be running before dispose");

  await opened.session.dispose();

  assert.equal(await waitUntilDead(grandchildPid, 8000), true, "grandchild must be killed by the process-tree teardown");
});

function stderrServer() {
  return {
    name: "stderr",
    transport: { kind: "stdio", command: process.execPath, args: [stderrServerPath], env: {} },
    source: "cursor-workspace",
    configPath: path.join(os.tmpdir(), "mcp.json"),
    rootKey: "mcpServers",
    raw: {},
    issues: [],
  };
}

test("a multibyte stderr char split across chunks is decoded without corruption in the failure detail", { timeout: 15000 }, async () => {
  const opened = await openSession(stderrServer(), 1500);
  assert.equal(opened.ok, true);
  try {
    const result = await opened.session.callTool("hang", {});
    assert.equal(result.ok, false);
    assert.ok(result.detail, "a timed-out call should carry the stderr tail as detail");
    assert.ok(result.detail.includes("€"), "the euro sign should be reassembled across chunk boundaries");
    assert.equal(result.detail.includes("�"), false, "no replacement character should leak from split multibyte bytes");
  } finally {
    await opened.session.dispose();
  }
});

function pidStubbornServer(pidFile) {
  return {
    name: "stubborn",
    transport: { kind: "stdio", command: process.execPath, args: [stubbornServerPath], env: { MCPWB_PID_FILE: pidFile } },
    source: "cursor-workspace",
    configPath: path.join(os.tmpdir(), "mcp.json"),
    rootKey: "mcpServers",
    raw: {},
    issues: [],
  };
}

test("onClosed fires exactly once when the server dies mid-session", { timeout: 20000 }, async () => {
  const pidFile = path.join(mkTemp("mcpwb-onclose-"), "pid");
  let closedCount = 0;
  let signalClosed;
  const closed = new Promise((resolve) => {
    signalClosed = resolve;
  });
  const opened = await openSession(pidStubbornServer(pidFile), 12000, {
    onClosed: () => {
      closedCount++;
      signalClosed();
    },
  });
  assert.equal(opened.ok, true);

  const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  assert.ok(Number.isInteger(pid) && pid > 0);
  process.kill(pid);

  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("onClosed never fired")), 8000)),
  ]);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(closedCount, 1, "onClosed must fire once for an unexpected death");

  await opened.session.dispose();
});

test("a deliberate dispose does not fire onClosed", { timeout: 15000 }, async () => {
  const server = {
    name: "echo",
    transport: { kind: "stdio", command: process.execPath, args: [echoServerPath], env: {} },
    source: "cursor-workspace",
    configPath: path.join(os.tmpdir(), "mcp.json"),
    rootKey: "mcpServers",
    raw: {},
    issues: [],
  };
  let closedCount = 0;
  const opened = await openSession(server, 12000, {
    onClosed: () => {
      closedCount++;
    },
  });
  assert.equal(opened.ok, true);
  await opened.session.dispose();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(closedCount, 0, "the closing guard must suppress onClosed during a deliberate teardown");
});

test("probe reports a reachable server with its tool count and a non-negative latency", { timeout: 15000 }, async () => {
  const server = {
    name: "echo",
    transport: { kind: "stdio", command: process.execPath, args: [echoServerPath], env: {} },
    source: "cursor-workspace",
    configPath: path.join(os.tmpdir(), "mcp.json"),
    rootKey: "mcpServers",
    raw: {},
    issues: [],
  };
  const result = await probe(server, 12000);
  assert.equal(result.ok, true);
  assert.ok(result.toolCount >= 1);
  assert.equal(typeof result.latencyMs, "number");
  assert.ok(result.latencyMs >= 0);
});

test("probe of an unlaunchable command fails without throwing and reports an error", { timeout: 10000 }, async () => {
  const server = {
    name: "broken",
    transport: { kind: "stdio", command: "mcpwb-nonexistent-binary-zzz", args: [], env: {} },
    source: "cursor-workspace",
    configPath: path.join(os.tmpdir(), "mcp.json"),
    rootKey: "mcpServers",
    raw: {},
    issues: [],
  };
  const result = await probe(server, 5000);
  assert.equal(result.ok, false);
  assert.equal(typeof result.latencyMs, "number");
  assert.equal(typeof result.error, "string");
  assert.ok(result.error.length > 0);
});

test("an unlaunchable command surfaces a PATH hint in the failure detail", { timeout: 10000 }, async () => {
  const server = {
    name: "broken",
    transport: { kind: "stdio", command: "mcpwb-nonexistent-binary-zzz", args: [], env: {} },
    source: "cursor-workspace",
    configPath: path.join(os.tmpdir(), "mcp.json"),
    rootKey: "mcpServers",
    raw: {},
    issues: [],
  };
  const result = await testServer(server, 5000);
  assert.equal(result.ok, false);
  assert.ok(result.detail, "an ENOENT failure should carry a detail");
  assert.match(result.detail, /PATH/);
});

test("post-connect list calls run concurrently rather than sequentially", { timeout: 12000 }, async () => {
  const start = Date.now();
  const opened = await openSession(stdioTarget("barrier", barrierServerPath), 4000);
  const elapsed = Date.now() - start;
  assert.equal(opened.ok, true);
  assert.ok(elapsed < 2500, `expected concurrent list calls, but openSession took ${elapsed}ms`);
  await opened.session.dispose();
});

test("a failing tools/list keeps the session open and reports the error instead of an empty list", { timeout: 8000 }, async () => {
  const opened = await openSession(stdioTarget("tools-error", toolsErrorServerPath), 2000);
  assert.equal(opened.ok, true);
  assert.deepEqual(opened.session.info.tools, []);
  assert.match(opened.session.info.listProblems.tools.error, /tools listing exploded/);
  await opened.session.dispose();
});

test("lists follow nextCursor across pages, in the tester and in Test Connection", { timeout: 15000 }, async () => {
  const opened = await openSession(stdioTarget("paged", pagedServerPath), 8000);
  assert.equal(opened.ok, true);
  try {
    const info = opened.session.info;
    assert.equal(info.tools.length, 25);
    assert.equal(info.tools[24].name, "tool-24");
    assert.equal(info.resources.length, 25);
    assert.equal(info.resourceTemplates.length, 25);
    assert.equal(info.prompts.length, 25);
    assert.deepEqual(info.listProblems, {});
  } finally {
    await opened.session.dispose();
  }
  const probed = await probe(stdioTarget("paged", pagedServerPath), 8000);
  assert.equal(probed.ok, true);
  assert.equal(probed.toolCount, 25);
});

test("tools on every page keep their output-schema validation", { timeout: 15000 }, async () => {
  const opened = await openSession(pagedTarget("schema", { MCPWB_OUTPUT_SCHEMA: "1" }), 8000);
  assert.equal(opened.ok, true);
  try {
    for (const name of ["tool-0", "tool-24"]) {
      const result = await opened.session.callTool(name, {});
      assert.equal(result.ok, false, `${name} should fail its output schema`);
      assert.match(result.error, /output schema/);
    }
  } finally {
    await opened.session.dispose();
  }
});

test("a server that repeats a page cursor stops listing with an error instead of repeating pages", { timeout: 15000 }, async () => {
  const opened = await openSession(pagedTarget("repeat", { MCPWB_REPEAT: "1" }), 8000);
  assert.equal(opened.ok, true);
  try {
    const { tools, listProblems } = opened.session.info;
    assert.equal(tools.length, 2);
    assert.match(listProblems.tools.error, /same page cursor twice/);
  } finally {
    await opened.session.dispose();
  }
});

test("listing shares one time limit across all its pages", { timeout: 15000 }, async () => {
  const started = Date.now();
  const opened = await openSession(pagedTarget("slow", { MCPWB_ENDLESS: "1", MCPWB_SLOW_MS: "150" }), 2000);
  assert.equal(opened.ok, true);
  try {
    assert.ok(Date.now() - started < 8000, "listing must not take 50 pages times the timeout");
    const { tools, listProblems } = opened.session.info;
    assert.ok(tools.length < 50);
    assert.ok(listProblems.tools.error);
  } finally {
    await opened.session.dispose();
  }
});

test("a server that advertises resources but implements no resources list shows no error", { timeout: 8000 }, async () => {
  const target = stdioTarget("no-resources-list", resourcesOnlyServerPath);
  target.transport.env = { MCPWB_NO_RESOURCES_LIST: "1" };
  const opened = await openSession(target, 4000);
  assert.equal(opened.ok, true);
  try {
    assert.deepEqual(opened.session.info.resources, []);
    assert.deepEqual(opened.session.info.listProblems, {});
  } finally {
    await opened.session.dispose();
  }
});

test("a server with resources but no templates handler shows no templates error", { timeout: 8000 }, async () => {
  const opened = await openSession(stdioTarget("resources-only", resourcesOnlyServerPath), 4000);
  assert.equal(opened.ok, true);
  try {
    assert.equal(opened.session.info.resources.length, 1);
    assert.deepEqual(opened.session.info.resourceTemplates, []);
    assert.deepEqual(opened.session.info.listProblems, {});
  } finally {
    await opened.session.dispose();
  }
});

test("a server that never stops paging is cut off and the listing says so", { timeout: 20000 }, async () => {
  const target = stdioTarget("endless", pagedServerPath);
  target.transport.env = { MCPWB_ENDLESS: "1" };
  const opened = await openSession(target, 8000);
  assert.equal(opened.ok, true);
  try {
    const { tools, listProblems } = opened.session.info;
    assert.equal(tools.length, 50);
    assert.equal(listProblems.tools.truncated, true);
    assert.equal(listProblems.tools.error, undefined);
  } finally {
    await opened.session.dispose();
  }
});

test("a long tool call that reports progress is not killed by the base timeout", { timeout: 10000 }, async () => {
  const opened = await openSession(stdioTarget("progress", progressServerPath), 1000);
  assert.equal(opened.ok, true);
  try {
    const result = await opened.session.callTool("slow", {});
    assert.equal(result.ok, true);
    const text = result.content.map((b) => (b && b.type === "text" ? b.text : "")).join("");
    assert.equal(text, "done");
  } finally {
    await opened.session.dispose();
  }
});

test("disposing a Streamable HTTP session sends a DELETE to terminate it server-side", { timeout: 8000 }, async () => {
  let deletedSession = null;
  const httpServer = http.createServer((req, res) => {
    if (req.method === "DELETE") {
      deletedSession = req.headers["mcp-session-id"] ?? null;
      res.writeHead(200).end();
      return;
    }
    if (req.method === "GET") {
      res.writeHead(405).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        res.writeHead(202).end();
        return;
      }
      if (message.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-xyz" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { protocolVersion: message.params.protocolVersion, capabilities: {}, serverInfo: { name: "http-fixture", version: "0.0.1" } },
        }));
        return;
      }
      res.writeHead(202).end();
    });
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = httpServer.address();
    const server = {
      name: "http-term",
      transport: { kind: "http", url: `http://127.0.0.1:${port}/mcp`, headers: {} },
      source: "cursor-workspace",
      configPath: path.join(os.tmpdir(), "mcp.json"),
      rootKey: "mcpServers",
      raw: {},
      issues: [],
    };
    const opened = await openSession(server, 3000);
    assert.equal(opened.ok, true);
    await opened.session.dispose();
    assert.equal(deletedSession, "sess-xyz");
  } finally {
    httpServer.close();
  }
});

test("a hung HTTP session-terminate does not block teardown", { timeout: 15000 }, async () => {
  const httpServer = http.createServer((req, res) => {
    if (req.method === "DELETE") {
      return;
    }
    if (req.method === "GET") {
      res.writeHead(405).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        res.writeHead(202).end();
        return;
      }
      if (message.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-hang" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { protocolVersion: message.params.protocolVersion, capabilities: {}, serverInfo: { name: "hang-fixture", version: "0.0.1" } },
        }));
        return;
      }
      res.writeHead(202).end();
    });
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = httpServer.address();
    const server = {
      name: "http-hang",
      transport: { kind: "http", url: `http://127.0.0.1:${port}/mcp`, headers: {} },
      source: "cursor-workspace",
      configPath: path.join(os.tmpdir(), "mcp.json"),
      rootKey: "mcpServers",
      raw: {},
      issues: [],
    };
    const opened = await openSession(server, 1000);
    assert.equal(opened.ok, true);
    const start = Date.now();
    await opened.session.dispose();
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 4000, `teardown should be bounded despite a hung DELETE, took ${elapsed}ms`);
  } finally {
    httpServer.closeAllConnections?.();
    httpServer.close();
  }
});

test("a server's own missing-child ENOENT does not trigger the launcher PATH hint", { timeout: 10000 }, async () => {
  const scriptDir = mkTemp("mcpwb-childenoent-");
  const script = path.join(scriptDir, "child-enoent.cjs");
  fs.writeFileSync(script, "process.stderr.write('Error: spawn nonexistent-child-tool ENOENT\\n');\nsetTimeout(() => process.exit(1), 100);\n");
  const server = {
    name: "innocent-launcher",
    transport: { kind: "stdio", command: process.execPath, args: [script], env: {} },
    source: "cursor-workspace",
    configPath: path.join(os.tmpdir(), "mcp.json"),
    rootKey: "mcpServers",
    raw: {},
    issues: [],
  };
  const result = await testServer(server, 3000);
  assert.equal(result.ok, false);
  assert.ok(result.detail, "the failure should carry the server's stderr");
  assert.match(result.detail, /spawn nonexistent-child-tool ENOENT/);
  assert.doesNotMatch(result.detail, /could not be found on this editor's PATH/);
});

test("an unset header variable reaches a Claude Code remote server as written", () => {
  delete process.env.MCPWB_MISSING_HEADER;
  const server = {
    name: "needs-token",
    transport: { kind: "http", url: "http://127.0.0.1:1/never", headers: { Authorization: "Bearer ${MCPWB_MISSING_HEADER}" } },
    source: "claude-code-workspace",
    configPath: path.join(os.tmpdir(), ".mcp.json"),
    rootKey: "mcpServers",
    raw: {},
    issues: [],
  };
  const transport = createTransport(server);
  assert.equal(transport._requestInit.headers.Authorization, "Bearer ${MCPWB_MISSING_HEADER}");
});

function remoteServer(port, overrides = {}) {
  return {
    name: "remote",
    transport: { kind: "http", url: `http://127.0.0.1:${port}/mcp`, headers: {} },
    source: "vscode-workspace",
    configPath: path.join(os.tmpdir(), "mcp.json"),
    rootKey: "servers",
    raw: {},
    issues: [],
    ...overrides,
  };
}

function sseOnlyServer(postStatus) {
  const requests = [];
  let stream;
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url === "/mcp" && req.method === "POST") {
      res.writeHead(postStatus).end();
      return;
    }
    if (req.url === "/mcp" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write("event: endpoint\ndata: /messages\n\n");
      stream = res;
      return;
    }
    if (req.url === "/messages" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.writeHead(202).end();
        const message = JSON.parse(body);
        const reply = (result) => stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
        if (message.method === "initialize") {
          reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "sse-only", version: "0.0.1" } });
        } else if (message.method === "tools/list") {
          reply({ tools: [{ name: "ping", inputSchema: { type: "object" } }] });
        }
      });
      return;
    }
    res.writeHead(404).end();
  });
  return { server, requests };
}

async function listening(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

test("an http server that refuses Streamable HTTP is reached over SSE, the way editors fall back", { timeout: 10000 }, async () => {
  const { server, requests } = sseOnlyServer(405);
  const port = await listening(server);
  try {
    const result = await probe(remoteServer(port), 5000);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.connectedOver, "sse");
    assert.equal(result.toolCount, 1);
    assert.deepEqual(requests.slice(0, 2), ["POST /mcp", "GET /mcp"]);

    const opened = await openSession(remoteServer(port), 5000);
    assert.equal(opened.ok, true);
    assert.equal(opened.session.info.connectedOver, "sse");
    await opened.session.dispose();
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test("an explicit sse server is not tried over Streamable HTTP first", { timeout: 10000 }, async () => {
  const { server, requests } = sseOnlyServer(405);
  const port = await listening(server);
  try {
    const target = remoteServer(port);
    target.transport = { ...target.transport, kind: "sse" };
    const result = await probe(target, 5000);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.connectedOver, "sse");
    assert.equal(requests.includes("POST /mcp"), false);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test("an unauthorized Streamable HTTP server does not fall back to SSE", { timeout: 10000 }, async () => {
  const { server, requests } = sseOnlyServer(401);
  const port = await listening(server);
  try {
    const result = await probe(remoteServer(port), 5000);
    assert.equal(result.ok, false);
    assert.equal(requests.includes("GET /mcp"), false);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test("when SSE fails too, the Streamable HTTP error leads and the SSE error is in the detail", { timeout: 10000 }, async () => {
  const server = http.createServer((_req, res) => res.writeHead(404).end());
  const port = await listening(server);
  try {
    const result = await testServer(remoteServer(port), 5000);
    assert.equal(result.ok, false);
    assert.match(result.error, /Streamable HTTP error/);
    assert.match(result.detail, /retried over SSE/);
  } finally {
    server.close();
  }
});

function cmdLaunchedServer(name, scriptBody) {
  const dir = mkTemp(`mcpwb-${name}-`);
  const pidFile = path.join(dir, "pid");
  const script = path.join(dir, `${name}.cjs`);
  fs.writeFileSync(script, `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n${scriptBody}\nsetInterval(() => {}, 1 << 30);\n`);
  const launcher = path.join(dir, `launch-${name}.cmd`);
  fs.writeFileSync(launcher, `@"${process.execPath}" "${script}"\r\n`);
  const target = stdioTarget(name, script);
  target.transport = { kind: "stdio", command: launcher, args: [], env: {} };
  return { target, pidFile };
}

async function launchedPid(pidFile) {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(pidFile) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return Number(fs.readFileSync(pidFile, "utf8").trim());
}

test("on Windows a connect that times out kills the server behind a .cmd launcher", { timeout: 20000, skip: process.platform !== "win32" }, async () => {
  const { target, pidFile } = cmdLaunchedServer("silent", "process.stdin.resume();");
  const result = await probe(target, 4000);
  assert.equal(result.ok, false);
  const pid = await launchedPid(pidFile);
  assert.ok(Number.isInteger(pid) && pid > 0);
  assert.equal(await waitUntilDead(pid, 8000), true, "the node process behind the .cmd launcher must not outlive a failed connect");
});

test("on Windows a timed-out npx-style launcher explains that the first run may still be downloading", { timeout: 20000, skip: process.platform !== "win32" }, async () => {
  const dir = mkTemp("mcpwb-npxhint-");
  const script = path.join(dir, "silent.cjs");
  fs.writeFileSync(script, "process.stdin.resume();\nsetInterval(() => {}, 1 << 30);\n");
  const launcher = path.join(dir, "npx.cmd");
  fs.writeFileSync(launcher, `@"${process.execPath}" "${script}"\r\n`);
  const target = stdioTarget("npx-hint", script);
  target.transport = { kind: "stdio", command: launcher, args: [], env: {} };
  const result = await probe(target, 1500);
  assert.equal(result.ok, false);
  assert.match(result.error, /Timed out/);
  assert.match(result.detail, /download the package on the first run/);
});

test("on Windows a server behind a .cmd launcher that rejects initialize is killed too", { timeout: 20000, skip: process.platform !== "win32" }, async () => {
  const rejectInitialize = `
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "refusing to start" } }) + "\\n");
    }
  }
});`;
  const { target, pidFile } = cmdLaunchedServer("rejecting", rejectInitialize);
  const result = await probe(target, 8000);
  assert.equal(result.ok, false);
  assert.match(result.error, /refusing to start/);
  const pid = await launchedPid(pidFile);
  assert.equal(await waitUntilDead(pid, 8000), true, "a server that answers initialize with an error must not be orphaned");
});

test("on Windows a server behind a .cmd launcher with an unsupported protocol version is killed too", { timeout: 20000, skip: process.platform !== "win32" }, async () => {
  const wrongVersion = `
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (message.method === "initialize") {
      const result = { protocolVersion: "1999-01-01", capabilities: {}, serverInfo: { name: "old", version: "0.0.1" } };
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
    }
  }
});`;
  const { target, pidFile } = cmdLaunchedServer("old-protocol", wrongVersion);
  const result = await probe(target, 8000);
  assert.equal(result.ok, false);
  assert.match(result.error, /protocol version is not supported/);
  const pid = await launchedPid(pidFile);
  assert.equal(await waitUntilDead(pid, 8000), true, "a server with an unsupported protocol version must not be orphaned");
});

test("a Streamable HTTP server that fails after initialize succeeded is not retried over SSE", { timeout: 10000 }, async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.method);
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const message = JSON.parse(body);
      if (message.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "S1" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { protocolVersion: message.params.protocolVersion, capabilities: {}, serverInfo: { name: "late-404", version: "0.0.1" } },
        }));
        return;
      }
      res.writeHead(404).end();
    });
  });
  const port = await listening(server);
  try {
    const result = await probe(remoteServer(port), 5000);
    assert.equal(result.ok, false);
    assert.equal(requests.includes("GET"), false, "no SSE retry once initialize has worked");
    assert.doesNotMatch(result.detail ?? "", /retried over SSE/);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test("a malformed remote URL fails with the plain error and no detail", async () => {
  const server = {
    name: "bad-url",
    transport: { kind: "http", url: "not a url", headers: {} },
    source: "cursor-workspace",
    configPath: path.join(os.tmpdir(), "mcp.json"),
    rootKey: "mcpServers",
    raw: {},
    issues: [],
  };
  const result = await testServer(server, 400);
  assert.equal(result.ok, false);
  assert.match(result.error, /Invalid URL/);
  assert.equal(result.detail, undefined);
});

test("an SSE server that never sends endpoint times out instead of hanging", { timeout: 5000 }, async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(": waiting\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const sse = {
      name: "hang",
      transport: { kind: "sse", url: `http://127.0.0.1:${port}/sse`, headers: {} },
      source: "cursor-workspace",
      configPath: path.join(os.tmpdir(), "mcp.json"),
      rootKey: "mcpServers",
      raw: {},
      issues: [],
    };
    const result = await testServer(sse, 400);
    assert.equal(result.ok, false);
    assert.match(result.error, /Timed out/);
  } finally {
    server.close();
  }
});

test("on Windows a bare command is launched by its PATH location, not a same-named file in the project", () => {
  const bin = mkTemp("mcpwb-bin-");
  const project = mkTemp("mcpwb-proj-");
  fs.writeFileSync(path.join(bin, "mcpwbtool.cmd"), "@echo off\n");
  fs.writeFileSync(path.join(project, "mcpwbtool.cmd"), "@echo off\n");
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const savedPath = process.env.PATH;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  process.env.PATH = bin;
  try {
    const transport = createTransport({
      name: "shadowed",
      source: "claude-code-workspace",
      configPath: path.join(project, ".mcp.json"),
      projectDir: project,
      transport: { kind: "stdio", command: "mcpwbtool", args: [], env: {} },
    });
    assert.equal(transport._serverParams.command, path.join(bin, "mcpwbtool.cmd"));
  } finally {
    Object.defineProperty(process, "platform", platform);
    process.env.PATH = savedPath;
  }
});

test("on Windows the command is resolved with the server's substituted env PATH", () => {
  const bin = mkTemp("mcpwb-bin-");
  fs.writeFileSync(path.join(bin, "mcpwbtool.cmd"), "@echo off\n");
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const savedPath = process.env.PATH;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  process.env.PATH = mkTemp("mcpwb-empty-");
  process.env.MCPWB_BIN = bin;
  try {
    const transport = createTransport({
      name: "via-env-path",
      source: "vscode-workspace",
      configPath: path.join(bin, "mcp.json"),
      transport: { kind: "stdio", command: "mcpwbtool", args: [], env: { Path: "${env:MCPWB_BIN}" } },
    });
    assert.equal(transport._serverParams.command, path.join(bin, "mcpwbtool.cmd"));
    assert.equal(transport._serverParams.env.PATH, bin);
  } finally {
    Object.defineProperty(process, "platform", platform);
    process.env.PATH = savedPath;
    delete process.env.MCPWB_BIN;
  }
});

test("a substituted value is never expanded a second time", () => {
  const project = path.join(mkTemp("mcpwb-proj-"), "ws-${MCPWB_SECOND_PASS}");
  fs.mkdirSync(project);
  process.env.MCPWB_SECOND_PASS = "leaked";
  try {
    const transport = createTransport({
      name: "second-pass",
      source: "cursor-workspace",
      configPath: path.join(project, ".cursor", "mcp.json"),
      projectDir: project,
      transport: { kind: "stdio", command: "node", args: ["${workspaceFolder}"], env: {} },
    });
    assert.equal(transport._serverParams.args[0], project);
  } finally {
    delete process.env.MCPWB_SECOND_PASS;
  }
});
