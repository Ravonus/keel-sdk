/**
 * A build recipe: the canonical, hashable answer to "what produced these bytes".
 *
 * `KeelSourceReceipt` could already say that an on-chain object is the
 * *reproducible build* of some source, and it carried a `buildRecipeDigest` to
 * point at how. But nothing defined what that digest was a digest *of*. A
 * caller supplied thirty-two opaque bytes, the receipt recorded them, and the
 * disposition `"reproducible-build"` rested entirely on that caller's word —
 * which is the one thing a verification receipt is supposed to remove.
 *
 * This is the missing structure. A recipe names every input by path and digest,
 * the exact tool and version, and the exact options, so that:
 *
 *   - anyone holding the source tree can re-run it and get the same bytes;
 *   - anyone holding only the recipe can tell whether the source tree they have
 *     is the one it was built from, before running anything;
 *   - changing a single byte of a single input changes the digest, so a recipe
 *     cannot be quietly re-pointed at different source.
 *
 * That is what lets a creator write TypeScript, keep the readable source off
 * chain, and store only the minified output on chain — while a holder can still
 * prove the small thing they are running is the build of the large thing they
 * can read. Minification stops being a place where provenance is lost.
 *
 * ## Determinism is a property of the recipe, not a hope
 *
 * Every field that changes output is in the digest. `inputs` is the resolved
 * module graph, not a directory listing, so an unused file cannot perturb it and
 * a used one cannot be omitted. Entries are sorted by path, so the same graph
 * always canonicalizes the same way regardless of the order a bundler walked it.
 * `tool.version` is exact: a bundler is not obliged to emit identical bytes
 * across versions and pretending otherwise makes the receipt lie the first time
 * one is upgraded.
 *
 * This module is pure structure and hashing so it can run in a browser, a build
 * script, or an agent. Executing a recipe needs a filesystem and a bundler and
 * lives in `@keel/builder`.
 */

import { canonicalJson } from "./canonical.js";
import { utf8ToBytes } from "./bytes.js";
import { createIntegrity } from "./integrity.js";
import type { Hex, Integrity } from "./types.js";

export const KEEL_BUILD_RECIPE_PROTOCOL = "keel-build-recipe@1" as const;
export const KEEL_BUILD_RECIPE_PROTOCOL_V2 = "keel-build-recipe@2" as const;

export type KeelBuildRecipeProtocol =
  | typeof KEEL_BUILD_RECIPE_PROTOCOL
  | typeof KEEL_BUILD_RECIPE_PROTOCOL_V2;

/** Bundlers whose output this protocol is prepared to reproduce. */
export type KeelBuildTool = "esbuild";

/** Compactors whose output this protocol is prepared to reproduce. */
export type KeelCompactTool = "terser";

export interface KeelBuildToolIdentity {
  readonly name: KeelBuildTool;
  /** Exact version. A range would make the digest a promise nobody can keep. */
  readonly version: string;
}

/**
 * The options that change output bytes. Deliberately a closed set: an open
 * option bag would let a build depend on something the digest does not cover,
 * which is the same failure as having no digest.
 */
export interface KeelBuildOptions {
  readonly format: "esm" | "iife" | "cjs";
  readonly target: string;
  readonly platform: "browser" | "neutral" | "node";
  readonly minify: boolean;
  readonly bundle: boolean;
  /** Always dropped for on-chain output; kept explicit because it changes bytes. */
  readonly legalComments: "none" | "inline";
  readonly charset: "ascii" | "utf8";
  /** Names bound at build time, sorted. Each one changes the output. */
  readonly define?: Readonly<Record<string, string>>;
  /** Import specifiers left unresolved, sorted. */
  readonly external?: readonly string[];
}

/** One file in the resolved module graph, named by repository-relative path. */
export interface KeelBuildInput {
  readonly path: string;
  readonly integrity: Integrity;
}

/**
 * The options of the compact stage that change output bytes. A closed set for
 * the same reason `KeelBuildOptions` is: an option the digest does not cover
 * is an option a reproduction cannot be held to.
 */
export interface KeelCompactOptions {
  /** Compression passes. At least 2; more passes converge, they do not wander. */
  readonly passes: number;
  readonly mangle: boolean;
  /** Preserve legal comments (`/*!` and `@license`/`@preserve`) in shipped bytes. */
  readonly keepComments: boolean;
}

/** A banner file injected verbatim into the shipped bytes, named like an input. */
export interface KeelCompactStamp {
  readonly path: string;
  readonly integrity: Integrity;
}

/**
 * The compact stage of a `keel-build-recipe@2`: the bundler's output is run
 * through a second minifier, and the smaller of the two candidates ships. Both
 * candidate sizes and the winner are recorded so the choice is auditable, and
 * the tool version is exact so the stage reproduces byte for byte.
 */
export interface KeelBuildCompact {
  readonly tool: { readonly name: KeelCompactTool; readonly version: string };
  readonly options: KeelCompactOptions;
  readonly stamp?: KeelCompactStamp;
  readonly winner: "esbuild" | "terser";
  /** Candidate sizes before any stamp banner, so the comparison is honest. */
  readonly candidateBytes: { readonly esbuild: number; readonly terser: number };
}

export interface KeelBuildRecipe {
  readonly protocol: KeelBuildRecipeProtocol;
  readonly tool: KeelBuildToolIdentity;
  /** Entry point, relative to the recipe root. */
  readonly entry: string;
  /** The resolved graph, sorted by path. Not a directory listing. */
  readonly inputs: readonly KeelBuildInput[];
  readonly options: KeelBuildOptions;
  /** Present only on `keel-build-recipe@2`. `@1` records remain valid as-is. */
  readonly compact?: KeelBuildCompact;
  readonly output: {
    readonly mediaType: string;
    readonly integrity: Integrity;
  };
}

const SAFE_PATH = /^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[\x21-\x7e]+$/u;
const SEMVER_ISH = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const FORMATS = new Set(["esm", "iife", "cjs"]);
const PLATFORMS = new Set(["browser", "neutral", "node"]);
const LEGAL_COMMENTS = new Set(["none", "inline"]);
const CHARSETS = new Set(["ascii", "utf8"]);
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u;

function assertIntegrity(value: Integrity | undefined, label: string): void {
  if (
    value === undefined ||
    value.algorithm !== "sha256" ||
    !/^0x[0-9a-f]{64}$/u.test(value.digest) ||
    !Number.isSafeInteger(value.byteLength) ||
    (value.byteLength ?? -1) < 0
  ) {
    throw new TypeError(`${label} must be an exact SHA-256 integrity commitment.`);
  }
}

function assertPath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || !SAFE_PATH.test(value)) {
    throw new TypeError(`${label} must be a safe relative path without traversal.`);
  }
  return value;
}

function assertValidCompact(compact: KeelBuildCompact): void {
  if (compact === null || typeof compact !== "object") throw new TypeError("recipe.compact must be an object.");
  if (compact.tool?.name !== "terser") throw new TypeError("recipe.compact.tool.name is not a supported compactor.");
  if (typeof compact.tool.version !== "string" || !SEMVER_ISH.test(compact.tool.version)) {
    throw new TypeError("recipe.compact.tool.version must be an exact version.");
  }
  const options = compact.options;
  if (options === null || typeof options !== "object") throw new TypeError("recipe.compact.options is required.");
  if (!Number.isSafeInteger(options.passes) || options.passes < 2 || options.passes > 16) {
    throw new TypeError("recipe.compact.options.passes must be an integer from 2 through 16.");
  }
  if (typeof options.mangle !== "boolean" || typeof options.keepComments !== "boolean") {
    throw new TypeError("recipe.compact.options.mangle and .keepComments must be booleans.");
  }
  if (compact.stamp !== undefined) {
    assertPath(compact.stamp.path, "recipe.compact.stamp.path");
    assertIntegrity(compact.stamp.integrity, "recipe.compact.stamp.integrity");
  }
  if (compact.winner !== "esbuild" && compact.winner !== "terser") {
    throw new TypeError("recipe.compact.winner must be esbuild or terser.");
  }
  const sizes = compact.candidateBytes;
  if (
    sizes === null || typeof sizes !== "object" ||
    !Number.isSafeInteger(sizes.esbuild) || sizes.esbuild <= 0 ||
    !Number.isSafeInteger(sizes.terser) || sizes.terser <= 0
  ) {
    throw new TypeError("recipe.compact.candidateBytes must record both candidate sizes.");
  }
}

export function assertValidKeelBuildRecipe(recipe: KeelBuildRecipe): KeelBuildRecipe {
  if (recipe?.protocol !== KEEL_BUILD_RECIPE_PROTOCOL && recipe?.protocol !== KEEL_BUILD_RECIPE_PROTOCOL_V2) {
    throw new TypeError("recipe.protocol must be keel-build-recipe@1 or keel-build-recipe@2.");
  }
  if (recipe.compact !== undefined) {
    if (recipe.protocol !== KEEL_BUILD_RECIPE_PROTOCOL_V2) {
      throw new TypeError("recipe.compact requires keel-build-recipe@2.");
    }
    assertValidCompact(recipe.compact);
  }
  if (recipe.tool?.name !== "esbuild") throw new TypeError("recipe.tool.name is not a supported build tool.");
  if (typeof recipe.tool.version !== "string" || !SEMVER_ISH.test(recipe.tool.version)) {
    throw new TypeError("recipe.tool.version must be an exact version.");
  }
  assertPath(recipe.entry, "recipe.entry");

  const options = recipe.options;
  if (options === null || typeof options !== "object") throw new TypeError("recipe.options is required.");
  if (!FORMATS.has(options.format)) throw new TypeError("recipe.options.format is unsupported.");
  if (!PLATFORMS.has(options.platform)) throw new TypeError("recipe.options.platform is unsupported.");
  if (!LEGAL_COMMENTS.has(options.legalComments)) throw new TypeError("recipe.options.legalComments is unsupported.");
  if (!CHARSETS.has(options.charset)) throw new TypeError("recipe.options.charset is unsupported.");
  if (typeof options.target !== "string" || options.target.length === 0 || options.target.length > 64) {
    throw new TypeError("recipe.options.target is required.");
  }
  if (typeof options.minify !== "boolean" || typeof options.bundle !== "boolean") {
    throw new TypeError("recipe.options.minify and .bundle must be booleans.");
  }
  for (const [key, value] of Object.entries(options.define ?? {})) {
    if (key.length === 0 || typeof value !== "string") throw new TypeError("recipe.options.define entries must be strings.");
  }
  for (const [index, value] of (options.external ?? []).entries()) {
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(`recipe.options.external[${index}] must be a non-empty specifier.`);
    }
  }

  if (!Array.isArray(recipe.inputs) || recipe.inputs.length === 0) {
    throw new TypeError("recipe.inputs must name at least the entry point.");
  }
  let previous = "";
  const seen = new Set<string>();
  for (const [index, input] of recipe.inputs.entries()) {
    assertPath(input?.path, `recipe.inputs[${index}].path`);
    assertIntegrity(input.integrity, `recipe.inputs[${index}].integrity`);
    // Sorted and unique, so one graph has exactly one canonical form and the
    // digest cannot be varied by reordering a list that means the same thing.
    if (input.path <= previous) throw new TypeError("recipe.inputs must be sorted by path and unique.");
    if (seen.has(input.path)) throw new TypeError(`recipe.inputs[${index}].path is duplicated.`);
    seen.add(input.path);
    previous = input.path;
  }
  if (!seen.has(recipe.entry)) throw new TypeError("recipe.entry must appear in recipe.inputs.");

  if (!MEDIA_TYPE.test(recipe.output?.mediaType ?? "")) throw new TypeError("recipe.output.mediaType is invalid.");
  assertIntegrity(recipe.output.integrity, "recipe.output.integrity");
  return recipe;
}

/**
 * The digest a `KeelSourceReceipt` carries. Over the whole recipe including
 * its declared output, so the digest commits to the pairing rather than merely
 * to the ingredients: a recipe and an output that were never each other's
 * cannot be recombined under one digest.
 */
export async function keelBuildRecipeDigest(recipe: KeelBuildRecipe): Promise<Hex> {
  assertValidKeelBuildRecipe(recipe);
  const integrity = await createIntegrity(utf8ToBytes(canonicalJson(recipe)));
  return integrity.digest;
}

/**
 * Whether two recipes describe the same build. Used to tell a reader *why* a
 * rebuild diverged — a changed input is a different answer from a changed
 * bundler version, and "it did not match" alone sends people hunting.
 */
export function diffKeelBuildRecipes(
  expected: KeelBuildRecipe,
  actual: KeelBuildRecipe,
): readonly string[] {
  const issues: string[] = [];
  if (expected.tool.name !== actual.tool.name || expected.tool.version !== actual.tool.version) {
    issues.push(
      `tool: recipe was built with ${expected.tool.name}@${expected.tool.version}, this environment has ${actual.tool.name}@${actual.tool.version}`,
    );
  }
  if (expected.entry !== actual.entry) issues.push(`entry: ${expected.entry} vs ${actual.entry}`);
  if (canonicalJson(expected.options) !== canonicalJson(actual.options)) {
    issues.push("options: build options differ from the recipe");
  }
  const expectedByPath = new Map(expected.inputs.map((input) => [input.path, input.integrity.digest] as const));
  const actualByPath = new Map(actual.inputs.map((input) => [input.path, input.integrity.digest] as const));
  for (const [path, digest] of expectedByPath) {
    const found = actualByPath.get(path);
    if (found === undefined) issues.push(`input missing: ${path}`);
    else if (found !== digest) issues.push(`input changed: ${path}`);
  }
  for (const path of actualByPath.keys()) {
    if (!expectedByPath.has(path)) issues.push(`input added: ${path}`);
  }
  if (expected.protocol !== actual.protocol) {
    issues.push(`options: recipe protocol ${expected.protocol} vs ${actual.protocol}`);
  }
  if (expected.compact !== undefined || actual.compact !== undefined) {
    const expectedCompact = expected.compact;
    const actualCompact = actual.compact;
    if (expectedCompact === undefined || actualCompact === undefined) {
      issues.push("options: one recipe has a compact stage and the other does not");
    } else {
      if (expectedCompact.tool.name !== actualCompact.tool.name || expectedCompact.tool.version !== actualCompact.tool.version) {
        issues.push(
          `tool: recipe compact stage used ${expectedCompact.tool.name}@${expectedCompact.tool.version}, this environment has ${actualCompact.tool.name}@${actualCompact.tool.version}`,
        );
      }
      if (canonicalJson(expectedCompact.options) !== canonicalJson(actualCompact.options)) {
        issues.push("options: compact options differ from the recipe");
      }
      if ((expectedCompact.stamp?.path) !== (actualCompact.stamp?.path)) {
        issues.push("options: compact stamp declaration differs from the recipe");
      } else if (expectedCompact.stamp !== undefined && actualCompact.stamp !== undefined &&
                 expectedCompact.stamp.integrity.digest !== actualCompact.stamp.integrity.digest) {
        issues.push(`input changed: ${expectedCompact.stamp.path}`);
      }
      if (expectedCompact.winner !== actualCompact.winner ||
          expectedCompact.candidateBytes.esbuild !== actualCompact.candidateBytes.esbuild ||
          expectedCompact.candidateBytes.terser !== actualCompact.candidateBytes.terser) {
        issues.push("output: compact stage produced different candidates than the recipe records");
      }
    }
  }
  if (expected.output.integrity.digest !== actual.output.integrity.digest) {
    issues.push("output: rebuilt bytes differ from the recipe's declared output");
  }
  return issues;
}
