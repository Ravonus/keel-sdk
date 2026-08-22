# Vault Cross-Chain Release Gauntlet

**Status:** active — the first Sepolia builder lane failed independent review;
no release approval has been issued.

This ledger is the acceptance contract for the Vault character, weapon,
Keel viewer, metadata, mint, escrow-staking, map-injection, and cross-chain
data system. A build, passing unit test, HTTP 200, marketplace listing, or
builder-authored report is not release proof by itself.

## Non-negotiable process

1. A builder never approves its own implementation.
2. Every approval comes from a separate critic using the exact source and
   deployment fingerprints supplied by the builder.
3. A critic that lacks research, screenshots, RPC evidence, receipts, or a
   reproducible test path returns `NEEDS_EVIDENCE` and gathers that evidence;
   it must not infer a pass.
4. Each network is tested on its real public test environment, from a fresh RPC
   read and a fresh browser session.
5. Any mismatch between source, runtime bytecode, metadata, viewer bytes, or
   screenshots invalidates the approval.
6. No testnet contract in this gauntlet is source-verified on an explorer.
7. Old tokens remain deterministic when assets or catalog revisions are added.

Draft/rejected build locks are not protocol history. This project has not gone
live, so the first immutable selection/catalog/asset epoch begins only when a
candidate receives user acceptance, independent critic approval, and a recorded
published fingerprint. Failed candidates remain in evidence but are not kept as
loadable "legacy" revisions.

## Product invariants

- A minted character stores compact generation arguments and pinned revisions,
  not duplicated sprite, viewer, sound, or effect assets.
- One collection-scoped Keel viewer and seed set serve every character mint.
  A per-token viewer, seed set, or copied manifest is a scaling failure; the
  verified request anchor supplies `$anchor.tokenId` at read time.
- Shared assets live in Keel/content-addressed storage and are selected by a
  deterministic, append-safe recipe.
- The standard token metadata contains the character name, complete visual
  attributes, weapon attributes, particle/effect attributes, and attack sound.
- Standard ERC-721 `image` metadata renders the actual character and weapon,
  not a generic collection poster. Its pixels come from a shared pinned
  thumbnail codex/renderer or a digest-equivalent delivery mirror; no mint
  duplicates the shared atlas bytes. `animation_url` must be public/on-chain
  and can never contain localhost.
- The animation/viewer reconstructs the floating Orb character, detached
  animated weapon, masks, targeted color regions, particles, effects, and
  weapon-specific sound from chain-derived data.
- Staking takes real custody of the NFT and exposes the exact character render
  recipe to the selected map; unstaking returns the same NFT to the staker.
- New asset families and revisions cannot reroll existing tokens.
- The public sprite-codex pipeline covers every approved sprite class, not only
  weapons: character layers/directions/actions, tiles, floors/walls, foliage,
  environment props, pickups, projectiles, mobs, bosses, particles, world FX,
  and sprite-based UI. Candidate/rejected art is inventoried but never silently
  promoted into an active selection pool.
- Atlases are split by logical cell geometry and loading lifecycle. The
  standalone character graph can load while unstaked without map-only bytes;
  the staked map graph composes that pinned character graph with shared
  weapon/projectile/FX and world bundles. Shared dependencies are identified by
  immutable bundle roots and are not copied into each consumer.
- The character atlas stores the approved Orb base pixels plus the authored
  `componentFrames` and `skinFrames` semantic targeting recipe. Raw material or
  panel masks are build inputs/debug layers, never presented as collectible
  character skins. A passing preview must reconstruct the finished named skin
  styles (`metal`, `brushed`, `battle-worn`, `polished`, `oxidized`, and
  `prism-light`) with the same pixels as the canonical viewer.
- Every weapon frame carries its authored semantic panel/region overrides in
  the codex. Acceptance requires both a finished attribute-colored weapon and
  a labeled per-panel debug view; drawing only the grayscale atlas does not
  prove the masks are present or consumed.
- World extraction uses reviewed per-frame rectangles, transparent padding,
  and stable authored pivots. Fixed contact-sheet grids are not accepted when
  they clip an asset or include a neighboring asset. Non-tile sprites fail the
  build if unrelated alpha components are present or opaque pixels touch a crop
  boundary without an explicit edge declaration.
- Open-door frames preserve true alpha in the authored opening and are tested
  over a contrasting background. World particles/FX are named multi-frame
  animation loops with timing metadata and non-identical frame digests; a still
  image labeled as an animation is a release failure.
- FX may use static sprite particles, animated grayscale sprite masters, a
  bounded deterministic emitter, or a composition of those modes. Each map
  pins an FX catalog revision and derives its emission trace from the map seed,
  event kind, stable world/entity index, and emission ordinal. The same map
  replays byte-identically, different map seeds produce materially different
  palettes/motion/density, and appending a preset cannot reroll an old map.
- Ethereum and Tezos use the same logical schemas, recipe digests, asset
  digests, attribute names, and user-visible behavior. Chain-specific token and
  transfer primitives may differ, but security properties may not silently
  weaken.
- Collection verification separates the permanently bound Keel `tokenURI`
  route from mutable, version-tracked presentation revisions. Official hooks
  are the automatic path for new contracts; exact-code public adapters and
  evidence receipts cover reviewed existing contracts. Without either, content
  bytes may verify while route, mint, supply, and upgrade controls remain
  explicitly `Not verifiable`.
- Mint and supply are independent collector facets. The proof reports current
  mint mode and every change authority, plus outstanding/lifetime/burned/max/
  reserved/remaining supply where each counter is actually provable. Unknown
  counters never become zero. Green means the stated fact and control boundary
  are proven, amber names a remaining change authority, and red means an
  attempted proof failed—not merely that a public mint or tracked revision is
  active.

## Evidence states

Every row is one of `PENDING`, `BUILDER_PASS`, `CRITIC_PASS`, `FAIL`, or
`NEEDS_EVIDENCE`. Only `CRITIC_PASS` satisfies a gate.

| Gate | Builder evidence | Independent critic | State |
| --- | --- | --- | --- |
| Solidity unit/fuzz/invariant tests | 173/173 passed on remediation v2, but the same critic rejected pinned-map and asset-scaling behavior | separate Ethereum critic | FAIL |
| Sepolia deployment/source match | previous addresses are rejected; remediation v3 has not deployed | separate Ethereum critic | FAIL |
| Sepolia mint and deterministic recipe | RPC reads + repeat comparison | separate Ethereum critic | PENDING |
| ERC-721 marketplace metadata | localhost animation URL and viewer/metadata trait mismatch | separate Ethereum critic | FAIL |
| Viewer reconstruction | on-chain bundle digest passed; attribute parity failed | separate browser critic | FAIL |
| Weapon attributes/effects/sounds | four-weapon traces + captures | separate browser critic | PENDING |
| Escrow stake/unstake | reentrant exit fixed, but remediation v2 silently moved existing stakers to the latest map build | separate Ethereum critic | FAIL |
| Append-safe catalog evolution | stable IDs passed, but revision publication copied O(n) storage beyond realistic transaction gas | separate Ethereum critic | FAIL |
| Public sprite-codex library | hardened compiler/runtime/CLI, deterministic artifacts, exact 36-frame mask parity, clean browser render | separate package critic | CRITIC_PASS |
| Complete Vault asset graph | standalone character plus geometry-compatible weapon/world bundles, immutable dependency roots, canonical/candidate inventory | separate asset-graph critic | PENDING |
| Atlas append/retire stability | pinned render comparison across revisions | separate package critic | PENDING |
| Tezos local compile/scenarios | compiler hash + scenario receipts | separate Tezos critic | PENDING |
| FA2/TZIP metadata parity | raw storage/views + schema comparison | separate Tezos critic | PENDING |
| Shadownet deployment | operation hashes + RPC reads | separate Tezos critic | PENDING |
| objkt Shadownet rendering | marketplace + direct viewer screenshots | separate browser critic | PENDING |
| Tezos staking/map injection | custody + runtime recipe operations | separate Tezos critic | PENDING |
| Cross-chain anchor/adapters | codec/first Ethereum anchor passed; operational two-source locator and Vault/Tezos integration changed afterward | separate security critic | PENDING |
| Collection route/mint/supply verification | official hook, exact-code adapter, pinned-block receipt, collector facet UI, and no-hook unknown lane | separate contract + browser critic | PENDING |
| Optional Ord-hosted data carrier | exact stored-byte digest/length/availability must match the ETH/Tezos Keel content record; no Ord token/runtime parity | ETH/Tezos integration critic | PENDING |
| Final end-to-end release | complete immutable evidence index | fresh final judge | PENDING |

## Public test environments

- Ethereum: Sepolia (`chainId 11155111`).
- Tezos marketplace: <https://shadownet.objkt.com/>.
- Tezos marketplace API: <https://data.shadownet.objkt.com/>.
- Tezos faucet: <https://faucet.shadownet.teztnets.com/>.
- Ord-hosted bytes are optional storage only. The Vault release does not mint
  or execute an Ordinals version of the character system. Ethereum and Tezos
  consumers accept those bytes only when digest and decoded length match their
  pinned Keel content record; an inscription reference alone is not proof.

## Cross-chain trust requirement

The canonical portable identity of viewer data is a versioned manifest digest,
asset digests, recipe schema version, and source-chain anchor. Mirroring bytes
does not change identity. An Ethereum burn address, a Tezos transaction, or an
Ordinals inscription reference is only a signal unless the consuming chain
verifies the relevant consensus/state proof or relies on an explicitly named
bridge/oracle.

The implementation report must classify every route as one of:

1. **Native verification:** the destination contract verifies the source-chain
   proof under a pinned finality/reorg policy.
2. **Optimistic verification:** a challenge window and bonded actors secure the
   claim.
3. **Attested verification:** a named multisig/oracle/bridge signs the claim.
4. **Client verification:** contracts pin hashes while clients independently
   retrieve and verify bytes; availability and source-chain inclusion are not
   contract-verified.

No route may be called fully trustless unless its destination-chain verifier and
data-availability assumptions are exercised by adversarial tests. The report
must also define an append-only upgrade path from the deployed route to a
stronger verifier without changing existing content identities.

## Current Sepolia builder lane

The following deployment was stopped after its independent critic found release
blockers. It is retained only as failed-lane evidence and is **not approved**:

| Component | Address |
| --- | --- |
| HarnessRegistry | `0x2915a354d611a4fc3cd9d38f5984ee9b1b97dddf` |
| SeedRegistry | `0xf5486680a2b7ecc789ec4229465bf7afbcc7b031` |
| MetadataRenderer | `0x3395d3d67627e4be875ade294e32d73c8f7b448b` |
| Character collection | `0xcc7534a2284da2c8fc322f8b3e2195a36cfbb998` |
| CharacterRegistry | `0x1049e7ce02a92a2527c0f328da8e4aa260fc6042` |
| ArcadeRegistry | `0x3a011511f9a05e8550866dd9fbe9d64b16218ac7` |
| SpriteAssetRegistry | `0x0fc20431f3159e8c5f95d1db7b265a73e1179b52` |

Mint transaction:
`0x930d64d24d1d95620e16269a5cec0d990573c500c908193d7ccb9ef521d9019c`.

At the audit boundary, the collection registry pointer was zero, the catalog was
irreversibly frozen at revision 1, the map build revision was zero, and the
character was not staked. The deployment also reused one monolithic viewer
object for catalog, metadata, masks, FX, sound, and game roles. These addresses
must not be reused as release candidates.

The remediation lane must first prove atomic mint+recipe registration,
metadata/viewer trait parity, revision-pinned sprite-codex selection,
append/retire stability, reentrancy-safe escrow exit, and real map consumption
of the character recipe. Only then may it receive a fresh Sepolia deployment,
RPC/browser evidence bundle, and separate critic verdict.
