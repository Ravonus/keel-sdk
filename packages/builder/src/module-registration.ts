/**
 * Registering a module that lives in somebody else's repository.
 *
 * The whole point of the verification model is that Keel is not a code host: a
 * rebuild anybody can repeat is the proof, so the source can stay wherever its
 * author wants it. A registration is how that source gets into the catalog
 * without being copied into this one.
 *
 * ## Why the digests are committed
 *
 * Indexing MUST stay offline and deterministic. `keel module index` reading the
 * network would mean the catalog depends on what GitHub served that afternoon,
 * which destroys the property that re-indexing a clean checkout is a no-op diff
 * and that a stranger can check the published catalog by regenerating it.
 *
 * So a registration commits what a verification found: the origin, the exact
 * commit, and every digest that verification produced. `keel module index` then
 * only reads committed files, exactly as it does for a vendored module.
 *
 * The network half is a separate verb. `verifyKeelWorkspaceRegistrations`
 * re-fetches every origin, rebuilds it, and compares against the committed
 * digests. Drift is a hard failure: either the forge served different bytes for
 * the same commit, or the registration was written to claim something the
 * source does not produce. Both are things somebody needs to know about, and
 * neither should be able to quietly rewrite a catalog during an index run.
 *
 * ## What a registration does NOT get to assume
 *
 * Nothing about the foreign repository's language, layout, tooling, or house
 * style. The only inputs are an entry path, an optional subdirectory, and the
 * build options that affect the bytes. Everything else in that tree is none of
 * Keel's business.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, createIntegrity, utf8ToBytes, type Hex } from "@keel/protocol";
import { verifyKeelModuleFromOrigin } from "./module-verification.js";
import type { KeelCompactRequest } from "./build-recipe.js";

export const KEEL_REGISTRATION_SCHEMA = "keel.registration@1" as const;
export const KEEL_REGISTRATION_FILE = "keel.registration.json" as const;

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const HEX_DIGEST = /^0x[0-9a-f]{64}$/u;
const SLUG = /^[a-z][a-z0-9-]{0,63}$/u;
const SEGMENT = /^[A-Za-z0-9._-]{1,100}$/u;

export interface KeelRegistrationOrigin {
  readonly provider: string;
  readonly owner: string;
  readonly repo: string;
  /** A full commit hash. A branch moves, and a proof pinned to it expires silently. */
  readonly commit: string;
  /** Directory inside the repository the build runs in. Absent means the root. */
  readonly path?: string;
  /** Entry point, relative to `path`. Any path, any extension. */
  readonly entry: string;
}

export interface KeelRegistrationSourceFile {
  readonly path: string;
  readonly sha256: Hex;
}

/** What a verification run found, committed so indexing never needs the network. */
export interface KeelRegistrationExpectation {
  readonly sourceDigest: Hex;
  readonly outputDigest: Hex;
  readonly receiptDigest: Hex;
  /** sha256 of the exact archive that was fetched, so a forge cannot serve two trees for one commit. */
  readonly archiveDigest: Hex;
  readonly sourceFiles: readonly KeelRegistrationSourceFile[];
}

export interface KeelModuleRegistration {
  readonly schema: typeof KEEL_REGISTRATION_SCHEMA;
  readonly id: string;
  readonly version: string;
  readonly license: string;
  readonly summary: string;
  readonly category: string;
  readonly owner: Record<string, unknown>;
  readonly repository: string;
  readonly origin: KeelRegistrationOrigin;
  readonly expect: KeelRegistrationExpectation;
  /** Build options that change the bytes; omitted means the compact defaults. */
  readonly compact?: KeelCompactRequest;
  /** Who ran the verification this registration records, and when. */
  readonly verifiedAt: string;
}

function fail(message: string): never {
  throw new TypeError(`${KEEL_REGISTRATION_FILE}: ${message}`);
}

function text(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} must be printable text of 1 through ${maximum} characters.`);
  }
  return value;
}

function digest(value: unknown, label: string): Hex {
  const found = text(value, label, 66);
  if (!HEX_DIGEST.test(found)) fail(`${label} must be a lower-case sha256 digest.`);
  return found as Hex;
}

function safeRelative(value: unknown, label: string): string {
  const found = text(value, label, 256);
  if (found.startsWith("/") || found.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
    fail(`${label} must be a safe relative path.`);
  }
  return found;
}

function parseOrigin(value: unknown): KeelRegistrationOrigin {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("origin must be an object.");
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!["provider", "owner", "repo", "commit", "path", "entry"].includes(key)) fail(`origin.${key} is not supported.`);
  }
  const commit = text(input.commit, "origin.commit", 64);
  // The one thing that cannot be relaxed: a moving ref makes the recorded
  // digests unfalsifiable, because there is no fixed tree to disagree with.
  if (!COMMIT.test(commit)) fail("origin.commit must be a full commit hash, not a branch or tag.");
  const owner = text(input.owner, "origin.owner", 100);
  const repo = text(input.repo, "origin.repo", 100);
  if (!SEGMENT.test(owner) || !SEGMENT.test(repo)) fail("origin.owner and origin.repo must be plain path segments.");
  return {
    provider: text(input.provider, "origin.provider", 32),
    owner,
    repo,
    commit,
    ...(input.path === undefined ? {} : { path: safeRelative(input.path, "origin.path") }),
    entry: safeRelative(input.entry, "origin.entry"),
  };
}

function parseExpectation(value: unknown): KeelRegistrationExpectation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("expect must be an object.");
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!["sourceDigest", "outputDigest", "receiptDigest", "archiveDigest", "sourceFiles"].includes(key)) fail(`expect.${key} is not supported.`);
  }
  if (!Array.isArray(input.sourceFiles) || input.sourceFiles.length === 0) fail("expect.sourceFiles must list the readable files the build pinned.");
  return {
    sourceDigest: digest(input.sourceDigest, "expect.sourceDigest"),
    outputDigest: digest(input.outputDigest, "expect.outputDigest"),
    receiptDigest: digest(input.receiptDigest, "expect.receiptDigest"),
    archiveDigest: digest(input.archiveDigest, "expect.archiveDigest"),
    sourceFiles: (input.sourceFiles as readonly unknown[]).map((file, index) => {
      const item = file as Record<string, unknown>;
      return { path: safeRelative(item.path, `expect.sourceFiles[${index}].path`), sha256: digest(item.sha256, `expect.sourceFiles[${index}].sha256`) };
    }),
  };
}

export function parseKeelModuleRegistration(value: unknown): KeelModuleRegistration {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("must be a JSON object.");
  const input = value as Record<string, unknown>;
  const allowed = ["schema", "id", "version", "license", "summary", "category", "owner", "repository", "origin", "expect", "compact", "verifiedAt"];
  for (const key of Object.keys(input)) if (!allowed.includes(key)) fail(`"${key}" is not supported.`);
  if (input.schema !== KEEL_REGISTRATION_SCHEMA) fail(`schema must be ${KEEL_REGISTRATION_SCHEMA}.`);
  const id = text(input.id, "id", 64);
  if (!SLUG.test(id)) fail(`id must match ${SLUG.source}.`);
  const category = text(input.category, "category", 64);
  if (!SLUG.test(category)) fail(`category must match ${SLUG.source}.`);
  if (input.owner === null || typeof input.owner !== "object" || Array.isArray(input.owner)) fail("owner must be an object naming a user or an org.");
  const compact = input.compact;
  if (compact !== undefined && (compact === null || typeof compact !== "object" || Array.isArray(compact))) fail("compact must be an object.");
  return {
    schema: KEEL_REGISTRATION_SCHEMA,
    id,
    version: text(input.version, "version", 64),
    license: text(input.license, "license", 64),
    summary: text(input.summary, "summary", 512),
    category,
    owner: input.owner as Record<string, unknown>,
    repository: text(input.repository, "repository", 512),
    origin: parseOrigin(input.origin),
    expect: parseExpectation(input.expect),
    ...(compact === undefined ? {} : { compact: compact as KeelCompactRequest }),
    verifiedAt: text(input.verifiedAt, "verifiedAt", 64),
  };
}

export async function readKeelModuleRegistration(directory: string): Promise<KeelModuleRegistration> {
  const file = path.join(path.resolve(directory), KEEL_REGISTRATION_FILE);
  return parseKeelModuleRegistration(JSON.parse(await readFile(file, "utf8")) as unknown);
}

export interface RegistrationVerification {
  readonly registration: KeelModuleRegistration;
  readonly reproduced: boolean;
  /** Every committed expectation that the fresh rebuild disagreed with. */
  readonly mismatches: readonly string[];
  readonly actual: KeelRegistrationExpectation;
}

/**
 * Re-fetch a registration's origin, rebuild it, and compare every committed
 * digest against what came back.
 *
 * This is the networked half, and it is deliberately not reachable from
 * indexing. A mismatch means either the forge served a different tree for the
 * same commit or the registration claims something the source does not build
 * to; both are reported rather than absorbed, and neither is allowed to
 * silently become the new truth.
 */
export async function verifyKeelModuleRegistration(
  registration: KeelModuleRegistration,
  options: { readonly fetchImpl?: typeof fetch } = {},
): Promise<RegistrationVerification> {
  const { origin, expect } = registration;
  const verified = await verifyKeelModuleFromOrigin({
    origin: {
      protocol: "keel-source-origin@1",
      provider: origin.provider,
      owner: origin.owner,
      repo: origin.repo,
      commit: origin.commit,
      visibility: "public",
      ...(origin.path === undefined ? {} : { path: origin.path }),
    },
    identity: { namespace: "keel", name: registration.id, version: registration.version, entry: origin.entry },
    entry: origin.entry,
    mediaType: "text/javascript",
    ...(registration.compact === undefined ? { compact: { keepComments: false } } : { compact: registration.compact }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });

  const actual: KeelRegistrationExpectation = {
    sourceDigest: verified.receipt.source.digest,
    outputDigest: verified.recipe.output.integrity.digest,
    receiptDigest: (await createIntegrity(utf8ToBytes(canonicalJson(verified.receipt)))).digest,
    archiveDigest: verified.archiveIntegrity.digest,
    sourceFiles: verified.recipe.inputs.map((input) => ({ path: input.path, sha256: input.integrity.digest })),
  };

  const mismatches: string[] = [];
  if (!verified.verification.reproduced) mismatches.push(`origin did not reproduce: ${verified.verification.issues.join("; ")}`);
  for (const field of ["sourceDigest", "outputDigest", "receiptDigest", "archiveDigest"] as const) {
    if (actual[field] !== expect[field]) mismatches.push(`${field}: registered ${expect[field]}, origin produced ${actual[field]}`);
  }
  const expectedFiles = new Map(expect.sourceFiles.map((file) => [file.path, file.sha256] as const));
  for (const file of actual.sourceFiles) {
    const known = expectedFiles.get(file.path);
    if (known === undefined) mismatches.push(`source file not registered: ${file.path}`);
    else if (known !== file.sha256) mismatches.push(`source file changed: ${file.path}`);
    expectedFiles.delete(file.path);
  }
  for (const missing of expectedFiles.keys()) mismatches.push(`registered source file is gone from the origin: ${missing}`);

  return { registration, reproduced: mismatches.length === 0, mismatches, actual };
}

export interface RegisterKeelModuleOptions {
  readonly origin: KeelRegistrationOrigin;
  readonly id: string;
  readonly version: string;
  readonly license: string;
  readonly summary: string;
  readonly category: string;
  readonly owner: Record<string, unknown>;
  /** Directory the registration file is written into. */
  readonly outDirectory: string;
  readonly compact?: KeelCompactRequest;
  readonly fetchImpl?: typeof fetch;
  /** Injected so the written file is reproducible in tests. */
  readonly now?: () => Date;
}

export interface RegisterKeelModuleResult {
  readonly path: string;
  readonly registration: KeelModuleRegistration;
}

/**
 * `keel module register`: verify an origin once, then write down what it found.
 *
 * The registration is only ever produced BY a real verification, so the
 * digests in it are never somebody's assertion about their own code. If the
 * origin does not reproduce, nothing is written.
 */
export async function registerKeelModuleFromOrigin(options: RegisterKeelModuleOptions): Promise<RegisterKeelModuleResult> {
  const origin = parseKeelModuleRegistration({
    schema: KEEL_REGISTRATION_SCHEMA,
    id: options.id,
    version: options.version,
    license: options.license,
    summary: options.summary,
    category: options.category,
    owner: options.owner,
    repository: `https://github.com/${options.origin.owner}/${options.origin.repo}`,
    origin: options.origin,
    // Placeholder digests: replaced below by what the verification actually
    // produced. They exist only so the shape is validated before the fetch.
    expect: {
      sourceDigest: `0x${"0".repeat(64)}`,
      outputDigest: `0x${"0".repeat(64)}`,
      receiptDigest: `0x${"0".repeat(64)}`,
      archiveDigest: `0x${"0".repeat(64)}`,
      sourceFiles: [{ path: options.origin.entry, sha256: `0x${"0".repeat(64)}` }],
    },
    ...(options.compact === undefined ? {} : { compact: options.compact }),
    verifiedAt: "0000-00-00T00:00:00.000Z",
  });

  // A source that cannot be fetched or built throws from inside the
  // verification, so the refusal has to cover that path too: nothing is
  // written down as verified unless a rebuild actually happened.
  let checked: RegistrationVerification;
  try {
    checked = await verifyKeelModuleRegistration(origin, {
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
  } catch (error) {
    throw new Error(`Refusing to register ${options.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Every remaining mismatch is against placeholder zeros, so the only thing
  // that matters is whether the origin reproduced at all.
  if (checked.mismatches.some((issue) => issue.startsWith("origin did not reproduce"))) {
    throw new Error(`Refusing to register ${options.id}: ${checked.mismatches[0] as string}`);
  }

  const registration: KeelModuleRegistration = {
    ...origin,
    expect: checked.actual,
    verifiedAt: (options.now?.() ?? new Date()).toISOString(),
  };
  const target = path.join(path.resolve(options.outDirectory), KEEL_REGISTRATION_FILE);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(registration, null, 2)}\n`);
  return { path: target, registration };
}
