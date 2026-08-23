import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, sha256 } from "./hash.js";
import { compileSpriteCodex } from "./compiler.js";
import { resolveProfilePlan } from "./graph.js";
import {
  SPRITE_LIBRARY_BUILD_SCHEMA,
  SPRITE_LIBRARY_LOCK_SCHEMA,
  SPRITE_LIBRARY_SOURCE_SCHEMA,
  type CompileLibraryOptions,
  type SpriteBundleRevisionRef,
  type SpriteFrameSource,
  type SpriteInventoryEntry,
  type SpriteInventoryReport,
  type SpriteLibraryBuildManifest,
  type SpriteLibraryBundleBuild,
  type SpriteLibraryLock,
  type SpriteLibraryProfileSource,
  type SpriteLibrarySourceManifest,
  type SpriteSourceManifest,
} from "./types.js";

const LIBRARY_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const COMPILER_STAGE_DIRECTORY = /^\.sprite-library-stage-[A-Za-z0-9]{6}$/u;
const COMPILER_TRANSACTION_DIRECTORY = /^\.[a-z0-9][a-z0-9._-]{0,127}\.sprite-library-transaction$/u;
const COMPILER_TRANSACTION_CLAIM_DIRECTORY = /^\.[a-z0-9][a-z0-9._-]{0,127}\.sprite-library-transaction\.claim-[A-Za-z0-9]{6}$/u;
const INVENTORY_EXTENSIONS = new Set([".png", ".webp", ".json", ".bin", ".octr", ".ocmp"]);

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

function refKey(ref: SpriteBundleRevisionRef): string {
  return `${ref.bundleId}@${ref.revision}`;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function resolveConfined(root: string, base: string, input: string, label: string): string {
  if (path.isAbsolute(input)) throw new Error(`${label} must be a relative path`);
  const resolved = path.resolve(base, input);
  if (!isWithin(root, resolved)) throw new Error(`${label} escapes the permitted root`);
  return resolved;
}

async function exists(file: string): Promise<boolean> {
  try { await stat(file); return true; }
  catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
}

async function canonicalLeaf(file: string): Promise<string> {
  const resolved = path.resolve(file);
  return path.join(await realpath(path.dirname(resolved)), path.basename(resolved));
}

async function canonicalLeafOrUndefined(value: unknown): Promise<string | undefined> {
  if (typeof value !== "string") return undefined;
  try { return await canonicalLeaf(value); }
  catch { return undefined; }
}

async function workspaceBoundary(start: string): Promise<string> {
  let cursor = path.resolve(start);
  while (true) {
    if (await exists(path.join(cursor, "pnpm-workspace.yaml"))) return realpath(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) return realpath(start);
    cursor = parent;
  }
}

async function existingRealPathWithin(root: string, file: string, label: string): Promise<string> {
  const actual = await realpath(file);
  if (!isWithin(root, actual)) throw new Error(`${label} resolves outside the permitted root`);
  return actual;
}

async function confinedDestination(root: string, file: string, label: string): Promise<string> {
  const parent = path.dirname(file);
  let ancestor = parent;
  while (!(await exists(ancestor))) {
    const next = path.dirname(ancestor);
    if (next === ancestor) throw new Error(`${label} has no existing permitted ancestor`);
    ancestor = next;
  }
  const actualAncestor = await realpath(ancestor);
  if (!isWithin(root, actualAncestor)) throw new Error(`${label} resolves outside the permitted root`);
  await mkdir(parent, { recursive: true });
  const actualParent = await realpath(parent);
  if (!isWithin(root, actualParent)) throw new Error(`${label} resolves outside the permitted root`);
  return path.join(actualParent, path.basename(file));
}

interface PreparedWrite {
  final: string;
  temporary: string;
  backup: string;
  hadPrevious: boolean;
  transactionId: string;
  previousSha256: string | null;
  nextSha256: string;
}

interface LibraryTransaction {
  directory: string;
  transactionId: string;
}

async function fileSha256(file: string): Promise<string> {
  return sha256(new Uint8Array(await readFile(file)));
}

async function retryRecovery(operation: () => Promise<void>, label: string): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      failure = error;
    }
  }
  throw new Error(`${label} failed after three recovery attempts`, { cause: failure });
}

async function preparedWritePaths(file: string, transactionId: string): Promise<{ temporary: string; backup: string }> {
  const parent = path.dirname(file);
  const key = await sha256(new TextEncoder().encode(`${transactionId}\0${path.resolve(file)}`));
  return {
    temporary: path.join(parent, `.sprite-library-write-${key}.new`),
    backup: path.join(parent, `.sprite-library-write-${key}.old`),
  };
}

async function prepareWrite(file: string, bytes: Uint8Array | string, transactionId: string): Promise<PreparedWrite> {
  const { temporary, backup } = await preparedWritePaths(file, transactionId);
  let hadPrevious = false;
  try {
    await writeFile(temporary, bytes);
    const nextSha256 = await fileSha256(temporary);
    hadPrevious = await exists(file);
    if (hadPrevious) await copyFile(file, backup);
    const previousSha256 = hadPrevious ? await fileSha256(backup) : null;
    return { final: file, temporary, backup, hadPrevious, transactionId, previousSha256, nextSha256 };
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    await rm(backup, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function rollbackWrites(writes: readonly PreparedWrite[]): Promise<void> {
  let rollbackError: unknown;
  for (const write of [...writes].reverse()) {
    try {
      if (write.hadPrevious) await retryRecovery(() => copyFile(write.backup, write.final), `restore ${write.final}`);
      else await retryRecovery(() => rm(write.final, { force: true }), `remove ${write.final}`);
    } catch (error) {
      rollbackError ??= error;
    }
  }
  if (rollbackError !== undefined) throw rollbackError;
}

async function cleanupPreparedWrites(writes: readonly PreparedWrite[]): Promise<void> {
  for (const write of writes) {
    await rm(write.temporary, { force: true }).catch(() => undefined);
    await rm(write.backup, { force: true }).catch(() => undefined);
  }
}

async function generationMatches(libraryId: string, lockFile: string, output: string): Promise<boolean> {
  try {
    if (!(await exists(lockFile)) || !(await exists(output))) return false;
    const lock = JSON.parse(await readFile(lockFile, "utf8")) as Partial<SpriteLibraryLock>;
    if (
      lock.schema !== SPRITE_LIBRARY_LOCK_SCHEMA
      || lock.id !== libraryId
      || typeof lock.build?.manifestSha256 !== "string"
      || typeof lock.build?.inventorySha256 !== "string"
    ) return false;
    const manifestFile = path.join(output, `${libraryId}.library.json`);
    if (!(await exists(manifestFile)) || await fileSha256(manifestFile) !== lock.build.manifestSha256) return false;
    const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as Partial<SpriteLibraryBuildManifest>;
    if (
      manifest.schema !== SPRITE_LIBRARY_BUILD_SCHEMA
      || manifest.id !== libraryId
      || typeof manifest.inventory?.file !== "string"
    ) return false;
    const inventoryFile = resolveConfined(output, output, manifest.inventory.file, "recovery inventory");
    return await exists(inventoryFile) && await fileSha256(inventoryFile) === lock.build.inventorySha256;
  } catch {
    return false;
  }
}

async function recoverLibraryTransaction(
  lockDirectory: string,
  sourceDirectory: string,
  outputDirectory: string,
  libraryId: string,
  transactionId: string,
  protectedLockPath: string | undefined,
): Promise<boolean> {
  const journalPath = path.join(lockDirectory, "RECOVERY_REQUIRED.json");
  if (!(await exists(journalPath))) return false;
  const value = JSON.parse(await readFile(journalPath, "utf8")) as Partial<{
    schema: string;
    libraryId: string;
    transactionId: string;
    outputDirectory: string;
    stagedRecoveryDirectory: string;
    preparedWrites: PreparedWrite[];
  }>;
  if (
    value.schema !== "keel-sprite-library-recovery@2"
    || value.libraryId !== libraryId
    || value.transactionId !== transactionId
    || await canonicalLeafOrUndefined(value.outputDirectory) !== outputDirectory
    || typeof value.stagedRecoveryDirectory !== "string"
    || !Array.isArray(value.preparedWrites)
  ) throw new Error(`sprite library ${libraryId} recovery journal is invalid`);
  const stagingRoot = path.resolve(value.stagedRecoveryDirectory);
  const outputParent = await realpath(path.dirname(outputDirectory));
  const actualStaging = await realpath(stagingRoot);
  if (!isWithin(outputParent, actualStaging) || !path.basename(actualStaging).startsWith(".sprite-library-stage-")) {
    throw new Error(`sprite library ${libraryId} recovery staging path is invalid`);
  }
  const writes: PreparedWrite[] = [];
  const destinations = new Set<string>();
  for (const candidate of value.preparedWrites) {
    if (
      candidate === null
      || typeof candidate !== "object"
      || typeof candidate.final !== "string"
      || typeof candidate.temporary !== "string"
      || typeof candidate.backup !== "string"
      || typeof candidate.hadPrevious !== "boolean"
      || candidate.transactionId !== transactionId
      || (candidate.previousSha256 !== null && typeof candidate.previousSha256 !== "string")
      || typeof candidate.nextSha256 !== "string"
    ) throw new Error(`sprite library ${libraryId} recovery write is invalid`);
    const final = path.resolve(candidate.final);
    const temporary = path.resolve(candidate.temporary);
    const backup = path.resolve(candidate.backup);
    const actualParent = await realpath(path.dirname(final));
    const { temporary: expectedTemporary, backup: expectedBackup } = await preparedWritePaths(final, transactionId);
    if (
      !isWithin(sourceDirectory, actualParent)
      || temporary !== expectedTemporary
      || backup !== expectedBackup
      || destinations.has(final)
    ) throw new Error(`sprite library ${libraryId} recovery write escapes its transaction`);
    if (candidate.hadPrevious !== (candidate.previousSha256 !== null)) {
      throw new Error(`sprite library ${libraryId} recovery write has inconsistent prior state`);
    }
    if (candidate.hadPrevious) {
      if (!(await exists(backup)) || await fileSha256(backup) !== candidate.previousSha256) {
        throw new Error(`sprite library ${libraryId} recovery backup digest is invalid`);
      }
    } else if (await exists(backup)) {
      throw new Error(`sprite library ${libraryId} recovery unexpectedly contains a backup`);
    }
    if (await exists(temporary) && await fileSha256(temporary) !== candidate.nextSha256) {
      throw new Error(`sprite library ${libraryId} recovery next-value digest is invalid`);
    }
    if (await exists(final)) {
      const currentSha256 = await fileSha256(final);
      if (currentSha256 !== candidate.nextSha256 && currentSha256 !== candidate.previousSha256) {
        throw new Error(`sprite library ${libraryId} recovery destination digest is unknown`);
      }
    }
    destinations.add(final);
    writes.push({
      final,
      temporary,
      backup,
      hadPrevious: candidate.hadPrevious,
      transactionId,
      previousSha256: candidate.previousSha256,
      nextSha256: candidate.nextSha256,
    });
  }
  const previousOutput = path.join(actualStaging, "previous-output");
  if (protectedLockPath !== undefined) {
    const protectedWrite = writes.find((write) => write.final === protectedLockPath);
    if (protectedWrite === undefined) {
      throw new Error(`sprite library ${libraryId} recovery journal omits the canonical lock`);
    }
    // A durable journal may remain after the new lock/output pair was fully
    // installed, or a stale/corrupt journal may merely claim that it was. The
    // installed generation is authoritative only when its lock, graph, and
    // active inventory all agree and the installed top lock is exactly the
    // transaction's prepared next value. Preserve that valid pair rather than
    // replacing it from journal-selected bytes.
    if (
      await exists(protectedLockPath)
      && await fileSha256(protectedLockPath) === protectedWrite.nextSha256
      && await generationMatches(libraryId, protectedLockPath, outputDirectory)
    ) {
      await cleanupPreparedWrites(writes);
      await rm(actualStaging, { recursive: true, force: true });
      await rm(lockDirectory, { recursive: true, force: true });
      return true;
    }
    if (!protectedWrite.hadPrevious) {
      if (await exists(protectedLockPath)) {
        throw new Error(`sprite library ${libraryId} recovery cannot delete an unproven canonical lock`);
      }
    } else {
      // The journal is durable before the first lock rename. A process may
      // therefore stop while the still-canonical old output remains in place,
      // before it has been moved to previous-output. In that phase, prove the
      // installed output against the backed-up top lock and roll back only the
      // prepared locks. Once previous-output exists, it is the prior generation
      // that must be restored.
      const priorGeneration = await exists(previousOutput) ? previousOutput : outputDirectory;
      if (!(await exists(priorGeneration))) {
        throw new Error(`sprite library ${libraryId} recovery lacks the prior output generation`);
      }
      if (!(await generationMatches(libraryId, protectedWrite.backup, priorGeneration))) {
        throw new Error(`sprite library ${libraryId} recovery lock does not match the prior generation`);
      }
    }
  }
  if (await exists(previousOutput)) {
    await rm(outputDirectory, { recursive: true, force: true });
    try {
      await rename(previousOutput, outputDirectory);
    } catch {
      await cp(previousOutput, outputDirectory, { recursive: true });
    }
  }
  await rollbackWrites(writes);
  await cleanupPreparedWrites(writes);
  await rm(actualStaging, { recursive: true, force: true });
  await rm(lockDirectory, { recursive: true, force: true });
  return true;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

async function writeTransactionOwner(lockDirectory: string, libraryId: string, outputDirectory: string, transactionId: string): Promise<void> {
  await writeFile(path.join(lockDirectory, "OWNER.json"), `${JSON.stringify({
    schema: "keel-sprite-library-owner@2",
    libraryId,
    outputDirectory,
    transactionId,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`);
}

async function claimLibraryTransaction(
  lockDirectory: string,
  libraryId: string,
  outputDirectory: string,
): Promise<LibraryTransaction | undefined> {
  const claimDirectory = await mkdtemp(`${lockDirectory}.claim-`);
  const transactionId = path.basename(claimDirectory);
  try {
    await writeTransactionOwner(claimDirectory, libraryId, outputDirectory, transactionId);
    await rename(claimDirectory, lockDirectory);
    return { directory: lockDirectory, transactionId };
  } catch (error) {
    await rm(claimDirectory, { recursive: true, force: true });
    if (["EEXIST", "ENOTEMPTY"].includes((error as { code?: string }).code ?? "")) return undefined;
    throw error;
  }
}

async function acquireLibraryTransaction(
  sourceDirectory: string,
  outputDirectory: string,
  libraryId: string,
  protectedLockPath: string | undefined,
): Promise<LibraryTransaction> {
  const lockDirectory = path.join(sourceDirectory, `.${libraryId}.sprite-library-transaction`);
  let claim = await claimLibraryTransaction(lockDirectory, libraryId, outputDirectory);
  if (claim === undefined) {
      const ownerPath = path.join(lockDirectory, "OWNER.json");
      let owner: unknown;
      try { owner = JSON.parse(await readFile(ownerPath, "utf8")); } catch {}
      const ownerOutputDirectory = await canonicalLeafOrUndefined(
        (owner as { outputDirectory?: unknown } | null)?.outputDirectory,
      );
      if (
        owner !== null
        && typeof owner === "object"
        && (owner as { schema?: unknown }).schema === "keel-sprite-library-owner@2"
        && (owner as { libraryId?: unknown }).libraryId === libraryId
        && ownerOutputDirectory === outputDirectory
        && typeof (owner as { transactionId?: unknown }).transactionId === "string"
        && Number.isSafeInteger((owner as { pid?: unknown }).pid)
        && processIsAlive((owner as { pid: number }).pid)
      ) {
        throw new Error(`sprite library ${libraryId} build is already in progress`);
      }
      if (
        owner === null
        || typeof owner !== "object"
        || (owner as { schema?: unknown }).schema !== "keel-sprite-library-owner@2"
        || (owner as { libraryId?: unknown }).libraryId !== libraryId
        || ownerOutputDirectory !== outputDirectory
        || typeof (owner as { transactionId?: unknown }).transactionId !== "string"
      ) throw new Error(`sprite library ${libraryId} transaction owner is invalid`);
      const recovered = await recoverLibraryTransaction(
        lockDirectory,
        sourceDirectory,
        outputDirectory,
        libraryId,
        (owner as { transactionId: string }).transactionId,
        protectedLockPath,
      );
      if (!recovered) await rm(lockDirectory, { recursive: true, force: true });
      claim = await claimLibraryTransaction(lockDirectory, libraryId, outputDirectory);
      if (claim === undefined) {
        throw new Error(`sprite library ${libraryId} build was claimed during recovery`);
      }
  }
  return claim;
}

function sameRefs(left: readonly SpriteBundleRevisionRef[], right: readonly SpriteBundleRevisionRef[]): boolean {
  return left.length === right.length && left.every((value, index) => value.bundleId === right[index]?.bundleId && value.revision === right[index]?.revision);
}

function validateLibrarySource(value: unknown): asserts value is SpriteLibrarySourceManifest {
  if (value === null || typeof value !== "object") throw new Error("sprite library source must be an object");
  const source = value as Partial<SpriteLibrarySourceManifest>;
  if (source.schema !== SPRITE_LIBRARY_SOURCE_SCHEMA) throw new Error(`expected schema ${SPRITE_LIBRARY_SOURCE_SCHEMA}`);
  if (typeof source.id !== "string" || !LIBRARY_ID.test(source.id)) throw new Error("library id must be a stable lowercase identifier of at most 128 characters");
  if (!Array.isArray(source.bundles) || source.bundles.length === 0) throw new Error("library bundles cannot be empty");
  const references = new Set<string>();
  const identityKeys = new Map<number, string>();
  for (const bundle of source.bundles) {
    positiveInteger(bundle.bundleId, "bundle id");
    positiveInteger(bundle.revision, "bundle revision");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(bundle.key)) throw new Error(`invalid bundle key ${bundle.key}`);
    if (typeof bundle.role !== "string" || bundle.role.length === 0 || typeof bundle.source !== "string" || typeof bundle.lock !== "string") throw new Error(`bundle ${bundle.key} is incomplete`);
    if (!Array.isArray(bundle.dependencies)) throw new Error(`bundle ${bundle.key} dependencies must be an array`);
    const key = refKey(bundle);
    if (references.has(key)) throw new Error(`duplicate bundle revision ${key}`);
    const priorKey = identityKeys.get(bundle.bundleId);
    if (priorKey !== undefined && priorKey !== bundle.key) throw new Error(`bundle id ${bundle.bundleId} changed key`);
    references.add(key);
    identityKeys.set(bundle.bundleId, bundle.key);
  }
  for (const bundle of source.bundles) {
    const deps = new Set<string>();
    for (const dependency of bundle.dependencies) {
      positiveInteger(dependency.bundleId, "dependency bundle id");
      positiveInteger(dependency.revision, "dependency revision");
      const key = refKey(dependency);
      if (!references.has(key)) throw new Error(`bundle ${bundle.key} references unknown dependency ${key}`);
      if (key === refKey(bundle)) throw new Error(`bundle ${bundle.key} depends on itself`);
      if (deps.has(key)) throw new Error(`bundle ${bundle.key} repeats dependency ${key}`);
      deps.add(key);
    }
  }
  if (!Array.isArray(source.profiles) || source.profiles.length === 0) throw new Error("library profiles cannot be empty");
  const profiles = new Set<string>();
  for (const profile of source.profiles) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(profile.id)) throw new Error(`invalid profile id ${profile.id}`);
    positiveInteger(profile.revision, "profile revision");
    if (!Array.isArray(profile.roots) || profile.roots.length === 0) throw new Error(`profile ${profile.id} cannot be empty`);
    const key = `${profile.id}@${profile.revision}`;
    if (profiles.has(key)) throw new Error(`duplicate profile revision ${key}`);
    profiles.add(key);
    for (const root of profile.roots) if (!references.has(refKey(root))) throw new Error(`profile ${key} references unknown bundle ${refKey(root)}`);
  }
  if (!Array.isArray(source.inventoryRoots)) throw new Error("inventoryRoots must be an array");
  for (const root of source.inventoryRoots) if (typeof root.path !== "string" || typeof root.label !== "string") throw new Error("invalid inventory root");
  const validationGraph: SpriteLibraryBuildManifest = { schema: SPRITE_LIBRARY_BUILD_SCHEMA, id: source.id, bundles: source.bundles.map((bundle) => ({ ...bundle, buildManifest: "", buildManifestSha256: "" })), profiles: source.profiles, inventory: { file: "", sha256: "0".repeat(64), bytes: 0 } };
  for (const profile of source.profiles) resolveProfilePlan(validationGraph, profile.id, profile.revision);
  for (const bundle of source.bundles) resolveProfilePlan({ ...validationGraph, profiles: [{ id: "bundle-audit", revision: 1, roots: [{ bundleId: bundle.bundleId, revision: bundle.revision }] }] }, "bundle-audit", 1);
}

async function json<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

async function readLock(file: string | undefined): Promise<SpriteLibraryLock | undefined> {
  if (file === undefined) return undefined;
  try {
    const lock = await json<SpriteLibraryLock>(file);
    if (lock.schema !== SPRITE_LIBRARY_LOCK_SCHEMA) throw new Error(`unsupported sprite library lock ${file}`);
    return lock;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw error;
  }
}

function enforceLibraryHistory(prior: SpriteLibraryLock | undefined, next: SpriteLibraryLock, check: boolean): void {
  if (prior === undefined) return;
  if (prior.id !== next.id) throw new Error("library identity differs from immutable lock");
  for (const oldBundle of prior.bundles) {
    const bundle = next.bundles.find((entry) => refKey(entry) === refKey(oldBundle));
    if (bundle === undefined) throw new Error(`bundle revision ${refKey(oldBundle)} was deleted`);
    if (bundle.key !== oldBundle.key || bundle.role !== oldBundle.role || bundle.sourceSha256 !== oldBundle.sourceSha256 || bundle.buildManifestSha256 !== oldBundle.buildManifestSha256 || !sameRefs(bundle.dependencies, oldBundle.dependencies)) {
      throw new Error(`bundle revision ${refKey(oldBundle)} changed; append a new revision`);
    }
  }
  for (const oldProfile of prior.profiles) {
    const profile = next.profiles.find((entry) => entry.id === oldProfile.id && entry.revision === oldProfile.revision);
    if (profile === undefined || !sameRefs(profile.roots, oldProfile.roots)) throw new Error(`profile ${oldProfile.id}@${oldProfile.revision} changed; append a new revision`);
  }
  if (check && (prior.build.manifestSha256 !== next.build.manifestSha256 || prior.build.inventorySha256 !== next.build.inventorySha256)) throw new Error("sprite library check differs from locked deterministic build");
}

function framePath(frame: SpriteFrameSource): string {
  return typeof frame === "string" ? frame : frame.path;
}

function isIgnoredInventoryPath(candidate: string, ignoredRoots: readonly string[], ignoredFiles: ReadonlySet<string>): boolean {
  const resolved = path.resolve(candidate);
  return ignoredFiles.has(resolved) || ignoredRoots.some((root) => isWithin(root, resolved));
}

function isCompilerOwnedInventoryDirectory(name: string): boolean {
  // These are reserved compiler directory grammars. Near-matches remain
  // authored provenance and must never be silently omitted.
  return COMPILER_STAGE_DIRECTORY.test(name)
    || COMPILER_TRANSACTION_DIRECTORY.test(name)
    || COMPILER_TRANSACTION_CLAIM_DIRECTORY.test(name);
}

async function walk(root: string, ignoredRoots: readonly string[], ignoredFiles: ReadonlySet<string>): Promise<string[]> {
  if (isIgnoredInventoryPath(root, ignoredRoots, ignoredFiles)) return [];
  const info = await stat(root);
  if (info.isFile()) return [root];
  const output: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (isIgnoredInventoryPath(child, ignoredRoots, ignoredFiles)) continue;
    if (entry.isDirectory() && isCompilerOwnedInventoryDirectory(entry.name)) continue;
    if (entry.isDirectory()) output.push(...await walk(child, ignoredRoots, ignoredFiles));
    else if (entry.isFile() && INVENTORY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) output.push(child);
  }
  return output;
}

function exclusionReason(file: string): string {
  const normalized = file.toLowerCase().replaceAll("\\", "/");
  if (normalized.includes("/rejected") || normalized.includes("-rejected")) return "rejected art; retained for provenance and excluded from active selections";
  if (normalized.includes("/candidate") || normalized.includes("/candidates/") || normalized.includes("/concepts/") || normalized.includes("/asset-lab/")) return "candidate or benchmark art; visual approval is not recorded, so it is excluded";
  if (normalized.includes("/materials/") && normalized.includes("-source")) return "source material is retained for provenance; the active runtime uses a derived tile only after approval";
  return "not referenced by this pinned library revision; no active approval was inferred";
}

async function inventory(
  source: SpriteLibrarySourceManifest,
  sourceDirectory: string,
  workspaceRoot: string,
  referenced: Map<string, Set<string>>,
  ignoredRoots: readonly string[],
  ignoredFiles: ReadonlySet<string>,
): Promise<SpriteInventoryReport> {
  const paths = new Set<string>();
  for (const root of source.inventoryRoots) {
    const configured = resolveConfined(workspaceRoot, sourceDirectory, root.path, `inventory root ${root.path}`);
    const actual = await existingRealPathWithin(workspaceRoot, configured, `inventory root ${root.path}`);
    for (const file of await walk(actual, ignoredRoots, ignoredFiles)) paths.add(path.resolve(file));
  }
  for (const file of referenced.keys()) paths.add(file);
  const entries: SpriteInventoryEntry[] = [];
  for (const file of [...paths].sort()) {
    const actual = await existingRealPathWithin(workspaceRoot, file, `inventory file ${file}`);
    const bytes = new Uint8Array(await readFile(actual));
    const bundles = [...(referenced.get(file) ?? [])].sort();
    entries.push({
      path: path.relative(sourceDirectory, file).replaceAll(path.sep, "/"),
      sha256: await sha256(bytes),
      bytes: bytes.length,
      status: bundles.length > 0 ? "included" : "excluded",
      reason: bundles.length > 0 ? "explicitly referenced by an active immutable bundle revision" : exclusionReason(file),
      bundles,
    });
  }
  return { schema: "keel-sprite-inventory@1", libraryId: source.id, entries, included: entries.filter((entry) => entry.status === "included").length, excluded: entries.filter((entry) => entry.status === "excluded").length };
}

export async function compileSpriteLibrary(options: CompileLibraryOptions): Promise<{ manifest: SpriteLibraryBuildManifest; lock: SpriteLibraryLock; inventory: SpriteInventoryReport }> {
  const manifestPath = await realpath(path.resolve(options.manifestPath));
  const sourceDirectory = path.dirname(manifestPath);
  const requestedOutputDirectory = path.resolve(options.outputDirectory);
  await mkdir(path.dirname(requestedOutputDirectory), { recursive: true });
  const outputDirectory = await canonicalLeaf(requestedOutputDirectory);
  const workspaceRoot = await workspaceBoundary(sourceDirectory);
  await existingRealPathWithin(workspaceRoot, manifestPath, "library manifest");
  const requestedLockPath = options.lockPath === undefined ? undefined : path.resolve(options.lockPath);
  const lockPath = requestedLockPath === undefined
    ? undefined
    : await confinedDestination(sourceDirectory, requestedLockPath, "library lock path");
  const sourceUnknown = await json<unknown>(manifestPath);
  validateLibrarySource(sourceUnknown);
  const source = sourceUnknown;
  const stagingRoot = await mkdtemp(path.join(path.dirname(outputDirectory), ".sprite-library-stage-"));
  const stagedOutputDirectory = path.join(stagingRoot, "output");
  const stagedLocksDirectory = path.join(stagingRoot, "locks");
  let transaction: LibraryTransaction;
  try {
    transaction = await acquireLibraryTransaction(sourceDirectory, outputDirectory, source.id, lockPath);
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
  const bundles: SpriteLibraryBundleBuild[] = [];
  const lockBundles: SpriteLibraryLock["bundles"] = [];
  const pendingLocks: Array<{ staged: string; final: string }> = [];
  const lockDestinations = new Set<string>();
  const referenced = new Map<string, Set<string>>();
  let recoveryRequired = false;
  try {
  const prior = await readLock(lockPath);
  if (options.writeLock === false && (lockPath === undefined || prior === undefined)) throw new Error("library check mode requires an existing --lock file");
  for (const bundle of [...source.bundles].sort((left, right) => left.bundleId - right.bundleId || left.revision - right.revision)) {
    const bundleSourcePath = resolveConfined(workspaceRoot, sourceDirectory, bundle.source, `bundle ${bundle.key} source`);
    await existingRealPathWithin(workspaceRoot, bundleSourcePath, `bundle ${bundle.key} source`);
    const configuredBundleLock = resolveConfined(sourceDirectory, sourceDirectory, bundle.lock, `bundle ${bundle.key} lock`);
    const finalBundleLock = await confinedDestination(sourceDirectory, configuredBundleLock, `bundle ${bundle.key} lock`);
    if (lockDestinations.has(finalBundleLock) || finalBundleLock === lockPath) throw new Error(`bundle ${bundle.key} lock path is not unique`);
    lockDestinations.add(finalBundleLock);
    const bundleSource = await json<SpriteSourceManifest>(bundleSourcePath);
    for (const asset of bundleSource.assets) for (const frame of asset.frames) {
      const configured = path.resolve(path.dirname(bundleSourcePath), framePath(frame));
      await existingRealPathWithin(workspaceRoot, configured, `bundle ${bundle.key} frame`);
    }
    if (bundleSource.masks !== undefined) {
      const configured = path.resolve(path.dirname(bundleSourcePath), bundleSource.masks.path);
      await existingRealPathWithin(workspaceRoot, configured, `bundle ${bundle.key} masks`);
    }
    const bundleOutput = path.join(stagedOutputDirectory, "bundles", `${bundle.bundleId}-${bundle.revision}-${bundleSource.id}`);
    const stagedBundleLock = path.join(stagedLocksDirectory, `${bundle.bundleId}-${bundle.revision}.lock.json`);
    await mkdir(path.dirname(stagedBundleLock), { recursive: true });
    if (await exists(finalBundleLock)) await copyFile(finalBundleLock, stagedBundleLock);
    const result = await compileSpriteCodex({ manifestPath: bundleSourcePath, outputDirectory: bundleOutput, lockPath: stagedBundleLock, ...(options.writeLock === undefined ? {} : { writeLock: options.writeLock }) });
    if (options.writeLock !== false) pendingLocks.push({ staged: stagedBundleLock, final: finalBundleLock });
    const buildFile = path.join(bundleOutput, `${bundleSource.id}.build.json`);
    const buildBytes = new Uint8Array(await readFile(buildFile));
    const buildManifestSha256 = await sha256(buildBytes);
    const entry: SpriteLibraryBundleBuild = {
      bundleId: bundle.bundleId, revision: bundle.revision, key: bundle.key, role: bundle.role, dependencies: bundle.dependencies,
      buildManifest: path.relative(stagedOutputDirectory, buildFile).replaceAll(path.sep, "/"), buildManifestSha256,
    };
    bundles.push(entry);
    lockBundles.push({ ...entry, sourceSha256: result.manifest.sourceSha256 });
    const bundleName = refKey(bundle);
    const include = (file: string): void => {
      const absolute = path.resolve(path.dirname(bundleSourcePath), file);
      const existing = referenced.get(absolute) ?? new Set<string>(); existing.add(bundleName); referenced.set(absolute, existing);
    };
    const sourceReferences = referenced.get(bundleSourcePath) ?? new Set<string>();
    sourceReferences.add(bundleName);
    referenced.set(bundleSourcePath, sourceReferences);
    for (const asset of bundleSource.assets) for (const frame of asset.frames) include(framePath(frame));
    if (bundleSource.masks !== undefined) include(bundleSource.masks.path);
  }
  // Provenance inventories describe authored/source inputs, not artifacts made
  // by this compilation. Without these explicit exclusions an inventory root
  // such as "." can observe the live transaction OWNER, staging output, prior
  // generated output, or generated lock files. Besides being noisy, OWNER has
  // a PID and timestamp, so including it makes the full provenance report
  // nondeterministic even when every art input is unchanged.
  const ignoredInventoryRoots = [outputDirectory, stagingRoot, transaction.directory].map((entry) => path.resolve(entry));
  const ignoredInventoryFiles = new Set<string>([
    ...lockDestinations,
    ...(lockPath === undefined ? [] : [lockPath]),
  ].map((entry) => path.resolve(entry)));
  const report = await inventory(source, sourceDirectory, workspaceRoot, referenced, ignoredInventoryRoots, ignoredInventoryFiles);
  // The complete provenance inventory intentionally evolves as artists add
  // unapproved/candidate files. It must never perturb the immutable runtime
  // graph or reroll an existing profile. Commit only the explicitly referenced
  // active set; emit the full inventory beside it for approval/provenance UI.
  const activeReport: SpriteInventoryReport = {
    ...report,
    entries: report.entries.filter((entry) => entry.status === "included"),
    excluded: 0,
  };
  const inventoryFile = `${source.id}.inventory.json`;
  const activeInventoryFile = `${source.id}.active-inventory.json`;
  const inventoryBytes = new TextEncoder().encode(`${canonicalJson(report)}\n`);
  const activeInventoryBytes = new TextEncoder().encode(`${canonicalJson(activeReport)}\n`);
  const inventorySha256 = await sha256(activeInventoryBytes);
  const manifest: SpriteLibraryBuildManifest = { schema: SPRITE_LIBRARY_BUILD_SCHEMA, id: source.id, bundles, profiles: source.profiles, inventory: { file: activeInventoryFile, sha256: inventorySha256, bytes: activeInventoryBytes.length } };
  for (const profile of source.profiles) resolveProfilePlan(manifest, profile.id, profile.revision);
  const manifestFile = `${source.id}.library.json`;
  const manifestBytes = new TextEncoder().encode(`${canonicalJson(manifest)}\n`);
  const manifestSha256 = await sha256(manifestBytes);
  const lock: SpriteLibraryLock = { schema: SPRITE_LIBRARY_LOCK_SCHEMA, id: source.id, bundles: lockBundles, profiles: source.profiles, build: { manifestSha256, inventorySha256 } };
  enforceLibraryHistory(prior, lock, options.writeLock === false);
  await Promise.all([
    writeFile(path.join(stagedOutputDirectory, manifestFile), manifestBytes),
    writeFile(path.join(stagedOutputDirectory, inventoryFile), inventoryBytes),
    writeFile(path.join(stagedOutputDirectory, activeInventoryFile), activeInventoryBytes),
  ]);
  if (options.writeLock === false) return { manifest, lock, inventory: report };
  const transactionId = transaction.transactionId;
  const preparedWrites: PreparedWrite[] = [];
  try {
    for (const pending of pendingLocks) preparedWrites.push(await prepareWrite(pending.final, new Uint8Array(await readFile(pending.staged)), transactionId));
    if (lockPath !== undefined) preparedWrites.push(await prepareWrite(lockPath, `${canonicalJson(lock)}\n`, transactionId));
  } catch (error) {
    await cleanupPreparedWrites(preparedWrites);
    throw error;
  }
  const committedWrites: PreparedWrite[] = [];
  const previousOutput = path.join(stagingRoot, "previous-output");
  const journalTemporary = path.join(transaction.directory, "RECOVERY_REQUIRED.json.new");
  const journalPath = path.join(transaction.directory, "RECOVERY_REQUIRED.json");
  await writeFile(journalTemporary, `${JSON.stringify({
    schema: "keel-sprite-library-recovery@2",
    libraryId: source.id,
    transactionId,
    outputDirectory,
    stagedRecoveryDirectory: stagingRoot,
    preparedWrites,
  }, null, 2)}\n`);
  await rename(journalTemporary, journalPath);
  let outputMoved = false;
  let outputCommitted = false;
  try {
    for (const write of preparedWrites) {
      await rename(write.temporary, write.final);
      committedWrites.push(write);
    }
    if (await exists(outputDirectory)) {
      await rename(outputDirectory, previousOutput);
      outputMoved = true;
    }
    await rename(stagedOutputDirectory, outputDirectory);
    outputCommitted = true;
  } catch (error) {
    try {
      if (outputCommitted) await retryRecovery(
        () => rm(outputDirectory, { recursive: true, force: true }),
        `remove failed output ${outputDirectory}`,
      );
      if (outputMoved && await exists(previousOutput)) {
        try {
          await retryRecovery(() => rename(previousOutput, outputDirectory), `restore prior output ${outputDirectory}`);
        } catch {
          await retryRecovery(
            () => cp(previousOutput, outputDirectory, { recursive: true }),
            `copy prior output ${outputDirectory}`,
          );
        }
      }
      await rollbackWrites(committedWrites);
    } catch (recoveryError) {
      recoveryRequired = true;
      throw new AggregateError([error, recoveryError], "sprite library commit failed and automatic recovery could not complete");
    } finally {
      if (!recoveryRequired) await cleanupPreparedWrites(preparedWrites);
    }
    throw error;
  }
  await cleanupPreparedWrites(preparedWrites);
  return { manifest, lock, inventory: report };
  } finally {
    if (!recoveryRequired) {
      await rm(stagingRoot, { recursive: true, force: true });
      await rm(transaction.directory, { recursive: true, force: true });
    }
  }
}
