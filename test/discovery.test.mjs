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

process.env.USERPROFILE = mkTemp("mcpwb-home-");
process.env.HOME = process.env.USERPROFILE;

const require = createRequire(import.meta.url);

const bundlePath = path.join(mkTemp("mcpwb-bundle-"), "discovery.cjs");
await build({
  entryPoints: [path.resolve("src/discovery.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: bundlePath,
  alias: { "jsonc-parser": require.resolve("jsonc-parser/lib/esm/main.js") },
  logLevel: "silent",
});

const { discoverAll, claudeDesktopConfigPath } = require(bundlePath);

function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

function scanCursorWorkspace(contents) {
  const ws = mkTemp("mcpwb-ws-");
  const file = path.join(ws, ".cursor", "mcp.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  const scanned = discoverAll([ws]);
  return scanned.find((f) => f.source === "cursor-workspace" && f.path === file);
}

function hasIssue(issues, code) {
  return issues.some((i) => i.code === code);
}

test("line-comment characters inside string values are preserved", () => {
  const file = scanCursorWorkspace(
    JSON.stringify({
      mcpServers: {
        fs: { command: "node", args: ["--note", "use // for division", "C:/proj//data"] },
      },
    })
  );
  assert.ok(file, "cursor-workspace file should be scanned");
  assert.equal(hasIssue(file.fileIssues, "bad-json"), false, "valid config must not be reported as bad-json");
  assert.equal(file.servers.length, 1);
  assert.equal(file.servers[0].name, "fs");
  assert.deepEqual(file.servers[0].transport.args, ["--note", "use // for division", "C:/proj//data"]);
});

test("block-comment characters inside string values are preserved", () => {
  const file = scanCursorWorkspace(
    JSON.stringify({
      mcpServers: { fs: { command: "node", args: ["/* not a comment */text"] } },
    })
  );
  assert.ok(file);
  assert.equal(hasIssue(file.fileIssues, "bad-json"), false);
  assert.equal(file.servers.length, 1);
  assert.deepEqual(file.servers[0].transport.args, ["/* not a comment */text"]);
});

test("slashes inside a header value are preserved for http servers", () => {
  const file = scanCursorWorkspace(
    JSON.stringify({
      mcpServers: { api: { url: "https://example.com/mcp", headers: { Authorization: "Bearer x // y" } } },
    })
  );
  assert.ok(file);
  assert.equal(hasIssue(file.fileIssues, "bad-json"), false);
  assert.equal(file.servers[0].transport.headers.Authorization, "Bearer x // y");
});

test("genuine comments and trailing commas still parse", () => {
  const file = scanCursorWorkspace(
    `{
  // primary server
  "mcpServers": {
    "fs": {
      "command": "node", /* runtime */
      "args": ["x"],
    },
  }
}`
  );
  assert.ok(file);
  assert.equal(hasIssue(file.fileIssues, "bad-json"), false);
  assert.equal(file.servers.length, 1);
  assert.equal(file.servers[0].name, "fs");
  assert.deepEqual(file.servers[0].transport.args, ["x"]);
});

test("trailing commas without comments still parse", () => {
  const file = scanCursorWorkspace(`{ "mcpServers": { "fs": { "command": "node", "args": ["x"], }, }, }`);
  assert.ok(file);
  assert.equal(hasIssue(file.fileIssues, "bad-json"), false);
  assert.deepEqual(file.servers[0].transport.args, ["x"]);
});

test("a leading UTF-8 BOM does not make the whole file vanish", () => {
  const bom = String.fromCharCode(0xfeff);
  const file = scanCursorWorkspace(
    bom + JSON.stringify({ mcpServers: { fs: { command: "node" } } })
  );
  assert.ok(file);
  assert.equal(hasIssue(file.fileIssues, "bad-json"), false);
  assert.equal(file.servers.length, 1);
  assert.equal(file.servers[0].name, "fs");
});

test("multi-root folders stay separate, each attributed to its workspace", () => {
  const wsA = mkTemp("mcpwb-wsA-");
  const wsB = mkTemp("mcpwb-wsB-");
  for (const [ws, name] of [[wsA, "alpha"], [wsB, "beta"]]) {
    const file = path.join(ws, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { [name]: { command: "node" } } }));
  }
  const cursorFiles = discoverAll([wsA, wsB]).filter((f) => f.source === "cursor-workspace" && f.exists);
  assert.equal(cursorFiles.length, 2);
  const a = cursorFiles.find((f) => f.workspaceFolder === wsA);
  const b = cursorFiles.find((f) => f.workspaceFolder === wsB);
  assert.ok(a && b);
  assert.deepEqual(a.servers.map((s) => s.name), ["alpha"]);
  assert.deepEqual(b.servers.map((s) => s.name), ["beta"]);
  assert.equal(a.servers[0].projectDir, wsA);
  assert.equal(b.servers[0].projectDir, wsB);
});

test("an empty mcpServers object is flagged as empty-root-key, not missing", () => {
  const file = scanCursorWorkspace(JSON.stringify({ mcpServers: {} }));
  assert.ok(file);
  assert.equal(file.servers.length, 0);
  assert.equal(hasIssue(file.fileIssues, "empty-root-key"), true);
  assert.equal(hasIssue(file.fileIssues, "missing-root-key"), false);
});

test("an array mcpServers does not produce servers named 0,1", () => {
  const file = scanCursorWorkspace(JSON.stringify({ mcpServers: [{ command: "node" }] }));
  assert.ok(file);
  assert.equal(file.servers.length, 0);
  assert.equal(hasIssue(file.fileIssues, "missing-root-key"), true);
});

test("non-string args and env values are dropped and flagged", () => {
  const file = scanCursorWorkspace(
    JSON.stringify({ mcpServers: { x: { command: "node", args: ["ok", 42, null], env: { A: "s", B: 5 } } } })
  );
  const server = file.servers[0];
  assert.deepEqual(server.transport.args, ["ok"]);
  assert.deepEqual(server.transport.env, { A: "s" });
  assert.equal(server.issues.some((i) => i.code === "non-string-arg"), true);
  assert.equal(server.issues.some((i) => i.code === "non-string-value"), true);
});

test("a repeated unset env var reference is only flagged once", () => {
  delete process.env.MCPWB_DEFINITELY_UNSET;
  const file = scanCursorWorkspace(
    JSON.stringify({
      mcpServers: { x: { url: "http://localhost", headers: { a: "${MCPWB_DEFINITELY_UNSET} ${MCPWB_DEFINITELY_UNSET}" } } },
    })
  );
  const unset = file.servers[0].issues.filter((i) => i.code === "env-unset");
  assert.equal(unset.length, 1);
});

test("editor variables like ${workspaceFolder} are not mistaken for unset env vars", () => {
  const file = scanCursorWorkspace(
    JSON.stringify({
      mcpServers: {
        x: { command: "node", env: { WS: "${workspaceFolder}", HOME_CFG: "${userHome}/.cfg" } },
      },
    })
  );
  assert.ok(file);
  assert.equal(hasIssue(file.servers[0].issues, "env-unset"), false);
});

test("only exact-case, unprefixed editor variables are exempt from the unset-env check", () => {
  delete process.env.workspacefolder;
  const lower = scanCursorWorkspace(
    JSON.stringify({ mcpServers: { x: { command: "node", env: { DIR: "${workspacefolder}" } } } })
  );
  assert.equal(hasIssue(lower.servers[0].issues, "env-unset"), true, "a lowercase ${workspacefolder} is a real env ref, not an editor variable");

  const prefixed = scanCursorWorkspace(
    JSON.stringify({ mcpServers: { x: { command: "node", env: { DIR: "${env:workspaceFolder}" } } } })
  );
  assert.equal(hasIssue(prefixed.servers[0].issues, "env-unset"), true, "${env:workspaceFolder} explicitly asks for an env var");
});

test("an env var name containing parentheses is recognized", () => {
  delete process.env["MCPWB_PARENS(x86)"];
  const file = scanCursorWorkspace(
    JSON.stringify({ mcpServers: { x: { command: "node", env: { P: "${MCPWB_PARENS(x86)}" } } } })
  );
  const issue = file.servers[0].issues.find((i) => i.code === "env-unset");
  assert.ok(issue, "a parenthesized env var reference should be parsed and, when unset, flagged");
});

test("claude-code-user projects filter to the open workspace unless showAll is set", () => {
  const claudeJson = path.join(process.env.USERPROFILE, ".claude.json");
  const wsMatch = mkTemp("mcpwb-proj-");
  fs.writeFileSync(
    claudeJson,
    JSON.stringify({
      projects: {
        [wsMatch]: { mcpServers: { inside: { command: "node" } } },
        "C:/elsewhere/other-project": { mcpServers: { outside: { command: "node" } } },
      },
    })
  );
  try {
    const filtered = discoverAll([wsMatch]).find((f) => f.source === "claude-code-user");
    assert.deepEqual(filtered.servers.map((s) => s.name), ["inside"]);
    assert.equal(filtered.servers[0].projectDir, wsMatch);

    const all = discoverAll([wsMatch], { showAllClaudeProjects: true }).find((f) => f.source === "claude-code-user");
    assert.deepEqual(all.servers.map((s) => s.name).sort(), ["inside", "outside"]);
  } finally {
    fs.rmSync(claudeJson, { force: true });
  }
});

test("malformed JSON is still reported as bad-json", () => {
  const file = scanCursorWorkspace(`{ "mcpServers": { "fs": { "command": } } }`);
  assert.ok(file);
  assert.equal(file.exists, true);
  assert.equal(hasIssue(file.fileIssues, "bad-json"), true);
  assert.equal(file.servers.length, 0);
});

function scanServers(servers) {
  return scanCursorWorkspace(JSON.stringify({ mcpServers: servers }));
}

function scanServersWith(servers, options) {
  const ws = mkTemp("mcpwb-ws-");
  const file = path.join(ws, ".cursor", "mcp.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }));
  return discoverAll([ws], options).find((f) => f.source === "cursor-workspace" && f.path === file);
}

function issueOf(server, code) {
  return server.issues.find((i) => i.code === code);
}

test("plaintext http to a remote host is flagged, but https and localhost are not", () => {
  const remote = scanServers({ a: { url: "http://example.com/mcp" } }).servers[0];
  assert.equal(hasIssue(remote.issues, "insecure-remote-transport"), true);

  const secure = scanServers({ a: { url: "https://example.com/mcp" } }).servers[0];
  assert.equal(hasIssue(secure.issues, "insecure-remote-transport"), false);

  const local = scanServers({ a: { url: "http://localhost:3000/mcp" } }).servers[0];
  assert.equal(hasIssue(local.issues, "insecure-remote-transport"), false);
});

test("credentials in a URL are flagged via userinfo and via a token query param", () => {
  const userinfo = scanServers({ a: { url: "https://user:pass@example.com/mcp" } }).servers[0];
  assert.equal(hasIssue(userinfo.issues, "credential-in-url"), true);

  const query = scanServers({ a: { url: "https://example.com/mcp?token=abc123" } }).servers[0];
  assert.equal(hasIssue(query.issues, "credential-in-url"), true);

  const clean = scanServers({ a: { url: "https://example.com/mcp" } }).servers[0];
  assert.equal(hasIssue(clean.issues, "credential-in-url"), false);
});

test("a URL targeting the cloud metadata address is flagged", () => {
  const meta = scanServers({ a: { url: "http://169.254.169.254/latest/meta-data" } }).servers[0];
  assert.equal(hasIssue(meta.issues, "metadata-endpoint"), true);
});

test("a hardcoded secret in an env value is flagged but a ${VAR} reference is not", () => {
  const literal = scanServers({ a: { command: "node", env: { OPENAI_API_KEY: "sk-" + "a".repeat(40) } } }).servers[0];
  const issue = issueOf(literal, "hardcoded-secret");
  assert.ok(issue, "literal secret should be flagged");
  assert.deepEqual(issue.path, ["mcpServers", "a", "env", "OPENAI_API_KEY"]);

  const ref = scanServers({ a: { command: "node", env: { OPENAI_API_KEY: "${OPENAI_API_KEY}" } } }).servers[0];
  assert.equal(hasIssue(ref.issues, "hardcoded-secret"), false);
});

test("a hardcoded secret in an argument is flagged at its original index", () => {
  const server = scanServers({ a: { command: "node", args: ["--token", "ghp_" + "b".repeat(36)] } }).servers[0];
  const issue = issueOf(server, "hardcoded-secret");
  assert.ok(issue);
  assert.deepEqual(issue.path, ["mcpServers", "a", "args", 1]);
});

test("an unpinned npx launcher is info-flagged; a pinned one is not", () => {
  const unpinned = scanServers({ a: { command: "npx", args: ["-y", "some-pkg"] } }).servers[0];
  const issue = issueOf(unpinned, "unpinned-launcher");
  assert.ok(issue, "unpinned launcher should be flagged");
  assert.equal(issue.level, "info");

  const pinned = scanServers({ a: { command: "npx", args: ["-y", "some-pkg@1.2.3"] } }).servers[0];
  assert.equal(hasIssue(pinned.issues, "unpinned-launcher"), false);

  const notLauncher = scanServers({ a: { command: "node", args: ["server.js"] } }).servers[0];
  assert.equal(hasIssue(notLauncher.issues, "unpinned-launcher"), false);
});

test("an argument that pipes a download into a shell is flagged", () => {
  const server = scanServers({ a: { command: "bash", args: ["-c", "curl https://x.sh | sh"] } }).servers[0];
  const issue = issueOf(server, "risky-shell-pipe");
  assert.ok(issue);
  assert.deepEqual(issue.path, ["mcpServers", "a", "args", 1]);
});

test("an unknown-transport entry anchors its issue at the server name", () => {
  const server = scanServers({ a: { foo: "bar" } }).servers[0];
  const issue = issueOf(server, "unknown-transport");
  assert.ok(issue);
  assert.deepEqual(issue.path, ["mcpServers", "a"]);
});

test("env-unset carries a path to the offending env key", () => {
  delete process.env.MCPWB_UNSET_PATH;
  const server = scanServers({ a: { command: "node", env: { CONFIG: "${MCPWB_UNSET_PATH}" } } }).servers[0];
  const issue = issueOf(server, "env-unset");
  assert.ok(issue);
  assert.deepEqual(issue.path, ["mcpServers", "a", "env", "CONFIG"]);
});

test("a plain stdio server with a pinned launcher raises no security issues", () => {
  const server = scanServers({ a: { command: "node", args: ["./server.js"], env: { PORT: "3000" } } }).servers[0];
  const securityCodes = ["hardcoded-secret", "credential-in-url", "insecure-remote-transport", "risky-shell-pipe", "encoded-powershell", "metadata-endpoint", "unpinned-launcher"];
  assert.equal(server.issues.some((i) => securityCodes.includes(i.code)), false);
});

test("security checks are dropped when securityEnabled is false", () => {
  const file = scanServersWith(
    { a: { url: "http://example.com/mcp" }, b: { command: "npx", args: ["-y", "pkg"] } },
    { securityEnabled: false },
  );
  assert.equal(file.servers.some((s) => hasIssue(s.issues, "insecure-remote-transport")), false);
  assert.equal(file.servers.some((s) => hasIssue(s.issues, "unpinned-launcher")), false);
});

test("structural checks survive securityEnabled false", () => {
  delete process.env.MCPWB_STRUCT_UNSET;
  const file = scanServersWith(
    { a: { command: "npx", args: ["pkg"], env: { X: "${MCPWB_STRUCT_UNSET}" } } },
    { securityEnabled: false },
  );
  assert.equal(hasIssue(file.servers[0].issues, "npx-missing-y"), true);
  assert.equal(hasIssue(file.servers[0].issues, "env-unset"), true);
  assert.equal(hasIssue(file.servers[0].issues, "unpinned-launcher"), false);
});

test("a single security rule can be turned off via ruleSeverity", () => {
  const file = scanServersWith(
    { a: { command: "npx", args: ["-y", "pkg"] } },
    { ruleSeverity: { "unpinned-launcher": "off" } },
  );
  assert.equal(hasIssue(file.servers[0].issues, "unpinned-launcher"), false);
});

test("a security rule severity can be escalated via ruleSeverity", () => {
  const file = scanServersWith(
    { a: { command: "node", env: { KEY: "sk-" + "a".repeat(40) } } },
    { ruleSeverity: { "hardcoded-secret": "error" } },
  );
  const issue = file.servers[0].issues.find((i) => i.code === "hardcoded-secret");
  assert.ok(issue);
  assert.equal(issue.level, "error");
});

test("ruleSeverity does not affect non-security checks", () => {
  delete process.env.MCPWB_RS_UNSET;
  const file = scanServersWith(
    { a: { command: "node", env: { KEY: "${MCPWB_RS_UNSET}" } } },
    { ruleSeverity: { "env-unset": "off" } },
  );
  assert.equal(hasIssue(file.servers[0].issues, "env-unset"), true);
});

test("the Claude Desktop config path resolves to the per-OS application-support location", () => {
  const home = process.env.USERPROFILE;

  withPlatform("win32", () => {
    const savedAppData = process.env.APPDATA;
    process.env.APPDATA = path.join(home, "AppData", "Roaming");
    try {
      assert.equal(
        claudeDesktopConfigPath(),
        path.join(process.env.APPDATA, "Claude", "claude_desktop_config.json"),
      );
    } finally {
      if (savedAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = savedAppData;
    }
  });

  withPlatform("darwin", () => {
    assert.equal(
      claudeDesktopConfigPath(),
      path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    );
  });

  withPlatform("linux", () => {
    assert.equal(
      claudeDesktopConfigPath(),
      path.join(home, ".config", "Claude", "claude_desktop_config.json"),
    );
  });
});

test("the Claude Desktop config path is undefined on Windows when APPDATA is unset", () => {
  withPlatform("win32", () => {
    const savedAppData = process.env.APPDATA;
    delete process.env.APPDATA;
    try {
      assert.equal(claudeDesktopConfigPath(), undefined);
    } finally {
      if (savedAppData !== undefined) process.env.APPDATA = savedAppData;
    }
  });
});
