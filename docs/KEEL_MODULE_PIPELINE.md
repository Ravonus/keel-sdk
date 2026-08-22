# The Keel module pipeline: init to reviewed on-chain module

KEEL publishes JavaScript modules on chain. Authors write strict, clean
TypeScript (the verified readable portion); the platform minifies it for
on-chain bytes; and a hash-linked receipt connects the readable source to the
on-chain minified output. This page walks an author through the whole path with
the `keel` CLI (`@keel/builder`; the old `oca` bin name remains as an alias).

## 1. Scaffold: `keel module init <dir>`

```bash
keel module init ./my-module
```

Creates a small, strict module workspace:

- `keel.module.json` (`keel-module-manifest@1`): identity (name, version,
  description), the entry point, the license, and a `sourceRepository`
  placeholder. Replace the placeholder with the public repository, commit, and
  path holding this exact source before publishing; while it still says
  `example.invalid` the build deliberately omits it from the receipt.
- `tsconfig.json`: `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, ES2022 modules, `noEmit` (esbuild does the
  emitting). The build refuses to run if these flags are weakened, because the
  readable source is the verified portion.
- `src/index.ts`: a documented dependency-injected skeleton in the style of the
  `examples/library` modules. Everything the module needs arrives through
  `createModule(context)`; no ambient globals, no network, no CDN imports.
- `README.md`: a stub describing the pipeline.

## 2. Build: `keel module build <dir>`

```bash
keel module build ./my-module
```

One command runs the whole minify-and-hash pipeline:

1. Strict `tsc` typecheck of the module (fails closed on any diagnostic).
2. esbuild with `KEEL_MODULE_BUILD_OPTIONS` (ES2022 ESM, browser platform,
   minified, ASCII, no legal comments unless `--keep-comments`).
3. The compact stage: terser (exact version pinned by the builder and recorded
   in the recipe) re-minifies the esbuild output with fixed deterministic
   settings (3 passes, mangle, nothing time- or path-dependent). Whichever
   candidate is smaller ships as `dist/<name>.min.js`; the recipe records the
   winner and BOTH candidate sizes. `--no-compact` skips the stage.
4. `createKeelBuildRecipe` records the resolved module graph by digest into
   `dist/keel-build-recipe.json` (`keel-build-recipe@2` with a `compact`
   section; `--no-compact` builds still emit `keel-build-recipe@1`, and @1
   records remain valid).
5. `createKeelModuleSourceReceipt` rebuilds from the recipe, compact stage
   included, and only when the rebuild reproduces the exact shipped bytes
   emits `dist/keel-source-receipt.json` (`keel-source-receipt@1`,
   disposition `reproducible-build`).

Two compactor options, both recorded in the recipe so third-party
reproduction stays byte-exact:

- `--keep-comments` preserves legal comments (`/*!`, `@license`, `@preserve`)
  in the shipped bytes: esbuild carries them through (`legalComments:
  "inline"`) and terser keeps them (`comments: "some"`). Mark a comment you
  want on chain as a legal comment.
- `--stamp <file>` injects the file's contents as a leading `/*!` banner in
  the shipped bytes (for on-chain ASCII art). The file must live inside the
  module directory and must not contain `*/`. The recipe pins it by path and
  digest like any other input, and it is applied after the winner is chosen so
  it cannot tilt the size comparison.

### Workspaces: `keel module build --all`

A workspace is many art items in one directory, in the keel-modules repo
layout. Discovery has one rule: a directory holding a `keel.module.json` is a
module and is not descended into, anything else is a grouping directory. So
both layouts work and a workspace can migrate between them freely:

```
modules/<id>/                              flat
modules/<publisher>/<category>/<id>/       filed by publisher and category
```

Three manifest shapes are accepted: `keel-module-manifest@1`, the keel-modules
`keel.jsmodule@1` (id, entry, license, summary), and `keel.jsmodule@2`, which
adds `category` (what the module is, and the directory it lives in), `owner`
(who is responsible), and `repository` (the module's own public repository).

A publisher is a PERSON or an ORGANISATION, declared by
`modules/<publisher>/publisher.json` (`keel.publisher@1`). Nobody has to invent
an organisation to publish a module, so `owner: { user }` owns its modules
directly and has no groups; `owner: { org, group?, member? }` unlocks the
longer paths. Indexing cross-checks every owner path against the publisher, so
a module cannot list under a heading that does not exist, name somebody who is
not a member, or claim a person is an org.

```bash
keel module build --all --root ./keel-modules
keel module test  --all --root ./keel-modules
keel module index --root ./keel-modules --repository https://github.com/you/keel-modules
```

`--root` defaults to the current directory. Single-module verbs keep working
unchanged.

The command prints the three numbers that matter:

```
source digest:  0x...   sha256 of the readable source graph
output digest:  0x...   sha256 of the minified on-chain bytes
receipt digest: 0x...   sha256 of the canonical receipt binding the two
```

Anyone holding the source can recompute all three; a third party can verify a
published module against its public repository with
`verifyKeelModuleFromOrigin` (`@keel/builder`).

## 3. Test: `keel module test <dir>`

If a module ships test vectors (`test/vectors.mjs`, exporting an array of
`{ name, run(moduleExports) -> value, expect }` as the default or named
`vectors` export), `keel module test` builds the readable (unminified) source,
imports it and the shipped `dist/<name>.min.js` each in its own clean
subprocess, runs every vector against both, and fails on any divergence
between source behavior and shipped-bytes behavior, or between either and the
vector's own `expect`. Values must be JSON-serializable. `--all` runs every
module in the workspace and reports vector-less modules as skipped.

## 4. Agent-assisted minification: `keel module compact --candidate <file>`

An externally-minified candidate (from a human or an AI agent) has no
deterministic recipe, so it can never earn `reproducible-build`. This verb
runs the module's test vectors against the readable source build and the
candidate; if and only if behavior matches on every vector it writes
`dist/keel-candidate-receipt.json`: a `keel-source-receipt@1` with the honest
disposition `behaviorally-verified`, carrying the vectors-file digest and one
value digest per vector as executed evidence
(`keel-source-behavior-verification@1`). It never claims a rebuild. If the
module has no vectors, it refuses.

Trust order, strongest first: `exact-source-output` and `reproducible-build`
(byte proofs) > `behaviorally-verified` (vector-witnessed behavior only) >
`queued`.

## 4b. Check somebody else's module: `keel module verify`

```bash
keel module verify --repo keel-web3/noise2d --commit <sha> --expect 0x...
```

The public primitive. It fetches the archive for that exact commit, rebuilds
it in a temporary directory, prints the source, output, and archive digests,
deletes the checkout, and exits non-zero if the rebuild does not reproduce or
does not match `--expect`. `--path` names a directory inside the repository
for a monorepo layout.

No account, no permission, and no trust in the publisher or in Keel: this is
the command that makes "verified" a claim anyone can check rather than one
somebody made. A branch or tag is refused, because a proof pinned to a moving
ref expires without saying so.

It imposes nothing on the repository it is checking. No TypeScript, no
tsconfig, no `src/`, no manifest, no vectors, no layout: only the files the
entry point actually imports are pinned, and everything else in the tree is
none of Keel's business. The strictness gate in `keel module build` is a house
rule for repositories that opt into it; `keel module verify` does not run it.

## 5. Index for the site: `keel module index`

```bash
keel module index --root ./keel-modules --repository https://github.com/you/keel-modules
```

Scans the workspace and writes `catalog/catalog.json`
(`keel-module-catalog@3`): the `publishers` the workspace declares, plus one
entry per module with `id`, `version`, `license`, `summary`, `publisher`, `category`,
`owner`, `sourceRepository` (from the manifest when real, otherwise the
`--repository` flag, otherwise `null`), `moduleRepository` (its own public
repo, or null), `githubPath` (repo-relative path to the readable verified entry
source), `sourceFiles` (the READABLE files with per-file sha256; these are what
the site shows), `outputDigest`, `receiptDigest`, `disposition`, `verified`,
`deployments`, and `deployed`.

`verified` is true only for the byte-proof dispositions
(`exact-source-output`, `reproducible-build`); a behaviorally verified
candidate never sets it. Indexing refuses stale dist bytes; run
`keel module build --all` first.

**`verified` and `deployed` are independent, and neither is derived from the
other.** A module is verified the moment its readable source is proven to
rebuild into its exact minified bytes, which happens before any chain is
involved and stays true if it is never published. `deployments` lists the
revisions that HAVE reached a chain, each pinning the KeelHold address and
object id it lives at plus the `outputDigest` tying it back to verified bytes;
`deployed` is only whether that list is non-empty. An empty list on a verified
module is the normal starting state.

Every catalog field derives from a committed file, with nothing read from a
clock or an mtime, so indexing a clean workspace twice is a no-op diff and a
third party can check a published catalog by regenerating it and running
`diff`.

## 6. Plan: `keel module plan <dir>`

```bash
keel module plan ./my-module
keel module plan ./my-module --chain-id 11155111 --address 0x...
```

From the built output (it refuses stale bytes that no longer match the
recipe), this chunks the minified module, writes the chunk files plus
`dist/upload-plan.json`, and emits `dist/keel-publish-plan.json`: a canonical
`keel-publish-plan@1` envelope of `castSlugs` and `weldObject` operations
against KeelHold. Without flags it targets the registered Sepolia KeelHold
from the module deployment registry (`@keel/sdk`).

The plan is review-only by construction: `status: "review-only"`,
`signing: "not-performed"`, `submission: "not-performed"`. Nothing in this
pipeline touches a key or a network. A verified chain adapter
(`@keel/ethereum-adapter`) must encode, simulate, and submit it after human
review and wallet approval.

## 7. Review and publish

- Registry review flow: `packages/sdk/src/module-review.ts`
  (KeelModuleReviewRegistry actions) and `docs/KEEL_MODULES.md`.
- Submission: `packages/ethereum-adapter/src/adapter.ts` encodes and simulates
  publish plans against KeelHold; the wallet approves each transaction.

## Wrapping art in the verification shell

For creators shipping a viewable work rather than a library module, the SDK
has the one-call wrapper:

```ts
import { wrapInVerificationShell } from "@keel/sdk";

const wrapped = await wrapInVerificationShell({
  repositoryRoot,
  title: "My Piece",
  entry: { mediaType: "text/html", source: html },
  assets: [{ id: "palette", mediaType: "text/javascript", aliases: ["/content/palette.js"], bytes }],
});
// wrapped.html        -> the shell-wrapped, self-verifying document
// wrapped.publishPlan -> the review-only keel-publish-plan@1 for those bytes
```

The wrap keeps the shell's security properties: aliases resolve only from the
verified item graph committed in the envelope, there is no CDN or network
fallback, and the shell hash-checks every resource before mounting anything.
See `docs/KEEL_VERIFICATION_SHELL.md` for what the shell is.

## Tests

`tests/builder-module-pipeline.test.mjs` covers init, build, plan, digest
recomputation, and fail-closed behavior;
`tests/builder-module-workspace.test.mjs` covers workspace discovery,
`--all` builds, the compact stage and its recorded winner, stamp-injection
reproduction, `--keep-comments`, vector testing, the candidate flow, and the
catalog; `tests/sdk-verification-wrap.test.mjs` covers the wrapper and the
single-implementation guarantee with the studio scripts.

For what the pipeline is proven to guarantee, the tamper drills each of those
guarantees survives, and how to re-run the proofs against the real public
workspace and against GitHub itself, see `docs/KEEL_MODULE_ASSURANCE.md`
(`tests/keel-module-assurance.test.mjs` and
`tests/keel-modules-reproduction.test.mjs`).
