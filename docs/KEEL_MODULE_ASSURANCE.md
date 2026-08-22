# Module assurance: what is proven, and how to prove it again

`docs/KEEL_MODULE_PIPELINE.md` describes what the pipeline does. This page
describes what has actually been demonstrated about it, test by test, so that
the word "verified" on the site is a claim somebody can check rather than a
claim somebody made.

Two suites carry it:

- `tests/keel-module-assurance.test.mjs` works on a scratch module authored
  from zero inside a temporary directory. It covers the author path, the
  compactor, the candidate path, the tamper drills, and the wrap flow.
- `tests/keel-modules-reproduction.test.mjs` works on the real public
  workspace: a read-only copy of the `keel-modules` checkout next to this
  repository, and the public GitHub repository itself.

Both are in `scripts/test.mjs`.

```bash
node scripts/test.mjs                                   # everything
node --test tests/keel-module-assurance.test.mjs        # scratch module only
node --test tests/keel-modules-reproduction.test.mjs    # real workspace + GitHub
```

## The chain being proven

For one module the whole claim is a chain of sha256 links, each recomputable
from files a stranger can download:

```
readable .ts files          -> recipe.inputs[].integrity.digest
                            -> catalog.sourceFiles[].sha256
concatenated readable graph -> receipt.source.digest
canonical recipe JSON       -> recipe digest == receipt.buildRecipeDigest
                                             == receipt.verification.buildRecipeDigest
shipped dist/<id>.min.js    -> recipe.output.integrity.digest
                            == receipt.output.digest
                            == receipt.verification.rebuiltOutput.digest
                            == catalog.outputDigest
canonical receipt JSON      -> catalog.receiptDigest
```

`the receipt chain recomputes link by link` walks exactly that, for `noise2d`,
against both the freshly built copy and the committed `catalog/catalog.json`.

## What each claim rests on

| Claim | Test |
| --- | --- |
| `keel module init` to a self-proving build, with every printed digest recomputed from the file it names | `an author goes from zero to a build that proves itself` |
| The recipe pins both toolchain stages by exact version (esbuild and terser, resolved the way the builder resolves them) | same |
| Terser ships only when strictly smaller; both candidate sizes recorded; a rebuild is byte identical | `the compactor ships the smaller candidate...` and, across all 11 published modules, `every published module rebuilds reproducibly, twice...` |
| `--stamp` reproduces byte exactly through the receipt flow, and a stamp containing `*/` is refused | `a stamped build reproduces byte exactly...` |
| `--keep-comments` puts legal comments on chain and still reproduces | `--keep-comments puts legal comments on chain and still reproduces` |
| A hand-minified candidate earns `behaviorally-verified` with per-vector evidence digests, and never claims a rebuild | `a hand-minified candidate earns behaviorally-verified and never more` |
| A behavior-breaking candidate is rejected and leaves no receipt; a module without vectors cannot be behaviorally verified at all | `a behavior-breaking candidate is rejected...`, `a module with no vectors...` |
| All 11 published modules build reproducibly and all 65 vectors pass on the readable source AND on the shipped minified bytes | `every vector passes on the readable source and on the shipped minified bytes` |
| Re-indexing the workspace reproduces the committed catalog byte for byte | `indexing the workspace reproduces the committed catalog` |
| Verified and deployed are independent: a module is verified with an empty deployments list | `the receipt chain recomputes link by link` (link 7) and the site's loader tests |
| A stranger with only the GitHub path and commit rebuilds the exact published output digest | `a stranger with only the GitHub path reproduces the published on-chain bytes` |
| The wrap flow embeds the shell, resolves aliases only from the embedded graph, reaches no URL, and returns a review-only plan | `wrapInVerificationShell returns a self-contained document and a review-only plan` |

## The tamper drills

Each of these is an attack on the chain, and each is detected:

| Drill | Detected by |
| --- | --- |
| (a) Flip one byte of readable source after building, inside a doc comment the minifier strips, so the on-chain bytes do not move | `input changed: src/index.ts`, verdict `source-changed`; the rebuilt output digest is unchanged, which is what makes this the sharp case |
| (b) Flip one byte of the shipped `dist` bytes | recomputed sha256 no longer matches `recipe.output` or `receipt.output`; `keel module plan` refuses; `keel module index` refuses |
| (c) Edit what the recipe records about the build | the recipe digest moves, so it no longer equals `receipt.buildRecipeDigest`; when the edited option also changes bytes, the rebuild reports `output-differs` as well |
| (d) Swap the stamp file | `input changed: stamp.txt`, verdict `source-changed` |
| (e) Hand-edit `catalog.json` to mark an unverified entry verified | the site's catalog parser drops the row (`keel-site`, `apps/studio/tests/unit/verified-module-catalog.test.ts`) |

Drill (e) is the site's half of the story. `verified` is a boolean in a file
anyone with commit access can edit, so `parseVerifiedModuleCatalog` refuses to
carry a row whose `verified` flag its own `disposition` does not support, and
`moduleAssurance` derives what the page may claim rather than trusting the
flag. A `behaviorally-verified` module renders with its own honest label and
never with the VERIFIED badge.

## Verified before on chain

Verification is a statement about bytes: this readable source rebuilds into
exactly these minified bytes. It is earned on a laptop, before any chain is
involved, and it does not expire when nothing is ever published. So the
catalog records the two facts separately and never derives one from the other:

- `verified` comes from the receipt disposition, and from nothing else.
- `deployments` lists every revision that HAS reached a chain, each pinning the
  KeelHold instance and object id it lives in plus the `outputDigest` tying it
  back to the bytes a receipt verified. `deployed` is just whether that list is
  non-empty.

An empty `deployments` list on a verified module is the normal starting state,
not a defect, and the site renders it as "Verified / Not deployed" rather than
treating the pair as a contradiction.

## Known limits

These are true of the pipeline as it stands, and worth knowing before quoting
any of the above as stronger than it is.

- **The catalog is only as reproducible as its inputs are committed.** Every
  field is derived from a committed file, and nothing is read from a clock or
  an mtime, so `keel module index` on a clean checkout is a no-op diff. That is
  a property worth re-checking whenever a field is added: an earlier version
  took `builtAt` from the receipt file's mtime, which quietly made the whole
  document unreproducible.
- **Deployment records are asserted, not proven.** A `deployments/<chainId>.json`
  entry says a revision is at an address; nothing in this pipeline reads the
  chain to confirm it. The `outputDigest` in the record makes the claim
  checkable by anyone with an RPC endpoint, but the check is not run here.
- **`verifyKeelBuildRecipe` answers a narrow question.** It rebuilds using the
  recipe's own options, so it reports whether a recipe reproduces its own
  declared output, not whether the recipe is the one a receipt committed to.
  The binding that catches an edited recipe is `receipt.buildRecipeDigest`.
  Verify a receipt, not a recipe alone.
- **`behaviorally-verified` is only as good as the vectors.** It witnesses the
  behaviors somebody wrote down. A byte proof covers every byte. The trust
  order is `exact-source-output` and `reproducible-build`, then
  `behaviorally-verified`, then `queued`.
- **The GitHub half of the reproduction test skips when the archive cannot be
  fetched**, and when the local `keel-modules` checkout has uncommitted
  changes (its catalog would then not be what GitHub serves). A fetch that
  succeeds and then disagrees is always a hard failure, never a skip.
