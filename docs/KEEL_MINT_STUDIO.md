# Keel Studio mint flow

`/launch/mint` is the creator configuration surface and
`/drops/:chainId/:controller/:dropId` is the collector surface. Both are thin
clients over existing Keel/Keel contracts. They do not create a parallel
mint service or store authoritative draft/eligibility state.

The binding Cool S architecture document is identified in every exported
configuration by SHA-256
`aa74fa5f34d6d8be74c8d05dd27bf56a54ec14db66bdfabd8f7f21a1e67a282f`.

## Creator ownership

Studio attaches an existing collection first. The connected wallet must hold
the shell's `DEFAULT_ADMIN_ROLE`; the collection, supply ceiling, royalties,
presentation policy, modules, and treasury remain creator controlled. The
optional registered generic-factory step deploys a **plain KEEL721 only**, with
the connected wallet as shell admin and royalty receiver. It does not deploy a
Cool S/generative shell and does not make Studio or Keel the owner. Cool S
Simple mode attaches an already deployed creator-owned Cool S shell until an
exact matching shell factory is registered.

## Simple mode: OneMint

Simple mode compiles one call to `OneMintController.createDrop`:

| Studio field | OneMint argument/state |
| --- | --- |
| Collection shell | `target` |
| Creator payout | `payout` |
| Shared supply | `supply`, reserved against Keel capacity at creation |
| Transaction limit | `defaultMaxPerTransaction` |
| Wallet limit | `defaultMaxPerWallet`, shared across all stages |
| Ordered stage cards | immutable contiguous `StageConfig[]` |
| Schedule | stage `startTime` and `endTime` |
| Native/token price | `unitPrice` and `paymentAsset` |
| Allowlist/claim signer | stage `signer` |
| Claim collection | stage `entitlementToken` |
| Release/profile commitment | drop and stage metadata digests |

The receipt, not a prediction or database row, supplies the final `dropId`.
Permanent close releases unused target capacity. No stage can be edited in
place after creation.

## Advanced mode: existing MintAccess lane

Advanced mode can still produce the OneMint arguments exactly, and also exposes
the existing `KeelMintGate.createCampaign` lane for custom adapters,
Merkle/token/custom gates, and creator/platform signer policy. MintAccess is an
alternate existing controller; it is not wrapped inside OneMint.

Capacity protection is conditional in this lane. A direct MintAccess target
with a zero adapter is protected only when the target exposes the Keel
mint-capacity interface; campaign creation reverts if that reservation fails.
MintAccess deliberately skips the Keel reservation when a nonzero custom
adapter is selected. Studio labels and exports that path as unprotected instead
of implying the adapter has reservation semantics it does not expose.

The exported `keel-mint-launch@1` JSON contains normalized transaction
arguments, exact controller/shell addresses, module roots, seed/profile
commitments, and per-token `mintData`. Its `shell.observed` block is populated
from the same live inspection used to compile the transaction and is labeled
`factsSource: observed-chain`; an optional factory deployment block is labeled
`requestedDeployment` instead of being presented as chain state. The first
export/create click binds those reads directly and does not wait for UI state
to settle. `@keel/sdk` validates the same OneMint stage and allocation
invariants through `buildOneMintDrop`.

Export and create share one fail-closed live validator. For Cool S that gate
requires both `generativeConfigurationFrozen` and `coolSModulesFrozen`, the
frozen visual registry, matching immutable OneMint controller, nonzero
target-table root and resolver commitment, and the exact shell ↔ visual
registry ↔ inventory ↔ duplicator ↔ renderer bindings. It additionally proves
the shell's frozen viewer root, live viewer root, renderer root, Engine and
renderer runtime-code pins, frozen default presentation, disabled token-owner
presentation edits, and initial backpack capacity of at least two. A
generative shell cannot be relabeled Plain Keel to bypass those checks.
Creator-requested labels and values remain under
`generativeProfile.requested`; chain reads remain under
`generativeProfile.observed` and are never merged into one ambiguous fact set.

## Current ABI implementation extensions

These modules satisfy the architecture identified above; they do not replace
that product specification:

- `KeelEquipmentInventory` deploys immutable child contracts
  `KeelEquipmentReservationEngine` and `KeelEquipmentInventoryReader`.
  Studio reads `inventory.reservationEngine()` and `inventory.reader()`, then
  cross-proves each child's parent Registry/Inventory and collection binding.
- Cool S target table v1 pins inventory slot `6`. The Engine's `policy(6)` must
  name the exact `KeelOneUseDuplicator`, match
  `DUPLICATOR_ENTITLEMENT_ID`, pin the duplicator's direct runtime code hash,
  and be configured and permanently frozen. Studio compares the five-field
  `policy(6)` return, `materializerRuntimeCodeHash(6)`, and live duplicator
  bytecode hash.
- `KeelEquipmentInventory` also deploys an immutable
  `KeelEquipmentDescriptorValidator`. Each Cool S target definition must
  have a nonzero `definitionDescriptorCommitment`, and
  `computeDescriptorBoundDefinitionCommitment` must reproduce it from the
  Vault's advertised five-field `equipmentDescriptor(itemId)` tuple. The live
  slot, object ID, object revision, metadata digest, and descriptor commitment
  are all checked against the Inventory definition.
- Every definition enumerated through the visual registry target assets must
  point to a reservable Vault supply where the child Engine holds both
  `MINTER_ROLE` and `RESERVER_ROLE`. The parent Inventory must hold neither.
  This authority boundary is checked for every candidate, not inferred from a
  mutable quantity-issuer allowlist. After a Cool S spare is withdrawn, the
  frozen materializer selects the next target-family definition and the Engine
  reserves it before the transfer completes; generic collections without that
  selector retain the original one-use behavior.
- The shell pins `frozenReservationEngine`, Engine runtime code hash, metadata
  renderer runtime code hash, `frozenViewerBindingRoot`, and exposes
  `coolSViewerBindingRoot()` for live closure revalidation. Studio treats every
  mismatch as a hard mint-readiness failure.

Advanced Studio exports also accept the exact deployment link map for
`KeelHarnessContextDispatch`, `KeelCollectionFreezeValidation`, and
`KeelMintBoundEquipmentProvision`. Those addresses are labeled
`creator-request` with proof boundary
`deployment-link-map-not-shell-getters`; they are not promoted to observed
chain facts because Solidity libraries do not have shell getter addresses.

The checked-in `CoolSTargetTableV1` currently reports
`VIEWER_COMPATIBLE_RELEASE=false`. Studio therefore identifies it as a
non-release fixture and blocks export/create until a compatible release table
is deployed and observed. The G0 entropy flow also remains explicitly
`g0-unproven`; no future-block, VRF, or fair-randomness claim is made.
The linked-library address map remains a deferred Phase-2 deployment-evidence
surface and is not promoted into the Phase-1 onchain closure.

## Per-token generative context

The collection shell remains the only public mint target. OneMint calls
`strikeFromManager` once. Keel's pre-receiver hook receives exact per-token bytes:

- quantity 1: `mintData` is the token's bytes;
- quantity greater than 1 and empty context: `mintData == 0x`;
- quantity greater than 1 with context:
  `abi.encode(PER_TOKEN_MINT_DATA_DOMAIN, bytes[] slices)`, with exactly one
  ordered slice per token.

Studio never exposes named trait selection as a collector input. Frozen seed,
resolver, visual-registry, and uniqueness modules derive those traits inside
the creator-owned shell before the ERC-721 receiver callback.

For a declared generative profile, Simple mode and the collector page lock
`mintData` to canonical `0x`. Arbitrary context can steer seed-derived output
and enable rarity grinding, so raw context is exposed only in an explicit
Advanced/custom-profile disclosure. This context lock is deterministic replay
plumbing, **not** a future-block or VRF fairness claim.

## Collector proof boundary

The collector route requires a configured chain RPC and a Studio-registered
OneMint controller before enabling writes. It reads the live drop, every stage,
current stage, shared remaining supply, collection capacity, frozen generative
profile, and wallet usage. The indexer is labeled as indexed, partial, or
missing, but never replaces those reads.

Public/token-payment stages call `publicMint`. Allowlist and claim stages build
the contract's exact authorization/context and require the configured signer
signature. Pasted signed-stage inputs are labeled preflight, not eligible,
until the exact final call simulation succeeds. Claim ownership and
`claimIdUsed`, plus ERC-20 balance and allowance, are read from chain; duplicate
or consumed claim IDs fail preflight and an exact allowance can be submitted
before mint.

The module-address card is explicitly pre-read configuration context, not
receipt proof. After mint, Studio lists only decoded and identity-correlated
events from the exact controller, collection shell, visual registry,
visual-state ledger, inventory, child Reservation Engine, and enumerated Vault
supply addresses. `MaterializationSupplyReserved` is correlated by token,
slot, definition, entitlement, and reservation ID; the corresponding Vault
`MintSupplyReserved` and `ItemMinted` events are correlated by exact supply and
item. Follow-up `Engine.status(tokenId, 6)` values appear in a separately
labeled post-receipt live-read section, never in the receipt-event list. A
correlated `DropMinted` and the expected ERC-721 mint transfers are required
before token IDs are reported; missing module events are not replaced by
generic green checkmarks.

An unsupported network, unreadable drop, unregistered controller, missing
capacity reservation, malformed route, mismatched shell controller, incomplete
module graph, or unfrozen selected generative profile is shown as a hard
readiness failure rather than replaced by mock state.
