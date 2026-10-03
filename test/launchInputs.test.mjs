import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";

const require = createRequire(import.meta.url);

const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpwb-inputs-"));
const bundlePath = path.join(bundleDir, "launchInputs.cjs");
after(() => fs.rmSync(bundleDir, { recursive: true, force: true }));
await build({
  entryPoints: [path.resolve("src/launchInputs.ts")],
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

const { promptForInputs } = require(bundlePath);

beforeEach(() => {
  globalThis.__mcpwbVscode = { warnings: [], choices: [], commands: [], prompts: [], answers: [] };
});

function state() {
  return globalThis.__mcpwbVscode;
}

function vscodeServer(headers, inputs, configPath = "/ws/.vscode/mcp.json") {
  return {
    name: "remote",
    source: "vscode-workspace",
    configPath,
    rootKey: "servers",
    raw: {},
    issues: [],
    inputs,
    transport: { kind: "http", url: "https://mcp.example.com/mcp", headers },
  };
}

const API_KEY = { id: "api-key", type: "promptString", description: "API key", password: true };
const REGION = { id: "region", type: "pickString", description: "Region", options: [{ label: "eu", value: "eu" }, { label: "US East", value: "us-east-1" }] };
const USER = { id: "user", type: "promptString", description: "User name", default: "ada" };

test("each referenced input is asked for once, in order, and the answers come back by id", async () => {
  state().answers.push("s3cret", "us-east-1");
  const values = await promptForInputs(
    vscodeServer({ Authorization: "Bearer ${input:api-key}", "X-Region": "${input:region}", "X-Again": "${input:api-key}" }, [API_KEY, REGION]),
  );
  assert.deepEqual([...values], [["api-key", "s3cret"], ["region", "us-east-1"]]);
  const [key, region] = state().prompts;
  assert.equal(key.kind, "input");
  assert.equal(key.options.password, true);
  assert.equal(key.options.prompt, "API key");
  assert.equal(region.kind, "pick");
  assert.deepEqual(region.items.map((item) => item.value), ["eu", "us-east-1"]);
});

test("cancelling any prompt cancels the launch", async () => {
  state().answers.push("s3cret", undefined);
  const values = await promptForInputs(vscodeServer({ A: "${input:api-key}", B: "${input:region}" }, [API_KEY, REGION]));
  assert.equal(values, undefined);
});

test("undefined and command inputs are not asked for, so the launch reports them instead", async () => {
  const values = await promptForInputs(
    vscodeServer({ A: "${input:missing}", B: "${input:picked}" }, [{ id: "picked", type: "command" }]),
  );
  assert.deepEqual([...values], []);
  assert.equal(state().prompts.length, 0);
});

test("prompt text from the config is shown with hidden characters escaped", async () => {
  state().answers.push("v", "a");
  await promptForInputs(
    vscodeServer({ A: "${input:k}", B: "${input:p}" }, [
      { id: "k", type: "promptString", description: "Enter\u202etoken" },
      { id: "p", type: "pickString", description: "Pick", options: [{ label: "e\u200bu", value: "a" }] },
    ]),
  );
  assert.equal(state().prompts[0].options.prompt, "Enter\\u202etoken");
  assert.equal(state().prompts[1].items[0].label, "e\\u200bu");
});

test("a pickString lists its default first, and a repeated input id uses the last definition", async () => {
  state().answers.push("b");
  const values = await promptForInputs(
    vscodeServer({ A: "${input:k}" }, [
      { id: "k", type: "promptString", description: "ignored" },
      { id: "k", type: "pickString", description: "Pick", default: "b", options: [{ label: "a", value: "a" }, { label: "b", value: "b" }] },
    ]),
  );
  assert.equal(state().prompts[0].kind, "pick");
  assert.deepEqual(state().prompts[0].items.map((item) => item.value), ["b", "a"]);
  assert.deepEqual([...values], [["k", "b"]]);
});

test("servers from other editors are never prompted", async () => {
  const cursor = { ...vscodeServer({ A: "${input:api-key}" }, [API_KEY]), source: "cursor-workspace" };
  const values = await promptForInputs(cursor);
  assert.deepEqual([...values], []);
  assert.equal(state().prompts.length, 0);
});

test("a plain input starts from its default, then from the last answer, but a password is never remembered", async () => {
  const configPath = "/ws-remember/.vscode/mcp.json";
  const server = vscodeServer({ A: "${input:user}", B: "${input:api-key}" }, [USER, API_KEY], configPath);
  state().answers.push("grace", "first-secret");
  await promptForInputs(server);
  assert.equal(state().prompts[0].options.value, "ada");

  state().prompts.length = 0;
  state().answers.push("grace", "second-secret");
  await promptForInputs(server);
  assert.equal(state().prompts[0].options.value, "grace");
  assert.equal(state().prompts[1].options.value, undefined);
});
