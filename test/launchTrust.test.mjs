import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";

const require = createRequire(import.meta.url);

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

function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

function withPath(value, fn) {
  const saved = process.env.PATH;
  process.env.PATH = value;
  try {
    return fn();
  } finally {
    process.env.PATH = saved;
  }
}

function onWindows(searchPath, fn) {
  return withPlatform("win32", () => withPath(searchPath, fn));
}

const bundlePath = path.join(mkTemp("mcpwb-trust-"), "launchTrust.cjs");
await build({
  entryPoints: [path.resolve("src/launchTrust.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: bundlePath,
  alias: { "jsonc-parser": require.resolve("jsonc-parser/lib/esm/main.js") },
  logLevel: "silent",
});

const {
  LaunchTrustStore,
  launchFingerprint,
  launchAction,
  launchQuestion,
  launchPreview,
  hostVariables,
  launchedExecutable,
  launchesWorkspaceFile,
} = require(bundlePath);

const STORE_KEY = "mcpWorkbench.trustedLaunches";

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
  };
}

function stdioServer(transport = {}) {
  return {
    name: "local",
    source: "claude-code-workspace",
    configPath: "/ws/.mcp.json",
    rootKey: "mcpServers",
    raw: {},
    issues: [],
    transport: { kind: "stdio", command: "node", args: ["server.js"], env: { PORT: "3000" }, ...transport },
  };
}

function httpServer(transport = {}) {
  return {
    name: "remote",
    source: "vscode-workspace",
    configPath: "/ws/.vscode/mcp.json",
    rootKey: "servers",
    raw: {},
    issues: [],
    transport: { kind: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer ${GITHUB_TOKEN}" }, ...transport },
  };
}

function toolServer(workspace, env = {}) {
  return { ...stdioServer({ command: "mcpwbtool", args: [], env }), projectDir: workspace };
}

function writeTool(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "mcpwbtool.cmd"), "@echo off\n");
  return path.join(dir, "mcpwbtool.cmd");
}

function escapedForm(character) {
  const code = character.codePointAt(0);
  return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, "0")}`;
}

test("a trusted configuration stays trusted only until its launch details change", async () => {
  const store = new LaunchTrustStore(fakeMemento());
  assert.equal(store.isTrusted("id", stdioServer()), false);

  await store.trust("id", stdioServer());
  assert.equal(store.isTrusted("id", stdioServer()), true);
  assert.equal(store.isTrusted("id", stdioServer({ args: ["other.js"] })), false);
  assert.equal(store.isTrusted("id", stdioServer({ command: "python" })), false);
  assert.equal(store.isTrusted("id", stdioServer({ env: { PORT: "3000", NODE_OPTIONS: "--require ./x.js" } })), false);
  assert.equal(store.isTrusted("other-id", stdioServer()), false);
});

test("reordering env keys keeps the same fingerprint", () => {
  const a = stdioServer({ env: { A: "1", B: "2" } });
  const b = stdioServer({ env: { B: "2", A: "1" } });
  assert.equal(launchFingerprint(a), launchFingerprint(b));
});

test("changing a remote server's URL or a header value invalidates trust", async () => {
  const store = new LaunchTrustStore(fakeMemento());
  await store.trust("id", httpServer());
  assert.equal(store.isTrusted("id", httpServer()), true);
  assert.equal(store.isTrusted("id", httpServer({ url: "https://evil.example.com/mcp" })), false);
  assert.equal(store.isTrusted("id", httpServer({ headers: { Authorization: "Bearer ${AWS_SECRET_ACCESS_KEY}" } })), false);
});

test("trust survives a reload through the memento, and reset clears it", async () => {
  const memento = fakeMemento();
  await new LaunchTrustStore(memento).trust("id", stdioServer());

  const reloaded = new LaunchTrustStore(memento);
  assert.equal(reloaded.size, 1);
  assert.equal(reloaded.isTrusted("id", stdioServer()), true);

  await reloaded.reset();
  assert.equal(reloaded.size, 0);
  assert.equal(new LaunchTrustStore(memento).isTrusted("id", stdioServer()), false);
});

test("malformed persisted trust entries are ignored", () => {
  const store = new LaunchTrustStore(fakeMemento({ good: launchFingerprint(stdioServer()), bad: 42, worse: null }));
  assert.equal(store.size, 1);
  assert.equal(store.isTrusted("good", stdioServer()), true);
  assert.equal(new LaunchTrustStore(fakeMemento(["x"])).size, 0);
  assert.equal(new LaunchTrustStore(fakeMemento("x")).size, 0);
});

test("the stdio preview lists host variables first, then the program, one argument per line, and every env entry", () => {
  const preview = launchPreview(
    stdioServer({
      args: ["server.js", "--root", "${workspaceFolder}"],
      env: { NODE_OPTIONS: "--require ./x.js", TOKEN: "${API_TOKEN}" },
    }),
  );
  assert.match(preview, /starts a program on your machine/);
  assert.match(preview, /^Filled in from your machine: API_TOKEN$/m);
  assert.match(preview, /Program: "node"/);
  assert.ok(preview.indexOf("Filled in") < preview.indexOf("Program:"), preview);
  assert.ok(preview.includes('Arguments:\n  "server.js"\n  "--root"\n  "${workspaceFolder}"'), preview);
  assert.ok(preview.includes('NODE_OPTIONS = "--require ./x.js"'), preview);
});

test("the remote preview shows the headers and names the secrets that will be sent", () => {
  const preview = launchPreview(httpServer());
  assert.match(preview, /connects to a remote server/);
  assert.ok(preview.includes('Authorization: "Bearer ${GITHUB_TOKEN}"'), preview);
  assert.match(preview, /^Filled in from your machine: GITHUB_TOKEN$/m);
  assert.doesNotMatch(preview, /starts a program/);
});

test("a remote server with no headers and no variables gets a short preview", () => {
  const preview = launchPreview(httpServer({ headers: {} }));
  assert.doesNotMatch(preview, /Headers/);
  assert.doesNotMatch(preview, /Filled in/);
});

test("a long argument is shortened on its own line, so later arguments still show", () => {
  const preview = launchPreview(stdioServer({ args: ["--pad=" + "x".repeat(500), "--registry=https://npm.evil.example/"] }));
  assert.equal(preview.includes("x".repeat(300)), false);
  assert.match(preview, /\(\+\d+ more characters\)/);
  assert.ok(preview.includes('"--registry=https://npm.evil.example/"'), preview);
  assert.match(preview, /Some values are shortened here/);
});

test("control, format, line-separator and filler characters are shown escaped instead of rendered", () => {
  const hidden = ["‮", "\n", "​", " ", " ", "\u0085", "­", "؜", "⁠", "﻿", "ㅤ", "\u{E0041}"];
  const preview = launchPreview(stdioServer({ args: hidden.map((c) => `a${c}b`) }));
  for (const c of hidden) {
    const escaped = escapedForm(c);
    assert.ok(preview.includes(`"a${escaped}b"`), `${escaped} should be escaped`);
    assert.equal(preview.includes(`a${c}b`), false, `${escaped} should not appear raw`);
  }
});

test("the server name is escaped and clipped in the prompt title", () => {
  const server = stdioServer();
  server.name = "safe‮eman\n" + "x".repeat(200);
  const question = launchQuestion(server);
  assert.ok(question.includes("safe\\u202eeman\\u000a"), question);
  assert.equal(question.includes("‮"), false);
  assert.ok(question.length < 120, question);
});

test("long keys are clipped and long lists are capped, and both are flagged as shortened", () => {
  const env = {};
  for (let i = 0; i < 60; i++) {
    env[`VAR_${i}`] = "v";
  }
  env["K".repeat(500)] = "v";
  const preview = launchPreview(stdioServer({ env }));
  assert.equal(preview.includes("K".repeat(100)), false);
  assert.match(preview, /…and 21 more/);
  assert.match(preview, /Some values are shortened here/);
});

test("a remote server names the local paths it sends, not just environment variables", () => {
  assert.deepEqual(hostVariables(httpServer({ url: "https://mcp.example.com/${userHome}", headers: {} })), ["userHome"]);
  assert.match(launchPreview(httpServer({ headers: { "X-Home": "${userHome}" } })), /^Filled in from your machine: userHome$/m);
});

test("on Windows a program on PATH wins over a same-named file in the workspace", () => {
  const workspace = mkTemp("mcpwb-ws-");
  const bin = mkTemp("mcpwb-bin-");
  writeTool(workspace);
  const onPath = writeTool(bin);
  const server = toolServer(workspace);
  onWindows(bin, () => {
    assert.deepEqual(launchedExecutable(server), { path: onPath, fromWorkingDir: false });
    assert.equal(launchesWorkspaceFile(server), false);
    assert.match(launchPreview(server), /^Resolves to: ".*mcpwbtool\.cmd"$/m);
  });
});

test("on Windows a bare command only found through the workspace is called out and changes the fingerprint", () => {
  const workspace = mkTemp("mcpwb-ws-");
  const server = toolServer(workspace);
  onWindows(mkTemp("mcpwb-bin-"), () => {
    const before = launchFingerprint(server);
    assert.equal(launchesWorkspaceFile(server), false);

    writeTool(workspace);
    assert.equal(launchesWorkspaceFile(server), true);
    assert.notEqual(launchFingerprint(server), before);
    assert.match(launchPreview(server), /Resolves to: ".*mcpwbtool\.cmd" \(found through this workspace folder, not on your PATH\)/);
  });
});

test("a program found on PATH is not treated as a workspace file even when it lives under the workspace folder", () => {
  const workspace = mkTemp("mcpwb-home-");
  const bin = path.join(workspace, ".local", "bin");
  writeTool(bin);
  const server = toolServer(workspace);
  onWindows(bin, () => {
    assert.equal(launchesWorkspaceFile(server), false);
    assert.doesNotMatch(launchPreview(server), /found through this workspace folder/);
  });
});

test("a PATH built from ${workspaceFolder} is resolved after substitution, so a program added there changes the fingerprint", () => {
  const workspace = mkTemp("mcpwb-ws-");
  const server = toolServer(workspace, { PATH: "${workspaceFolder}/bin" });
  onWindows(mkTemp("mcpwb-bin-"), () => {
    const before = launchFingerprint(server);
    const added = writeTool(path.join(workspace, "bin"));
    assert.equal(launchedExecutable(server).path, added);
    assert.notEqual(launchFingerprint(server), before);
  });
});

test("a relative PATH entry in the config is treated as coming from the workspace", () => {
  const workspace = mkTemp("mcpwb-ws-");
  writeTool(path.join(workspace, "bin"));
  const server = toolServer(workspace, { PATH: "bin" });
  onWindows(mkTemp("mcpwb-bin-"), () => {
    assert.equal(launchesWorkspaceFile(server), true);
  });
});

test("on Windows an unresolvable bare command says so in the preview", () => {
  const server = { ...stdioServer({ command: "mcpwb-missing", args: [], env: {} }), projectDir: mkTemp("mcpwb-ws-") };
  onWindows(mkTemp("mcpwb-bin-"), () => {
    assert.match(launchPreview(server), /^Resolves to: nothing on your PATH$/m);
  });
});

test("stdio servers are launched and remote servers are connected to", () => {
  assert.equal(launchAction(stdioServer()), "Launch");
  assert.equal(launchAction(httpServer()), "Connect");
  assert.equal(launchQuestion(stdioServer()), "Launch local from this workspace?");
  assert.equal(launchQuestion(httpServer()), "Connect to remote from this workspace?");
});

test("hostVariables lists each referenced variable once across every field and skips editor variables for local programs", () => {
  const names = hostVariables(
    stdioServer({ command: "${TOOLS}/node", args: ["${KEY}", "${env:KEY}", "${userHome}/x"], env: { A: "${OTHER}" } }),
  );
  assert.deepEqual(names, ["TOOLS", "KEY", "OTHER"]);
});
