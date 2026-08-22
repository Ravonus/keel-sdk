/**
 * Running a build recipe, and checking that a recipe still produces what it
 * claims. This is the half of `keel-build-recipe` that needs a filesystem
 * and a bundler; the structure and the digest live in `@keel/protocol` so a
 * browser can hold a recipe without being able to execute one.
 *
 * The point of the pair is that a creator can keep readable TypeScript in a
 * public repository and put only the minified bundle on chain, and a holder can
 * still prove the small thing they are running is the build of the large thing
 * they can read. Without this, minification is where provenance goes to die:
 * the on-chain bytes are unreadable, the source is unlinked, and "trust me, it
 * is the same code" is the whole argument.
 *
 * ## What makes the answer worth anything
 *
 * `createKeelBuildRecipe` records the *resolved module graph* from esbuild's
 * metafile, not a directory listing. A file the entry point never imports
 * cannot perturb the digest, and one it does import cannot be left out — which
 * is the difference between a recipe that pins a build and one that pins a
 * folder somebody can add to.
 *
 * `verifyKeelBuildRecipe` re-reads every named input, re-runs the build, and
 * compares. When it fails it says which of the three things went wrong — an
 * input changed, the options changed, or the same inputs and options produced
 * different bytes — because "it did not match" alone sends people hunting.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { build, version as esbuildVersion } from "esbuild";
import {
  assertValidKeelBuildRecipe,
  createIntegrity,
  diffKeelBuildRecipes,
  keelBuildRecipeDigest,
  verifySourceBuild,
  KEEL_BUILD_RECIPE_PROTOCOL,
  type Hex,
  type Integrity,
  type KeelBuildOptions,
  type KeelBuildRecipe,
  type KeelSourceReceipt,
} from "@keel/protocol";

/**
 * Defaults chosen for bytes that go on chain and run in a sandboxed frame.
 * `legalComments: "none"` and `charset: "ascii"` are not cosmetic: comments are
 * gas, and a non-ASCII escape is bytes a marketplace's transport may mangle.
 */
export const KEEL_MODULE_BUILD_OPTIONS: KeelBuildOptions = Object.freeze({
  format: "esm",
  target: "es2022",
  platform: "browser",
  minify: true,
  bundle: true,
  legalComments: "none",
  charset: "ascii",
});

export interface CreateKeelBuildRecipeOptions {
  /** Everything is named relative to this, so a recipe is machine-independent. */
  readonly root: string;
  /** Entry point, relative to `root`. */
  readonly entry: string;
  readonly options?: KeelBuildOptions;
  readonly mediaType?: string;
}

export interface KeelBuildResult {
  readonly recipe: KeelBuildRecipe;
  readonly recipeDigest: Hex;
  readonly outputBytes: Uint8Array;
  readonly outputIntegrity: Integrity;
}

function sortedRecord(value: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  const keys = Object.keys(value).sort();
  if (keys.length === 0) return undefined;
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, value[key] as string])));
}

function normalizedOptions(options: KeelBuildOptions): KeelBuildOptions {
  const define = sortedRecord(options.define);
  const external = options.external === undefined || options.external.length === 0
    ? undefined
    : [...options.external].sort();
  return Object.freeze({
    format: options.format,
    target: options.target,
    platform: options.platform,
    minify: options.minify,
    bundle: options.bundle,
    legalComments: options.legalComments,
    charset: options.charset,
    ...(define === undefined ? {} : { define }),
    ...(external === undefined ? {} : { external }),
  });
}

/** Relative, POSIX-separated, so a recipe made on Windows verifies on Linux. */
function relative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/");
}

async function runBuild(
  root: string,
  entry: string,
  options: KeelBuildOptions,
): Promise<{ readonly bytes: Uint8Array; readonly inputs: readonly string[] }> {
  const result = await build({
    absWorkingDir: path.resolve(root),
    entryPoints: [entry],
    bundle: options.bundle,
    minify: options.minify,
    format: options.format,
    target: [options.target],
    platform: options.platform,
    legalComments: options.legalComments,
    charset: options.charset,
    ...(options.define === undefined ? {} : { define: { ...options.define } }),
    ...(options.external === undefined ? {} : { external: [...options.external] }),
    write: false,
    metafile: true,
    // A sourcemap comment would put a path from the build machine into the
    // bytes, which is both a leak and a reason two machines disagree.
    sourcemap: false,
  });
  const output = result.outputFiles?.[0];
  if (output === undefined) throw new Error(`Build of ${entry} produced no output.`);
  // esbuild reports metafile input keys relative to absWorkingDir already.
  return { bytes: new Uint8Array(output.contents), inputs: Object.keys(result.metafile?.inputs ?? {}).sort() };
}

export async function createKeelBuildRecipe(
  options: CreateKeelBuildRecipeOptions,
): Promise<KeelBuildResult> {
  const root = path.resolve(options.root);
  const entry = relative(root, path.resolve(root, options.entry));
  const buildOptions = normalizedOptions(options.options ?? KEEL_MODULE_BUILD_OPTIONS);
  const { bytes, inputs } = await runBuild(root, entry, buildOptions);

  const graph = await Promise.all(
    inputs.map(async (input) => ({
      path: input,
      integrity: await createIntegrity(new Uint8Array(await readFile(path.resolve(root, input)))),
    })),
  );
  const outputIntegrity = await createIntegrity(bytes);
  const recipe: KeelBuildRecipe = {
    protocol: KEEL_BUILD_RECIPE_PROTOCOL,
    tool: { name: "esbuild", version: esbuildVersion },
    entry,
    inputs: graph.sort((left, right) => (left.path < right.path ? -1 : 1)),
    options: buildOptions,
    output: { mediaType: options.mediaType ?? "text/javascript", integrity: outputIntegrity },
  };
  assertValidKeelBuildRecipe(recipe);
  return { recipe, recipeDigest: await keelBuildRecipeDigest(recipe), outputBytes: bytes, outputIntegrity };
}

export type KeelBuildVerdict = "reproduced" | "source-changed" | "environment-changed" | "output-differs";

export interface KeelBuildVerification {
  readonly verdict: KeelBuildVerdict;
  readonly reproduced: boolean;
  readonly recipeDigest: Hex;
  readonly rebuiltOutput: Integrity;
  readonly rebuiltBytes: Uint8Array;
  /** Why it diverged, in terms a person can act on. Empty when reproduced. */
  readonly issues: readonly string[];
}

export interface VerifyKeelBuildRecipeOptions {
  readonly recipe: KeelBuildRecipe;
  /** The tree to rebuild from — a checkout of the pinned source. */
  readonly root: string;
}

/**
 * Rebuild from a checkout and say whether it reproduces the recipe's output.
 *
 * The inputs are checked before the build runs. A changed input is a different
 * finding from a bundler that emits different bytes for the same input, and
 * collapsing them into one failure is how a reproducibility claim becomes
 * noise nobody investigates.
 */
export async function verifyKeelBuildRecipe(
  options: VerifyKeelBuildRecipeOptions,
): Promise<KeelBuildVerification> {
  const recipe = assertValidKeelBuildRecipe(options.recipe);
  const root = path.resolve(options.root);
  const recipeDigest = await keelBuildRecipeDigest(recipe);

  const { bytes, inputs } = await runBuild(root, recipe.entry, recipe.options);
  const graph = await Promise.all(
    inputs.map(async (input) => ({
      path: input,
      integrity: await createIntegrity(new Uint8Array(await readFile(path.resolve(root, input)))),
    })),
  );
  const rebuiltOutput = await createIntegrity(bytes);
  const actual: KeelBuildRecipe = {
    ...recipe,
    tool: { name: "esbuild", version: esbuildVersion },
    inputs: graph.sort((left, right) => (left.path < right.path ? -1 : 1)),
    output: { mediaType: recipe.output.mediaType, integrity: rebuiltOutput },
  };
  const issues = diffKeelBuildRecipes(recipe, actual);
  if (issues.length === 0) {
    return { verdict: "reproduced", reproduced: true, recipeDigest, rebuiltOutput, rebuiltBytes: bytes, issues };
  }
  // Ordered by what a reader should look at first: their checkout, then their
  // toolchain, then the genuinely interesting case where neither explains it.
  const verdict: KeelBuildVerdict = issues.some((issue: string) => issue.startsWith("input "))
    ? "source-changed"
    : issues.some((issue: string) => issue.startsWith("tool:") || issue.startsWith("options:"))
      ? "environment-changed"
      : "output-differs";
  return { verdict, reproduced: false, recipeDigest, rebuiltOutput, rebuiltBytes: bytes, issues };
}

export interface KeelModuleSourceReceiptOptions {
  readonly recipe: KeelBuildRecipe;
  readonly root: string;
  /** The readable source a holder is being pointed at, for the readability report. */
  readonly sourceBytes: Uint8Array;
  readonly sourceMediaType?: string;
  readonly repository?: { readonly url: string; readonly revision: string; readonly path: string };
}

/**
 * The end of the chain: a `KeelSourceReceipt` whose `buildRecipeDigest` is a
 * digest of an actual recipe, and whose `reproducible-build` disposition was
 * earned by rebuilding rather than asserted by whoever filed it.
 */
export async function createKeelModuleSourceReceipt(
  options: KeelModuleSourceReceiptOptions,
): Promise<{ readonly receipt: KeelSourceReceipt; readonly verification: KeelBuildVerification }> {
  const verification = await verifyKeelBuildRecipe({ recipe: options.recipe, root: options.root });
  if (!verification.reproduced) {
    throw new Error(`Build did not reproduce (${verification.verdict}): ${verification.issues.join("; ")}`);
  }
  const receipt = await verifySourceBuild({
    sourceBytes: options.sourceBytes,
    outputBytes: verification.rebuiltBytes,
    // The bytes we rebuilt are the bytes we are attesting to. Passing the same
    // buffer is the point: the receipt's own equality check is then over what
    // this verifier actually produced, not over a number it was handed.
    rebuiltOutputBytes: verification.rebuiltBytes,
    mediaType: options.sourceMediaType ?? options.recipe.output.mediaType,
    buildRecipeDigest: verification.recipeDigest,
    verifier: { name: "keel-build-recipe", version: "1.0.0" },
    ...(options.repository === undefined ? {} : { repository: options.repository }),
  });
  return { receipt, verification };
}
