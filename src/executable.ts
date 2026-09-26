import * as fs from "fs";
import * as path from "path";

const DEFAULT_PATH_EXTENSIONS = ".COM;.EXE;.BAT;.CMD";
const BATCH_FILE = /\.(?:cmd|bat)$/i;
const CHARACTERS_CMD_SPLITS_ON = /[= ]/;
const DRIVE_RELATIVE = /^[a-z]:(?![\\/])/i;

export interface ResolvedExecutable {
  path: string;
  fromWorkingDir: boolean;
}

export function resolveWindowsExecutable(
  command: string,
  env: Record<string, string>,
  workingDir: string | undefined,
): ResolvedExecutable | undefined {
  if (process.platform !== "win32" || !command.trim() || command.includes("${") || isNetworkPath(command) || DRIVE_RELATIVE.test(command)) {
    return undefined;
  }
  const localWorkingDir = workingDir && !isNetworkPath(workingDir) ? workingDir : undefined;
  const extensions = executableExtensions(command);

  if (/[\\/]/.test(command)) {
    if (path.isAbsolute(command) || !localWorkingDir) {
      return undefined;
    }
    const found = findWithExtensions(path.resolve(localWorkingDir, command), extensions);
    return found ? { path: found, fromWorkingDir: true } : undefined;
  }

  for (const entry of searchEntries(envValue(env, "PATH") ?? process.env.PATH ?? "")) {
    const relative = !path.isAbsolute(entry);
    const directory = !relative ? entry : localWorkingDir ? path.resolve(localWorkingDir, entry) : undefined;
    const found = directory ? findWithExtensions(path.join(directory, command), extensions) : undefined;
    if (found) {
      return { path: found, fromWorkingDir: relative };
    }
  }

  if (localWorkingDir) {
    const found = findWithExtensions(path.join(localWorkingDir, command), extensions);
    if (found) {
      return { path: found, fromWorkingDir: true };
    }
  }
  return undefined;
}

export function spawnableCommand(command: string, resolved: ResolvedExecutable | undefined, workingDir: string | undefined): string {
  if (!resolved) {
    return command;
  }
  if (!BATCH_FILE.test(resolved.path) || !CHARACTERS_CMD_SPLITS_ON.test(resolved.path)) {
    return resolved.path;
  }
  const shadowed = workingDir !== undefined && findWithExtensions(path.join(workingDir, command), executableExtensions(command)) !== undefined;
  if (resolved.fromWorkingDir || shadowed) {
    throw new Error(
      `Can't launch ${resolved.path} safely: cmd.exe splits paths containing "=" or a non-breaking space. Move it to a folder without those characters or point the config at it directly.`,
    );
  }
  return command;
}

export function isWithinFolder(target: string, folder: string): boolean {
  const relative = path.relative(folder, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isNetworkPath(value: string): boolean {
  return /^(?:\\\\|\/\/)/.test(value);
}

function searchEntries(searchPath: string): string[] {
  return searchPath
    .split(";")
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => entry !== "" && !isNetworkPath(entry));
}

function executableExtensions(command: string): string[] {
  const extensions = (process.env.PATHEXT || DEFAULT_PATH_EXTENSIONS)
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean);
  return command.includes(".") ? ["", ...extensions] : extensions;
}

function findWithExtensions(base: string, extensions: string[]): string | undefined {
  for (const extension of extensions) {
    const candidate = base + extension;
    if (isFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function envValue(env: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EACCES" && isSymbolicLink(candidate);
  }
}

function isSymbolicLink(candidate: string): boolean {
  try {
    return fs.lstatSync(candidate).isSymbolicLink();
  } catch {
    return false;
  }
}
