# Keel Trusted Runtime — Current-State Inventory & Gap Map

Status: inventory produced before any hardening code. Goal of the effort: let a
gallery/marketplace integrate the Keel runtime **once** and trust that
application code beneath it cannot exceed the authority declared through
manifests, modules, host policy, and on-chain verification.

Guiding rule for the work that follows: **HARDEN / EXTEND / GENERALIZE / REUSE**
over REWRITE / REPLACE / DUPLICATE. Almost every needed primitive already
exists; the missing layer is generalization, wiring, and a handful of targeted
hardening fixes — not new systems.

All line references are to the working tree at inventory time.

---

## 1. The one-paragraph finding

Keel already implements the hard parts of a trusted runtime: an opaque
unique-origin iframe with deny-by-default CSP and no injected provider
(`packages/viewer/src/sandbox.ts`), a verified-only content gateway
(`gateway.ts`), a symbolic wallet-intent model where creator code never
constructs calldata (`plugin-adapter.ts`, `KeelPluginWalletIntent`), and an
on-chain trust lattice for plugins (`KeelGraphRegistry` +
`KeelPluginRegistry`, live-deployed on Sepolia). The gaps are that these
strong mechanisms are **special-cased to one plugin (`keel.market`) and one
protocol path**, the **host↔frame message bridge is unspecified and unguarded**
(no size caps, no operation-authority model, `postMessage(..., "*")`
everywhere, one blind bidirectional relay), the **"trusted outer runtime +
restricted inner app" layering is described but not built** (the core viewer is
single-frame; the one real two-layer instance adds zero mediation), and several
**app surfaces bypass the sandbox entirely** (bare/`allow-same-origin` iframes).
"CODE ≠ AUTHORITY" holds for wallet and network today; it does not yet hold for
the message bridge or for the app-embedding surfaces.

---

## 2. Component map (KEEP / HARDEN / EXTEND / MERGE / NEW)

### Runtime / sandbox

| Component | Where | What it does today | Authority | Class |
|---|---|---|---|---|
| `createSandboxDocument` | `packages/viewer/src/sandbox.ts:770` | Pure string builder: sandbox tokens, CSP, Permissions-Policy, frozen `__OCA_RUNTIME__/__OCA_CONTENT__/__KEEL__`, replay determinism, `fetch`/XHR/WebSocket/nav/form denial | none (emits string) | **KEEP** (strong) |
| `mountArtifact` | `packages/viewer/src/mount.ts:4` | Creates the one iframe: `srcdoc` (opaque origin), `sandbox`, `allow`, `csp` attr, `credentialless` | sole iframe factory | **HARDEN** (add bridge; Chromium-only attrs) |
| Content gateway | `gateway.ts:108` | Deny-by-default route table; refuses registry-trust without proof | routing only | **KEEP** |
| Electron egress guard | `egress.ts:49` | Blanket network cancel — Electron only | full deny | **KEEP** (web equivalent is deploy guidance) |
| Sandbox SDK | `packages/sandbox-sdk/src` | Same `createSandboxDocument` from a file tree; CLI | none | **KEEP** (fix `--out` top-level doc caveat) |
| `RuntimeCapabilities` | `packages/protocol/src/types.ts:370` | `downloads/pointerLock/fullscreen/clipboardWrite/gamepad/audioAutoplay/webAssembly` | manifest-declared browser caps | **EXTEND** (no host/bridge/wallet capability dimension) |

### Host ↔ frame bridge

| Component | Where | What it does today | Class |
|---|---|---|---|
| `parseKeelPluginFrameMessage` | `plugin-bridge.ts:28` | Only real schema gate: exact-keys, session hex, `intentId` regex, field length caps — **hard-coded to `plugin==="keel-market"` and `^market\.`** | **GENERALIZE** |
| `keel-viewer-bridge.ts` | `packages/protocol/src/keel-viewer-bridge.ts` | Typed `oca-viewer-verification@1` presentation shapes — **no length/range/key-count caps** | **HARDEN** |
| Verification chrome ("the stamp") | `keel-verification-chrome.js:502` | In-frame UI; only frame-side handler that checks `event.source` | **KEEP** |
| `transitionViewerVerificationHost` | `verification-state.ts:22` | Only replay/dup defense in any bridge (dup `mounted`/`ready` → fail) | **EXTEND** (generalize the discipline) |
| vault-runner presentation relay | `apps/vault-runner/.../presentation/character/[tokenId]/route.ts:11` | **Blind bidirectional relay**: no protocol/schema/size/origin filter | **HARDEN** (this is the real 2-layer seam) |

There are four postMessage protocols (`oca-viewer-verification@1`,
`keel-*wallet*@1`, `oca-thumbnail-capture@1`, `oca-viewer-command@1`). **All
use `targetOrigin:"*"`; no handler checks `event.origin`; `MessageChannel`/
`MessagePort` are used nowhere.** Sender-window checks exist in most host
handlers but not in `sandbox.ts:711` or the vault-runner relay. No size cap or
operation-authority model exists anywhere.

### Wallet

| Component | Where | Class |
|---|---|---|
| `KeelPluginWalletIntent` (symbolic intents, digest-committed, on-chain `permissionsDigest`) | `types.ts:317`, `plugin-adapter.ts:354` | **KEEP + EXTEND** (only enforced capability model in the repo; make generic beyond `keel.market`) |
| `resolveKeelContractPlugin` (graph+manifest+bytes+registry+live-code at one pinned block; `walletAuthorized()` re-derived) | `plugin-adapter.ts:295` | **KEEP** (deepest gate) |
| `HOST_INTENT_BINDINGS` + `switch` on 8 literal intent IDs | `apps/studio/src/lib/keel-plugin-client.ts:491` | **GENERALIZE** (manifest-declared intents are cross-checked, not the driver) |
| `keel-wallet-request@1` (single request) | `packages/sdk/src/wallet-request.ts` | **HARDEN** (`to`+`data`+`valueWei` arbitrary — no selector/value restriction) |
| `keel-wallet-intent@1` (batch, SDK) | `packages/sdk/src/wallet-intent.ts:10` | **HARDEN** (protocol string collides with the bridge envelope) |
| `wallet-link@1`, `typed-data.ts`, ethereum-adapter executor | `packages/sdk`, `packages/ethereum-adapter` | **KEEP** (strong: value pinned `0`, ABI pinned, receipt re-verified) |

Confirmed: **sandboxed artifact code has zero wallet access** — no provider,
`connect-src 'none'`, e2e asserts `globalThis.ethereum === undefined`. The only
artifact→wallet channel is a symbolic session-bound intent ID the host turns
into calldata itself.

### API systems

| System | Where | State | Class |
|---|---|---|---|
| Live / manifested API snapshot (`UpdateKind.ApiSnapshot`) | `KeelPresentationStateRegistry.sol`, `keel-adapter.ts:1725` | Oracle-published, digest-committed snapshots spliced into the manifest as inline resources | **EXTEND / WIRE** |
| Manifest network posture | `types.ts` sources + `parse.ts:409,421` | `capabilities.network` and `networkAllowlist` **rejected by design**; only hashed URI/onchain/contract-call sources | **KEEP** |
| Frozen dataset (`keel-frozen-dataset@1`) | `packages/{sdk,protocol,viewer}/src/frozen-dataset.ts` | Per-chunk SHA-256 + byteLength + slot-binding + canonical re-encode equality | **HARDEN + WIRE** |

Both API paths terminate in verified bytes materialized into the iframe before
it runs; **no dynamic network is reachable from inside the sandbox**.

### On-chain trust

| Contract | Where | Role | Class |
|---|---|---|---|
| `KeelGraphRegistry` | `packages/contracts/src/modules/keel-graph/KeelGraphRegistry.sol` | Append-only publisher + version + manifest/resource digests + monotonic storage tier; `GraphKind.{ContractPlugin,Library,…}` | **KEEP** |
| `KeelPluginRegistry` | `…/KeelPluginRegistry.sol` | Code hash + interface constants + review lifecycle (`Unvetted→Sanctioned→Deprecated→Revoked`); `walletAuthorized()` re-derives live bindings | **KEEP** (fix Sepolia admin=approver=deployer EOA) |
| `KeelLibraryRegistry` | `…/KeelLibraryRegistry.sol` | `AssetKind.CreationModule`; access modes; binds `GraphKind.Library` | **KEEP** |
| `keel-module-catalog@1` | `packages/protocol/src/keel-hold.ts:120` | Non-contract module identity (namespace+name+version+entry+sha256) — **JSON file on disk, not on-chain** | **NEW/EXTEND** (only genuine on-chain gap for "trusted modules") |

---

## 3. Trust-gap summary (ranked)

**G1 — Bridge has no security contract.** No message-size cap anywhere; no
per-operation authority declaration; `targetOrigin:"*"` and missing
`event.source` checks in two spots; `keel-viewer-bridge.ts` validates types
but not bounds; only one protocol has replay/dup defense. `docs/SECURITY.md:37`
already states the requirement ("validate sender window, expected protocol,
message schema, size, and allowed operation") — size and allowed-operation are
unmet. **Highest leverage, most contained fix.**

**G2 — The two-layer model is documented but not built.** Core viewer is a
single frame; the only production two-layer instance
(`vault-runner/.../presentation/character/[tokenId]/route.ts:11`) is a blind
relay. This is exactly the "trusted outer runtime + restricted inner app" seam
the goal needs, currently adding zero mediation.

**G3 — Sandbox bypasses in app code.** Extension grants `allow-same-origin` on
objkt.com (`content.js:56`); Studio renders remote `animationUrl` in a bare
iframe (`keel-object-room.tsx:242`); vault-runner play/maps/preview iframes
have no `sandbox` (`play-screen.tsx`, `maps-screen.tsx`, `generative-visuals.tsx`).
Some are dev affordances; each needs a decision, not a blind edit.

**G4 — Wallet/host capability model is single-plugin.** The enforced,
digest+on-chain capability model works only for `keel.market` via a
hard-coded host binding table and `plugin==="keel-market"` bridge check.
Generalizing it (manifest-driven bindings, generic plugin IDs) is the path to
"marketplace declares ALLOW/DENY and the app can only narrow."

**G5 — No effective-capability intersection.** The goal's
`app ∩ manifest ∩ module ∩ host = effective` model has no host-policy object and
no intersection enforcement point yet.

**G6 — API/frozen wiring & hardening.** `ApiSnapshot` is rejected by the
viewer's state binding (hard-requires `TypedState`) and cannot be sealed
on-chain; the "API source manifest" format is only a `bytes32` (undefined
shape); frozen datasets are unwired (no gateway route, no sandbox surface) and
lack manifest anchor-verification in the query path plus chunk-count/size gates.

**G7 — On-chain module registration for non-contract modules.** Trusted-module
identity for JS/WASM modules lives in an off-chain JSON catalog; there is no
single on-chain record binding publisher + code hash + version + manifest with
revocation for a non-contract module.

**G8 — Runtime benchmarking absent.** Gas benchmarking is strict
(`forge snapshot --check` + policy scan). There is no hashing-throughput,
chunk-verification, or sandbox-startup benchmark — required to prove the added
layer is practical.

**G9 — Operational.** Complete Sepolia address record is gitignored;
`KeelPluginRegistry` admin and approver are both the deployer EOA.

---

## 4. Smallest useful extension (proposed phase order)

Maps to the brief's STEP 3→11. Each phase is one coherent, reviewable unit; the
security reviewer attacks at the phase boundary.

1. **Bridge security contract (G1).** A single typed host-side bridge in
   `@keel/viewer`: origin/sender validation, exact-key + bounded schemas,
   hard byte-size cap, per-protocol dedup/sequence, and a declared
   **allowed-operation** set. Generalize `plugin-bridge.ts` and
   `keel-viewer-bridge.ts` under it; keep `parseKeelPluginFrameMessage`'s
   fail-closed discipline. Replace `"*"` where a concrete target is knowable.
2. **Host-policy + effective-capability object (G4/G5).** A manifest/host-policy
   type expressing marketplace ALLOW/DENY, with an intersection function
   (`app ∩ manifest ∩ module ∩ host`) enforced at the bridge and the wallet gate.
   Drive the wallet bindings from the manifest intent table instead of the
   hard-coded host `switch`.
3. **Mediating outer runtime (G2).** Replace the blind relay with the bridge
   from phase 1, making the outer document the real capability-enforcement layer
   over the restricted inner app.
4. **API/frozen wiring & hardening (G6)** — only the genuinely missing pieces.
5. **On-chain module record (G7)** — extend the existing registries; do not
   fork a new trust standard.
6. **Sepolia flows + gas + runtime benchmarks (G8)**; fix operational items
   (G9).

Adversarial test app + marketplace demo are built alongside phases 1–3 to prove
each boundary rejects undeclared behavior while declared operations keep working.

---

## 4a. Phase 1 status — host-bridge security contract (DONE, reviewed)

Built `packages/viewer/src/host-bridge.ts` (exported from the package;
gated in `scripts/verify.mjs`; tested by `tests/host-bridge.test.mjs`, 20 cases;
existing 40-case viewer suite still green). It is a reusable, declarative,
fail-closed bridge providing every control `docs/SECURITY.md:37` requires:
sender-window pinning, origin policy, exact-key bounded schema, byte/depth/
key-count caps with single-pass early-exit, prototype-pollution defense, an
explicit allowed-operation authority model (`code != authority`), and
host-controlled session registration with strictly-increasing sequences.

Security review (Agent 2) ran against the first draft and found two real HIGH
issues, both now fixed and regression-tested:
- **Source pinning was optional** under an opaque-origin policy (any co-embedded
  `null`-origin frame could forge messages). Fixed: opaque policies now
  hard-require an expected source window (`bad-source` if absent).
- **Replay floor was resettable** by flooding the LRU session table to evict a
  victim and reset its sequence. Fixed: replaced LRU-reset with host-controlled
  `registerSession`; unregistered sessions are rejected outright and never enter
  the table, so attacker sessions cannot evict a victim's floor.
Also fixed: opaque policy no longer treats a missing origin as valid; session
values are format-checked; the replay map key is a structured (collision-safe)
tuple; caller-supplied stateful (`g`/`y`) regexes are made pure; the byte-cap's
purpose is documented honestly (bounds validation/forwarding cost, not inbound
peak memory — that is a transport/deployment concern).

## 4b. Phase 2 status — wiring host-bridge into live seams (DONE, reviewed)

Security review (Agent 2) ran against 2a/2b; all findings fixed and tested:
- Relay size cap was bypassable with binary clonables (`JSON.stringify(ArrayBuffer)`
  is a few bytes while the clone is huge). Fixed: the relay now re-serializes
  through JSON and forwards the parsed copy, which bounds true clone cost and
  strips binary/exotic values and prototype-pollution shapes.
- `preview-ready` was silently rejected (the producer sends an extra `state`
  field vs an empty schema). Fixed: `state` is an accepted optional field.
- The presentation policy used `origin:"any"` for a frame that is actually
  opaque (sandboxed without `allow-same-origin`). Fixed to `origin:"opaque"`,
  which pins `origin==="null"` and forces an expected source window.
- Relay parent-direction `targetOrigin` now prefers the real embedder origin,
  falling back to the document's own origin before ever using `"*"`.
- `maxBytes` raised so the declared field bounds are actually reachable.


- **2a presentation seam (DONE):** `packages/viewer/src/presentation-bridge.ts`
  is a bounded, source-pinned validator for `oca-viewer-verification@1`
  presentation messages, built on host-bridge. `apps/vault-runner`
  `gallery-presentation.tsx` now routes through it, replacing the unbounded
  type-only `isKeelViewerPresentationState` path that fed an
  attacker-controllable `weapon.build` map and arbitrary strings into React
  state. 8 tests.
- **2b vault-runner relay (DONE):** the blind bidirectional relay in
  `.../presentation/character/[tokenId]/route.ts` now forwards only plain
  objects carrying a string `protocol` under a 32 KiB cap, and targets the real
  ancestor origin toward the host instead of `"*"`. Downstream ends still do
  full schema validation (host-bridge on the host, the frame's guards inside).
- **2c `plugin-bridge.ts` (intentionally unchanged):** already embodies the
  host-bridge discipline (exact-keys, regex-bound session/intentId, capped
  proposal, fail-closed) and is pinned by market e2e tests. It predates and
  inspired host-bridge. Unifying it onto the shared engine would need
  regex-operation support and risks a proven wallet path for only cosmetic gain;
  left as the reference implementation, tracked as optional future cleanup.

## 4c. Phase 3 status — effective-capability intersection (algebra DONE)

`packages/viewer/src/capability-policy.ts` implements the brief's
`effective = app ∩ manifest ∩ module ∩ host` model as a token algebra:
`effective = (⋂ allow_i) \ (⋃ deny_i)` over namespaced capability tokens
(`browser.webAssembly`, `wallet.market.bid`, `host.openListing`,
`network.manifested`, …). This structurally guarantees the two properties a
marketplace needs — **monotonicity** (a lower layer can only narrow, never widen
above the host ceiling) and **deny-wins** — both test-covered. Layers may defer
with `allow:"*"` and match namespaces with `wallet.*`; `explain(token)` reports
which layer blocked a capability. Mappers connect the effective set to concrete
enforcement: `effectiveRuntimeCapabilities` (sandbox browser caps),
`allowedWalletIntents`, and `allowedHostOperations` (bridge gating).
`manifestCapabilityLayer` derives a manifest's layer from its
`RuntimeCapabilities` + declared wallet intents + network posture. 12 tests.

Phase 3b (sandbox clamp, DONE): `createSandboxDocument` now accepts a
`capabilityCeiling` (`SandboxOptions`); each browser capability is enabled only
if the manifest declares it AND the ceiling allows it — a host narrows, never
widens. Pair with `effectiveRuntimeCapabilities(effective)`. Backward-compatible
(no ceiling → unchanged), and it never touches the `__KEEL__`/`__OCA_CONTENT__`
composition path — a test asserts both the clamp and that the content API is
still injected. The wallet-intent narrowing primitive is done too: `narrowWalletOperations` /
`narrowHostOperations` / `narrowOperationsByCapability` filter a bridge's declared
operations (or a plugin's resolved intent table) by the effective set. They are
additive-only — they can remove a host-forbidden intent but never introduce one
the verified plugin manifest did not declare — so the adapter's selector/target/
ABI verification stays the hard gate and host policy is a further restriction on
top, exactly as the Phase 3a review required. Remaining adoption step (studio):
call `narrowWalletOperations` where the market bridge builds its accepted intents,
threading a host-policy layer — a small, explicit change to the live market path,
best done with the market e2e suite runnable.

## 4d. Load-bearing principle — the runtime stays OPTIONAL and dynamic

The trusted runtime must never become mandatory or static. Two invariants this
effort preserves and treats as first-class:

1. **Optional.** Conventional ERC-721 consumers keep plain `tokenURI`
   image/animation (`docs/ARCHITECTURE.md:10,46`); the Keel layer is opt-in
   (`ARCHITECTURE.md:60`). All hardening here (host-bridge, presentation-bridge,
   relay filter, capability policy) only tightens the boundary *when the runtime
   is engaged* — none forces the viewer or blocks conventional access.

2. **Dynamic composition ("keel call").** Any object can be called and built
   directly from chain, and the verifier/viewer can be attached to any object
   *even if the original was not published with one*:
   - Per-object, on-chain: `KeelHarnessBuilder.harnessHTML(objectId,
     expectedDigest)` / `harnessHTMLWithContext(...)` reconstruct an exact object
     (fail-closed) from its own chain storage — no gateway, no server.
   - Dynamic viewer binding, on-chain: `KeelHarnessRegistry.forkHarnessForToken`
     / `effectiveHarness` attach or override a viewer for a token at will.
   - Dynamic wrapping, off-chain: `bindKeelManifest` + `resolveKeelArtifact`
     bind arbitrary Keel registries to a manifest, and `createSandboxDocument`
     wraps *any* resolved content in the sandbox+verifier — content-agnostic, so
     a raw object with no declared viewer can still be mounted under a chosen
     trusted verifier.

   **Capability-gated, not ungoverned.** "Dynamically attach the trusted verifier
   to an arbitrary object" is exactly the kind of powerful operation the Phase 3
   capability model should govern: a host declares it allows it (a `viewer.*` /
   `verifier.*` token family), and the trust registries (`KeelHarnessRegistry`,
   `KeelPluginRegistry`) decide *which* viewers/verifiers are eligible. Dynamic
   stays dynamic; it just can't smuggle in an unverified viewer above host policy.

   Open gap for a later phase: a single atomic on-chain call that composes an
   arbitrary content object with an arbitrary viewer/verifier object (today
   `harnessHTML` takes one object that must already reference its content; the
   free composition is done at the adapter/off-chain layer).

## 4e. Composition model — verified dynamic + hash-locked (per the docs/vision)

Traced end-to-end and confirmed the runtime is built the way the docs specify;
no change needed, and the hardening here does not touch it.

- **Items are built inside the trusted host from a manifest-committed graph.**
  A resource has an ordered `sources` fallback list; `resolver.ts` resolves each
  (inline / onchain / contract-call / uri / composite), and **composite objects
  recursively resolve+concatenate children** (`resolver.ts:323-334`). The
  primary build path is **on-chain recursive object reconstruction from immutable
  bytecode** — `chunk-store.ts:203-270` rebuilds leaf/composite objects from
  `KeelHold` and verifies the decoded digest at every node.
- **Every source is hash-locked.** `validate.ts` requires integrity on all five
  source kinds and rejects `algorithm:"none"`; `resolver.ts` decompresses **then**
  verifies (`:366`→`:373`) before a byte is admitted; the gateway refuses to
  expose any source lacking cryptographic integrity (`gateway.ts:16-22`).
- **"Modules are fetched by URL" is wrong.** A module/object is content-addressed
  by SHA-256 and can advertise **multiple byte-identical carriers**
  (`keel → onchfs → ipfs → https`, on-chain preferred); a URL is one allowed
  carrier for those exact bytes, verified after decompression before exposure
  (`keel-hold.ts`, `module-catalog.ts:143-152`, `module-resolver.ts:417`).
  The creator iframe never fetches: `fetch` is replaced by a verified-only shim,
  `connect-src 'none'`.
- **Dynamism is real but commitment-bounded:** per-token context injection into
  frozen `__OCA_CONTEXT__` (`keel-adapter.ts:1608`, `sandbox.ts:261-274`),
  per-token viewer forks (`KeelHarnessRegistry.forkHarnessForToken/activateFork`,
  which require `KeelIndex.presentationMatches`), and arbitrary
  viewer↔content pairing via `bindKeelManifest` — which renders only when the
  on-chain commitment and the manifest digest agree (`keel-adapter.ts:1670`).
  So any viewer can be pointed at any object even if the object never declared a
  viewer, but nothing mounts above the cryptographic commitment.

The Phase 3 `viewer.dynamicbind` / `verifier.attach` capability tokens sit **on
top of** that registry-commitment gate as an additional host-policy ceiling, not
a replacement for it — dynamic, but governed.

## 4f. Runtime benchmark — the boundary is practically free

`scripts/benchmark-trusted-runtime.mjs` (`pnpm trusted-runtime:benchmark`)
measures the security-critical paths this effort added, against the SHA-256
hashing the system already does per resource (node v22, representative run):

| Path | ns/op | ops/sec |
|---|---|---|
| host-bridge accept (valid wallet intent) | ~1,377 | ~726K |
| host-bridge reject (oversize message) | ~386 | ~2.59M |
| intersectCapabilities (4 layers) | ~2,767 | ~361K |
| validateKeelPresentationMessage | ~1,986 | ~503K |
| sha256 (1 KiB) — guarded work | ~8,419 | ~119K |
| sha256 (64 KiB) — guarded work | ~24,497 | ~41K |

The whole boundary costs single-digit microseconds — a valid bridge validation
is ~18× cheaper than hashing one 64 KiB resource. Two properties worth noting:
rejecting a hostile oversize message (~386 ns) is *faster* than accepting a
valid one, so flooding is cheap to shed (the bounded-scan early-exit working as
designed); and capability intersection at four layers is still sub-3µs, so a
per-mount host-policy computation is negligible.

## 4g. Adversarial boundary proof (executable)

`tests/adversarial-boundary.test.mjs` is the brief's "adversarial sandbox
example" in executable form: a simulated hostile app runs the brief's attack list
against a simulated marketplace host and asserts each fails at the boundary,
while a legitimate declared+permitted bid passes. Covered attacks: forged/
spoofed-source host messages, undeclared intents, smuggled raw
target/selector/calldata/value, excessive-ETH proposals, forged sessions, replay,
prototype pollution, session-flooding to reset a replay floor, blocked browser
permissions (camera/mic), an app widening wallet authority above host policy, and
tampered/oversized frozen presentation data. 14 scenarios; part of the default
`pnpm test` gate. This is the living proof to show a gallery: integrate the
runtime once, and undeclared behavior cannot exceed verified capability.

## 4h. Phase 4 — frozen-dataset hardening

Closed the retrieval-boundary gaps the inventory found in the frozen-dataset
query path (`packages/viewer/src/frozen-dataset.ts`), without weakening its
per-chunk verification:
- `assertKeelFrozenDatasetWithinLimits` bounds an untrusted manifest before
  any chunk is fetched — `maxChunks`, `maxChunkBytes`, `maxTotalBytes`, `maxRows`
  (defaults 4096 / 4 MiB / 256 MiB / 1M). A hostile manifest can no longer force
  an unbounded number of requests or a huge allocation; each chunk's declared
  `integrity.byteLength` is checked against the ceiling up front, and
  `verifyIntegrity` still rejects any chunk whose actual bytes disagree.
- `queryKeelFrozenDataset`/`planKeelFrozenDatasetQuery` now enforce those
  limits (query rejects before fetching any chunk — a test asserts zero loads).
- Optional `expectedManifestIntegrity`: binds the whole dataset to a committed
  digest (`sha256(canonicalJson(manifest))`) before any chunk descriptor is
  trusted, closing the "manifest handed in is trusted blindly" gap. A tampered
  manifest fails the anchor check. Chunk-level SHA-256 + slot-binding + canonical
  re-encode verification are unchanged. 7 tests.

## 4i. Phase 5 — on-chain module trust (revocation gap closed)

A grounded investigation corrected the earlier overstated gap: publisher + hash +
version + manifest for non-contract modules (ES/UMD/CommonJS/classic/WASM) are
**already on-chain** via `KeelGraphRegistry` (`GraphKind.Library/Model/Media`)
and `KeelLibraryRegistry` (`AssetKind.CreationModule`). The *only* missing
piece was a reasoned trust-review status (`closeAsset` is a controller access
kill-switch with no reason; `KeelPluginRegistry`'s real lifecycle is
contract-only). Closed it by reusing that proven pattern, not rebuilding it:

`packages/contracts/src/modules/keel-graph/KeelModuleReviewRegistry.sol` is the non-contract twin
of `KeelPluginRegistry`: the same permissionless submit + separate
`APPROVER_ROLE` review lifecycle (`Unvetted→Sanctioned→Deprecated→Revoked` with
`reasonDigest`/`replacementDigest`), keyed on a module's `(graphId, graphVersion,
manifestDigest, resourceGraphDigest)` and cross-checked against GraphRegistry —
with the contract-target/codehash/delegation checks dropped and a non-contract
graph-kind check (Library/Model/Media/Other, rejecting ContractPlugin) added.
`moduleAuthorized()` re-derives bindings live (a status check alone never
authorizes), exactly like `walletAuthorized()`. Foundry-tested
(`test/KeelModuleReviewRegistry.t.sol`: submit→sanction→deprecate→revoke,
approver-only, one-bit-change can't borrow approval, contract-plugin graph and
digest-mismatch rejected). So a marketplace can now sanction or revoke a JS/WASM
module on-chain, closing the last "trusted modules" gap.

## 4j. Sepolia verification — module trust lifecycle, live on-chain

`KeelModuleReviewRegistry` was deployed to Sepolia and its full lifecycle
exercised end-to-end via `pnpm trusted-runtime:module-registry:sepolia`
(`scripts/deploy-module-review-registry-sepolia.mjs`; reuses the audited
mode-checked key file, hard-guards `chainId === 11155111`, never prints the key).
Evidence: `evidence/keel-trusted-runtime/module-review-registry-sepolia.json`.

- registry deployed at `0x9abb1f929a05e0ddf558aa9f594ec7775e28f8b2`, bound to the
  live GraphRegistry `0x5b86…dca4`.
- createGraph(Library) → submitModule → sanctionModule (→ `moduleAuthorized:true`)
  → revokeModule (→ `moduleAuthorized:false`, status Revoked). All assertions
  passed against real chain state.
- Gas: deploy 1,363,688 · createGraph 259,765 · submitModule 288,638 ·
  sanctionModule 131,256 · revokeModule 65,943 (submit/sanction/revoke are the
  frequently-registered paths and stay cheap). Total run cost ≈ 0.0022 ETH.

## 4k. Studio live wiring + marketplace demo

- **Live market wiring:** `prepareKeelMarketIntent`
  (`apps/studio/src/lib/keel-plugin-client.ts`) now accepts an optional
  `capabilityPolicy` (an `EffectiveCapabilities`) and rejects an intent the host
  policy forbids (`wallet.<intentId>`) before building any transaction. It is
  additive-only — it narrows the verified plugin's declared intent set, never
  widens it — so the adapter's selector/target/ABI verification stays the hard
  gate. The enforcement point is now in the real market path; a marketplace
  passes its policy to clamp a running app end-to-end.
- **Marketplace demo:** `apps/studio/src/components/keel/trusted-runtime-boundary.tsx`
  is a live panel on the real `/keel` page. It renders `effective = app ∩
  manifest ∩ host` with the actual `intersectCapabilities`; toggling capabilities
  (including adversarial ones — camera, unlimited approval, parent navigation)
  shows them stay blocked because the host denied them and the app cannot
  override the ceiling. The visible proof of the same intersection the runtime
  enforces, on the page a gallery would integrate.

## 4l. SDK + MCP surface (agents can do all of this properly)

So the new capabilities are usable through the canonical developer/agent surface,
not just the host runtime:

- **`capability-policy` relocated to `@keel/protocol`.** It is pure algebra with no
  viewer/DOM dependency; living in `@keel/viewer` left it unreachable from
  `@keel/sdk`/`@keel/mcp` (which depend only on protocol). Now any consumer can
  compute `effective = app ∩ manifest ∩ host`. `@keel/viewer` re-exports it, so
  studio and existing tests are unchanged.
- **`@keel/sdk` module-review builder.** `buildKeelModuleReviewRequest` prepares
  a review-only, non-custodial descriptor for submit/sanction/deprecate/revoke
  against `KeelModuleReviewRegistry` (validates spec + digests, maps to the
  registry function + args, integrity over the canonical body — never signs,
  encodes final calldata, or submits). `KEEL_MODULE_REVIEW_REGISTRY_ABI` is
  exported for encoding.
- **`@keel/mcp` `module-review-prepare` tool.** Exposes the builder to agents with
  a bounded schema, review-only, matching the existing wallet-request/wallet-link
  non-custodial pattern. Tool registry now 18 tools.

## 4m. Test suite (unit) and on-chain testnet coverage

**Unit (node --test), all green:**
- host-bridge — `host-bridge.test.mjs` (20: source/origin pinning, bounded
  schema, oversize/depth/dangerous-key, unknown-session, replay, flooding) +
  `host-bridge-transport.test.mjs` (8: same-origin/allowlist/any origin policies,
  number-field range/integer validation, session register/forget/independence,
  the MessageEvent adapter).
- capability-policy — `capability-policy.test.mjs` (20: intersection,
  monotonicity, deny-wins, wildcard/`strictCeiling`, case-insensitivity, the
  narrow/effective mappers).
- presentation-bridge — `presentation-bridge.test.mjs` (12).
- frozen-dataset — `keel-frozen-dataset-limits.test.mjs` (7: ceilings enforced
  before fetch, committed-digest anchor).
- adversarial boundary — `adversarial-boundary.test.mjs` (14: the brief's attack
  list fails, declared ops pass).
- sandbox clamp — in `viewer.test.mjs` (capabilityCeiling narrows, composition
  untouched).
- SDK module-review — `sdk-module-review.test.mjs` (4) + MCP tool in
  `mcp.test.mjs`.

**Contract (Foundry): `KeelModuleReviewRegistry.t.sol`, 18/18.** Full lifecycle;
approver-only; one-bit-change can't borrow approval; contract-plugin graph,
manifest/resource-digest mismatch, and zero fields rejected; constructor
zero-address guards; double-submit, unknown-spec, can't-sanction-twice,
expiry-only-shrinks, revoke-is-terminal, reason-required; bindings views.

**On-chain (Sepolia), all against the live registry `0x9abb…f8b2`:**
- `pnpm trusted-runtime:module-registry:sepolia` — deploy + submit→sanction→revoke.
- `pnpm trusted-runtime:module-registry:deprecate-sepolia` — submit→sanction→
  deprecate (reuses the deployed registry + graph; ~3 tx). Verified: authorized
  through the window, status Deprecated, reason + replacement recorded.
- `pnpm trusted-runtime:module-registry:verify-sepolia` — **read-only, no key, no
  gas** (CI/monitoring-safe): re-reads the deployed state and asserts the recorded
  lifecycle outcome (Revoked, not authorized, bindings intact, reason recorded).
Evidence: `evidence/keel-trusted-runtime/module-review-registry-*.json`.

## 5. What NOT to rebuild

The verifier shell/wrapper, the sandbox document, the content gateway, the
frozen-dataset chunk verifier, the plugin trust lattice, the wallet-intent
symbolic model, the EIP-712 authorization structures, the manifest source model,
and the on-chain registries are all sound and stay. The manifest's deliberate
**absence** of a network capability is a feature, not a gap — keep it.
