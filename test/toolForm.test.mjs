import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";

const require = createRequire(import.meta.url);

const bundlePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcpwb-form-")), "testPanel.cjs");
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

const { isFormable, formFields, toolItem } = require(bundlePath);

const obj = (properties, required) => ({ type: "object", properties, ...(required ? { required } : {}) });

test("a schema of simple fields is formable", () => {
  assert.equal(isFormable(obj({ q: { type: "string" }, n: { type: "integer" }, ok: { type: "boolean" } }, ["q"])), true);
});

test("an empty-properties schema is a formable zero-field form", () => {
  assert.equal(isFormable(obj({})), true);
  assert.deepEqual(formFields(obj({})), []);
});

test("scalar enum and const without a type are formable", () => {
  assert.equal(isFormable(obj({ level: { enum: [1, 2, 3] } })), true);
  assert.equal(isFormable(obj({ v: { const: "v1" } })), true);
});

test("array-of-scalar is formable; array-of-object is not", () => {
  assert.equal(isFormable(obj({ tags: { type: "array", items: { type: "string" } } })), true);
  assert.equal(isFormable(obj({ msgs: { type: "array", items: { type: "object", properties: { r: { type: "string" } } } } })), false);
});

test("nested object, composition, ref, and type-arrays fall back to non-formable", () => {
  assert.equal(isFormable(obj({ filter: { type: "object", properties: { x: { type: "string" } } } })), false);
  assert.equal(isFormable({ anyOf: [obj({ a: { type: "string" } }), obj({ b: { type: "number" } })] }), false);
  assert.equal(isFormable(obj({ val: { oneOf: [{ type: "string" }, { type: "number" }] } })), false);
  assert.equal(isFormable(obj({ ref: { $ref: "#/defs/x" } })), false);
  assert.equal(isFormable(obj({ note: { type: ["string", "null"] } })), false);
});

test("a free additionalProperties map with no declared properties is non-formable", () => {
  assert.equal(isFormable({ type: "object", additionalProperties: { type: "string" } }), false);
});

test("non-object / wrong-type root schemas are non-formable", () => {
  assert.equal(isFormable({ type: "string" }), false);
  assert.equal(isFormable(null), false);
  assert.equal(isFormable("nope"), false);
});

test("formFields captures kind, required, defaults, enum options, and array item type", () => {
  const fields = formFields(
    obj(
      {
        q: { type: "string" },
        limit: { type: "integer", default: 10 },
        safe: { type: "boolean" },
        sort: { type: "string", enum: ["asc", "desc"] },
        tags: { type: "array", items: { type: "number" }, minItems: 2 },
        version: { const: "v1" },
      },
      ["q"],
    ),
  );
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
  assert.equal(byKey.q.kind, "string");
  assert.equal(byKey.q.required, true);
  assert.equal(byKey.limit.kind, "integer");
  assert.equal(byKey.limit.defaultValue, 10);
  assert.equal(byKey.safe.kind, "boolean");
  assert.equal(byKey.sort.kind, "enum");
  assert.deepEqual(byKey.sort.options.map((o) => o.value), ['"asc"', '"desc"']);
  assert.equal(byKey.tags.kind, "array-lines");
  assert.equal(byKey.tags.itemType, "number");
  assert.equal(byKey.tags.minItems, 2);
  assert.equal(byKey.version.kind, "const");
});

test("a formable tool renders a form-mode and a hidden json-mode; a non-formable tool renders only the textarea", () => {
  const formable = toolItem({ name: "search", inputSchema: obj({ q: { type: "string" } }, ["q"]) }, 0);
  assert.match(formable, /data-formable="true"/);
  assert.match(formable, /class="form-mode"/);
  assert.match(formable, /class="json-mode" hidden/);
  assert.match(formable, /button class="toggle"/);

  const nested = toolItem({ name: "complex", inputSchema: obj({ filter: { type: "object" } }) }, 1);
  assert.match(nested, /data-formable="false"/);
  assert.doesNotMatch(nested, /class="form-mode"/);
  assert.match(nested, /textarea class="args"/);
});

test("a malicious property name is escaped and never emitted as live markup", () => {
  const html = toolItem({ name: "x", inputSchema: obj({ '"><img src=x onerror=alert(1)>': { type: "string" } }) }, 0);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /data-name="[^"]*&gt;&lt;img/);
});

test("enum option values and labels are escaped", () => {
  const html = toolItem({ name: "x", inputSchema: obj({ c: { enum: ["<b>", '"x"'] } }) }, 0);
  assert.doesNotMatch(html, /<option value="<b>"/);
  assert.match(html, /&lt;b&gt;/);
});
