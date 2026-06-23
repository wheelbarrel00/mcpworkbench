import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";

const require = createRequire(import.meta.url);

const bundlePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcpwb-health-")), "health.cjs");
await build({
  entryPoints: [path.resolve("src/health.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: bundlePath,
  logLevel: "silent",
});

const { HealthStore, recordFromProbe, rollup, statusBarSeverity, statusBarText, statusBarTooltip, healthSuffix } =
  require(bundlePath);

const STORE_KEY = "mcpWorkbench.health";

function fakeMemento(initial) {
  const data = {};
  if (initial !== undefined) {
    data[STORE_KEY] = initial;
  }
  return {
    get(key, fallback) {
      return key in data ? data[key] : fallback;
    },
    update(key, value) {
      data[key] = value;
      return Promise.resolve();
    },
    raw: () => data[STORE_KEY],
  };
}

function file(over) {
  return { path: "/x", source: "cursor-workspace", exists: true, fileIssues: [], servers: [], ...over };
}

function server(issues = []) {
  return { name: "s", transport: { kind: "stdio" }, source: "cursor-workspace", configPath: "/x", issues };
}

test("rollup counts servers and error/warning issues, excluding info and non-existent files", () => {
  const files = [
    file({
      fileIssues: [{ level: "warning" }, { level: "info" }],
      servers: [server([{ level: "error" }, { level: "info" }]), server([{ level: "warning" }])],
    }),
    file({ exists: false, servers: [server([{ level: "error" }])] }),
  ];
  assert.deepEqual(rollup(files), { servers: 2, errors: 1, warnings: 2 });
});

test("statusBarSeverity prefers error over warning over none", () => {
  assert.equal(statusBarSeverity({ servers: 1, errors: 1, warnings: 3 }), "error");
  assert.equal(statusBarSeverity({ servers: 1, errors: 0, warnings: 2 }), "warning");
  assert.equal(statusBarSeverity({ servers: 1, errors: 0, warnings: 0 }), "none");
});

test("statusBarText pluralizes servers and issues and omits the issue clause when clean", () => {
  assert.equal(statusBarText({ servers: 0, errors: 0, warnings: 0 }), "$(server) MCP: 0 servers");
  assert.equal(statusBarText({ servers: 1, errors: 0, warnings: 0 }), "$(server) MCP: 1 server");
  assert.equal(statusBarText({ servers: 3, errors: 1, warnings: 0 }), "$(server) MCP: 3 servers, 1 issue");
  assert.equal(statusBarText({ servers: 2, errors: 1, warnings: 1 }), "$(server) MCP: 2 servers, 2 issues");
});

test("statusBarTooltip pluralizes each count independently", () => {
  assert.equal(statusBarTooltip({ servers: 1, errors: 1, warnings: 1 }), "MCP Workbench — 1 server, 1 error, 1 warning");
  assert.equal(
    statusBarTooltip({ servers: 0, errors: 2, warnings: 3 }),
    "MCP Workbench — 0 servers, 2 errors, 3 warnings",
  );
});

test("healthSuffix renders ok latency+tools, error, and nothing for unknown/undefined", () => {
  assert.equal(healthSuffix(undefined), "");
  assert.equal(healthSuffix({ status: "unknown", checkedAt: 0 }), "");
  assert.equal(healthSuffix({ status: "error", checkedAt: 0 }), "✗ unreachable");
  assert.equal(healthSuffix({ status: "ok", latencyMs: 42, toolCount: 3, checkedAt: 0 }), "✓ 42ms · 3 tools");
  assert.equal(healthSuffix({ status: "ok", latencyMs: 5, toolCount: 1, checkedAt: 0 }), "✓ 5ms · 1 tool");
});

test("healthSuffix never emits the literal 'undefined' when fields are missing", () => {
  const suffix = healthSuffix({ status: "ok", checkedAt: 0 });
  assert.equal(suffix, "✓");
  assert.doesNotMatch(suffix, /undefined/);
});

test("recordFromProbe maps ok and error probe results", () => {
  assert.deepEqual(recordFromProbe({ ok: true, latencyMs: 12, toolCount: 4 }, 100), {
    status: "ok",
    latencyMs: 12,
    toolCount: 4,
    checkedAt: 100,
  });
  assert.deepEqual(recordFromProbe({ ok: false, latencyMs: 7, error: "boom" }, 200), {
    status: "error",
    latencyMs: 7,
    error: "boom",
    checkedAt: 200,
  });
});

test("HealthStore round-trips a record and persists it to the memento", async () => {
  const memento = fakeMemento();
  const store = new HealthStore(memento);
  await store.set("a", { status: "ok", latencyMs: 9, toolCount: 2, checkedAt: 1 });
  assert.deepEqual(store.get("a"), { status: "ok", latencyMs: 9, toolCount: 2, checkedAt: 1 });
  assert.deepEqual(memento.raw(), { a: { status: "ok", latencyMs: 9, toolCount: 2, checkedAt: 1 } });
});

test("HealthStore loads previously persisted records on construction", () => {
  const memento = fakeMemento({ a: { status: "error", checkedAt: 3, error: "x" } });
  const store = new HealthStore(memento);
  assert.deepEqual(store.get("a"), { status: "error", checkedAt: 3, error: "x" });
});

test("HealthStore.prune drops ids not in the valid set and persists only when something changed", async () => {
  const memento = fakeMemento({
    keep: { status: "ok", checkedAt: 1 },
    drop: { status: "ok", checkedAt: 2 },
  });
  const store = new HealthStore(memento);
  await store.prune(new Set(["keep"]));
  assert.ok(store.get("keep"));
  assert.equal(store.get("drop"), undefined);
  assert.deepEqual(Object.keys(memento.raw()), ["keep"]);

  const before = memento.raw();
  const result = store.prune(new Set(["keep"]));
  assert.equal(result, undefined);
  assert.equal(memento.raw(), before);
});

test("HealthStore ignores a corrupt persisted shape", () => {
  for (const corrupt of ["nope", ["a"], 42, null]) {
    const store = new HealthStore(fakeMemento(corrupt));
    assert.equal(store.get("a"), undefined);
  }
});

test("HealthStore drops malformed records and coerces a non-numeric checkedAt", () => {
  const memento = fakeMemento({
    bad: { status: "bogus", checkedAt: 1 },
    weird: { status: "ok", checkedAt: "soon", latencyMs: "fast", toolCount: 5 },
  });
  const store = new HealthStore(memento);
  assert.equal(store.get("bad"), undefined);
  assert.deepEqual(store.get("weird"), { status: "ok", checkedAt: 0, toolCount: 5 });
});
