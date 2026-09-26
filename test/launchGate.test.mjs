import { test, after, beforeEach } from "node:test";
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

const bundleDir = mkTemp("mcpwb-gate-");

async function bundle(entry) {
  const outfile = path.join(bundleDir, `${path.basename(entry, ".ts")}.cjs`);
  await build({
    entryPoints: [path.resolve(entry)],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node18",
    outfile,
    alias: {
      vscode: path.resolve("test/stubs/vscode.mjs"),
      "jsonc-parser": require.resolve("jsonc-parser/lib/esm/main.js"),
    },
    logLevel: "silent",
  });
  return require(outfile);
}

const { confirmLaunch, resetLaunchTrust, forgetLegacyLaunchTrust, ALWAYS_ALLOW, MANAGE_TRUST } = await bundle("src/launchGate.ts");
const { LaunchTrustStore } = await bundle("src/launchTrust.ts");

function fakeMemento(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get(key, fallback) {
      return key in data ? data[key] : fallback;
    },
    update(key, value) {
      if (value === undefined) {
        delete data[key];
      } else {
        data[key] = value;
      }
      return Promise.resolve();
    },
  };
}

function dialogs(...choices) {
  globalThis.__mcpwbVscode = { warnings: [], choices, commands: [] };
  return globalThis.__mcpwbVscode;
}

function setTrusted(trusted) {
  if (trusted) {
    delete process.env.MCPWB_TEST_UNTRUSTED;
  } else {
    process.env.MCPWB_TEST_UNTRUSTED = "1";
  }
}

function openFolders(...folders) {
  process.env.MCPWB_TEST_FOLDERS = JSON.stringify(folders);
}

const workspace = mkTemp("mcpwb-ws-");

function workspaceServer(transport = {}) {
  return {
    name: "repo-server",
    source: "claude-code-workspace",
    configPath: path.join(workspace, ".mcp.json"),
    rootKey: "mcpServers",
    projectDir: workspace,
    raw: {},
    issues: [],
    transport: { kind: "stdio", command: "node", args: ["server.js"], env: {}, ...transport },
  };
}

function userServer(projectDir) {
  return {
    name: "user-server",
    source: "claude-code-user",
    configPath: path.join(os.homedir(), ".claude.json"),
    rootKey: "mcpServers",
    scope: projectDir,
    projectDir,
    raw: {},
    issues: [],
    transport: { kind: "stdio", command: "node", args: ["server.js"], env: {} },
  };
}

function remoteWorkspaceServer() {
  return {
    ...workspaceServer(),
    source: "vscode-workspace",
    transport: { kind: "http", url: "https://mcp.example.com/mcp", headers: {} },
  };
}

beforeEach(() => {
  setTrusted(true);
  openFolders(workspace);
  dialogs();
});

test("a user-level server with no workspace working folder launches without a prompt, even in Restricted Mode", async () => {
  setTrusted(false);
  const state = dialogs();
  assert.equal(await confirmLaunch(new LaunchTrustStore(fakeMemento()), userServer(undefined)), true);
  assert.equal(state.warnings.length, 0);
});

test("in Restricted Mode a workspace server is refused and can open the trust editor", async () => {
  setTrusted(false);
  const state = dialogs(MANAGE_TRUST);
  const store = new LaunchTrustStore(fakeMemento());
  assert.equal(await confirmLaunch(store, workspaceServer()), false);
  assert.match(state.warnings[0].message, /Restricted Mode/);
  assert.deepEqual(state.commands.map((c) => c.command), ["workbench.trust.manage"]);
  assert.equal(store.size, 0);
});

test("in Restricted Mode a user-level server that runs in the open workspace folder is refused too", async () => {
  setTrusted(false);
  const state = dialogs();
  assert.equal(await confirmLaunch(new LaunchTrustStore(fakeMemento()), userServer(workspace)), false);
  assert.match(state.warnings[0].message, /would run code from this workspace/);
});

test("in Restricted Mode a user-level server for a folder that isn't open still launches", async () => {
  setTrusted(false);
  const state = dialogs();
  assert.equal(await confirmLaunch(new LaunchTrustStore(fakeMemento()), userServer(mkTemp("mcpwb-other-"))), true);
  assert.equal(state.warnings.length, 0);
});

test("in a trusted workspace a user-level server running there launches without a prompt", async () => {
  const state = dialogs();
  assert.equal(await confirmLaunch(new LaunchTrustStore(fakeMemento()), userServer(workspace)), true);
  assert.equal(state.warnings.length, 0);
});

test("a workspace server shows a modal preview, and launching once does not remember it", async () => {
  const store = new LaunchTrustStore(fakeMemento());
  const state = dialogs("Launch", "Launch");
  assert.equal(await confirmLaunch(store, workspaceServer()), true);
  const [first] = state.warnings;
  assert.match(first.message, /Launch repo-server from this workspace\?/);
  assert.equal(first.rest[0].modal, true);
  assert.match(first.rest[0].detail, /Program: "node"/);
  assert.deepEqual(first.rest.slice(1), ["Launch", ALWAYS_ALLOW]);

  assert.equal(await confirmLaunch(store, workspaceServer()), true);
  assert.equal(state.warnings.length, 2, "a one-off launch asks again next time");
});

test("always allowing a configuration skips the prompt until the entry changes", async () => {
  const store = new LaunchTrustStore(fakeMemento());
  const state = dialogs(ALWAYS_ALLOW);
  assert.equal(await confirmLaunch(store, workspaceServer()), true);
  assert.equal(await confirmLaunch(store, workspaceServer()), true);
  assert.equal(state.warnings.length, 1);

  state.choices.push("Launch");
  assert.equal(await confirmLaunch(store, workspaceServer({ args: ["other.js"] })), true);
  assert.equal(state.warnings.length, 2);
});

test("dismissing the prompt refuses the launch", async () => {
  dialogs(undefined);
  assert.equal(await confirmLaunch(new LaunchTrustStore(fakeMemento()), workspaceServer()), false);
});

test("a remote workspace server is offered as a connection, not a launch", async () => {
  const state = dialogs("Connect");
  assert.equal(await confirmLaunch(new LaunchTrustStore(fakeMemento()), remoteWorkspaceServer()), true);
  assert.match(state.warnings[0].message, /Connect to repo-server from this workspace\?/);
  assert.deepEqual(state.warnings[0].rest.slice(1), ["Connect", ALWAYS_ALLOW]);
});

test("in Restricted Mode a remote workspace server is described as a connection", async () => {
  setTrusted(false);
  const state = dialogs();
  assert.equal(await confirmLaunch(new LaunchTrustStore(fakeMemento()), remoteWorkspaceServer()), false);
  assert.match(state.warnings[0].message, /Trust the workspace to connect to it/);
});

test("resetting launch trust reports how many approvals were cleared", async () => {
  const store = new LaunchTrustStore(fakeMemento());
  assert.match(await resetLaunchTrust(store), /no trusted launch configurations/);
  await store.trust("a", workspaceServer());
  assert.match(await resetLaunchTrust(store), /cleared 1 trusted launch configuration in/);
  await store.trust("a", workspaceServer());
  await store.trust("b", workspaceServer({ args: ["b.js"] }));
  assert.match(await resetLaunchTrust(store), /cleared 2 trusted launch configurations/);
  assert.equal(store.size, 0);
});

test("the old workspace-wide trust flag is removed, and nothing is written when it is absent", async () => {
  const legacy = fakeMemento({ trustWorkspaceLaunch: true, other: 1 });
  await forgetLegacyLaunchTrust(legacy);
  assert.deepEqual(legacy.data, { other: 1 });

  const clean = fakeMemento({ other: 1 });
  assert.equal(forgetLegacyLaunchTrust(clean), undefined);
});
