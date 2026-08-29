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
- **Canonical default shell** (markup, rendering, verification logic):
  `packages/sdk/src/verification-shell.ts`, specifically
  `buildCompactInlineKeelShell`. Its stable landmarks are
  `id="keel-verify-stamp"`, `id="keel-verify-panel"`, and the frozen
  `__KEEL_SHELL_API__`. The K control belongs to the outer shell; creator code
  runs in an opaque child frame and cannot replace it. Vault Arcade is a demo
  presentation and regression fixture, not a source agents copy into projects.
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
  the frozen `__KEEL_CONTEXT__` global the shell renders. This includes
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
  integrity-bound context script that sets `__KEEL_CONTEXT__` plus the
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

## Ethereum shell registry

`KeelHarnessBuilder` also exposes a registry for reusable presentation shells.
A shell is exactly one immutable top object plus one immutable bottom object;
the ordered work/module graph is inserted between them. The shell is not an
uploaded `index.html`, and ordinary project agents do not author one:

- `INLINE_PROTECTION_SHELL_ID()` is the stable canonical composable shell ID.
  It uses `PreEncodedGraph`: registered top, any ordered shared modules and
  creator work, then registered bottom. `registeredPreEncodedTokenURI(...)`
  checks those exact graph boundaries and copies the already encoded graph.
  It does not rebuild or Base64-encode the p5 runtime, shell, or creator work.
- `PROTECTION_SHELL_ID()` keeps the older complete-document protection wrapper
  separate. Its three-argument `shellDataURI` overload remains compatible for
  advanced callers, but it is not the canonical Inline graph assembler.
- `setShell(shellId, prefixObjectId, suffixObjectId, payloadMode,
  metadataObjectId)` registers or replaces a platform shell plus the committed
  catalogue manifest needed for creator/tag search. `SandboxedHTML` carries a
  complete document in an isolated frame; `GzipBase64` carries a gzip object;
  `PreEncodedGraph` is the composable top/graph/bottom path. Only the builder
  keeper can change platform registrations.
- `shellDataURI(shellId, artifactObjectId, artifactDigest, contextJSON)` selects
  an explicit shell. A non-protection shell is presentation only and must not
  display the Keel seal or imply verification.
- `setProtector(prefix, suffix)` remains compatible and updates the registry
  entry identified by `PROTECTION_SHELL_ID`.
- `registerShell(salt, prefix, suffix, payloadMode, metadataObjectId)` lets any
  creator register an immutable, creator-namespaced shell version. The JSON
  metadata object carries its name, description, version, creator, and tags;
  `ShellRegistered` exposes creator, metadata object, metadata digest, and both
  fragment IDs so an indexer can catalogue shells exactly like artifacts.
- A creator shell can never overwrite the default KEEL protection shell or an
  older creator version. A new version uses a new salt and keeps prior receipts
  stable.

The SDK exports `keelShellId`, `keelCreatorShellId`,
`createKeelShellManifest`, `buildKeelCreatorShellRegistrationCall`,
`buildKeelShellRegistrationCall`, `buildKeelShellDataURICall`, and
`buildKeelRegisteredPreEncodedTokenURICall`. The MCP
equivalent is `keel-shell-prepare`. Registration builders remain review-only:
they do not sign or submit a transaction.

## Protected K and extension API

The default shell keeps the work hidden until every resource length and
SHA-256 commitment matches. Success turns the lower-left K green; failure turns
it red, opens the explanation, and never mounts the work. Clicking K opens the
resource commitments, collector context, and declared extension panels.

`__KEEL_SHELL_API__` is a frozen, non-configurable, data-only surface with the
protocol `keel-shell-plugin@1`. It exposes read-only verification, resource,
and bounded plain-text extension data. It exposes no wallet, DOM, or proof-state
mutation authority. Creator code runs in an iframe without `allow-same-origin`,
and the child CSP denies network, forms, frames, and objects, so code placed
after the shell cannot change the K, the proof result, or the outer panel.

## The wrapper is a forced verifier

This section applies to the protection shell, not arbitrary registry shells.
Any system can build the protection shell around any content, and that is the point: the
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
