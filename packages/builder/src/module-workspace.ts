/**
 * Workspace support for the module pipeline: many art items in one directory.
 *
 * The layout is exactly the keel-modules repo's layout, a root holding
 * `modules/<name>/{keel.module.json, src/...}`, and this file is the only
 * place that layout is known. Discovery walks it; `--all` builds and tests
 * walk discovery; and `keel module index` distills it into the one artifact
 * the site reads: `catalog/catalog.json` (`keel-module-catalog@1`).
 *
 * The catalog is the site's whole view of the workspace, so its rules are
 * conservative: an entry's `verified` flag is true only for the byte-proof
 * dispositions (exact-source-output, reproducible-build); behaviorally
 * verified candidates and queued builds never get it. And `sourceFiles`
 * lists the READABLE files with per-file digests, because those are what the
 * site shows next to the word "verified".
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

export const KEEL_MODULE_CATALOG_SCHEMA = "keel-module-catalog@1" as const;
export const KEEL_MODULE_CATALOG_FILE = "catalog/catalog.json" as const;
const MODULES_DIRECTORY = "modules" as const;

export interface KeelWorkspaceModule {
  /** Absolute path to the module directory. */
  readonly directory: string;
  /** Workspace-root-relative POSIX path, e.g. `modules/seeded-random`. */
  readonly workspacePath: string;
  readonly manifest: KeelModuleManifest;
}

/** Every module manifest under `modules/`, sorted by directory name. */
export async function discoverKeelWorkspaceModules(root: string): Promise<readonly KeelWorkspaceModule[]> {
  const resolvedRoot = path.resolve(root);
  const modulesRoot = path.join(resolvedRoot, MODULES_DIRECTORY);
  let entries;
  try {
    entries = await readdir(modulesRoot, { withFileTypes: true });
  } catch {
    throw new Error(`${modulesRoot} not found. A module workspace keeps its modules in ${MODULES_DIRECTORY}/<name>/.`);
  }
  const modules: KeelWorkspaceModule[] = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((left, right) => (left.name < right.name ? -1 : 1))) {
    const directory = path.join(modulesRoot, entry.name);
    try {
      await stat(path.join(directory, KEEL_MODULE_MANIFEST_FILE));
    } catch {
      continue; // a directory without a manifest is not a module
    }
    const manifest = await readKeelModuleManifest(directory);
    modules.push({ directory, workspacePath: `${MODULES_DIRECTORY}/${entry.name}`, manifest });
  }
  if (modules.length === 0) {
    throw new Error(`No ${KEEL_MODULE_MANIFEST_FILE} found under ${modulesRoot}. Nothing to process.`);
  }
  return modules;
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
  /** Public repository URL for the readable source; null until one is known. */
  readonly sourceRepository: string | null;
  /** Repo-relative path to the readable verified entry source. */
  readonly githubPath: string;
  /** The READABLE files the site shows, each pinned by digest. */
  readonly sourceFiles: readonly KeelCatalogSourceFile[];
  readonly outputDigest: Hex;
  readonly receiptDigest: Hex;
  readonly disposition: KeelSourceReceipt["disposition"];
  /** True only for the byte-proof dispositions: exact-source-output, reproducible-build. */
  readonly verified: boolean;
  readonly builtAt: string;
}

export interface KeelModuleCatalog {
  readonly schema: typeof KEEL_MODULE_CATALOG_SCHEMA;
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
  const builtAt = new Date((await stat(receiptPath)).mtimeMs).toISOString();
  const manifestRepository = placeholderFree(module.manifest.sourceRepository.url);
  return {
    id: module.manifest.name,
    version: module.manifest.version,
    license: module.manifest.license,
    summary: module.manifest.description,
    sourceRepository: manifestRepository ?? options.repositoryUrl ?? null,
    githubPath: `${module.workspacePath}/${module.manifest.entry}`,
    sourceFiles: recipe.inputs.map((input) => ({
      path: `${module.workspacePath}/${input.path}`,
      sha256: input.integrity.digest,
    })),
    outputDigest: outputIntegrity.digest,
    receiptDigest,
    disposition: receipt.disposition,
    verified: VERIFIED_DISPOSITIONS.has(receipt.disposition),
    builtAt,
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
  const entries = [];
  for (const module of modules) entries.push(await catalogEntry(module, options));
  const catalog: KeelModuleCatalog = {
    schema: KEEL_MODULE_CATALOG_SCHEMA,
    modules: entries.sort((left, right) => (left.id < right.id ? -1 : 1)),
  };
  const catalogPath = path.join(resolvedRoot, KEEL_MODULE_CATALOG_FILE);
  await mkdir(path.dirname(catalogPath), { recursive: true });
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  return { catalogPath, catalog };
}
