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
   minified, ASCII, no legal comments) producing `dist/<name>.min.js`.
3. `createKeelBuildRecipe` records the resolved module graph by digest into
   `dist/keel-build-recipe.json` (`keel-build-recipe@1`).
4. `createKeelModuleSourceReceipt` rebuilds from the recipe and, only when the
   rebuild reproduces the exact bytes, emits `dist/keel-source-receipt.json`
   (`keel-source-receipt@1`, disposition `reproducible-build`).

The command prints the three numbers that matter:

```
source digest:  0x...   sha256 of the readable source graph
output digest:  0x...   sha256 of the minified on-chain bytes
receipt digest: 0x...   sha256 of the canonical receipt binding the two
```

Anyone holding the source can recompute all three; a third party can verify a
published module against its public repository with
`verifyKeelModuleFromOrigin` (`@keel/builder`).

## 3. Plan: `keel module plan <dir>`

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

## 4. Review and publish

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
recomputation, and fail-closed behavior; `tests/sdk-verification-wrap.test.mjs`
covers the wrapper and the single-implementation guarantee with the studio
scripts.
