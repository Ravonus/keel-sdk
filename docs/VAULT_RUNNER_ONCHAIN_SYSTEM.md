# Vault Runner on-chain system

This is the local implementation of the new Keel-based Vault Runner
character, equipment, backpack, gamecard, and achievement system. It has not
been deployed.

The earlier reference contracts remain product-design evidence only:

- `/Users/ravonus/dev/chainrougesolidity-inventory/contracts/CharacterMint.sol`
- `/Users/ravonus/dev/chainrougesolidity-inventory/contracts/EquipmentMix.sol`
- `/Users/ravonus/dev/chainrougesolidity-inventory/contracts/Backpack.sol`
- `/Users/ravonus/dev/chainrougesolidity-inventory/contracts/BackpackManager.sol`
- `/Users/ravonus/dev/chainrougesolidity-inventory/contracts/GameNFT.sol`
- `/Users/ravonus/dev/chainrougesolidity-inventory/contracts/MapMint.sol`

They must not be redeployed. The current implementation keeps the useful game
model without `tx.origin`, public mint/burn paths, cached pseudo-ERC-721 owners,
weak randomness, arbitrary metadata mutation, or transfer hooks that can brick
the character NFT.

## What was retained

| Reference intent                          | Current implementation                                                                                                                                | Storage decision                                                                                                     |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Paid character starts with removable gear | `VaultCharacterStarterPack` atomically mints one character, initializes its backpack tier, mints exactly two items, deposits them, and equips them    | One transaction and one rollback boundary; a failed item mint leaves no character or payment credit behind           |
| Equipment can be removed and sold         | The two starter definitions must be distinct ERC-1155 types in distinct slots and `ForeverUnbound`                                                    | Item copies move independently; the character keeps no copied art bytes                                              |
| Some equipment eventually binds           | `KeelEquipmentInventory` supports `ForeverUnbound`, `LimitedUnequips`, and `BindOnEquip`                                                           | One immutable policy per definition plus a tiny per-character binding state                                          |
| Character-owned backpack                  | Escrow authority is read from `ownerOf` for every mutation; transferring the character transfers backpack control                                     | No cached owner and no character transfer hook                                                                       |
| Backpack sizes and later upgrades         | Every character must receive an explicit capacity tier; an isolated capacity manager can only increase it up to 42                                    | One byte of capacity state; uninitialized characters cannot accept inventory                                         |
| Nine equipment positions                  | Head, body, legs, shirt, eyes, weapon, and three add-on slots                                                                                         | Loadout stores nine definition IDs, not nine copies of metadata or art                                               |
| Armory/inventory pages                    | `inventoryPage`, `inventoryContains`, `inventoryCount`, `backpackStatus`, and `loadout`                                                               | At most 42 holdings per character with stable pagination                                                             |
| Item NFT contract and item viewer         | `VaultItem1155` exposes standard ERC-1155/2981 metadata, inline JSON, inline SVG fallback, ERC-4804 JSON, supply caps, rarity, slot, and Keel pins | One shared immutable item definition serves every copy                                                               |
| On-chain game                             | `VaultArcadeRegistry` pins deterministic map builds and escrows the exact character/build assignment                                                  | Maps store exact graph/object commitments, not duplicated HTML, sprites, or character bytes                          |
| Server-refereed leaderboard               | `VaultRunLeaderboard` pins exact Keel WASM bytes and accepts a build-authorized signature only over server-derived state and score                 | Compact receipts and bounded ranks stay on-chain; input batches remain content-addressed evidence                    |
| Persistent player/game card               | `VaultGameCard` dynamically composes owner, controller, backpack, loadout, achievements, active map, and best verified run                            | It is a view contract rather than a second NFT that can become stale after character transfer                        |
| Quests, milestones, and badges            | `VaultAchievementRegistry` supports floor, score, backpack, equipped-slot, and EIP-712/ERC-1271 attested achievements                                 | Up to 256 permanent achievements fit in one bitmap per character; evidence and metadata remain separately verifiable |

The reference paid-character code encoded one claimable unbound item in seed position
14 and separately described the gun as removable/bindable. The current product
rule is explicit and stronger: a paid purchase receives **two** detachable item
tokens. `VaultCharacterStarterPack` therefore fixes exactly two definitions in
its immutable content digest and rejects bound definitions, colliding slots,
different item collections, or any inventory descriptor that disagrees with the
canonical item contract.

## Permanent mint-seed rule

Each character receives its one canonical seed at the atomic mint boundary.
There is no seed setter, transfer hook, reroll, or administrative replacement.
EVM stores it in `VaultCharacter721.tokenSeed`; Tezos stores it in the immutable
`VaultCharacterFA2` recipe and rejects reuse of that token ID even if a future
extension adds burning. Ownership transfer, staking, exit/re-entry, player,
assignment epoch, session ID, and time cannot change this mint seed.

The run seed is that permanent mint seed exactly. Map/build, simulator, loadout,
assignment epoch, and session ID are separate signed commitments, so the
simulator detects any different context without re-deriving or replacing the
seed. Replay protection therefore cannot become a reroll mechanism.

## Contract graph

```text
KEEL721 / VaultCharacter721
  ↑ strikeFromManager
VaultCharacterStarterPack ── exact two definitions ──┐
  │                                                  │
  ├─ initialize backpack tier                        │
  └─ provision + equip twice                         ▼
KeelEquipmentInventory ← mint role ─────── VaultItem1155
  │ ownerOf on mutation                             │
  │ loadout / holdings                              └─ exact Keel object revision
  ▼
VaultArcadeRegistry ── assignment/build/seed ──→ VaultRunLeaderboard
       │                                             ↑
       │                                  exact Keel WASM object
       │                                             │
       └─ active map → VaultGameCard ← VaultAchievementRegistry
                              ↑                ↑
                       leaderboard run   leaderboard run

player client ── input only ──→ referee server
      │                              │
      └──── same WASM bytes ─────────┘

super-admin governors (2/3 initially)
  └─ delayed governance ──→ KeelManager
                              ├─ admin/mod role roster
                              └─ exact machine capabilities
                                       │
                                       ▼
                         VaultRunSignatureAuthority
                              └─ scoped receipt only ──→ VaultRunLeaderboard
```

## Item metadata

`VaultItem1155` uses a normal ERC-1155 `uri(id)` data URI, not a custom-only
marketplace interface. `itemJSON(id)` includes:

- name, description, image, and animation URL;
- slot and rarity attributes;
- exact Keel object ID and revision;
- the Keel revision's metadata digest;
- an immutable item commitment over text, URIs, source, supply, slot, and
  rarity;
- minted and maximum lifetime supply;
- a deterministic ERC-4804 metadata route.

`itemSource(id)` also resolves the committed KeelHold object, decoded digest,
byte length, compression, and media type without relying on an indexer.

An omitted image uses the contract's on-chain SVG poster. An omitted animation
uses the exact `keel://object/<id>/<revision>` locator. External metadata can
provide a verified normal viewer URL while retaining the Keel pins.

The item contract validates that its `metadataDigest` equals the digest recorded
on the selected `KeelArtifactRegistry` revision. The inventory copies that same
digest into its immutable equipment definition. This gives collectors one
continuous chain:

```text
ERC-1155 item id
  → immutable item commitment
  → inventory equipment definition
  → exact Keel object revision
  → KeelHold object / verified fidelity links
  → decoded-byte digest
```

## Backpack and binding rules

- `MAX_INVENTORY_UNITS` is 42, carrying forward the reference contract's documented
  range as an explicit upper bound.
- Starter packs initialize a per-character capacity between 2 and 42.
- A separate authorized manager may only increase that capacity. It cannot
  decrease it, move items, equip items, or edit the item catalog.
- Every character must be explicitly initialized. An uninitialized character
  reports capacity zero and cannot accept inventory.
- Character transfer immediately changes backpack authority because every
  mutation reads `ownerOf` when it executes.
- `ForeverUnbound` items may be unequipped, withdrawn, transferred, and placed
  into another compatible character.
- `LimitedUnequips` decrements only on unequip and permanently binds at zero.
- `BindOnEquip` permanently binds on first equip.
- A bound item remains in character custody when the character transfers.

## Achievement rules

Every append-only achievement definition pins a metadata object revision and
uses one rule:

- `BestFloor`: reads a verifier-recorded best run for one map;
- `BestScore`: reads a verifier-recorded best score for one map;
- `BackpackCount`: proves a minimum number of current holdings;
- `EquippedSlot`: proves a non-empty exact loadout slot;
- `Attested`: accepts EIP-712 claims from the committed EOA or ERC-1271
  contract, suitable for Tezos, Ordinals, event, or manually adjudicated proof.

Deterministic claims store a digest of the exact on-chain state that satisfied
the rule. Attested claims bind character collection, character ID, achievement
ID, claimant, evidence digest, nonce, deadline, chain, and registry. Earned
badges attach to the character and therefore travel with it.

## Gamecard

`VaultGameCard` is intentionally a dynamic read model rather than a soulbound
copy. After deployment, a read for a character and map will return and render:

- canonical ERC-721 owner and current gameplay controller;
- active/staked map and exact render-recipe digest;
- backpack used/capacity and loadout digest;
- achievement bitmap, count, and points;
- best verified floor, score, build revision, player, and run digest;
- a digest of the complete card state.

`gameCardJSON` and `gameCardURI` provide conventional metadata, while
`erc4804URI` provides a deterministic on-chain read route. The metadata labels
the storage model directly: shared immutable objects plus compact state pointers.

The active-map reader and run reader are intentionally separate constructor
inputs. `VaultArcadeRegistry` supplies current staking context;
`VaultRunLeaderboard` supplies server-refereed best runs. Collection checks on
both inputs prevent a card from composing unrelated character systems.

## Deterministic WASM referee and leaderboard

`packages/vault-referee` supplies one fixed-tick, integer-only WASM rules kernel
for both the browser and server. The client sends only canonical input frames.
It cannot submit position, health, floor, enemies, score, or elapsed ticks as
authority. The server replays the exact same SHA-256-pinned bytes, persists
snapshots with compare-and-swap revisions, and writes each canonical input batch
as an immutable content-addressed evidence object. It rejects ticks ahead of
server wall time and performs a full seed-to-finish evidence replay before the
protected signer sees a receipt.

`VaultRunLeaderboard.configureLeague` is one-time configuration for an exact
`(mapId, buildRevision)`. It requires:

- a playable portable map build and its build-authorized verifier;
- an exact Keel object ID/revision whose media type is
  `application/wasm`, digest algorithm is SHA-256, and decoded digest and byte
  length are recorded by `KeelArtifactRegistry`;
- the rules digest, tick rate, maximum run ticks, and bounded top-list size.

The resulting simulator commitment also includes chain, leaderboard, arcade,
map manifest, resource graph, portable root, permanent map seed, content clamp,
WASM metadata/fidelity descriptors, compression, publisher, and timing rules.

The deterministic run seed is the character's permanent mint seed exactly:

```text
runSeed = characterSeedAtMint
```

There is no setter, reroll, or contextual re-derivation. Map/build, loadout,
simulator, session ID, assignment epoch, and timestamps remain separately
signed receipt fields, so changing any of them invalidates the receipt without
changing the seed. The monotonically increasing assignment epoch prevents a
receipt opened during an earlier escrow from being submitted after re-entry.

The server produces the EIP-712 receipt only after deriving all result fields
from its WASM state. The receipt binds player, character, map/build, assignment
epoch, session, run seed, loadout, simulator, start/final state digests, input
transcript digest, floor, score, ticks, final health, terminal outcome, server
timestamps, and deadline. `VaultRunSignatureAuthority` then requires a second,
consumer-bound operational envelope. A current admin may sign every gameplay
scope; a moderator may sign standard and hardcore-survival receipts but cannot
permanently death-lock a character. A machine key may sign only when its exact
standard, hardcore-survival, or hardcore-defeat capability is live. Machine
keys and grants cannot extend beyond 30 days and may be renewed or revoked.
The envelope includes its authority class, scope, deadline, and revocation
nonce. Super-admin governor status is ignored.
Session and run digests are single-use.

The authority configuration digest is immutable and part of each league and
hardcore terms digest. Changing an admin/mod role or machine grant invalidates
previous envelopes through its nonce without changing the player-visible
deterministic seed. Super-admin roster transitions are a separate
`KeelManager` process: the current two-thirds quorum stages a complete new
roster, every incoming governor proves control, the old roster remains active
for at least seven days and can cancel, activation is bounded, and anyone can
activate or expire the accepted transition.

Rankings are bounded per exact map build, contain at most one best entry per
character, and order by floor, then score, then fewer ticks. Overall personal
bests remain available by map for achievements and gamecards. Full input bytes
and optional snapshots do not inflate contract storage: events and state retain
their commitments, while evidence can be published into Keel later without
changing the receipt.

The current WASM module is the first authoritative scoreable rules version. Any
browser-demo mechanic not yet driven by that ABI remains outside signed ranking
until it is moved into the shared kernel; presentation code is never allowed to
silently become score authority.

## Hardcore custody and trust boundary

Hardcore is a separate, explicit staking mode; a standard stake never becomes
hardcore implicitly. Before the referee accepts one input frame, the current
staker signs an EIP-712 authorization for the exact session, deterministic seed,
loadout, simulator, start state, immutable terms digest, start time, and
deadline. A relayer records that authorization on-chain and the server re-reads
the active session after confirmation. This closes the defeat-to-chain race:
the character cannot be withdrawn while a potentially fatal authorized run is
unsettled.

The settlement window is bounded, but custody is deliberately fail-closed. If
the operational signer service, referee, network, or RPC path disappears and no
valid survival is settled by the signed deadline plus fifteen minutes, anyone
may apply the player-consented timeout/abandonment forfeit and the character is
permanently death-locked. Disconnecting or withholding a fatal transcript is
not an unstake path. A new hardcore session is rejected while the operational
authority is paused, moderators cannot pause that authority, and a survival is
valid only at the configured terminal tick. If a current defeat-scope
operational signer attests a receipt whose terminal health is zero and outcome
is defeated,
`VaultArcadeRegistry` writes the run digest as a permanent one-way lock. There
is intentionally no owner, map-owner, reporter, governor, admin, or moderator
escape for that character. A valid survival-scope receipt clears the temporary
lock normally.

The wallet-facing confirmation must spell out all of those terms before asking
for the EIP-712 signature: permanent death on signed defeat; permanent forfeit
on timeout, abandonment, disconnect, server outage, or settlement failure; no
admin recovery; terminal-tick-only survival; and an empty backpack requirement
so detachable items are never stranded. The signed `hardcoreTermsDigest` is the
on-chain commitment to that exact policy, not a substitute for displaying it.

This is constrained signer trust, not mathematical trustlessness. Governance
seats do not automatically sign gameplay, and gameplay signers cannot change
governors, roles, capabilities, policies, or code. A machine envelope is usable
only for its exact scope, consumer, digest, deadline, and current nonce. Those
limits prevent a run signer from damaging unrelated system authority, but an
authorized defeat signer can still falsely attest defeat for the one exact
player-authorized active session. A validity proof for the WASM transition or
an optimistic fraud-proof window is required before irreversible custody can
be called trustless. Until that exists, hardcore is non-live, experimental,
and never risk-free custody.

## Tezos end

The SmartPy lane implements the same model with Tezos-native signatures and FA2
custody:

- `VaultArcadeEscrow` stores standard/hardcore mode, exact build, monotonic
  assignment epoch, active session, bounded settlement time, and permanent
  death digest;
- `KeelManager` keeps the two-thirds super-admin roster separate and stages
  complete delayed roster transitions that every incoming governor accepts;
- `VaultRunSignatureAuthority` is bound once to one leaderboard and validates
  current operational admin/mod keys or independently scoped machine keys,
  with separate standard, survival, and defeat privileges plus revocation
  nonces;
- `VaultRunPolicyRegistry` lets the map owner commit once to the exact frozen
  build, reporter, simulator/rules, signature authority/configuration, timing, and
  permanent-death semantics;
- `VaultRunLeaderboard` reads the exact permanent character recipe seed, keeps
  the stake, loadout, build, simulator, and policy as separate commitments,
  stores active sessions and per-character bests, and atomically resolves the
  escrow from a scope-authorized terminal receipt.

On Tezos, the player calls `begin_hardcore_run` directly, so the normal signed
operation is the pre-game authorization. Input acceptance must wait until that
operation is confirmed. Terminal receipts are signed over canonically packed,
chain/contract-domain-separated evidence. The signature authority, policy, and
leaderboard are separate contracts so every deployable canonical Micheline
artifact remains below the local 64 KiB gate.

As on EVM, the Tezos run seed is the exact permanent recipe seed written at
mint. Player, assignment epoch, session ID, timestamps, map/build, loadout, and
simulator values remain separately bound in active-run and signed-receipt state;
none can replace or reroll the seed.

## Assembly order for a future deployment

1. Deploy `KeelHold`, `KeelArtifactRegistry`, `KeelIndex`, the
   character collection, and `KeelEquipmentInventory`.
2. Publish immutable Keel object revisions for each starter item's payload
   and metadata.
3. Deploy `VaultItem1155`; create the item types; register those exact item IDs
   as inventory definitions with the same object revisions and metadata digests.
4. Explicitly configure both starter binding policies as `ForeverUnbound`. The
   one-time policy lock prevents either item from becoming bound later.
5. Deploy `VaultCharacterStarterPack` with the price, backpack capacity, and the
   exact two definition IDs.
6. Grant character `MINTER_ROLE` to the starter pack, grant item `MINTER_ROLE`
   to `inventory.reservationEngine()`, and call
   `inventory.setStarterIssuer(starterPack, true)`.
7. Reserve shared Keel mint capacity before advertising supply, then open the
   sale.
8. Publish the exact WASM bytes and its metadata as a SHA-256
   `application/wasm` Keel object revision. Publish and portably bind the map
   build with its content clamp and protected run verifier.
9. Deploy `KeelManager` with the intended three hardware-wallet governors,
   then deploy `VaultRunLeaderboard` and its consumer-bound
   `VaultRunSignatureAuthority`. Through governance, add the separate admin/mod
   wallets and exact machine capabilities; configure each scoreable build once
   and bind hardcore terms before accepting stakes. Test accounts are not
   evidence of Ledger custody.
10. Deploy `VaultAchievementRegistry` against the canonical character and
    `KeelArtifactRegistry`, using `VaultArcadeRegistry` as its staker/controller
    source. Point floor/score achievement definitions at
    `VaultRunLeaderboard`; then publish badge definitions.
11. Deploy `VaultGameCard` with `VaultArcadeRegistry` as active-map source and
    `VaultRunLeaderboard` as run source. Constructor collection checks reject
    mixed systems.
12. Run the referee behind wallet authorization, a durable session store,
    content-addressed evidence storage, verified Keel resolution, and a
    protected EIP-712 signer.

If this system is deployed, production roles belong behind the intended
multisig/timelock. The starter issuer and backpack-capacity manager are
deliberately narrower than catalog, withdrawal, or character authority.

## Verification boundary

No deployment of this system or public-chain acceptance is claimed here. The
implementation proof boundary is local source, compilation, tests, deterministic
replay, and pinned-fork execution. The public testnet verifier performs read-only
observations (`mutation: none`) of pre-existing experimental Sepolia and
Shadownet contracts; those addresses are not a deployment of the item, referee,
leaderboard, achievement, gamecard, or hardcore system described here.

The focused contract and referee suites are:

```bash
forge test --root packages/contracts --match-path 'test/Vault*' -vvv
node packages/vault-referee/scripts/build-wasm.mjs
tsc -p packages/vault-referee/tsconfig.json
node --test tests/vault-referee.test.mjs
PYTHONPATH=packages/tezos packages/tezos/.venv/bin/python packages/tezos/tests/test_vault_hardcore.py
```

It covers:

- exact two-item paid purchase and initial equip;
- unequip, withdrawal, transfer, and new-owner backpack authority;
- complete atomic rollback when item provisioning fails;
- limited-unequip binding;
- item metadata and Keel digest continuity;
- bounded starter capacity and monotonic backpack upgrade;
- floor, backpack, equipped-slot, and typed-attestation achievements;
- dynamic gamecard composition and character-transfer continuity;
- immutable league/WASM configuration and invalid-media rejection;
- deterministic seed stability across re-entry plus stale assignment rejection;
- loadout, seed, player, session, signature, tick, and evidence binding;
- identical browser/server WASM replay and snapshot restore;
- durable CAS session recovery, immutable input-batch storage, transcript
  chaining, checkpoint mismatch rejection, and exact EIP-712 receipt shape;
- confirmed player-authorized hardcore activation before inputs, distinct
  governance/operational rosters, scoped role and machine validation, permanent
  defeat lock, survival release, revocation/regrant nonce invalidation, replay
  rejection, terminal-tick survival, and permanent timeout/abandonment forfeit
  on EVM and Tezos.

## Deliberately separate modules

The reference contracts' pseudo-random paid item selection, token emissions,
escape-rope economics, coin purse, daily reward schedule, and item-shop prices
were not copied. Those implementations were unfinished or unsafe. The current contracts
provide explicit attachment points—starter definitions, item minter roles,
capacity managers, deterministic run evidence, and typed attestations—so those
rules can be added as isolated reviewed modules without changing character
ownership, item metadata, or backpack custody.
