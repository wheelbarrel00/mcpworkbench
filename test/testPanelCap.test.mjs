import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";

const require = createRequire(import.meta.url);

const bundlePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcpwb-cap-")), "testPanel.cjs");
await build({
  entryPoints: [path.resolve("src/testPanel.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: bundlePath,
  alias: { vscode: path.resolve("test/stubs/vscode.mjs") },
  logLevel: "silent",
});

const { capForWire } = require(bundlePath);

test("an oversized block array is capped to 100 blocks before it crosses the wire", () => {
  const blocks = Array.from({ length: 500 }, (_, i) => ({ type: "text", text: "b" + i }));
  const out = capForWire(blocks);
  assert.equal(out.length, 100);
  assert.equal(out[0].text, "b0");
});

test("a huge text block is truncated to the wire limit host-side", () => {
  const out = capForWire([{ type: "text", text: "x".repeat(5_000_000) }]);
  assert.equal(out[0].text.length, 200000);
});

test("a nested resource text is truncated", () => {
  const out = capForWire([{ type: "resource", resource: { uri: "u", text: "x".repeat(5_000_000) } }]);
  assert.equal(out[0].resource.text.length, 200000);
});

test("a huge structuredContent string value is truncated", () => {
  const out = capForWire({ big: "x".repeat(5_000_000), n: 3 });
  assert.equal(out.big.length, 200000);
  assert.equal(out.n, 3);
});

test("a normal small payload passes through unchanged", () => {
  const input = [
    { type: "text", text: "hello" },
    { type: "resource", resource: { uri: "u", text: "hi" } },
  ];
  assert.deepEqual(capForWire(input), input);
});

test("undefined structuredContent stays undefined", () => {
  assert.equal(capForWire(undefined), undefined);
});
