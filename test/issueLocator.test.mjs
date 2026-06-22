import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";

const require = createRequire(import.meta.url);

const bundlePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcpwb-loc-")), "issueLocator.cjs");
await build({
  entryPoints: [path.resolve("src/issueLocator.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: bundlePath,
  alias: { "jsonc-parser": require.resolve("jsonc-parser/lib/esm/main.js") },
  logLevel: "silent",
});

const { locateIssue, parseDocumentTree } = require(bundlePath);

const TEXT = `{
  "mcpServers": {
    "fs": {
      "command": "npx",
      "env": { "TOKEN": "secret" }
    }
  }
}`;
const tree = parseDocumentTree(TEXT);

function slice(span) {
  return TEXT.slice(span.offset, span.offset + span.length);
}

test("a path resolves to the offending key, including its quotes", () => {
  const span = locateIssue(tree, { level: "error", code: "x", message: "", path: ["mcpServers", "fs", "command"] });
  assert.ok(span);
  assert.equal(slice(span), '"command"');
});

test("a path one level shallower points at the server name key", () => {
  const span = locateIssue(tree, { level: "error", code: "x", message: "", path: ["mcpServers", "fs"] });
  assert.equal(slice(span), '"fs"');
});

test("a nested env key resolves to that key", () => {
  const span = locateIssue(tree, { level: "warning", code: "x", message: "", path: ["mcpServers", "fs", "env", "TOKEN"] });
  assert.equal(slice(span), '"TOKEN"');
});

test("an offset issue (bad JSON) yields a single-character span at that offset", () => {
  const span = locateIssue(undefined, { level: "error", code: "bad-json", message: "", offset: 7 });
  assert.deepEqual(span, { offset: 7, length: 1 });
});

test("a path that does not exist in the document returns undefined", () => {
  assert.equal(locateIssue(tree, { level: "error", code: "x", message: "", path: ["mcpServers", "nope"] }), undefined);
});

test("an issue with neither path nor offset returns undefined", () => {
  assert.equal(locateIssue(tree, { level: "error", code: "x", message: "" }), undefined);
});
