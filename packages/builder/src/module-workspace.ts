/**
 * Workspace support for the module pipeline: many art items in one directory.
 *
 * The layout is the keel-modules repo's layout, and this file is the only
 * place it is known. Modules live under `modules/`, either flat
 * (`modules/<id>/`) or filed by organisation and category
 * (`modules/<publisher>/<category>/<id>/`); discovery finds a module wherever its
 * `keel.module.json` sits, so both shapes work and a workspace can migrate
 * between them without the rest of the toolchain noticing.
 *
 * `--all` builds and tests walk discovery, and `keel module index` distills
 * the whole workspace into the one artifact the site reads:
 * `catalog/catalog.json` (`keel-module-catalog@3`).
 *
 * The catalog is the site's whole view, so its rules are conservative:
 *
 *   - `verified` is true only for the byte-proof dispositions
 *     (exact-source-output, reproducible-build). Behaviourally verified
 *     candidates and queued builds never get it.
 *   - `verified` and `deployed` are INDEPENDENT. A module is verified the
 *     moment its readable source reproduces its minified bytes, which happens
 *     long before anything reaches a chain, and it stays verified whether or
 *     not it is ever published. Nothing here infers one from the other.
 *   - `sourceFiles` lists the READABLE files with per-file digests, because
 *     those are what the site shows next to the word "verified".
 *   - Every field is derived from committed files, so re-indexing a clean
 *     workspace is a no-op diff. Nothing is read from a clock or an mtime.
 */

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createIntegrity,
  utf8ToBytes,
  canonicalJson,
  type Hex,
  type KeelBuildRecipe,
  type KeelSourceReceipt,
} from "@keel/protocol";
import {
  buildKeelModule,
  readKeelModuleManifest,
  type BuildKeelModuleOptions,
  type BuildKeelModuleResult,
  type KeelModuleManifest,
  KEEL_MODULE_MANIFEST_FILE,
} from "./module-pipeline.js";
import { hasModuleVectors, testKeelModule, type TestKeelModuleResult } from "./module-testing.js";

export const KEEL_MODULE_CATALOG_SCHEMA = "keel-module-catalog@3" as const;
export const KEEL_MODULE_CATALOG_FILE = "catalog/catalog.json" as const;
export const KEEL_PUBLISHER_MANIFEST_FILE = "publisher.json" as const;
/** The original name, when every publisher was assumed to be an organisation. */
export const KEEL_ORG_MANIFEST_FILE = "org.json" as const;
export const KEEL_PUBLISHER_SCHEMA = "keel.publisher@1" as const;
export const KEEL_ORG_SCHEMA = "keel.org@1" as const;
export const KEEL_MODULE_DEPLOYMENTS_DIRECTORY = "deployments" as const;
export const KEEL_MODULE_DEPLOYMENT_SCHEMA = "keel.jsmodule-deployment@1" as const;
const MODULES_DIRECTORY = "modules" as const;
/** modules/<publisher>/<category>/<id> is the deepest supported nesting. */
const MAX_DISCOVERY_DEPTH = 3;

export interface KeelWorkspaceModule {
  /** Absolute path to the module directory. */
  readonly directory: string;
  /** Workspace-root-relative POSIX path, e.g. `modules/keel-web3/generative/noise2d`. */
  readonly workspacePath: string;
  readonly manifest: KeelModuleManifest;
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

/**
 * Every module manifest under `modules/`, sorted by id.
 *
 * A directory holding a `keel.module.json` is a module and is not descended
 * into; anything else is a grouping directory. That one rule handles the flat
 * layout and the `<publisher>/<category>` layout without either being special-cased,
 * and it means filing a module under a new category is a `git mv`.
 */
export async function discoverKeelWorkspaceModules(root: string): Promise<readonly KeelWorkspaceModule[]> {
  const resolvedRoot = path.resolve(root);
  const modulesRoot = path.join(resolvedRoot, MODULES_DIRECTORY);
  try {
    await readdir(modulesRoot);
  } catch {
    throw new Error(`${modulesRoot} not found. A module workspace keeps its modules in ${MODULES_DIRECTORY}/.`);
  }
  const modules: KeelWorkspaceModule[] = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.filter((item) => item.isDirectory()).sort((left, right) => (left.name < right.name ? -1 : 1))) {
      const child = path.join(directory, entry.name);
      if (await isFile(path.join(child, KEEL_MODULE_MANIFEST_FILE))) {
        const manifest = await readKeelModuleManifest(child);
        modules.push({
          directory: child,
          workspacePath: path.relative(resolvedRoot, child).split(path.sep).join("/"),
          manifest,
        });
        continue;
      }
      if (depth < MAX_DISCOVERY_DEPTH) await walk(child, depth + 1);
    }
  };
  await walk(modulesRoot, 1);
  if (modules.length === 0) {
    throw new Error(`No ${KEEL_MODULE_MANIFEST_FILE} found under ${modulesRoot}. Nothing to process.`);
  }
  return modules.sort((left, right) => (left.manifest.name < right.manifest.name ? -1 : 1));
}

/* ------------------------------------------------------------- publishers */

export interface KeelPublisherMember {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly github: string | null;
  /** On-chain address, once the member has one. Absent is normal. */
  readonly address: string | null;
}

export interface KeelPublisherGroup {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly members: readonly string[];
}

/**
 * Whoever publishes a module: a PERSON or an ORGANISATION.
 *
 * Most people are not an organisation, and requiring them to invent one to
 * publish a module would be a made-up hurdle. So `kind: "user"` is a first
 * class publisher that owns its modules directly, not a one-member org with
 * empty ceremony around it. Groups belong to organisations and a user simply
 * has none.
 *
 * `identityId` is the on-chain id once one is registered, and null until then.
 * That is the same rule the modules follow: the repository is the source of
 * truth and chain state is mirrored INTO it, so a publisher, their people, and
 * their modules all exist and list correctly before anything is deployed.
 */
export interface KeelPublisher {
  readonly id: string;
  readonly kind: "user" | "org";
  readonly title: string;
  readonly summary: string;
  readonly url: string | null;
  readonly identityId: string | null;
  readonly members: readonly KeelPublisherMember[];
  readonly groups: readonly KeelPublisherGroup[];
}

function publisherText(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`${KEEL_PUBLISHER_MANIFEST_FILE}: ${label} must be text of 1 through ${maximum} characters.`);
  }
  return value;
}

function optionalText(value: unknown, label: string, maximum = 512): string | null {
  return value === undefined || value === null ? null : publisherText(value, label, maximum);
}

export function parseKeelPublisher(value: unknown): KeelPublisher {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${KEEL_PUBLISHER_MANIFEST_FILE} must be a JSON object.`);
  const input = value as Record<string, unknown>;
  // keel.org@1 predates users existing, so it is exactly an org publisher.
  const legacy = input.schema === KEEL_ORG_SCHEMA;
  if (!legacy && input.schema !== KEEL_PUBLISHER_SCHEMA) {
    throw new Error(`${KEEL_PUBLISHER_MANIFEST_FILE}: schema must be ${KEEL_PUBLISHER_SCHEMA} (or the older ${KEEL_ORG_SCHEMA}).`);
  }
  const kind = legacy ? "org" : input.kind;
  if (kind !== "user" && kind !== "org") throw new Error(`${KEEL_PUBLISHER_MANIFEST_FILE}: kind must be "user" or "org".`);
  const members = Array.isArray(input.members) ? input.members : [];
  const groups = Array.isArray(input.groups) ? input.groups : [];
  if (kind === "user" && groups.length > 0) {
    throw new Error(`${KEEL_PUBLISHER_MANIFEST_FILE}: a user publisher has no groups; groups belong to an org.`);
  }
  const parsedMembers = members.map((member) => {
    const item = member as Record<string, unknown>;
    return {
      id: publisherText(item.id, "members[].id", 64),
      name: publisherText(item.name, "members[].name", 128),
      role: publisherText(item.role, "members[].role", 64),
      github: optionalText(item.github, "members[].github", 128),
      address: optionalText(item.address, "members[].address", 128),
    };
  });
  const known = new Set(parsedMembers.map((member) => member.id));
  const parsedGroups = groups.map((group) => {
    const item = group as Record<string, unknown>;
    const groupMembers = (Array.isArray(item.members) ? item.members : []).map((id) => publisherText(id, "groups[].members[]", 64));
    // A group naming somebody who is not in the org is a listing that leads
    // nowhere, so it fails here rather than rendering as a dead link.
    for (const id of groupMembers) if (!known.has(id)) throw new Error(`${KEEL_PUBLISHER_MANIFEST_FILE}: group "${String(item.id)}" names unknown member "${id}".`);
    return {
      id: publisherText(item.id, "groups[].id", 64),
      title: publisherText(item.title, "groups[].title", 128),
      summary: publisherText(item.summary, "groups[].summary", 512),
      members: groupMembers,
    };
  });
  return {
    id: publisherText(input.id, "id", 64),
    kind,
    title: publisherText(input.title, "title", 128),
    summary: publisherText(input.summary, "summary", 512),
    url: optionalText(input.url, "url"),
    identityId: optionalText(input.identityId ?? input.organizationId, "identityId", 66),
    members: parsedMembers,
    groups: parsedGroups,
  };
}

/** Every `modules/<publisher>/publisher.json` (or legacy `org.json`), by id. */
export async function discoverKeelWorkspacePublishers(root: string): Promise<readonly KeelPublisher[]> {
  const modulesRoot = path.join(path.resolve(root), MODULES_DIRECTORY);
  let entries;
  try {
    entries = await readdir(modulesRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const publishers: KeelPublisher[] = [];
  for (const entry of entries.filter((item) => item.isDirectory())) {
    for (const file of [KEEL_PUBLISHER_MANIFEST_FILE, KEEL_ORG_MANIFEST_FILE]) {
      const manifestPath = path.join(modulesRoot, entry.name, file);
      if (!(await isFile(manifestPath))) continue;
      const publisher = parseKeelPublisher(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
      if (publisher.id !== entry.name) throw new Error(`${manifestPath}: publisher id "${publisher.id}" does not match its directory "${entry.name}".`);
      publishers.push(publisher);
      break;
    }
  }
  return publishers.sort((left, right) => (left.id < right.id ? -1 : 1));
}

/* ------------------------------------------------------------ deployments */

/**
 * One published revision of a module on one chain.
 *
 * A JS module goes on chain as a KeelHold object, so the address that matters
 * is the KeelHold instance plus the object id inside it. `outputDigest` ties
 * the revision back to the exact bytes a receipt verified, which is what makes
 * "this address is running that source" a checkable claim rather than a label.
 */
export interface KeelModuleRevision {
  readonly chainId: number;
  readonly hold: { readonly address: string; readonly objectId: string };
  readonly version: string;
  readonly outputDigest: Hex;
  readonly receiptDigest: Hex;
  readonly block: string | null;
  readonly txHash: string | null;
  readonly publishedAt: string;
  readonly status: "current" | "superseded";
}

const HEX_DIGEST = /^0x[0-9a-f]{64}$/u;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;

function revisionDigest(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !HEX_DIGEST.test(value)) throw new Error(`deployment: ${label} must be a lower-case sha256 digest.`);
  return value as Hex;
}

/**
 * Every `deployments/<chainId>.json` a module ships, flattened to revisions.
 *
 * No file, no deployments, and that is a normal, fully verified state rather
 * than an error: a module is verified by its receipt, not by having reached a
 * chain.
 */
export async function readKeelModuleRevisions(moduleDirectory: string): Promise<readonly KeelModuleRevision[]> {
  const directory = path.join(moduleDirectory, KEEL_MODULE_DEPLOYMENTS_DIRECTORY);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const revisions: KeelModuleRevision[] = [];
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".json")).sort((left, right) => (left.name < right.name ? -1 : 1))) {
    const record = JSON.parse(await readFile(path.join(directory, entry.name), "utf8")) as Record<string, unknown>;
    if (record.schema !== KEEL_MODULE_DEPLOYMENT_SCHEMA) throw new Error(`${path.join(directory, entry.name)}: schema must be ${KEEL_MODULE_DEPLOYMENT_SCHEMA}.`);
    const chainId = record.chainId;
    if (!Number.isSafeInteger(chainId) || (chainId as number) <= 0) throw new Error(`${path.join(directory, entry.name)}: chainId must be a positive integer.`);
    const list = Array.isArray(record.revisions) ? record.revisions : [];
    for (const item of list as readonly Record<string, unknown>[]) {
      const hold = item.hold as Record<string, unknown> | undefined;
      if (hold === undefined || typeof hold.address !== "string" || !ADDRESS.test(hold.address)) {
        throw new Error(`${path.join(directory, entry.name)}: every revision needs hold.address, the KeelHold instance it lives in.`);
      }
      revisions.push({
        chainId: chainId as number,
        hold: { address: hold.address.toLowerCase(), objectId: revisionDigest(hold.objectId, "hold.objectId") },
        version: publisherText(item.version, "revisions[].version", 64),
        outputDigest: revisionDigest(item.outputDigest, "revisions[].outputDigest"),
        receiptDigest: revisionDigest(item.receiptDigest, "revisions[].receiptDigest"),
        block: optionalText(item.block, "revisions[].block", 64),
        txHash: optionalText(item.txHash, "revisions[].txHash", 66),
        publishedAt: publisherText(item.publishedAt, "revisions[].publishedAt", 64),
        status: item.status === "current" ? "current" : "superseded",
      });
    }
  }
  return revisions;
}

export interface WorkspaceBuildResult {
  readonly module: KeelWorkspaceModule;
  readonly build: BuildKeelModuleResult;
}

/** `keel module build --all`: every module, fail-fast, module named in every failure. */
export async function buildKeelWorkspace(root: string, options: BuildKeelModuleOptions = {}): Promise<readonly WorkspaceBuildResult[]> {
  const modules = await discoverKeelWorkspaceModules(root);
  const results: WorkspaceBuildResult[] = [];
  for (const module of modules) {
    try {
      results.push({ module, build: await buildKeelModule(module.directory, options) });
    } catch (error) {
      throw new Error(`Build of ${module.workspacePath} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return results;
}

export interface WorkspaceTestResult {
  readonly module: KeelWorkspaceModule;
  /** Undefined when the module ships no test vectors; reported, not failed. */
  readonly test?: TestKeelModuleResult;
}

/** `keel module test --all`: every module with vectors; the rest are reported as skipped. */
export async function testKeelWorkspace(root: string): Promise<readonly WorkspaceTestResult[]> {
  const modules = await discoverKeelWorkspaceModules(root);
  const results: WorkspaceTestResult[] = [];
  for (const module of modules) {
    if (!(await hasModuleVectors(module.directory))) {
      results.push({ module });
      continue;
    }
    results.push({ module, test: await testKeelModule(module.directory) });
  }
  return results;
}

export interface KeelCatalogSourceFile {
  readonly path: string;
  readonly sha256: Hex;
}

export interface KeelModuleCatalogEntry {
  readonly id: string;
  readonly version: string;
  readonly license: string;
  readonly summary: string;
  /** Publisher that owns the module, and the category it is filed under. */
  readonly publisher: string | null;
  readonly category: string | null;
  /**
   * The listing path. A user owns its modules directly; an org may own them
   * directly, through a group, or through a member of a group.
   */
  readonly owner: {
    readonly publisher: string;
    readonly kind: "user" | "org";
    readonly group: string | null;
    readonly member: string | null;
  } | null;
  /** Public repository URL for the readable source; null until one is known. */
  readonly sourceRepository: string | null;
  /** The module's own public repository, once split out; null while it is monorepo-only. */
  readonly moduleRepository: string | null;
  /** Repo-relative path to the readable verified entry source. */
  readonly githubPath: string;
  /** The READABLE files the site shows, each pinned by digest. */
  readonly sourceFiles: readonly KeelCatalogSourceFile[];
  readonly outputDigest: Hex;
  readonly receiptDigest: Hex;
  readonly disposition: KeelSourceReceipt["disposition"];
  /** True only for the byte-proof dispositions: exact-source-output, reproducible-build. */
  readonly verified: boolean;
  /**
   * Every published revision, on every chain, each pinning the KeelHold
   * instance and object it lives in. Empty is the normal state for a module
   * that is verified but not yet published, and says nothing about `verified`.
   */
  readonly deployments: readonly KeelModuleRevision[];
  /** Convenience for the site: whether any revision has reached a chain. */
  readonly deployed: boolean;
}

export interface KeelModuleCatalog {
  readonly schema: typeof KEEL_MODULE_CATALOG_SCHEMA;
  /** The listing tree: publishers (people and organisations), and their groups. */
  readonly publishers: readonly KeelPublisher[];
  readonly modules: readonly KeelModuleCatalogEntry[];
}

export interface IndexKeelWorkspaceOptions {
  /** Fallback repository URL for manifests that carry none (the keel-modules shape). */
  readonly repositoryUrl?: string;
}

export interface IndexKeelWorkspaceResult {
  readonly catalogPath: string;
  readonly catalog: KeelModuleCatalog;
}

const VERIFIED_DISPOSITIONS: ReadonlySet<KeelSourceReceipt["disposition"]> = new Set([
  "exact-source-output",
  "reproducible-build",
]);

function placeholderFree(url: string): string | null {
  return url.includes("example.invalid") ? null : url;
}

async function catalogEntry(module: KeelWorkspaceModule, options: IndexKeelWorkspaceOptions): Promise<KeelModuleCatalogEntry> {
  const distDirectory = path.join(module.directory, "dist");
  const shippedPath = path.join(distDirectory, `${module.manifest.name}.min.js`);
  const recipePath = path.join(distDirectory, "keel-build-recipe.json");
  const receiptPath = path.join(distDirectory, "keel-source-receipt.json");
  const [shippedBytes, recipeBytes, receiptBytes] = await Promise.all([
    readFile(shippedPath),
    readFile(recipePath),
    readFile(receiptPath),
  ]).catch(() => {
    throw new Error(`${module.workspacePath} has no complete dist/. Run "keel module build --all" before indexing.`);
  });
  const recipe = JSON.parse(recipeBytes.toString("utf8")) as KeelBuildRecipe;
  const receipt = JSON.parse(receiptBytes.toString("utf8")) as KeelSourceReceipt;
  const outputIntegrity = await createIntegrity(new Uint8Array(shippedBytes));
  if (outputIntegrity.digest !== recipe.output.integrity.digest) {
    throw new Error(`${module.workspacePath}: dist bytes no longer match the recipe. Rebuild before indexing.`);
  }
  if (receipt.output.digest !== outputIntegrity.digest) {
    throw new Error(`${module.workspacePath}: the source receipt does not cover the dist bytes. Rebuild before indexing.`);
  }
  const receiptDigest = (await createIntegrity(utf8ToBytes(canonicalJson(receipt)))).digest;
  const manifestRepository = placeholderFree(module.manifest.sourceRepository.url);
  const placement = module.manifest.placement;
  const deployments = await readKeelModuleRevisions(module.directory);
  return {
    id: module.manifest.name,
    version: module.manifest.version,
    license: module.manifest.license,
    summary: module.manifest.description,
    publisher: placement?.publisher ?? null,
    category: placement?.category ?? null,
    owner: placement === undefined
      ? null
      : {
          publisher: placement.publisher,
          kind: placement.publisherKind,
          group: placement.group ?? null,
          member: placement.member ?? null,
        },
    sourceRepository: manifestRepository ?? options.repositoryUrl ?? null,
    moduleRepository: module.manifest.moduleRepository ?? null,
    githubPath: `${module.workspacePath}/${module.manifest.entry}`,
    sourceFiles: recipe.inputs.map((input) => ({
      path: `${module.workspacePath}/${input.path}`,
      sha256: input.integrity.digest,
    })),
    outputDigest: outputIntegrity.digest,
    receiptDigest,
    disposition: receipt.disposition,
    // Verified is a statement about bytes, not about chains. It is set here
    // and nowhere else, and `deployments` never touches it.
    verified: VERIFIED_DISPOSITIONS.has(receipt.disposition),
    deployments,
    deployed: deployments.length > 0,
  };
}

/**
 * `keel module index`: scan the workspace, verify every module's dist is
 * current, and write the catalog the keel-site reads. Entries are sorted by
 * id and the file layout is stable, so a rebuild-free re-index is a no-op diff.
 */
export async function indexKeelWorkspace(root: string, options: IndexKeelWorkspaceOptions = {}): Promise<IndexKeelWorkspaceResult> {
  const resolvedRoot = path.resolve(root);
  const modules = await discoverKeelWorkspaceModules(resolvedRoot);
  const publishers = await discoverKeelWorkspacePublishers(resolvedRoot);
  const entries = [];
  for (const module of modules) entries.push(await catalogEntry(module, options));
  // A module filed under a publisher the workspace does not define would list
  // under a heading that does not exist, so it is caught at index time.
  for (const entry of entries) {
    if (entry.owner === null) continue;
    const owner = entry.owner;
    const publisher = publishers.find((candidate) => candidate.id === owner.publisher);
    if (publisher === undefined) {
      throw new Error(`${entry.id}: owner "${owner.publisher}" has no ${KEEL_PUBLISHER_MANIFEST_FILE} in this workspace.`);
    }
    // Claiming a person is an org (or the reverse) would render the wrong
    // listing shape, so the manifest and the publisher have to agree.
    if (publisher.kind !== owner.kind) {
      throw new Error(`${entry.id}: owner names ${owner.publisher} as a ${owner.kind}, but it is declared as a ${publisher.kind}.`);
    }
    if (owner.group !== null && !publisher.groups.some((candidate) => candidate.id === owner.group)) {
      throw new Error(`${entry.id}: owner.group "${owner.group}" is not a group of ${owner.publisher}.`);
    }
    if (owner.member !== null && !publisher.members.some((candidate) => candidate.id === owner.member)) {
      throw new Error(`${entry.id}: owner.member "${owner.member}" is not a member of ${owner.publisher}.`);
    }
  }
  const catalog: KeelModuleCatalog = {
    schema: KEEL_MODULE_CATALOG_SCHEMA,
    publishers,
    modules: entries.sort((left, right) => (left.id < right.id ? -1 : 1)),
  };
  const catalogPath = path.join(resolvedRoot, KEEL_MODULE_CATALOG_FILE);
  await mkdir(path.dirname(catalogPath), { recursive: true });
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  return { catalogPath, catalog };
}
