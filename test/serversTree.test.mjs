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

const bundlePath = path.join(mkTemp("mcpwb-tree-"), "serversTree.cjs");
await build({
  entryPoints: [path.resolve("src/serversTree.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: bundlePath,
  alias: {
    vscode: path.resolve("test/stubs/vscode.mjs"),
    "jsonc-parser": require.resolve("jsonc-parser/lib/esm/main.js"),
  },
  logLevel: "silent",
});

const { ServersProvider } = require(bundlePath);

function cursorWorkspace(servers) {
  const ws = mkTemp("mcpwb-ws-");
  const file = path.join(ws, ".cursor", "mcp.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }));
  return ws;
}

function providerFor(folders) {
  process.env.MCPWB_TEST_FOLDERS = JSON.stringify(folders);
  const p = new ServersProvider();
  p.refresh();
  return p;
}

function cursorSources(p) {
  return p.getChildren().filter((n) => n.kind === "source" && n.file.source === "cursor-workspace");
}

test("each multi-root folder gets its own disambiguated source node", () => {
  const a = cursorWorkspace({ alpha: { command: "node" } });
  const b = cursorWorkspace({ beta: { command: "node" } });
  const sources = cursorSources(providerFor([a, b]));
  assert.equal(sources.length, 2);
  assert.equal(sources.every((n) => n.label.startsWith("Cursor (workspace) · ")), true);
  assert.notEqual(sources[0].label, sources[1].label);
});

test("a source node's children are only that file's servers", () => {
  const a = cursorWorkspace({ alpha: { command: "node" } });
  const b = cursorWorkspace({ beta: { command: "node" } });
  const p = providerFor([a, b]);
  const names = cursorSources(p).map((source) =>
    p.getChildren(source).filter((k) => k.kind === "server").map((k) => k.server.name),
  );
  assert.deepEqual(names.sort().flat(), ["alpha", "beta"]);
  assert.equal(names.every((group) => group.length === 1), true);
});

test("duplicate-named servers across folders still get unique tree ids", () => {
  const a = cursorWorkspace({ shared: { command: "node" }, alpha: { command: "node" } });
  const b = cursorWorkspace({ shared: { command: "node" }, beta: { command: "node" } });
  const p = providerFor([a, b]);
  const ids = [];
  for (const root of p.getChildren()) {
    ids.push(root.id);
    for (const child of p.getChildren(root)) {
      ids.push(child.id);
    }
  }
  assert.equal(ids.length, new Set(ids).size, "ids must be unique: " + JSON.stringify(ids));
});

test("single-root keeps the plain source label", () => {
  const sources = cursorSources(providerFor([cursorWorkspace({ alpha: { command: "node" } })]));
  assert.equal(sources.length, 1);
  assert.equal(sources[0].label, "Cursor (workspace)");
});

function serverTooltip(configPath, name = "s") {
  const p = providerFor([]);
  const item = p.getTreeItem({
    kind: "server",
    id: "x",
    server: {
      name,
      transport: { kind: "stdio", command: "node", args: [], env: {} },
      source: "cursor-workspace",
      configPath,
      scope: undefined,
      issues: [],
    },
  });
  return item.tooltip.value;
}

test("homePath collapses real subdirs but not sibling dirs", () => {
  const home = process.env.USERPROFILE;
  assert.match(serverTooltip(path.join(home, "sub", "mcp.json")), /Config: `~/);
  assert.doesNotMatch(serverTooltip(home + "X" + path.sep + "mcp.json"), /Config: `~/);
});

test("backticks and markdown metacharacters in a server name are escaped in the tooltip", () => {
  const value = serverTooltip(path.join(process.env.USERPROFILE, "mcp.json"), "weird`*_name");
  assert.ok(value.includes("weird\\`"), "backtick should be backslash-escaped");
  assert.ok(value.includes("\\*"), "asterisk should be backslash-escaped");
});
