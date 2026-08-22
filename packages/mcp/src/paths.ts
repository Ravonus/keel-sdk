import { readFile as fsReadFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Workspace } from "./types.js";

const MAX_PATH_LENGTH = 4096;

function safeText(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_LENGTH || /[\\\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be a non-empty path without control characters.`);
  }
  return value;
}

function contained(root: string, target: string, label: string, allowRoot = false): void {
  const relative = path.relative(root, target);
  if ((!allowRoot && relative.length === 0) || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the MCP workspace.`);
  }
}

function lexicalPath(root: string, value: string, label: string, allowRoot = false): string {
  const target = path.resolve(root, safeText(value, label));
  contained(root, target, label, allowRoot);
  return target;
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function regularEntry(target: string, label: string): Promise<void> {
  const entries = await readdir(path.dirname(target), { withFileTypes: true });
  const entry = entries.find((candidate) => candidate.name === path.basename(target));
  if (entry === undefined) {
    const error = new TypeError(`${label} does not exist.`) as TypeError & { code?: string };
    error.code = "ENOENT";
    throw error;
  }
  if (!entry.isFile() || entry.isSymbolicLink()) throw new TypeError(`${label} must be a regular non-symlink file.`);
}

async function stableFile(root: string, value: string, maxBytes: number): Promise<{ path: string; bytes: Uint8Array }> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError("maxBytes must be a positive safe integer.");
  const requested = lexicalPath(root, value, "file path");
  await regularEntry(requested, "file path");
  const resolved = await realpath(requested);
  contained(root, resolved, "file path");
  const before = await stat(resolved);
  if (!before.isFile() || before.size > maxBytes) throw new RangeError(`file path must be a regular file no larger than ${maxBytes} bytes.`);
  const bytes = new Uint8Array(await fsReadFile(resolved));
  const second = new Uint8Array(await fsReadFile(resolved));
  const after = await stat(resolved);
  const stable = bytes.byteLength === second.byteLength && bytes.every((byte, index) => byte === second[index]);
  if (!stable || bytes.byteLength !== before.size || bytes.byteLength !== after.size || (await realpath(requested)) !== resolved) {
    throw new Error("file path changed while it was being read.");
  }
  return { path: resolved, bytes };
}

async function existingDirectory(root: string, value: string): Promise<string> {
  const requested = lexicalPath(root, value, "directory path", true);
  const resolved = await realpath(requested);
  contained(root, resolved, "directory path", true);
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new TypeError("directory path must be a directory.");
  return resolved;
}

async function outputDirectory(root: string, value: string): Promise<string> {
  const requested = lexicalPath(root, value, "output directory", true);
  let cursor = requested;
  while (true) {
    try {
      const resolved = await realpath(cursor);
      contained(root, resolved, "output directory", true);
      if (!(await stat(resolved)).isDirectory()) throw new TypeError("output directory parent must be a directory.");
      return requested;
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      if (cursor === root) throw error;
      cursor = path.dirname(cursor);
    }
  }
}

async function writeJson(root: string, value: string, payload: unknown): Promise<string> {
  const requested = lexicalPath(root, value, "output file");
  const parent = await existingDirectory(root, path.dirname(requested));
  const entries = await readdir(parent, { withFileTypes: true });
  const existing = entries.find((candidate) => candidate.name === path.basename(requested));
  if (existing?.isSymbolicLink()) throw new TypeError("output file cannot overwrite a symlink.");
  const temporary = path.join(parent, `.oca-mcp-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, requested);
  return requested;
}

export async function createWorkspace(rootValue = "."): Promise<Workspace> {
  const requested = path.resolve(safeText(rootValue, "workspace root"));
  const root = await realpath(requested);
  if (!(await stat(root)).isDirectory()) throw new TypeError("workspace root must be a directory.");
  return {
    root,
    resolveExistingFile: async (value, maxBytes) => (await stableFile(root, value, maxBytes)).path,
    readFile: (value, maxBytes) => stableFile(root, value, maxBytes),
    resolveExistingDirectory: (value) => existingDirectory(root, value),
    resolveOutputDirectory: (value) => outputDirectory(root, value),
    writeJson: (value, payload) => writeJson(root, value, payload),
  };
}
