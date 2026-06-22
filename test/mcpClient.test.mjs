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

const { createTransport, testServer, openSession } = require(bundlePath);

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
