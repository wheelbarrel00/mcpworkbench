import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);

const bundlePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcpwb-formdom-")), "testPanel.cjs");
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

const { toolItem, SCRIPT } = require(bundlePath);

const obj = (properties, required) => ({ type: "object", properties, ...(required ? { required } : {}) });

function setup(tool) {
  const dom = new JSDOM(`<!DOCTYPE html><body><ul class="tools">${toolItem(tool, 0)}</ul></body>`, { runScripts: "outside-only" });
  const posted = [];
  dom.window.acquireVsCodeApi = () => ({ postMessage: (m) => posted.push(m) });
  dom.window.eval(SCRIPT);
  const li = dom.window.document.querySelector(".tool");
  return { dom, posted, li };
}

function field(li, name) {
  for (const el of li.querySelectorAll(".field")) {
    if (el.dataset.name === name) {
      return el;
    }
  }
  return null;
}

const call = (li) => li.querySelector("button.call").click();
const toggle = (li) => li.querySelector("button.toggle").click();

test("an empty required field blocks the call, then succeeds once filled", () => {
  const { posted, li } = setup({ name: "s", inputSchema: obj({ q: { type: "string" } }, ["q"]) });
  call(li);
  assert.equal(posted.length, 0);
  assert.ok(li.querySelector(".field-row.invalid"));
  assert.match(li.querySelector(".result").textContent, /Fill the required/);

  field(li, "q").value = "cats";
  call(li);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, "call");
  assert.equal(posted[0].args, '{"q":"cats"}');
});

test("a valid form serializes only the provided fields, with booleans always included", () => {
  const { posted, li } = setup({
    name: "s",
    inputSchema: obj({ q: { type: "string" }, limit: { type: "integer" }, safe: { type: "boolean" }, sort: { type: "string", enum: ["asc", "desc"] } }, ["q"]),
  });
  field(li, "q").value = "cats";
  field(li, "safe").checked = true;
  call(li);
  assert.equal(posted[0].args, '{"q":"cats","safe":true}');
});

test("numbers coerce to JSON numbers and reject non-numeric input", () => {
  const good = setup({ name: "s", inputSchema: obj({ n: { type: "number" } }, ["n"]) });
  field(good.li, "n").value = "3.5";
  call(good.li);
  assert.equal(good.posted[0].args, '{"n":3.5}');

  const bad = setup({ name: "s", inputSchema: obj({ n: { type: "number" } }, ["n"]) });
  field(bad.li, "n").value = "abc";
  call(bad.li);
  assert.equal(bad.posted.length, 0);
  assert.ok(bad.li.querySelector(".field-row.invalid"));
});

test("integer fields reject fractions", () => {
  const { posted, li } = setup({ name: "s", inputSchema: obj({ p: { type: "integer" } }, ["p"]) });
  field(li, "p").value = "1.5";
  call(li);
  assert.equal(posted.length, 0);
  field(li, "p").value = "2";
  call(li);
  assert.equal(posted[0].args, '{"p":2}');
});

test("an empty optional integer is omitted, not coerced to 0", () => {
  const { posted, li } = setup({ name: "s", inputSchema: obj({ limit: { type: "integer" } }) });
  call(li);
  assert.equal(posted[0].args, "{}");
});

test("a boolean checkbox always sends an explicit boolean", () => {
  const { posted, li } = setup({ name: "s", inputSchema: obj({ flag: { type: "boolean", default: true } }) });
  assert.equal(field(li, "flag").checked, true);
  field(li, "flag").checked = false;
  call(li);
  assert.equal(posted[0].args, '{"flag":false}');
});

test("a numeric enum coerces the selection back to a number", () => {
  const { posted, li } = setup({ name: "s", inputSchema: obj({ level: { enum: [1, 2, 3] } }, ["level"]) });
  call(li);
  assert.equal(posted.length, 0, "required enum left at placeholder must block");
  field(li, "level").value = "2";
  call(li);
  assert.equal(posted[0].args, '{"level":2}');
});

test("an array-of-strings field splits lines and drops blanks", () => {
  const { posted, li } = setup({ name: "s", inputSchema: obj({ tags: { type: "array", items: { type: "string" } } }, ["tags"]) });
  field(li, "tags").value = "a\n \nb";
  call(li);
  assert.equal(posted[0].args, '{"tags":["a","b"]}');
});

test("a const field always emits its fixed value", () => {
  const { posted, li } = setup({ name: "s", inputSchema: obj({ version: { const: "v1" }, name: { type: "string" } }, ["name"]) });
  field(li, "name").value = "x";
  call(li);
  assert.equal(posted[0].args, '{"version":"v1","name":"x"}');
});

test("a zero-argument tool posts an empty object", () => {
  const { posted, li } = setup({ name: "s", inputSchema: obj({}) });
  assert.match(li.querySelector(".form-mode").textContent, /No arguments/);
  call(li);
  assert.equal(posted[0].args, "{}");
});

test("a non-formable tool posts the JSON textarea verbatim", () => {
  const { posted, li } = setup({ name: "s", inputSchema: obj({ filter: { type: "object" } }) });
  assert.equal(li.dataset.formable, "false");
  li.querySelector("textarea.args").value = '{"filter":{"x":1}}';
  call(li);
  assert.equal(posted[0].args, '{"filter":{"x":1}}');
});

test("Form <-> JSON toggling round-trips losslessly", () => {
  const { li } = setup({
    name: "s",
    inputSchema: obj({ q: { type: "string" }, n: { type: "number" }, flag: { type: "boolean" }, tags: { type: "array", items: { type: "string" } } }, ["q"]),
  });
  field(li, "q").value = "hi";
  field(li, "n").value = "5";
  field(li, "flag").checked = true;
  field(li, "tags").value = "a\nb";

  toggle(li);
  const textarea = li.querySelector("textarea.args");
  const first = JSON.parse(textarea.value);
  assert.deepEqual(first, { q: "hi", n: 5, flag: true, tags: ["a", "b"] });

  toggle(li);
  toggle(li);
  assert.deepEqual(JSON.parse(textarea.value), first);
});

test("toggling to form refuses JSON with an unknown key and stays in JSON", () => {
  const { li } = setup({ name: "s", inputSchema: obj({ q: { type: "string" } }) });
  toggle(li);
  const textarea = li.querySelector("textarea.args");
  textarea.value = '{"q":"a","zzz":1}';
  toggle(li);
  assert.equal(li.querySelector(".json-mode").hidden, false);
  assert.match(li.querySelector(".result").textContent, /can't be shown as a form/);
});

test("json->form refuses a non-finite number and stays in JSON", () => {
  const { li } = setup({ name: "s", inputSchema: obj({ n: { type: "number" } }) });
  toggle(li);
  const textarea = li.querySelector("textarea.args");
  textarea.value = '{"n":1e400}';
  toggle(li);
  assert.equal(li.querySelector(".json-mode").hidden, false);
  assert.match(li.querySelector(".result").textContent, /can't be shown as a form/);
});

test("json->form refuses a fractional value for an integer field", () => {
  const { li } = setup({ name: "s", inputSchema: obj({ limit: { type: "integer" } }) });
  toggle(li);
  const textarea = li.querySelector("textarea.args");
  textarea.value = '{"limit":1.5}';
  toggle(li);
  assert.equal(li.querySelector(".json-mode").hidden, false);
});

test("json->form refuses a mismatched const but accepts a matching one", () => {
  const { li } = setup({ name: "s", inputSchema: obj({ version: { const: "v1" }, name: { type: "string" } }) });
  toggle(li);
  const textarea = li.querySelector("textarea.args");
  textarea.value = '{"version":"WRONG","name":"x"}';
  toggle(li);
  assert.equal(li.querySelector(".json-mode").hidden, false, "mismatched const stays in JSON");

  textarea.value = '{"version":"v1","name":"x"}';
  toggle(li);
  assert.equal(li.querySelector(".json-mode").hidden, true, "matching const switches to form");
});

test("a malicious property name round-trips as a literal key with no injection", () => {
  const name = '"><img src=x onerror=alert(1)>';
  const { posted, li } = setup({ name: "s", inputSchema: obj({ [name]: { type: "string" } }, [name]) });
  const el = field(li, name);
  assert.ok(el, "field resolves by its literal decoded data-name");
  el.value = "v";
  call(li);
  assert.deepEqual(JSON.parse(posted[0].args), { [name]: "v" });
});

test("an ampersand property name decodes through the dataset round-trip", () => {
  const { posted, li } = setup({ name: "s", inputSchema: obj({ "a&b": { type: "string" } }, ["a&b"]) });
  field(li, "a&b").value = "x";
  call(li);
  assert.deepEqual(JSON.parse(posted[0].args), { "a&b": "x" });
});
