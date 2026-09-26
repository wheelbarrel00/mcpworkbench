import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { build } from "esbuild";
import { createRequire } from "node:module";

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

function onWindowsWithPath(searchPath, fn) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const savedPath = process.env.PATH;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  process.env.PATH = searchPath;
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", platform);
    process.env.PATH = savedPath;
  }
}

function dirWith(...names) {
  const dir = mkTemp("mcpwb-bin-");
  for (const name of names) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), "@echo off\n");
  }
  return dir;
}

const bundlePath = path.join(mkTemp("mcpwb-exe-"), "executable.cjs");
await build({
  entryPoints: [path.resolve("src/executable.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: bundlePath,
  logLevel: "silent",
});

const { resolveWindowsExecutable, spawnableCommand, isWithinFolder } = require(bundlePath);

test("a bare command resolves through PATH and PATHEXT to an absolute file found on PATH", () => {
  const bin = dirWith("mcpwbtool.cmd");
  onWindowsWithPath(bin, () => {
    assert.deepEqual(resolveWindowsExecutable("mcpwbtool", {}, undefined), { path: path.join(bin, "mcpwbtool.cmd"), fromWorkingDir: false });
  });
});

test("PATH entries are searched before the working folder", () => {
  const bin = dirWith("mcpwbtool.cmd");
  const workspace = dirWith("mcpwbtool.cmd");
  onWindowsWithPath(bin, () => {
    assert.deepEqual(resolveWindowsExecutable("mcpwbtool", {}, workspace), { path: path.join(bin, "mcpwbtool.cmd"), fromWorkingDir: false });
  });
});

test("the working folder is a last resort and is reported as such", () => {
  const workspace = dirWith("mcpwbtool.cmd");
  onWindowsWithPath(mkTemp("mcpwb-bin-"), () => {
    assert.deepEqual(resolveWindowsExecutable("mcpwbtool", {}, workspace), { path: path.join(workspace, "mcpwbtool.cmd"), fromWorkingDir: true });
  });
});

test("a relative PATH entry resolves against the working folder and is reported as coming from it", () => {
  const workspace = dirWith(path.join("tools", "mcpwbtool.cmd"));
  onWindowsWithPath(`tools;${mkTemp("mcpwb-bin-")}`, () => {
    assert.deepEqual(resolveWindowsExecutable("mcpwbtool", {}, workspace), {
      path: path.join(workspace, "tools", "mcpwbtool.cmd"),
      fromWorkingDir: true,
    });
  });
});

test("a relative path-form command resolves against the working folder", () => {
  const workspace = dirWith(path.join("scripts", "mcpwbtool.cmd"));
  onWindowsWithPath(mkTemp("mcpwb-bin-"), () => {
    assert.deepEqual(resolveWindowsExecutable("scripts/mcpwbtool", {}, workspace), {
      path: path.join(workspace, "scripts", "mcpwbtool.cmd"),
      fromWorkingDir: true,
    });
  });
});

test("a command with an explicit extension is tried as written", () => {
  const bin = dirWith("mcpwbtool.cmd");
  onWindowsWithPath(bin, () => {
    assert.equal(resolveWindowsExecutable("mcpwbtool.cmd", {}, undefined).path, path.join(bin, "mcpwbtool.cmd"));
  });
});

test("an extensionless file does not satisfy a bare command", () => {
  const bin = dirWith("mcpwbtool");
  onWindowsWithPath(bin, () => {
    assert.equal(resolveWindowsExecutable("mcpwbtool", {}, undefined), undefined);
  });
});

test("a PATH set in the server's env wins over the host PATH, whatever its casing", () => {
  const hostBin = dirWith("mcpwbtool.cmd");
  const serverBin = dirWith("mcpwbtool.cmd");
  onWindowsWithPath(hostBin, () => {
    assert.equal(resolveWindowsExecutable("mcpwbtool", { Path: serverBin }, undefined).path, path.join(serverBin, "mcpwbtool.cmd"));
  });
});

test("quoted PATH entries are unwrapped and network entries are skipped", () => {
  const bin = dirWith("mcpwbtool.cmd");
  onWindowsWithPath(`\\\\mcpwb-unc.invalid\\share;//mcpwb-unc.invalid/share;"${bin}"`, () => {
    assert.equal(resolveWindowsExecutable("mcpwbtool", {}, undefined).path, path.join(bin, "mcpwbtool.cmd"));
  });
});

test("absolute, network, drive-relative and unexpanded commands, unknown commands and other platforms are left alone", () => {
  const bin = dirWith("mcpwbtool.cmd", "${TOOLS}.cmd");
  onWindowsWithPath(bin, () => {
    assert.equal(resolveWindowsExecutable(path.join(bin, "mcpwbtool"), {}, bin), undefined);
    assert.equal(resolveWindowsExecutable("\\\\mcpwb-unc.invalid\\share\\mcpwbtool", {}, bin), undefined);
    assert.equal(resolveWindowsExecutable("C:mcpwbtool", {}, bin), undefined);
    assert.equal(resolveWindowsExecutable("${TOOLS}", {}, bin), undefined);
    assert.equal(resolveWindowsExecutable("mcpwb-missing", {}, undefined), undefined);
  });
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  try {
    assert.equal(resolveWindowsExecutable("mcpwbtool", { PATH: bin }, undefined), undefined);
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});

test("a resolved program is spawned by its full path", () => {
  const bin = dirWith("mcpwbtool.cmd");
  assert.equal(spawnableCommand("mcpwbtool", { path: path.join(bin, "mcpwbtool.cmd"), fromWorkingDir: false }, undefined), path.join(bin, "mcpwbtool.cmd"));
  assert.equal(spawnableCommand("mcpwbtool", undefined, undefined), "mcpwbtool");
});

test("a batch file whose path cmd.exe would split falls back to the bare name, unless the working folder could shadow it", () => {
  const bin = dirWith(path.join("a=b", "mcpwbtool.cmd"));
  const resolved = { path: path.join(bin, "a=b", "mcpwbtool.cmd"), fromWorkingDir: false };
  onWindowsWithPath(bin, () => {
    assert.equal(spawnableCommand("mcpwbtool", resolved, mkTemp("mcpwb-ws-")), "mcpwbtool");
    assert.throws(() => spawnableCommand("mcpwbtool", resolved, dirWith("mcpwbtool.cmd")), /can't launch .* safely/i);
    assert.throws(() => spawnableCommand("mcpwbtool", { ...resolved, fromWorkingDir: true }, undefined), /safely/);
  });
});

test("isWithinFolder accepts the folder itself and its descendants, not a sibling with the same prefix or a dotted child name", () => {
  const root = mkTemp("mcpwb-root-");
  assert.equal(isWithinFolder(path.join(root, "a", "tool.cmd"), root), true);
  assert.equal(isWithinFolder(root, root), true);
  assert.equal(isWithinFolder(path.join(root, "..cache"), root), true);
  assert.equal(isWithinFolder(path.join(`${root}-sibling`, "tool.cmd"), root), false);
  assert.equal(isWithinFolder(path.dirname(root), root), false);
});
