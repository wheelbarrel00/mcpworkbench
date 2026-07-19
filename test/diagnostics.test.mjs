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

const require = createRequire(import.meta.url);

const bundlePath = path.join(mkTemp("mcpwb-diag-"), "diagnostics.cjs");
await build({
  entryPoints: [path.resolve("src/diagnostics.ts")],
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

const { reportableIssues } = require(bundlePath);

test("no-servers and projects-filtered are suppressed from the Problems panel", () => {
  const issues = [
    { level: "info", code: "no-servers", message: "x" },
    { level: "info", code: "projects-filtered", message: "y" },
  ];
  assert.deepEqual(reportableIssues(issues), []);
});

test("real errors and warnings still reach the Problems panel", () => {
  const issues = [
    { level: "error", code: "missing-root-key", message: "x" },
    { level: "info", code: "no-servers", message: "y" },
    { level: "warning", code: "empty-root-key", message: "z" },
  ];
  assert.deepEqual(
    reportableIssues(issues).map((i) => i.code),
    ["missing-root-key", "empty-root-key"],
  );
});
