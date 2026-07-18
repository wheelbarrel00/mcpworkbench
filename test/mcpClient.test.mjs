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

test("only configured env reaches the server, with ${VAR} expanded", () => {
  process.env.MCPWB_TOKEN = "tok";
  const transport = createTransport(stdioServer({ API_KEY: "${MCPWB_TOKEN}", LITERAL: "plain" }));
  assert.deepEqual(transport._serverParams.env, { API_KEY: "tok", LITERAL: "plain" });
});

test("unrelated process.env secrets and PATH are not forwarded by us", () => {
  process.env.MCPWB_SECRET = "should-not-leak";
  const transport = createTransport(stdioServer({}));
  const passed = transport._serverParams.env;
  assert.equal("MCPWB_SECRET" in passed, false);
  assert.equal("PATH" in passed, false);
  assert.deepEqual(passed, {});
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
  assert.deepEqual(transport._serverParams.env, { WS: proj });
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
  assert.deepEqual(transport._serverParams.env, { WS: proj });
});

test("${workspaceFolder} does not throw as an env var when no project dir is set", () => {
  const server = {
    name: "demo",
    transport: { kind: "stdio", command: "node", args: ["${workspaceFolder}/x.js"], env: {} },
    source: "cursor-workspace",
    configPath: path.join(os.tmpdir(), "mcp.json"),
    rootKey: "mcpServers",
    raw: {},
    issues: [],
  };
  const transport = createTransport(server);
  assert.deepEqual(transport._serverParams.args, ["/x.js"]);
});

test("an env var name with parentheses expands in the command", () => {
  process.env["MCPWB_PF(x86)"] = "C:/PF86";
  const server = {
    name: "demo",
    transport: { kind: "stdio", command: "${MCPWB_PF(x86)}/app", args: [], env: {} },
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
    transport: { kind: "http", url: "https://${MCPWB_HOST}/mcp", headers: {} },
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
  const opened = await openSession(pidStubbornServer(pidFile), 12000, () => {
    closedCount++;
    signalClosed();
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
  const opened = await openSession(server, 12000, () => {
    closedCount++;
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

test("a failing tools/list yields an empty tool list instead of failing the whole session", { timeout: 8000 }, async () => {
  const opened = await openSession(stdioTarget("tools-error", toolsErrorServerPath), 2000);
  assert.equal(opened.ok, true);
  assert.deepEqual(opened.session.info.tools, []);
  await opened.session.dispose();
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

test("a referenced env var that is not set fails with a clear error", async () => {
  delete process.env.MCPWB_MISSING_HEADER;
  const server = {
    name: "needs-token",
    transport: { kind: "http", url: "http://127.0.0.1:1/never", headers: { Authorization: "Bearer ${MCPWB_MISSING_HEADER}" } },
    source: "cursor-workspace",
    configPath: path.join(os.tmpdir(), "mcp.json"),
    rootKey: "mcpServers",
    raw: {},
    issues: [],
  };
  const result = await testServer(server, 400);
  assert.equal(result.ok, false);
  assert.match(result.error, /MCPWB_MISSING_HEADER/);
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
