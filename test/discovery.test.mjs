import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

process.env.USERPROFILE = mkTemp("mcpwb-home-");
process.env.HOME = process.env.USERPROFILE;

const require = createRequire(import.meta.url);

const bundlePath = path.join(mkTemp("mcpwb-bundle-"), "discovery.cjs");
await build({
  entryPoints: [path.resolve("src/discovery.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: bundlePath,
  alias: { "jsonc-parser": require.resolve("jsonc-parser/lib/esm/main.js") },
  logLevel: "silent",
});

const { discoverAll } = require(bundlePath);

function scanCursorWorkspace(contents) {
  const ws = mkTemp("mcpwb-ws-");
  const file = path.join(ws, ".cursor", "mcp.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  const scanned = discoverAll([ws]);
  return scanned.find((f) => f.source === "cursor-workspace" && f.path === file);
}

function hasIssue(issues, code) {
  return issues.some((i) => i.code === code);
}

test("line-comment characters inside string values are preserved", () => {
  const file = scanCursorWorkspace(
    JSON.stringify({
      mcpServers: {
        fs: { command: "node", args: ["--note", "use // for division", "C:/proj//data"] },
      },
    })
  );
  assert.ok(file, "cursor-workspace file should be scanned");
  assert.equal(hasIssue(file.fileIssues, "bad-json"), false, "valid config must not be reported as bad-json");
  assert.equal(file.servers.length, 1);
  assert.equal(file.servers[0].name, "fs");
  assert.deepEqual(file.servers[0].transport.args, ["--note", "use // for division", "C:/proj//data"]);
});

test("block-comment characters inside string values are preserved", () => {
  const file = scanCursorWorkspace(
    JSON.stringify({
      mcpServers: { fs: { command: "node", args: ["/* not a comment */text"] } },
    })
  );
  assert.ok(file);
  assert.equal(hasIssue(file.fileIssues, "bad-json"), false);
  assert.equal(file.servers.length, 1);
  assert.deepEqual(file.servers[0].transport.args, ["/* not a comment */text"]);
});

test("slashes inside a header value are preserved for http servers", () => {
  const file = scanCursorWorkspace(
    JSON.stringify({
      mcpServers: { api: { url: "https://example.com/mcp", headers: { Authorization: "Bearer x // y" } } },
    })
  );
  assert.ok(file);
  assert.equal(hasIssue(file.fileIssues, "bad-json"), false);
  assert.equal(file.servers[0].transport.headers.Authorization, "Bearer x // y");
});

test("genuine comments and trailing commas still parse", () => {
  const file = scanCursorWorkspace(
    `{
  // primary server
  "mcpServers": {
    "fs": {
      "command": "node", /* runtime */
      "args": ["x"],
    },
  }
}`
  );
  assert.ok(file);
  assert.equal(hasIssue(file.fileIssues, "bad-json"), false);
  assert.equal(file.servers.length, 1);
  assert.equal(file.servers[0].name, "fs");
  assert.deepEqual(file.servers[0].transport.args, ["x"]);
});

test("trailing commas without comments still parse", () => {
  const file = scanCursorWorkspace(`{ "mcpServers": { "fs": { "command": "node", "args": ["x"], }, }, }`);
  assert.ok(file);
  assert.equal(hasIssue(file.fileIssues, "bad-json"), false);
  assert.deepEqual(file.servers[0].transport.args, ["x"]);
});

test("a leading UTF-8 BOM does not make the whole file vanish", () => {
  const bom = String.fromCharCode(0xfeff);
  const file = scanCursorWorkspace(
    bom + JSON.stringify({ mcpServers: { fs: { command: "node" } } })
  );
  assert.ok(file);
  assert.equal(hasIssue(file.fileIssues, "bad-json"), false);
  assert.equal(file.servers.length, 1);
  assert.equal(file.servers[0].name, "fs");
});

test("malformed JSON is still reported as bad-json", () => {
  const file = scanCursorWorkspace(`{ "mcpServers": { "fs": { "command": } } }`);
  assert.ok(file);
  assert.equal(file.exists, true);
  assert.equal(hasIssue(file.fileIssues, "bad-json"), true);
  assert.equal(file.servers.length, 0);
});
