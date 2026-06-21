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

const { createTransport, testServer } = require(bundlePath);

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
