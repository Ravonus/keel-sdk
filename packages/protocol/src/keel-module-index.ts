/**
 * The register of Keel modules: what each one is, where its source lives,
 * what built it, and where the built bytes ended up.
 *
 * Modules are developed as their own public repositories — one module, one
 * repo, one verifiable build. That is what makes each of them independently
 * checkable, and it is also what makes them easy to lose track of. This index
 * is the other half of that trade: it lives in the monorepo and points at every
 * module repo, so the set stays organised in one place even though no module's
 * source is stored here.
 *
 * The link runs both ways on purpose. The index names the repo (`origin`); the
 * repo names its slot here (`workspace`). Either one alone is a claim; the pair
 * agreeing is a check, and a module that has drifted out of the monorepo's
 * knowledge shows up as a mismatch rather than as silence.
 *
 * ## What an entry proves, and what it does not
 *
 * An entry that carries `recipeDigest`, `output`, and `receiptDigest` says: the
 * bytes at `output` are the reproducible build of the source at `origin`, and
 * here is the recipe you can re-run to see for yourself. It says nothing about
 * whether the module is any *good*, or whether it should be trusted — that is
 * `KeelModuleReviewRegistry`'s job, on chain, with revocation. Provenance
 * and endorsement are different questions and this file only answers the first.
 *
 * `carriers` is where the built bytes actually are. For a module meant to be
 * carried inside viewer documents, the carrier that matters is the `keel`
 * one: the module is stored on chain *once*, as its own object, and every
 * document that needs it references that object as a composite part rather than
 * bundling its own copy. Storage is charged once, not once per token.
 */

import type { KeelCarrier, KeelModuleIdentity } from "./keel-hold.js";
import type { KeelSourceOrigin } from "./keel-source-origin.js";
import type { Hex, Integrity } from "./types.js";

export const KEEL_MODULE_INDEX_PROTOCOL = "keel-module-index@1" as const;

export interface KeelModuleIndexEntry {
  readonly identity: KeelModuleIdentity;
  /** Public source, pinned to an immutable commit. Keel stores none of it. */
  readonly origin: KeelSourceOrigin;
  /** Path inside the repository that the build recipe's root maps to. */
  readonly recipeRoot?: string;
  /** Digest of the `KeelBuildRecipe` that produced `output`. */
  readonly recipeDigest: Hex;
  /** The exact built bytes — what goes on chain. */
  readonly output: Integrity;
  /** Digest of the `KeelSourceReceipt` recording the reproducible build. */
  readonly receiptDigest?: Hex;
  /** Where those bytes are retrievable. A `keel` carrier is the on-chain object. */
  readonly carriers?: readonly KeelCarrier[];
  /**
   * The module's slot in this monorepo. The back-pointer: a module repo that
   * declares the same path is one this index still knows about.
   */
  readonly workspace?: { readonly path: string };
  readonly description?: string;
}

export interface KeelModuleIndex {
  readonly protocol: typeof KEEL_MODULE_INDEX_PROTOCOL;
  readonly canonicalDigest: "sha256";
  /** Sorted by `namespace/name@version`, so the file has one canonical form. */
  readonly modules: readonly KeelModuleIndexEntry[];
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._@/-]{0,127}$/u;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const SAFE_PATH = /^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[\x21-\x7e]+$/u;
const DIGEST = /^0x[0-9a-f]{64}$/u;

export function keelModuleKey(identity: KeelModuleIdentity): string {
  return `${identity.namespace}/${identity.name}@${identity.version}`;
}

function assertIntegrity(value: Integrity | undefined, label: string): void {
  if (
    value === undefined ||
    value.algorithm !== "sha256" ||
    !DIGEST.test(value.digest) ||
    !Number.isSafeInteger(value.byteLength) ||
    (value.byteLength ?? -1) <= 0
  ) {
    throw new TypeError(`${label} must be an exact non-empty SHA-256 integrity commitment.`);
  }
}

export function assertValidKeelModuleIndex(index: KeelModuleIndex): KeelModuleIndex {
  if (index?.protocol !== KEEL_MODULE_INDEX_PROTOCOL) {
    throw new TypeError("index.protocol must be keel-module-index@1.");
  }
  if (index.canonicalDigest !== "sha256") throw new TypeError("index.canonicalDigest must be sha256.");
  if (!Array.isArray(index.modules)) throw new TypeError("index.modules must be an array.");

  let previous = "";
  for (const [position, entry] of index.modules.entries()) {
    const label = `index.modules[${position}]`;
    const identity = entry?.identity;
    if (identity === undefined || !["npm", "keel", "github"].includes(identity.namespace)) {
      throw new TypeError(`${label}.identity.namespace is unsupported.`);
    }
    if (!NAME.test(identity.name ?? "")) throw new TypeError(`${label}.identity.name is invalid.`);
    if (!VERSION.test(identity.version ?? "")) throw new TypeError(`${label}.identity.version must be exact.`);
    if (!SAFE_PATH.test(identity.entry ?? "")) throw new TypeError(`${label}.identity.entry is invalid.`);

    const key = keelModuleKey(identity);
    // Sorted and unique, so one set of modules has one canonical file and a
    // reordered diff is never mistaken for a change.
    if (key <= previous) throw new TypeError(`${label} must be sorted by module key and unique (${key}).`);
    previous = key;

    if (!DIGEST.test(entry.recipeDigest ?? "")) throw new TypeError(`${label}.recipeDigest is invalid.`);
    if (entry.receiptDigest !== undefined && !DIGEST.test(entry.receiptDigest)) {
      throw new TypeError(`${label}.receiptDigest is invalid.`);
    }
    assertIntegrity(entry.output, `${label}.output`);
    if (entry.recipeRoot !== undefined && !SAFE_PATH.test(entry.recipeRoot)) {
      throw new TypeError(`${label}.recipeRoot must be a safe relative path.`);
    }
    if (entry.workspace !== undefined && !SAFE_PATH.test(entry.workspace.path ?? "")) {
      throw new TypeError(`${label}.workspace.path must be a safe relative path.`);
    }
    if (entry.origin === undefined) throw new TypeError(`${label}.origin is required.`);
  }
  return index;
}

export function sortKeelModuleIndex(
  entries: readonly KeelModuleIndexEntry[],
): readonly KeelModuleIndexEntry[] {
  return [...entries].sort((left, right) =>
    keelModuleKey(left.identity) < keelModuleKey(right.identity) ? -1 : 1,
  );
}

/**
 * Whether a module repo's own declaration and this index agree about each
 * other. Both halves of the link are claims; only the agreement is a check.
 */
export function keelModuleLinkIssues(
  entry: KeelModuleIndexEntry,
  declared: { readonly workspace?: { readonly path: string }; readonly monorepo?: string },
): readonly string[] {
  const issues: string[] = [];
  if (entry.workspace === undefined) {
    issues.push(`${keelModuleKey(entry.identity)} has no workspace slot in the index.`);
  } else if (declared.workspace === undefined) {
    issues.push(`${keelModuleKey(entry.identity)} does not declare the monorepo slot the index assigns it.`);
  } else if (declared.workspace.path !== entry.workspace.path) {
    issues.push(
      `${keelModuleKey(entry.identity)} declares workspace ${declared.workspace.path}; the index says ${entry.workspace.path}.`,
    );
  }
  return issues;
}
