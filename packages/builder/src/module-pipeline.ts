/**
 * The author-facing module pipeline behind `keel module init|build|plan`.
 *
 * The contract is the one the rest of the toolchain already enforces: authors
 * keep strict, readable TypeScript; the platform minifies it for on-chain
 * bytes; and a hash-linked receipt binds the readable source to the exact
 * minified output. This file adds nothing to that machinery. It only walks a
 * directory through the existing pieces in the right order:
 *
 *   init  -> a strict-TS scaffold with a dependency-injected entry module
 *   build -> strict tsc typecheck, esbuild with KEEL_MODULE_BUILD_OPTIONS,
 *            then createKeelBuildRecipe + createKeelModuleSourceReceipt
 *   plan  -> a review-only keel-publish-plan@1 for the built bytes; no
 *            signing, no network, ever
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import {
  canonicalJson,
  createIntegrity,
  utf8ToBytes,
  type Hex,
  type Integrity,
  type KeelBuildRecipe,
  type KeelSourceReceipt,
} from "@keel/protocol";
import {
  createKeelPublishReviewPlan,
  resolveModuleTarget,
  type KeelPublishReviewPlanEnvelope,
} from "@keel/sdk";
import {
  KEEL_MODULE_BUILD_OPTIONS,
  createKeelBuildRecipe,
  createKeelModuleSourceReceipt,
  type KeelBuildVerification,
} from "./build-recipe.js";
import { createUploadPlan } from "./plan.js";
import type { ObjectUploadPlan } from "./types.js";

const require = createRequire(import.meta.url);

export const KEEL_MODULE_MANIFEST_PROTOCOL = "keel-module-manifest@1" as const;
export const KEEL_MODULE_MANIFEST_FILE = "keel.module.json" as const;

const MODULE_NAME = /^[a-z][a-z0-9-]{0,63}$/u;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_CHUNKS_PER_CAST = 3;
const DEFAULT_PLAN_CHAIN_ID = 11_155_111;
const REPOSITORY_PLACEHOLDER_URL = "https://example.invalid/your-org/your-repo";
const REPOSITORY_PLACEHOLDER_REVISION = "replace-with-a-commit-hash";

export interface KeelModuleManifest {
  readonly protocol: typeof KEEL_MODULE_MANIFEST_PROTOCOL;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly entry: string;
  readonly license: string;
  /** Placeholder until the module has a public home; build skips it until it is real. */
  readonly sourceRepository: { readonly url: string; readonly revision: string; readonly path: string };
}

function fail(message: string): never {
  throw new TypeError(message);
}

function moduleName(value: string): string {
  if (!MODULE_NAME.test(value)) fail(`Module name "${value}" must match ${MODULE_NAME.source}.`);
  return value;
}

function textField(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${KEEL_MODULE_MANIFEST_FILE}: ${label} must be printable text of 1 through ${maximum} characters.`);
  }
  return value;
}

export function parseKeelModuleManifest(value: unknown): KeelModuleManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${KEEL_MODULE_MANIFEST_FILE} must be a JSON object.`);
  const input = value as Record<string, unknown>;
  const allowed = new Set(["protocol", "name", "version", "description", "entry", "license", "sourceRepository"]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) fail(`${KEEL_MODULE_MANIFEST_FILE}: "${key}" is not supported.`);
  if (input.protocol !== KEEL_MODULE_MANIFEST_PROTOCOL) fail(`${KEEL_MODULE_MANIFEST_FILE}: protocol must be ${KEEL_MODULE_MANIFEST_PROTOCOL}.`);
  const name = moduleName(textField(input.name, "name", 64));
  const entry = textField(input.entry, "entry", 256);
  if (entry.startsWith("/") || entry.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
    fail(`${KEEL_MODULE_MANIFEST_FILE}: entry must be a safe relative path.`);
  }
  const repositoryValue = input.sourceRepository;
  if (repositoryValue === null || typeof repositoryValue !== "object" || Array.isArray(repositoryValue)) {
    fail(`${KEEL_MODULE_MANIFEST_FILE}: sourceRepository must be an object with url, revision, and path.`);
  }
  const repository = repositoryValue as Record<string, unknown>;
  return {
    protocol: KEEL_MODULE_MANIFEST_PROTOCOL,
    name,
    version: textField(input.version, "version", 64),
    description: textField(input.description, "description", 512),
    entry,
    license: textField(input.license, "license", 64),
    sourceRepository: {
      url: textField(repository.url, "sourceRepository.url", 512),
      revision: textField(repository.revision, "sourceRepository.revision", 128),
      path: textField(repository.path, "sourceRepository.path", 256),
    },
  };
}

export async function readKeelModuleManifest(directory: string): Promise<KeelModuleManifest> {
  const manifestPath = path.join(path.resolve(directory), KEEL_MODULE_MANIFEST_FILE);
  const bytes = await readFile(manifestPath);
  if (bytes.byteLength > MAX_MANIFEST_BYTES) fail(`${KEEL_MODULE_MANIFEST_FILE} exceeds ${MAX_MANIFEST_BYTES} bytes.`);
  return parseKeelModuleManifest(JSON.parse(bytes.toString("utf8")) as unknown);
}

/* ------------------------------------------------------------------ init */

export interface InitKeelModuleOptions {
  readonly name?: string;
}

export interface InitKeelModuleResult {
  readonly directory: string;
  readonly manifest: KeelModuleManifest;
  readonly files: readonly string[];
}

function scaffoldTsconfig(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ES2022",
        moduleResolution: "bundler",
        lib: ["ES2022", "DOM"],
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        noImplicitOverride: true,
        useUnknownInCatchVariables: true,
        forceConsistentCasingInFileNames: true,
        noEmit: true,
      },
      include: ["src/**/*.ts"],
    },
    null,
    2,
  )}\n`;
}

function scaffoldEntry(name: string): string {
  return `/**
 * ${name}: a Keel module.
 *
 * Everything the module needs arrives through \`createModule(context)\`.
 * No ambient globals, no network, no CDN imports: on Keel the verified
 * on-chain graph is the only dependency source, so a module that asks for
 * its capabilities explicitly stays reproducible and reviewable.
 *
 * Authors keep this file strict and readable; \`keel module build\` minifies
 * it for on-chain bytes and emits a hash-linked receipt binding the two.
 */

/** Capabilities the host injects. Extend this instead of reaching for globals. */
export interface ModuleContext {
  /** Deterministic seed the host derives from the token identity. */
  readonly seed: string;
  /** Deterministic unit-interval random. Same seed, same sequence. */
  readonly random: () => number;
}

/** The surface the host receives back. Replace \`next\` with the real API. */
export interface ModuleApi {
  readonly name: string;
  next(): number;
}

export function createModule(context: ModuleContext): ModuleApi {
  if (context.seed.length === 0) {
    throw new RangeError("createModule requires a non-empty seed.");
  }
  return {
    name: ${JSON.stringify(name)},
    next: () => context.random(),
  };
}

export default createModule;
`;
}

function scaffoldReadme(name: string): string {
  return `# ${name}

A Keel module: strict, readable TypeScript that the platform minifies for
on-chain bytes, with a hash-linked receipt connecting the two.

## Pipeline

\`\`\`bash
keel module build .   # strict typecheck, minify, recipe + source receipt
keel module plan .    # review-only keel-publish-plan@1 (no signing, no network)
\`\`\`

Outputs land in \`dist/\`: \`${name}.min.js\`, \`keel-build-recipe.json\`,
\`keel-source-receipt.json\`, and \`keel-publish-plan.json\`.

Before publishing, replace the \`sourceRepository\` placeholder in
\`keel.module.json\` with the public repository, commit, and path holding this
exact source, so third parties can reproduce the build with
\`verifyKeelModuleFromOrigin\`.
`;
}

export async function initKeelModule(directory: string, options: InitKeelModuleOptions = {}): Promise<InitKeelModuleResult> {
  const root = path.resolve(directory);
  const name = moduleName(options.name ?? path.basename(root).toLowerCase());
  const manifestPath = path.join(root, KEEL_MODULE_MANIFEST_FILE);
  let exists = false;
  try {
    await readFile(manifestPath);
    exists = true;
  } catch {
    exists = false;
  }
  if (exists) fail(`${manifestPath} already exists; refusing to overwrite a module.`);
  const manifest: KeelModuleManifest = {
    protocol: KEEL_MODULE_MANIFEST_PROTOCOL,
    name,
    version: "0.1.0",
    description: `${name}: a Keel module.`,
    entry: "src/index.ts",
    license: "MIT",
    sourceRepository: {
      url: REPOSITORY_PLACEHOLDER_URL,
      revision: REPOSITORY_PLACEHOLDER_REVISION,
      path: ".",
    },
  };
  await mkdir(path.join(root, "src"), { recursive: true });
  const files: readonly (readonly [string, string])[] = [
    [KEEL_MODULE_MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`],
    ["tsconfig.json", scaffoldTsconfig()],
    ["src/index.ts", scaffoldEntry(name)],
    ["README.md", scaffoldReadme(name)],
  ];
  for (const [file, content] of files) await writeFile(path.join(root, file), content);
  return { directory: root, manifest, files: files.map(([file]) => file) };
}

/* ----------------------------------------------------------------- build */

export interface BuildKeelModuleResult {
  readonly directory: string;
  readonly manifest: KeelModuleManifest;
  readonly outputPath: string;
  readonly recipePath: string;
  readonly receiptPath: string;
  readonly recipe: KeelBuildRecipe;
  readonly recipeDigest: Hex;
  readonly outputIntegrity: Integrity;
  readonly receipt: KeelSourceReceipt;
  readonly receiptDigest: Hex;
  readonly verification: KeelBuildVerification;
}

function runStrictTypecheck(directory: string): void {
  // The typescript package is loaded from the toolchain, not from the module
  // being built, so a module cannot swap in a permissive compiler.
  const ts = require("typescript") as typeof import("typescript");
  const configPath = path.join(directory, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error !== undefined) {
    fail(`tsconfig.json could not be read: ${ts.flattenDiagnosticMessageText(config.error.messageText, "\n")}`);
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, directory);
  const options = parsed.options;
  for (const [flag, value] of [
    ["strict", options.strict],
    ["noUncheckedIndexedAccess", options.noUncheckedIndexedAccess],
    ["exactOptionalPropertyTypes", options.exactOptionalPropertyTypes],
  ] as const) {
    if (value !== true) fail(`Keel modules must keep "${flag}": true in tsconfig.json; the readable source is the verified portion.`);
  }
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: { ...options, noEmit: true } });
  const diagnostics = [...ts.getPreEmitDiagnostics(program)];
  if (diagnostics.length > 0) {
    const formatted = diagnostics
      .map((diagnostic) => ts.formatDiagnostic(diagnostic, {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => directory,
        getNewLine: () => "\n",
      }))
      .join("");
    throw new Error(`Strict typecheck failed:\n${formatted}`);
  }
}

function realRepository(manifest: KeelModuleManifest): KeelModuleManifest["sourceRepository"] | undefined {
  const { url, revision } = manifest.sourceRepository;
  if (url.includes("example.invalid") || revision.startsWith("replace-with")) return undefined;
  return manifest.sourceRepository;
}

export async function buildKeelModule(directory: string): Promise<BuildKeelModuleResult> {
  const root = path.resolve(directory);
  const manifest = await readKeelModuleManifest(root);
  runStrictTypecheck(root);
  const built = await createKeelBuildRecipe({
    root,
    entry: manifest.entry,
    options: KEEL_MODULE_BUILD_OPTIONS,
    mediaType: "text/javascript",
  });
  // The readable source the receipt points a holder at is the resolved module
  // graph the recipe pinned, in recipe order, so no imported file escapes the
  // readability report and no unimported file can join it.
  const sourceParts = await Promise.all(
    built.recipe.inputs.map(async (input) => new Uint8Array(await readFile(path.join(root, input.path)))),
  );
  const sourceBytes = new Uint8Array(Buffer.concat(sourceParts));
  const repository = realRepository(manifest);
  const { receipt, verification } = await createKeelModuleSourceReceipt({
    recipe: built.recipe,
    root,
    sourceBytes,
    sourceMediaType: "application/typescript",
    ...(repository === undefined ? {} : { repository }),
  });
  const distDirectory = path.join(root, "dist");
  await mkdir(distDirectory, { recursive: true });
  const outputPath = path.join(distDirectory, `${manifest.name}.min.js`);
  const recipePath = path.join(distDirectory, "keel-build-recipe.json");
  const receiptPath = path.join(distDirectory, "keel-source-receipt.json");
  await writeFile(outputPath, built.outputBytes);
  await writeFile(recipePath, `${canonicalJson(built.recipe)}\n`);
  await writeFile(receiptPath, `${canonicalJson(receipt)}\n`);
  const receiptDigest = (await createIntegrity(utf8ToBytes(canonicalJson(receipt)))).digest;
  return {
    directory: root,
    manifest,
    outputPath,
    recipePath,
    receiptPath,
    recipe: built.recipe,
    recipeDigest: built.recipeDigest,
    outputIntegrity: built.outputIntegrity,
    receipt,
    receiptDigest,
    verification,
  };
}

/* ------------------------------------------------------------------ plan */

export interface PlanKeelModuleOptions {
  readonly chainId?: number;
  readonly address?: `0x${string}`;
}

export interface PlanKeelModuleResult {
  readonly directory: string;
  readonly manifest: KeelModuleManifest;
  readonly planPath: string;
  readonly uploadPlan: ObjectUploadPlan;
  readonly envelope: KeelPublishReviewPlanEnvelope;
}

export function chainOperationsForUploadPlan(uploadPlan: ObjectUploadPlan): readonly Record<string, unknown>[] {
  const operations: Record<string, unknown>[] = [];
  for (let offset = 0; offset < uploadPlan.chunks.length; offset += MAX_CHUNKS_PER_CAST) {
    const batch = uploadPlan.chunks.slice(offset, offset + MAX_CHUNKS_PER_CAST);
    operations.push({
      kind: "castSlugs",
      function: "castSlugs(bytes[])",
      payloadEncoding: "raw-bytes-from-files",
      chunkFiles: batch.map((chunk) => chunk.file),
      chunkByteLengths: batch.map((chunk) => chunk.byteLength),
      chunkIntegrities: batch.map((chunk) => chunk.integrity),
      slugIds: "derived-keccak256-after-review",
    });
  }
  operations.push({
    kind: "weldObject",
    function: "weldObject(bytes32[],bytes32,uint64,uint8,string)",
    slugIds: "from-preceding-castSlugs",
    digest: uploadPlan.integrity,
    byteLength: uploadPlan.originalByteLength,
    compression: uploadPlan.compression,
    mediaType: uploadPlan.mediaType,
  });
  return operations;
}

export async function planKeelModule(directory: string, options: PlanKeelModuleOptions = {}): Promise<PlanKeelModuleResult> {
  const root = path.resolve(directory);
  const manifest = await readKeelModuleManifest(root);
  const distDirectory = path.join(root, "dist");
  const outputPath = path.join(distDirectory, `${manifest.name}.min.js`);
  const recipePath = path.join(distDirectory, "keel-build-recipe.json");
  const [outputBytes, recipeBytes] = await Promise.all([readFile(outputPath), readFile(recipePath)]).catch(() => {
    return fail(`Run "keel module build ${directory}" first; the plan works from the built output.`);
  });
  const recipe = JSON.parse(recipeBytes.toString("utf8")) as KeelBuildRecipe;
  const outputIntegrity = await createIntegrity(new Uint8Array(outputBytes));
  if (outputIntegrity.digest !== recipe.output.integrity.digest || outputIntegrity.byteLength !== recipe.output.integrity.byteLength) {
    fail(`${outputPath} no longer matches dist/keel-build-recipe.json; rebuild before planning.`);
  }
  const chainId = options.chainId ?? DEFAULT_PLAN_CHAIN_ID;
  const address = options.address
    ?? resolveModuleTarget({ module: "keel-hold", contract: "KeelHold", chainId }).address;
  const uploadPlan = await createUploadPlan(new Uint8Array(outputBytes), {
    objectName: `${manifest.name}.min.js`,
    mediaType: recipe.output.mediaType,
    outputDirectory: distDirectory,
    compression: "auto",
  });
  const envelope = await createKeelPublishReviewPlan({
    schema: "keel-chain-operation-plan@1",
    status: "review-only",
    materialized: true,
    descriptorMaterialized: true,
    chainReady: false,
    target: { family: "ethereum", chainId, address },
    sourcePlan: {
      path: "upload-plan.json",
      schema: uploadPlan.schema,
      objectName: uploadPlan.objectName,
      mediaType: uploadPlan.mediaType,
      integrity: uploadPlan.integrity,
    },
    operations: chainOperationsForUploadPlan(uploadPlan),
    encoding: "deferred-contract-abi",
    walletApproval: "required",
    signing: "not-performed",
    submission: "not-performed",
    caveat: "Operation descriptors are review-only; a verified chain adapter must encode, simulate, sign, and submit them.",
  });
  const planPath = path.join(distDirectory, "keel-publish-plan.json");
  await writeFile(planPath, `${JSON.stringify(envelope, null, 2)}\n`);
  return { directory: root, manifest, planPath, uploadPlan, envelope };
}
