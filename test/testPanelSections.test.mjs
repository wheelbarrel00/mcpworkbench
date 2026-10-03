import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { build } from "esbuild";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpwb-sections-"));
const bundlePath = path.join(bundleDir, "testPanel.cjs");
after(() => fs.rmSync(bundleDir, { recursive: true, force: true }));
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

const { toolsSection, resourcesSection, promptsSection } = require(bundlePath);

function info(overrides) {
  return {
    ok: true,
    capabilities: {},
    connectedOver: "stdio",
    tools: [],
    resources: [],
    resourceTemplates: [],
    prompts: [],
    listProblems: {},
    ...overrides,
  };
}

const tool = { name: "ping", inputSchema: { type: "object" } };

test("a failed tools listing shows the error instead of claiming the server has no tools", () => {
  const html = toolsSection(info({ listProblems: { tools: { error: "tools listing <exploded>", truncated: false } } }));
  assert.match(html, /Listing tools failed: tools listing &lt;exploded&gt;/);
  assert.doesNotMatch(html, /exposes no tools/);
});

test("a listing that failed part way says how far it got", () => {
  const html = toolsSection(info({ tools: [tool, tool], listProblems: { tools: { error: "page 3 broke", truncated: false } } }));
  assert.match(html, /Listing tools stopped after 2 tools: page 3 broke/);
});

test("a server that really has no tools still says so", () => {
  assert.match(toolsSection(info()), /This server exposes no tools/);
});

test("a cut-off listing says how many items are shown", () => {
  const html = toolsSection(info({ tools: [tool, tool], listProblems: { tools: { truncated: true } } }));
  assert.match(html, /Showing the first 2 tools\. The server has more than the tester loads\./);
});

test("resource and prompt listing errors get their own section even when nothing was listed", () => {
  const resources = resourcesSection(info({ listProblems: { resourceTemplates: { error: "templates broke", truncated: false } } }));
  assert.match(resources, /<h2>Resources<\/h2>/);
  assert.match(resources, /Listing resource templates failed: templates broke/);

  const prompts = promptsSection(info({ listProblems: { prompts: { error: "prompts broke", truncated: false } } }));
  assert.match(prompts, /Listing prompts failed: prompts broke/);
});

test("resources and prompts stay hidden when the server has none and nothing failed", () => {
  assert.equal(resourcesSection(info()), "");
  assert.equal(promptsSection(info()), "");
});
