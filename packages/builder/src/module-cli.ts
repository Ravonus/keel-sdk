import { readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Hex } from "@keel/protocol";
import { createKeelModuleReceipt } from "./module-receipt.js";
import {
  createKeelModuleLock,
  resolveKeelModule,
  type ModuleLockEnvelope,
  type ModuleResolution,
  type ModuleSpecifier,
  type LegacyModuleResolverSnapshot,
  parseKeelModuleResolverSnapshot,
} from "./module-legacy.js";

const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
type Flags = Readonly<Record<string, string | boolean>>;

export interface ModuleLockCommandResult {
  readonly lockPath: string;
  readonly receiptPath: string;
  readonly lock: ModuleLockEnvelope;
  readonly receipt: Awaited<ReturnType<typeof createKeelModuleReceipt>>;
}

function flag(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function safeText(value: string, label: string): string {
  if (value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function directoryEntry(filePath: string): Promise<{ isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean } | undefined> {
  const entries = await readdir(path.dirname(filePath), { withFileTypes: true });
  return entries.find((entry) => entry.name === path.basename(filePath));
}

function tags(flags: Flags): readonly string[] | undefined {
  const value = flag(flags, "tag");
  if (value === undefined) return undefined;
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (values.length === 0 || values.length > 16) throw new RangeError("--tag accepts 1 through 16 comma-separated values.");
  return values;
}

export function moduleSpecifierFromFlags(flags: Flags): ModuleSpecifier {
  const digest = flag(flags, "digest");
  if (digest !== undefined) {
    if (["name", "namespace", "version", "entry", "artist", "tag"].some((name) => flags[name] !== undefined)) {
      throw new TypeError("--digest cannot be combined with name, namespace, version, entry, artist, or tag selectors.");
    }
    const byteLengthValue = flag(flags, "byte-length");
    if (byteLengthValue === undefined) throw new TypeError("--digest requires --byte-length for an exact selector.");
    const byteLength = Number(byteLengthValue);
    if (!Number.isSafeInteger(byteLength) || byteLength <= 0) throw new RangeError("--byte-length must be a positive safe integer.");
    if (!/^0x[0-9a-f]{64}$/u.test(digest)) throw new TypeError("--digest must be a lower-case SHA-256 digest.");
    return { kind: "hash", digest: digest as Hex, byteLength };
  }
  const name = flag(flags, "name");
  if (name === undefined) throw new TypeError("Provide --name or the exact --digest and --byte-length selector.");
  const namespace = flag(flags, "namespace");
  const version = flag(flags, "version");
  const entry = flag(flags, "entry");
  const artist = flag(flags, "artist");
  const moduleTags = tags(flags);
  return {
    kind: "query",
    name: safeText(name, "--name"),
    ...(namespace === undefined ? {} : { namespace: safeText(namespace, "--namespace") as "npm" | "keel" | "github" }),
    ...(version === undefined ? {} : { version: safeText(version, "--version") }),
    ...(entry === undefined ? {} : { entry: safeText(entry, "--entry") }),
    ...(artist === undefined ? {} : { artist: safeText(artist, "--artist") }),
    ...(moduleTags === undefined ? {} : { tags: moduleTags }),
  };
}

async function readStableFile(filePath: string, label: string): Promise<Uint8Array> {
  const requested = path.resolve(safeText(filePath, label));
  const entry = await directoryEntry(requested);
  if (entry === undefined || !entry.isFile() || entry.isSymbolicLink()) throw new TypeError(`${label} must be a regular non-symlink file.`);
  const resolved = await realpath(requested);
  const before = await stat(resolved);
  if (!before.isFile() || before.size > MAX_SNAPSHOT_BYTES) throw new RangeError(`${label} must be a regular file no larger than ${MAX_SNAPSHOT_BYTES} bytes.`);
  const bytes = new Uint8Array(await readFile(resolved));
  const secondRead = new Uint8Array(await readFile(resolved));
  const after = await stat(resolved);
  const stable = bytes.byteLength === secondRead.byteLength && bytes.every((value, index) => value === secondRead[index]);
  if (before.size !== after.size || bytes.byteLength !== after.size || !stable || (await realpath(requested)) !== resolved) throw new Error(`${label} changed while it was being read.`);
  return bytes;
}

export async function readModuleResolverSnapshot(filePath: string): Promise<LegacyModuleResolverSnapshot> {
  const bytes = await readStableFile(filePath, "snapshot");
  return parseKeelModuleResolverSnapshot(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown);
}

async function writablePath(filePath: string, label: string): Promise<string> {
  const resolved = path.resolve(safeText(filePath, label));
  const parent = await realpath(path.dirname(resolved));
  const parentInfo = await stat(parent);
  if (!parentInfo.isDirectory()) throw new TypeError(`${label} parent must be a directory.`);
  try {
    const entry = await directoryEntry(resolved);
    if (entry?.isSymbolicLink()) throw new TypeError(`${label} cannot overwrite a symlink.`);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  return path.join(parent, path.basename(resolved));
}

async function writeAtomic(filePath: string, content: string, label: string): Promise<void> {
  const temporary = await writablePath(filePath + ".tmp-" + String(process.pid), label + " temporary");
  await writeFile(temporary, content);
  await rename(temporary, filePath);
}

export async function resolveModuleSnapshotFile(filePath: string, selector: ModuleSpecifier): Promise<ModuleResolution> {
  const snapshot = await readModuleResolverSnapshot(filePath);
  return resolveKeelModule(snapshot, selector);
}

export async function lockModuleSnapshotFile(
  filePath: string,
  outputPath: string,
  selector: ModuleSpecifier,
): Promise<ModuleLockCommandResult> {
  const snapshot = await readModuleResolverSnapshot(filePath);
  const lock = await createKeelModuleLock(snapshot, [selector]);
  const receipt = await createKeelModuleReceipt(snapshot, lock);
  const lockPath = await writablePath(outputPath, "lock output");
  const receiptPath = await writablePath(lockPath + ".receipt.json", "receipt output");
  await writeAtomic(lockPath, JSON.stringify(lock, null, 2) + "\n", "lock output");
  await writeAtomic(receiptPath, JSON.stringify(receipt, null, 2) + "\n", "receipt output");
  return { lockPath, receiptPath, lock, receipt };
}
