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

test("multi-root folders stay separate, each attributed to its workspace", () => {
  const wsA = mkTemp("mcpwb-wsA-");
  const wsB = mkTemp("mcpwb-wsB-");
  for (const [ws, name] of [[wsA, "alpha"], [wsB, "beta"]]) {
    const file = path.join(ws, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { [name]: { command: "node" } } }));
  }
  const cursorFiles = discoverAll([wsA, wsB]).filter((f) => f.source === "cursor-workspace" && f.exists);
  assert.equal(cursorFiles.length, 2);
  const a = cursorFiles.find((f) => f.workspaceFolder === wsA);
  const b = cursorFiles.find((f) => f.workspaceFolder === wsB);
  assert.ok(a && b);
  assert.deepEqual(a.servers.map((s) => s.name), ["alpha"]);
  assert.deepEqual(b.servers.map((s) => s.name), ["beta"]);
  assert.equal(a.servers[0].projectDir, wsA);
  assert.equal(b.servers[0].projectDir, wsB);
});

test("an empty mcpServers object is flagged as empty-root-key, not missing", () => {
  const file = scanCursorWorkspace(JSON.stringify({ mcpServers: {} }));
  assert.ok(file);
  assert.equal(file.servers.length, 0);
  assert.equal(hasIssue(file.fileIssues, "empty-root-key"), true);
  assert.equal(hasIssue(file.fileIssues, "missing-root-key"), false);
});

test("an array mcpServers does not produce servers named 0,1", () => {
  const file = scanCursorWorkspace(JSON.stringify({ mcpServers: [{ command: "node" }] }));
  assert.ok(file);
  assert.equal(file.servers.length, 0);
  assert.equal(hasIssue(file.fileIssues, "missing-root-key"), true);
});

test("non-string args and env values are dropped and flagged", () => {
  const file = scanCursorWorkspace(
    JSON.stringify({ mcpServers: { x: { command: "node", args: ["ok", 42, null], env: { A: "s", B: 5 } } } })
  );
  const server = file.servers[0];
  assert.deepEqual(server.transport.args, ["ok"]);
  assert.deepEqual(server.transport.env, { A: "s" });
  assert.equal(server.issues.some((i) => i.code === "non-string-arg"), true);
  assert.equal(server.issues.some((i) => i.code === "non-string-value"), true);
});

test("a repeated unset env var reference is only flagged once", () => {
  delete process.env.MCPWB_DEFINITELY_UNSET;
  const file = scanCursorWorkspace(
    JSON.stringify({
      mcpServers: { x: { url: "http://localhost", headers: { a: "${MCPWB_DEFINITELY_UNSET} ${MCPWB_DEFINITELY_UNSET}" } } },
    })
  );
  const unset = file.servers[0].issues.filter((i) => i.code === "env-unset");
  assert.equal(unset.length, 1);
});

test("claude-code-user projects filter to the open workspace unless showAll is set", () => {
  const claudeJson = path.join(process.env.USERPROFILE, ".claude.json");
  const wsMatch = mkTemp("mcpwb-proj-");
  fs.writeFileSync(
    claudeJson,
    JSON.stringify({
      projects: {
        [wsMatch]: { mcpServers: { inside: { command: "node" } } },
        "C:/elsewhere/other-project": { mcpServers: { outside: { command: "node" } } },
      },
    })
  );
  try {
    const filtered = discoverAll([wsMatch]).find((f) => f.source === "claude-code-user");
    assert.deepEqual(filtered.servers.map((s) => s.name), ["inside"]);
    assert.equal(filtered.servers[0].projectDir, wsMatch);

    const all = discoverAll([wsMatch], { showAllClaudeProjects: true }).find((f) => f.source === "claude-code-user");
    assert.deepEqual(all.servers.map((s) => s.name).sort(), ["inside", "outside"]);
  } finally {
    fs.rmSync(claudeJson, { force: true });
  }
});

test("malformed JSON is still reported as bad-json", () => {
  const file = scanCursorWorkspace(`{ "mcpServers": { "fs": { "command": } } }`);
  assert.ok(file);
  assert.equal(file.exists, true);
  assert.equal(hasIssue(file.fileIssues, "bad-json"), true);
  assert.equal(file.servers.length, 0);
});
