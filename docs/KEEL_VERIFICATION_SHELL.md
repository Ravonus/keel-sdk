# The Keel verification shell (the "stamp")

Every default collector-facing Keel viewer is wrapped in one canonical on-chain
HTML verification shell: the seal button in the bottom-left corner (green or
red by verification state) that opens a tabbed proof surface. A creator can
explicitly select another compatible registered shell or publish an artifact
without a viewer, but an agent must never silently manufacture a replacement.
People call it
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
- **Canonical default shell chrome** (the one K stamp, tabbed panel, rendering,
  and verification UI): `packages/viewer/src/keel-verification-chrome.js`.
  Its stable landmarks are `id="verify-seal"`, `id="verify-panel"`, and
  `.verify-page-nav`. `buildCompactInlineKeelShell` is only the chain-registry
  bootstrap builder that bundles this exact module with the graph verifier; it
  is not a second shell and agents never copy its output into a project. The
  frozen `__KEEL_SHELL_API__` belongs to the outer shell; creator code runs in
  an opaque child frame and cannot replace it. Vault Arcade and Ghost Flash are
  regression presentations of this canonical module, not sources agents copy
  into projects.

## Collector interaction

The canonical default is the collector-friendly Stratus prototype promoted to
one reusable KEEL module, not a simplified replacement:

- the protected K stamp rests at the lower left and reveals on pointer intent;
- desktop opens a full-height panel on the right and resizes the verified art
  stage so the work remains completely visible rather than being covered or
  clipped;
- narrow/mobile viewports open the same proof surface as a bottom sheet with a
  visible drag handle;
- Proof, Files, and Trail are views over the same immutable verification result,
  not independent sources of truth;
- creator work remains in the opaque inner sandbox while the K, proof result,
  data tables, and extension boundary remain in the protected outer shell.

`packages/viewer/src/keel-verification-chrome.js` is the only source for these
behaviors. Compact Inline and standalone viewer builders both import it. Demo
projects may exercise the module but never define or fork the default.
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

- `KEEL_INLINE_PROTECTION_SHELL_ID` is the stable canonical composable shell ID
  derived by the SDK from `keel.shell.inline-protection@1`. Current builders may
  expose the same value through `INLINE_PROTECTION_SHELL_ID()`, but that
  convenience getter is not a readiness gate. The selected-chain Studio catalog
  and the exact `shells(shellId)` registration are authoritative.
  It uses `PreEncodedGraph`: registered top, any ordered shared modules and
  creator work, then registered bottom. `registeredPreEncodedTokenURI(...)`
  checks those exact graph boundaries and copies the already encoded graph.
  It does not rebuild or Base64-encode the p5 runtime, shell, or creator work.
  Resolve its builder from the selected-chain Studio Inline catalog, require
  that address to be Studio's active `keel-harness-builder`, and verify the
  exact `shells(shellId)` record. An old deployment journal is a receipt, not
  active configuration.
- `PROTECTION_SHELL_ID()` keeps the older complete-document protection wrapper
  separate. Its three-argument `shellDataURI` overload remains compatible for
  advanced callers, but it is not the canonical Inline graph assembler. Current
  builders store this route only in `shells(PROTECTION_SHELL_ID)`: duplicate
  `protectorPrefix()` / `protectorSuffix()` state and `NoProtector` were removed.
  Historic deployments may still expose those getters and the old
  `protectedHarnessDataURI(...)` alias. Current builders use the registered
  shell entrypoints only. Historic state must never disable Inline or cause an
  agent to create a local replacement shell.
- `setShell(shellId, prefixObjectId, suffixObjectId, payloadMode,
  metadataObjectId)` registers or replaces a platform shell plus the committed
  catalogue manifest needed for creator/tag search. `SandboxedHTML` carries a
  complete document in an isolated frame; `GzipBase64` carries a gzip object;
  `PreEncodedGraph` is the composable top/graph/bottom path. Only the builder
  keeper can change platform registrations.
- `shellDataURI(shellId, artifactObjectId, artifactDigest, contextJSON)` selects
  an explicit shell. A non-protection shell is presentation only and must not
  display the Keel seal or imply verification.
- Update the older complete-document route through
  `setShell(PROTECTION_SHELL_ID, prefix, suffix)`; current builders do not keep
  a second `setProtector` mutation path.
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

## Shell choice never replaces the artifact

Presentation and storage are separate axes. The SDK, MCP, skill, and Studio
handoff use the registered default KEEL shell when a collector-facing viewer is
requested and no shell was explicitly selected. A creator may explicitly
select any compatible registered shell from the indexed catalogue; ownership
of the shell is not required. No selected shell can overwrite or impersonate
the platform default. The supported raw artifact choice is no shell at all.
None of these presentation choices changes the immutable artifact object.

Every released work keeps a direct artifact descriptor: store, object ID,
digest, byte length, media type, and its `web3://.../haulObject/<objectId>`
URI. A KEEL-aware reader can call `haulObject(bytes32)` and recover the exact
raw image, video, model, script, or other artifact even while the standard
`tokenURI` presents that same work through a shell. Artifact-only therefore
means **no shell**, not “cannot be minted” and not “no contract-readable art.”

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

For a direct image, video, or self-contained GLB entrypoint, the same opaque
child receives a frozen `__KEEL_ENTRY__` descriptor (`id`, name, media type,
digest, byte length, verified data URL) plus the read-only `__KEEL_CONTENT__`
resource descriptors. The registered `keel.asset-display@1` module self-mounts
that direct entry. AVIF and WebP images mount through an intrinsic-size canvas,
which gives collectors a browser-native PNG save surface. The short child document is synthesized only in memory by
the verified shell; it is not a creator-uploaded `index.html`, custom shell, or
wallet-capable runtime.

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
