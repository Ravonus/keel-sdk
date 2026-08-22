# The Keel verification shell (the "stamp")

Every published Keel build is wrapped in one canonical on-chain HTML
verification shell: the seal button in the bottom-left corner (green or red by
verification state) that opens a tabbed overlay of proof data. People call it
"the stamp", "the Keel button", "the wrapper", or "the verifier" — it is
one system, and this page is the map that was previously missing.

## Naming disambiguation

| When someone says… | They mean | Lives in |
| --- | --- | --- |
| the stamp / the Keel button / the seal | The in-artifact verification shell UI | shell sources below |
| the wrapper | The on-chain HTML file that goes around every build (the shell is inside it) | built by the viewer builders below |
| the native stamp / `stampNative` | A stored receipt in the attested-anchor registry (not UI, adds no verification for same-chain bytes) | `docs/KEEL_ATTESTED_ANCHORS.md`, "Native stamps" |
| the proof modal in Studio | The React host chrome around embedded viewers — NOT the canonical shell | `apps/studio/src/components/artifacts/artifact-viewer.tsx` |

## File map

- **Presentation protocol** (seal glyph/shape/motion, tab pages, typed data
  panels): `packages/protocol/src/keel-verification-presentation.ts`
  (`keel-verification-presentation@1`). Panel types: `overview`, `checks`,
  `storage`, `resources`, `identity`, `commitments`, `object-trail`,
  `staking`, `contract-facets`. Presentation can rearrange proof data but can
  never add proof claims or change check results.
- **Shell sources** (markup, rendering, verification logic):
  `examples/demos/vault-arcade/generated-attribute-proxy/vault-keel-viewer.html`,
  `vault-keel-viewer.js`, and `vault-verification.js`. Landmarks:
  `id="verify-seal"`, `id="verify-panel"`, `data-keel-seal="stamp"`, and
  the `keel-verification-presentation` JSON script tag that themes it.
- **Builders** (bundle the shell byte-identically for every carrier):
  `packages/sdk/src/verification-shell.ts` (`buildStandaloneKeelViewer`,
  `buildEmbeddedKeelViewerShell`, and the one-call
  `wrapInVerificationShell`; `apps/studio/scripts/keel-viewer-builder.ts`
  re-exports it so there is one implementation) and
  `apps/studio/scripts/vault-keel-viewer-bundle.ts`
  (`buildVaultKeelViewer`). Ethereum and Tezos carriers must ship the
  exact same shell bytes — `tests/keel-verification-shell.test.mjs`
  enforces it, and `tests/studio-core.test.mjs` enforces that ordinary
  creator modules never embed a duplicate shell.
- **Data injection** (how verified chain facts reach the shell's tables):
  `packages/viewer/src/keel-adapter.ts` — manifest-declared
  `keel-injection@1` fields resolve through pinned-block reads and land in
  the frozen `__OCA_CONTEXT__` global the shell renders. This includes
  `character.attestedAnchors` (cross-chain anchor rows in the
  "Keel object trail" panel, read from the attested-anchor registry's
  `objectAnchoredChains`; requires a `keel.attestedAnchorRegistry`
  address in the manifest extension).

## On-chain wrapper reconstruction (one call, any chain)

The wrapper is committed content, so each chain can rebuild it from its own
storage with no gateway:

- **Ethereum** — `packages/contracts/src/modules/keel-harness/KeelHarnessBuilder.sol`:
  `harnessHTML(objectId, expectedDigest)` returns the exact committed wrapper
  (fail-closed: a broken object returns a self-contained failure document,
  never substitute bytes); `harnessHTMLWithContext(...)` prepends an
  integrity-bound context script that sets `__OCA_CONTEXT__` plus the
  `__KEEL_ONCHAIN_CONTEXT__` envelope (json, sha256 digest, byteLength);
  `harnessDataURI*` wrap either as `data:` URIs.
- **Tezos** — `packages/tezos/contracts/keel_immutable_checkpoint.py`:
  `viewer_html(object_id)` and `viewer_html_with_context(object_id,
  context_json)` are the twins of the EVM lanes, sharing one internal
  reconstruction path with `read_immutable_object`. Same media gate (sealed,
  uncompressed `text/html` only), same fail-closed failure document, same
  injected globals — hex embedding replaces base64 because the encoder lives
  in Michelson. Covered by
  `packages/tezos/tests/test_keel_immutable_checkpoint.py`, which checks
  the injected document byte-for-byte against a Python reference.

## The wrapper is a forced verifier

Any system can build this around any content, and that is the point: the
verifier IS the entrypoint. A browser cannot display the work without
executing the wrapper, and the wrapper hash-checks its complete committed
resource graph before mounting anything — so rendering and verifying are the
same act, and the person looking at it does nothing. There is no separate
"verify" step to skip, and failure is unmissable: bad bytes produce the
failure document, never a silent fallback.

The one boundary condition: this guarantee holds when the wrapper bytes
themselves come from the chain. That is exactly what the one-call builders
provide — `harnessHTML` / `viewer_html` return the committed verifier itself,
so a marketplace, gallery, or any downstream system that loads through them
(or checks the wrapper's digest) is serving the honest verifier by
construction. A host that serves tampered wrapper bytes from its own storage
is outside the guarantee — which is why the builders exist.

## What verification actually is here

The shell never trusts a server: bytes are content-addressed, so the same
check runs at three audiences — the viewer hashes what it renders (the badge
a human sees), contracts re-run the linkage inside the EVM/Michelson when
state changes, and the attested-anchor registry stores verdicts so other
contracts and chains can query them (`isChainAnchored`,
`objectAnchoredChains`) without re-checking. A fully on-chain build is
verified by construction; stamps and anchors are receipts about *where else*
those exact bytes live.
