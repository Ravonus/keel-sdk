# Keel Contract Union

This document describes the contract-first Keel vertical slice implemented
in `packages/contracts`. The historical source in
`/Users/ravonus/dev/chainrougesolidity-inventory` is the product-design
authority; it is not safe bytecode to redeploy. Its public mutation paths,
empty verifier methods, weak ownership bookkeeping, and unfinished branches are
treated as evidence of intent rather than compatibility requirements.

## Contract graph

```text
KeelHold
    ↑ immutable contentObjectId + decoded-byte descriptor
KeelArtifactRegistry ───────→ KeelLinkRegistry
    ↑ exact (objectId, revision)       preview / high-res / Hybrid locators
    │
KeelHarnessRegistry ───────→ KeelSeedRegistry
    │ viewer revision + token fork     exact viewer-revision seed root
    │
KeelAttributionRegistry ───→ creator-authored people and role labels
    │ independent of edit, owner, fork, runtime, and IP authority
    │
KeelIndex ←──────── KEEL721 ───── KeelMintGate
    ↑ active manifest       ↑           OneMintController
    │                       │
    │              VaultCharacterStarterPack
    │                 exact character + two items
    │                       │
    └──────── KeelEquipmentInventory ←──── VaultItem1155
           owner read on mutation + tiers       shared copies + exact objects
                          │
VaultArcadeRegistry → VaultRunLeaderboard ← exact shared WASM referee
                          │
              VaultAchievementRegistry → VaultGameCard
             dynamic composed collector view
```

The browser accepts bytes only through the reverse proof chain:

```text
active KeelIndex presentation
  → RFC 8785 manifest SHA-256
  → keel.runtime@1 registry addresses and viewer ID
  → effective viewer/object revisions, fidelity sets, seed, and loadout
  → exact KeelHold or verified external bytes
  → isolated Keel sandbox
```

The indexer accelerates discovery and records every event, but it is never a
rendering trust root.

## Registries

### `KeelArtifactRegistry`

- Creates deterministic logical object IDs independently of KeelHold IDs.
- Binds to the immutable `KeelManager` address. A zero fee is the default;
  governance may set an exact native contribution per successful logical
  object, select its recipient, and pull accrued contributions only through a
  two-thirds manager execution. Admin and automation lanes cannot change the
  fee because the registry checks the manager's execution context.
- Appends linear revisions with exact-parent checks.
- Pins the KeelHold content object, digest algorithm, decoded digest, decoded
  length, compression, media type, metadata digest, and fidelity-set digest.
- Supports creator, token-owner, creator-or-token-owner, and immutable editing
  policies. Token ownership is read live from `ownerOf`; it is never cached.
- Freezing is permanent. Immutable creation freezes revision one immediately.
- Creation and revision-policy callbacks are non-reentrant. Incorrect native
  payments revert before the object is committed, and `protocolFeesAccrued` is
  decremented before the recipient interaction during claims.

An object revision descriptor commits decoded bytes, not Brotli recompression
output. Different valid compressed streams may decode to the same committed
content.

### `KeelHarnessRegistry`

- Stores ordered slots as exact `(objectId, objectRevision)` pairs rather than
  the prototype's lossy packed-history convention.
- Appends linear viewer revisions and records the manifest and seed-set
  commitments for each revision.
- Allows policy-controlled token forks to select different revisions of the
  same declared object lineages.
- Activates a fork only when its manifest digest and revision agree with the
  token's `KeelIndex` presentation.
- Resolves an `EffectiveViewer` for a collection token without transfer hooks.

Token forks deliberately cannot substitute arbitrary object IDs. Dynamic
equipment is a separate manifest-declared overlay.

### `KeelAttributionRegistry`

- Adds multiple creator-authored labels to either a logical object or a logical
  viewer, including custom labels such as `artist`, `engineer`, `partner`, and
  `contributor`.
- Uses the immutable object or viewer creator as the attesting manager; the
  named account can also publish a self-claimed label that remains visibly
  unverified until the subject creator attests it.
- Keeps labels outside edit policy, token ownership, fork authority, runtime
  capabilities, and IP-control decisions. Freezing an object or viewer does not
  erase its contribution history.
- Records deactivation rather than deleting an entry, so indexers and viewers
  can distinguish an active contribution, a removed contribution, and a
  self-claim.

### `KeelLinkRegistry`

- Publishes at most one Preview, HighResolution, and Hybrid locator for an exact
  object revision.
- Supports canonical HTTPS, IPFS, IPNS, and Arweave locators.
- Binds algorithm, compression, media type, decoded digest, byte length, and
  provenance.
- Requires the complete link set to match the revision's precommitment before
  publication.
- Allows the original revision publisher to reveal a committed set even after a
  later object revision exists, avoiding a head-race liveness failure.

Hybrid means the external and on-chain paths reproduce the same decoded bytes.
The browser rejects a corrupt external response and falls back to the pinned
KeelHold source. Preview and HighResolution are distinct renditions and are
not silently substituted for the exact resource.

### `KeelSeedRegistry`

- Publishes one immutable root for an exact viewer revision.
- Verifies the viewer revision's precommitted seed-set digest.
- Records both the original viewer-revision publisher and the later revealer.
- Derives token seeds with chain ID, registry address, collection, viewer ID,
  viewer revision, manifest digest, root, and token ID domain separation.

`live` manifests may read the current seed and loadout. Replay manifests must
pin the viewer, block, derived seed, and equipment digest.

## Equipment inventory

`KeelEquipmentInventory` is deployed per canonical KEEL721 character
collection.

- The inventory constructor requires the character collection's configured
  KeelIndex to match its immutable registry.
- Catalog mutation rechecks that match, so a Keel registry migration cannot
  leave stale catalog authority active.
- The current character-collection controller curates compatible equipment.
  This is compatibility curation, not proof that an equipment collection
  endorsed the mapping.
- Definitions are immutable and pin an exact Keel object revision.
- ERC-721 and single-unit ERC-1155 assets are escrowed. Every player mutation
  checks the character NFT's current owner before and after external token calls.
- Character transfer immediately transfers backpack authority without moving
  escrow or adding a KEEL721 transfer hook.
- Withdrawal clears render state before the outbound transfer and rolls the
  whole transaction back if character ownership changes in the receiver
  callback.
- Raw ERC-721 `transferFrom` cannot invoke a receiver hook. An event-audited
  controller recovery method exists only for untracked tokens actually held by
  the vault; tracked holdings cannot use it.
- A managed slot may freeze one collection-wide materializer, entitlement ID,
  and exact direct runtime code hash before mint. Delegating runtimes are
  rejected at configuration and any later byte drift fails closed before the
  consumed bit or reservation changes. The consumed/cycle state lives in the
  inventory under the immutable character collection, token ID, and slot,
  rather than in the adapter.
- The reserved provisioning path requires capacity of at least two, protects
  one capacity unit from unrelated deposits, and reserves real capped
  `VaultItem1155` supply. It never promises a future best-effort mint.
- An unused reservation follows atomic same-slot replacement. The old supply
  reservation is released and the next definition's supply is reserved in one
  transaction; exhaustion restores the old reservation and visual state.
- Once this policy is frozen, the legacy mutable quantity-issuer path is closed
  for that managed slot. A second adapter or a later issuer grant cannot reset
  or bypass the policy. Cool S re-arms only after the duplicated ERC-1155 spare
  leaves Inventory; its frozen materializer selects a deterministic next
  target-family definition, excludes the immediately previous one, and reserves
  the replacement before the outbound transfer. The equipped unit remains
  non-withdrawable, so every token keeps one backed part.
- ERC-1155 assets advertising `IKeelERC1155EquipmentDescriptor` use the
  strict `registerDescriptorBoundERC1155Definition` lane. Inventory checks the
  exact `(slot, objectId, objectRevision, metadataDigest, commitment)` tuple and
  stores a nonzero definition commitment. The generic `registerDefinition`
  lane remains compatible only with non-advertising legacy assets.
- Strict tuple validation uses the Inventory's immutable
  `descriptorValidator()` child through an ordinary call. The child exposes its
  Inventory back-reference and owns no mutable state; Inventory therefore has
  no descriptor-library link reference or validation `DELEGATECALL`.

Two historical numbers are deliberate v1 choices, not claims that the old
prototype implemented them correctly:

- Slots `0..7` match the executable prototype. Slot `8` (`AddonThree`) realizes
  the ninth slot named in its comments but ignored by its write/render code.
- The 42-unit limit realizes the prototype's documented `0..41` packed-item
  range; the old population/capacity flow was unfinished.

Deployment is restricted to the non-burnable KEEL721 in this repository. A
character collection with an uncoordinated burn path can strand escrow and is
unsupported until it implements a pre-burn inventory-release protocol.

The KeelIndex controller is a custody-recovery trustee for untracked
ERC-721s. Production deployments must place that authority behind the intended
multisig/timelock and monitor `UntrackedERC721Recovered`.

The complete Vault Runner item, two-item starter purchase, capacity-tier,
achievement, and dynamic-gamecard model is documented in
[`VAULT_RUNNER_ONCHAIN_SYSTEM.md`](./VAULT_RUNNER_ONCHAIN_SYSTEM.md).

## Vault Arcade maps and verified runs

`VaultArcadeRegistry` keeps game data outside the normal character and map
ERC-721 contracts while binding playable results to exact on-chain state.

- A verifier-bound map build pins its manifest, complete resource graph, game
  object revision, permanent map seed, and a content-clamp digest for the exact
  tile, object, enemy, boss, and FX catalogue that build may use.
- `floorSeed` domain-separates chain, registry, map, build revision, graph
  commitments, content clamp, map seed, and floor number. The same build and
  floor therefore reproduce the same rooms, story beats, missions, locks,
  chests, enemies, boss moves, and shop cadence.
- Ownership controls character staking and backpack authority. Public players
  may still play an assigned character from its collector page.
- A scoreable build pins its run verifier. `VaultRunLeaderboard` additionally
  pins an exact SHA-256 `application/wasm` Keel object revision, rules digest,
  tick rate, and maximum tick count.
- Its deterministic run seed is the character's permanent mint seed exactly.
  Map/build, render recipe, loadout, simulator, and assignment epoch remain
  separately signed receipt fields, so they cannot reroll or replace that seed.
- Scores require an EIP-712 receipt binding player, character, map, exact build,
  assignment epoch, session, run seed, loadout, simulator, start/final state,
  input transcript, floor, score, ticks, server times, and deadline.
- Prototype-style builds without a verifier remain readable but cannot create
  entries in the signature-gated leaderboard.

## Mint controllers and shared capacity

The recovered OneMint product model and the newer modular manager coexist:

- `KeelMintGate` handles public, Merkle, token, custom-gate, and EIP-712 /
  ERC-1271 signed campaigns.
- `OneMintController` handles ordered drop stages sharing one drop allocation
  and one per-wallet count: Allowlist, Public, TokenPayment, Claim, and Premint.
- ProofOfWork, Auction, NeuralPayment, and Airdrop enum values remain reserved
  and unsupported because those prototype implementations were absent or unsafe.
- Claim signatures bind the complete ordered entitlement-ID list, and each ID
  must currently belong to the claimant.
- Payments require exact `unitPrice × quantity`; fee-on-transfer ERC-20s are
  rejected.
- Drop creation requires the target admin or an explicit full-trust sales
  delegate. KEEL721's narrower campaign-creator role is not upgraded into a
  self-mint superuser.

`KEEL721` implements a shared mint-capacity ledger. Both managers reserve before
opening protected direct allocations, consume their own reservation while
minting, and release remaining capacity on permanent close. A manager with an
outstanding reservation cannot lose `MINTER_ROLE`, preventing stranded global
capacity. `KeelFactory.FACTORY_VERSION` and `dieCreationCodeHash()` let
Studio reject factories that embed the pre-capacity KEEL721 creation code.

Drop creation and supply/close lifecycle changes are guarded because each can
call a target's capacity hook. Payouts are pull-based in both
`OneMintController` and `KeelMintGate`: the account that owns a pending
balance calls `withdraw`, and the balance is zeroed before the external native
or ERC-20 transfer.

## Browser binding

`KEEL721` has an opt-in `_harnessContext(tokenId, manifestDigest)` extension. An
empty context preserves `harnessDataURI` exactly. Dynamic collections return
canonical JSON and use `harnessDataURIWithContext`, which injects data around the
same committed viewer program bytes. A dynamic release should bind token ID,
mint seed, current visual digest/revision, release/profile root, viewer object
and digest, resolver/code commitment, target-table root, and manifest digest.

`KeelVisualStateLedger` can store the complete canonical state and a complete
reconstruction context at every revision. Project registries additionally
publish canonical patch bytes. A digest receipt alone is not considered enough
to reconstruct historical art.

Direct resolver policies use `KeelCodeIdentity` to pin `EXTCODEHASH` and
reject CALLCODE, DELEGATECALL, and EIP-7702 delegation designators. This is a
direct-runtime rule, not a general proxy attestation lane.

The Cool S shell delegates its read-only freeze closure to the stateless linked
`KeelCollectionFreezeValidation` library. Permanent freeze records the
inventory child reservation engine's exact address and direct runtime hash, in
addition to the renderer/viewer closure. The shell's viewer-binding gate
rechecks the complete live registry/inventory child/renderer/viewer-builder
closure. Only after that fail-closed check does it call the pinned metadata
renderer's existing `harnessContext`; the renderer remains the sole
authoritative context assembler, so field order and committed context semantics
are not duplicated in the shell or validation library.
Cool S v1 also names its single inventory slot as a private collection policy
constant; permanent freeze independently requires the registry's immutable
target table to report that same slot, and every mint rechecks the generator's
returned slot before backed provisioning.

Dynamic Keel collections also link the stateless `KeelHarnessContextDispatch`
library. `KEEL721` invokes it only when `_harnessContext` returns nonempty bytes;
empty context continues through the original `harnessDataURI` route. The
dispatcher forwards the exact context to `harnessDataURIWithContext`, bubbles
all reverts, and provides no fallback viewer.

Generative equipment collections may link the stateless
`KeelMintBoundEquipmentProvision` library for their pre-receiver mint hook.
After the collection has authorized the mint and bound its seed, the helper
atomically calls the configured generator's canonical mint initialization,
requires its returned slot to match the collection's frozen slot policy, and
provisions the backed ERC-1155 through the configured inventory with the
generator as coordinator. It has no state, alternate path, catch, or fallback;
any claim, slot, reservation, or supply failure reverts the complete ERC-721
mint before its receiver callback.

`CoolS721` therefore has explicit external-library link references: deploy the
reviewed libraries once, link those exact addresses into creation bytecode, and
publish the link map with the collection deployment record. Linked addresses
are embedded in runtime; neither library has storage, policy authority, or an
administrative entry point.

The versioned manifest extension is `extensions["keel.runtime"]` with
protocol `keel-runtime@1`. It declares:

- chain, ObjectRegistry, HarnessRegistry, optional LinkRegistry and SeedRegistry;
- viewer ID, token ID, binding mode, and positional viewer-slot resources;
- an exact viewer snapshot for replay mode;
- optional equipment inventory, character binding, exact/live loadout mode,
  and slot-to-resource overlays.

The reference Keel object/viewer resolver talks to same-origin Studio
routes. Those view calls are limited to an explicit function allowlist on
enabled, correctly typed contract addresses. The renderer cannot invoke
mutation methods through this gateway.

The sanctioned contract-plugin path has a stricter serverless mode. The host
browser resolves KeelHold objects and registry state directly from a declared
public RPC. Studio may serve static application bytes, but no Studio route,
database, listing index, or server signature is an authorization source.

`/keel` is the local contract-union test bench. Its demo deliberately feeds
corrupt bytes to an IPFS Hybrid path, proves the on-chain fallback, derives the
token seed, resolves slot-8 equipment, and mounts both layers in the normal Keel
sandbox.

## Recursive contract plugins and KeelMarket

`KeelGraphRegistry`, `KeelPluginRegistry`, and `KeelMarket` form the
first production-path contract-plugin slice.

- A plugin graph version commits the exact nested plugin manifest, ABI JSON,
  declarative adapter, wallet runtime, contract target, runtime code hash,
  permissions, and storage tier. Graph versions are append-only; storage tiers
  only move toward stronger permanence, and a frozen graph cannot be edited.
- Submission is permissionless. A review authority may sanction, deprecate, or
  terminally revoke one exact spec digest. Updating any committed byte requires
  a new graph/plugin version and a new review.
- Wallet authorization requires the complete recursive graph to resolve and
  match the installed audited bytes, live target code, interface markers,
  contract constants, status, and declared permissions. A status check by
  itself never unlocks a wallet.
- The artwork remains in an opaque, no-provider sandbox. It may send only a
  symbolic, session-bound intent such as `market.buy`; it cannot supply an ABI,
  target, calldata, value, provider request, or navigation target.
- The verified host re-resolves the graph, derives the exact transaction from
  fresh chain state, displays and simulates it, asks the wallet, then re-reads
  the mined transaction and its contract postcondition before reporting
  success.

`KeelMarket` is an escrow marketplace, not a marketplace-shaped demo API.
Listings, bids, settlement quotes, pull-payment credits, royalties, and
platform fees live in the contract. A static host plus public RPC and wallet is
sufficient to list, update, cancel, buy, bid, accept, and withdraw. Offers are
deliberately token-bound across ownership transfers until accepted, cancelled,
expired/reclaimed, or replaced. Recovery authority is suitable for a Ledger
EOA during isolated early tests and must be transferred to the intended
multisig/timelock before production custody.

## Local proof

After compiling and deploying the local graph:

```bash
pnpm --filter @keel/studio contracts:deploy-local
pnpm --filter @keel/studio contracts:verify-local
pnpm --filter @keel/studio contracts:seed-keel
pnpm --filter @keel/studio contracts:verify-keel-demo
pnpm --filter @keel/studio contracts:seed-historical-keel
pnpm --filter @keel/studio contracts:seed-keel-market
pnpm --filter @keel/studio indexer:once
```

The live browser regression test is intentionally separate from the ordinary
Studio suite because it requires the seeded contract graph:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3000 \
  pnpm --filter @keel/studio test:e2e:keel

KEEL_RPC_URL=http://127.0.0.1:8545 \
PLAYWRIGHT_BASE_URL=http://localhost:3000 \
  pnpm --filter @keel/studio test:e2e:keel-market
```

## Scope still open

This slice proves the secure contract and browser seam plus one real sanctioned
market plugin. It does not yet claim the generic external-API broker, arbitrary
third-party marketplace aggregators, mint-through-NFT flow, or the
background/hat equipment demo. It also does not claim the full historical
mega-test bench: canonical comet assembly, the seven-module fluid viewer, the
large three.js payload, or the 10+ token game on-chain dedupe measurement.
Those remain subsequent production-path slices and must use these registries
rather than reviving `ScriptStorage` authority paths.
