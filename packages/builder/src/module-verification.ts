/**
 * The verification call itself: given a public repository and a commit, prove
 * that the bytes going on chain are the reproducible build of that source — and
 * keep none of the source afterwards.
 *
 * This is the shape the service exposes to a creator. They bring a repository;
 * Keel brings the recipe, the rebuild, and the receipt. What Keel does
 * not bring is storage for their code, and that is a design constraint rather
 * than a limitation to work around:
 *
 *   - Keel is not a code host. Becoming one means retention, moderation, and
 *     takedown obligations for other people's repositories, in exchange for
 *     duplicating what a public forge already does better.
 *   - A verification anybody can repeat is the only kind worth recording. If
 *     the source were only inside Keel, "we checked it" would be the whole
 *     proof, which is exactly the situation this system exists to replace.
 *
 * So the archive is fetched, hashed, unpacked to a temporary directory, built,
 * compared, and deleted. The temporary directory is removed on every path,
 * including failures. What survives is the recipe — which names every input by
 * digest — the receipt, and the built bytes. That is enough for anyone holding
 * a copy of the source to reproduce the result, and it stays enough after the
 * repository is renamed, force-pushed, or deleted.
 *
 * The caps are not paranoia. An archive URL is attacker-influenced input the
 * moment a creator can submit one, and a verifier that will unpack an unbounded
 * tarball into its own filesystem is a verifier that can be turned into a disk
 * filler. Every limit below is enforced before anything is written.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertValidKeelSourceOrigin,
  createIntegrity,
  remoteUrlAllowed,
  keelBuildRecipeDigest,
  keelSourceArchiveUrl,
  keelSourceRepositoryRef,
  KEEL_MODULE_INDEX_PROTOCOL,
  type Hex,
  type Integrity,
  type KeelBuildOptions,
  type KeelBuildRecipe,
  type KeelModuleIdentity,
  type KeelModuleIndexEntry,
  type KeelSourceOrigin,
  type KeelSourceReceipt,
} from "@keel/protocol";
import { createKeelBuildRecipe, createKeelModuleSourceReceipt, type KeelBuildVerification, type KeelCompactRequest } from "./build-recipe.js";

/** Forges an archive may be fetched from. Same shape as the RPC host list: a
 *  governed set, not whatever URL an submission happens to contain. */
export const KEEL_DEFAULT_SOURCE_HOSTS: readonly string[] = Object.freeze([
  "codeload.github.com",
  "github.com",
]);

export interface VerifyKeelModuleOptions {
  readonly origin: KeelSourceOrigin;
  readonly identity: KeelModuleIdentity;
  /** Entry point, relative to `recipeRoot` inside the repository. */
  readonly entry: string;
  /** Directory inside the repository the build runs in. Defaults to the root. */
  readonly recipeRoot?: string;
  /** The readable file a holder is pointed at. Defaults to `entry`. */
  readonly sourcePath?: string;
  readonly options?: KeelBuildOptions;
  /** Present when the published bytes were built with the compact stage; the
   *  reproduction then repeats it (same terser pinning, same stamp file from
   *  inside the archive) so the exact shipped bytes come back. */
  readonly compact?: KeelCompactRequest;
  readonly mediaType?: string;
  /** Forges permitted to serve archives. */
  readonly sourceHosts?: readonly string[];
  readonly fetchImpl?: typeof fetch;
  /** Refuse an archive larger than this before unpacking any of it. */
  readonly maxArchiveBytes?: number;
  readonly maxFiles?: number;
  readonly workspacePath?: string;
  readonly description?: string;
}

export interface VerifiedKeelModule {
  readonly identity: KeelModuleIdentity;
  readonly origin: KeelSourceOrigin;
  readonly recipe: KeelBuildRecipe;
  readonly recipeDigest: Hex;
  readonly receipt: KeelSourceReceipt;
  readonly verification: KeelBuildVerification;
  /** The bytes to store on chain. */
  readonly outputBytes: Uint8Array;
  readonly archiveIntegrity: Integrity;
  /** Ready to append to the monorepo's module index. */
  readonly indexEntry: KeelModuleIndexEntry;
}

const DEFAULT_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_FILES = 20_000;
const BLOCK = 512;

function octal(bytes: Uint8Array): number {
  let text = "";
  for (const byte of bytes) {
    if (byte === 0 || byte === 0x20) break;
    text += String.fromCharCode(byte);
  }
  return text.length === 0 ? 0 : Number.parseInt(text, 8);
}

function cstring(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end));
}

interface TarEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/**
 * Enough of tar to read a forge's source archive. Only regular files are
 * extracted: a symlink, a device node, or a hard link in somebody else's
 * tarball has no business becoming a real one inside the verifier, and a build
 * that needs one is a build this cannot reproduce anyway.
 */
function readTar(bytes: Uint8Array, maxFiles: number): readonly TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let longName: string | undefined;
  while (offset + BLOCK <= bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const name = longName ?? cstring(header.subarray(0, 100));
    const prefix = cstring(header.subarray(345, 500));
    const size = octal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] ?? 0);
    offset += BLOCK;
    const body = bytes.subarray(offset, offset + size);
    offset += Math.ceil(size / BLOCK) * BLOCK;
    longName = undefined;

    if (type === "L") {
      longName = cstring(body);
      continue;
    }
    if (type === "x" || type === "g") continue; // pax metadata
    if (type !== "0" && type !== "\0") continue; // not a regular file
    if (entries.length >= maxFiles) throw new Error(`Archive contains more than ${maxFiles} files.`);
    entries.push({ name: prefix.length === 0 ? name : `${prefix}/${name}`, bytes: new Uint8Array(body) });
  }
  return entries;
}

/** GitHub wraps everything in `<repo>-<commit>/`. Strip exactly one segment. */
function stripRoot(name: string): string | undefined {
  const slash = name.indexOf("/");
  if (slash === -1) return undefined;
  const rest = name.slice(slash + 1);
  return rest.length === 0 ? undefined : rest;
}

function safeRelative(name: string): string | undefined {
  if (name.startsWith("/") || name.includes("\\")) return undefined;
  const parts = name.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return undefined;
  return parts.join("/");
}

async function gunzip(bytes: Uint8Array, maximum: number): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maximum) throw new Error(`Decompressed archive exceeds ${maximum} bytes.`);
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * Fetch, build, compare, discard.
 *
 * The temporary checkout is removed on every exit path. If this function ever
 * grows a branch that leaves it behind, the no-custody promise is broken and
 * the comment above it becomes a lie — so the `finally` is the load-bearing
 * line in the function, not the happy path.
 */
export async function verifyKeelModuleFromOrigin(
  options: VerifyKeelModuleOptions,
): Promise<VerifiedKeelModule> {
  const origin = assertValidKeelSourceOrigin(options.origin);
  const url = keelSourceArchiveUrl(origin);
  const hosts = options.sourceHosts ?? KEEL_DEFAULT_SOURCE_HOSTS;
  if (!remoteUrlAllowed(url, hosts, false)) {
    throw new Error(`Source archive host is not permitted: ${url}`);
  }
  const maxArchiveBytes = options.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;

  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Source archive fetch failed: HTTP ${response.status} for ${url}`);
  const archive = new Uint8Array(await response.arrayBuffer());
  if (archive.byteLength > maxArchiveBytes) {
    throw new Error(`Source archive is ${archive.byteLength} bytes; the limit is ${maxArchiveBytes}.`);
  }
  // Hashed before anything is unpacked, so the receipt can name the exact
  // archive rather than trusting the forge to serve one commit identically twice.
  const archiveIntegrity = await createIntegrity(archive);

  const checkout = await mkdtemp(path.join(tmpdir(), "keel-verify-"));
  try {
    for (const entry of readTar(await gunzip(archive, maxArchiveBytes), maxFiles)) {
      const stripped = stripRoot(entry.name);
      if (stripped === undefined) continue;
      const relative = safeRelative(stripped);
      if (relative === undefined) continue; // traversal or absolute: not extracted
      const target = path.join(checkout, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, entry.bytes);
    }

    const repoRoot = origin.path === undefined ? checkout : path.join(checkout, origin.path);
    const root = options.recipeRoot === undefined ? repoRoot : path.join(repoRoot, options.recipeRoot);
    const { recipe, recipeDigest, outputBytes } = await createKeelBuildRecipe({
      root,
      entry: options.entry,
      ...(options.options === undefined ? {} : { options: options.options }),
      ...(options.compact === undefined ? {} : { compact: options.compact }),
      ...(options.mediaType === undefined ? {} : { mediaType: options.mediaType }),
    });
    const sourcePath = options.sourcePath ?? options.entry;
    const { receipt, verification } = await createKeelModuleSourceReceipt({
      recipe,
      root,
      sourceBytes: new Uint8Array(await readFile(path.join(root, sourcePath))),
      repository: keelSourceRepositoryRef(origin, sourcePath),
    });
    const receiptDigest = (await createIntegrity(
      new TextEncoder().encode(JSON.stringify(receipt)),
    )).digest;

    const indexEntry: KeelModuleIndexEntry = {
      identity: options.identity,
      origin: { ...origin, archiveIntegrity },
      ...(options.recipeRoot === undefined ? {} : { recipeRoot: options.recipeRoot }),
      recipeDigest,
      output: recipe.output.integrity,
      receiptDigest,
      ...(options.workspacePath === undefined ? {} : { workspace: { path: options.workspacePath } }),
      ...(options.description === undefined ? {} : { description: options.description }),
    };
    return {
      identity: options.identity,
      origin: { ...origin, archiveIntegrity },
      recipe,
      recipeDigest: await keelBuildRecipeDigest(recipe),
      receipt,
      verification,
      outputBytes,
      archiveIntegrity,
      indexEntry,
    };
  } finally {
    // No custody. Not on success, not on failure, not on a thrown build error.
    await rm(checkout, { recursive: true, force: true });
  }
}

export const KEEL_MODULE_INDEX = KEEL_MODULE_INDEX_PROTOCOL;
