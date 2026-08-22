# Legacy Repository Review

Reviewed sources:

- `Ravonus/Keel-demo`
- `Ravonus/oca_whitepaper`
- `Ravonus/AboutOCA`
- `Ravonus/oca_snake`
- `Ravonus/Mafia`

The repositories contain a coherent protocol idea spread across proofs of concept. This report separates the valuable design lineage from implementation patterns that should not be redeployed.

## Valuable ideas retained

- Browser rendering as the primary presentation layer rather than an image-only NFT assumption.
- Reusable scripts, sprites, shaders, procedural audio, SVG fragments, and libraries.
- Standard, layered, hybrid, preview, and high-resolution object modes.
- Content hashes and visible storage provenance.
- Multi-call construction for data too large for one contract operation.
- Parent objects, history, compatibility ranges, and owner/creator upgrade choices.
- Compact component identifiers and bitmap trait state.
- One manager capable of public, signed, token-gated, airdrop, claim, and staged distribution.
- Interactive on-chain HTML/JavaScript demonstrated by Keel Snake.

## Critical/high-risk legacy findings

### Unrestricted or overly broad mint/reveal paths

Several experimental contracts exposed test minting, reveal, or state-changing helper paths without production authorization. A public test mint is equivalent to losing supply control. The modern contracts have no test methods and use explicit roles or target authorization.

### `tx.origin` authorization and contract-wallet exclusion

Legacy mint, token, and staking code used `tx.origin == msg.sender`. This does not establish meaningful identity, blocks Safe/account-abstraction wallets, and creates phishing/composability hazards. It is prohibited by the new static checks.

### Raw signatures without typed domain separation

Legacy access paths assembled ad hoc hashes and called `ecrecover`. Domain fields were incomplete or implicit, signer roles were hardcoded, and smart-contract signatures were unsupported. The rewrite uses EIP-712 plus `SignatureChecker` and binds campaign, account, signer, price, quantity, nonce, deadline, chain, manager, and optional payload context.

### Weak block-derived randomness

Reveal and role assignment mixed timestamps/block values with user data. Block producers and callers can influence these values; they are not secure randomness. The modern protocol does not claim on-chain randomness. Projects that need unpredictable assignment should integrate a reviewed VRF/commit-reveal module outside the presentation core.

### Public inventory mutation and stage complexity

The old distribution manager exposed inventory-changing helpers and derived changing drop modes through difficult timestamp loops. That enlarged the attack surface and made accounting hard to reason about. `OneMintController` now uses immutable ordered stages sharing one allocation, while `KeelMintGate` remains the composable campaign engine. All accounting changes happen inside guarded mint transactions.

### Cross-contract transfer coupling

Some ERC-721 transfer paths called project-specific external contracts. A revert or misconfiguration in the dependency could brick ordinary transfers. The new ERC-721 transfer path is standard; game/staking state belongs in separate contracts and hooks must not be mandatory for ownership transfer.

### Monolithic generated-art contracts

Large SVG arrays, traits, reveal state, minting, game state, and metadata generation lived together. This raises code-size, deployment, audit, and upgrade risk. The new manifest and chunk store make render assets data; the token contract stores only presentation pointers and conventional metadata.

## Medium-risk/correctness findings

- Uninitialized memory arrays and storage pointers in manager/rule-set code.
- Supply comparisons with off-by-one behavior.
- Reward formulas mixing seconds, days, and repeated multipliers.
- Staking loops that validated many IDs but operated on only the first.
- Hardcoded privileged addresses and infrastructure URLs.
- Inconsistent project/drop ID bookkeeping.
- Missing existence checks and controller lifecycle controls.
- External self-calls used to reach public helper functions.
- Ether overpayment accepted without a deterministic refund rule.
- ERC-20 assumptions that did not account for nonstandard transfer behavior.
- O(n) owner enumeration and custom ERC-721 variants with incomplete interface behavior.

## Frontend/data pipeline findings

### Character count used as byte count

The Keel demo split JavaScript strings by character positions while contract/code limits are byte based. Multibyte UTF-8 could exceed expected limits or split unpredictably. The new builder encodes first and chunks bytes.

### Only the first generated chunk was submitted

A standard-object upload path calculated an array of chunks but sent only index zero. Large assets were silently truncated. The new upload plan writes every chunk as an explicit file/transaction item and tests reconstruction.

### State-changing work during React render

Some components packed state or triggered setters/read-dependent work during render, risking loops and stale transactions. The new packages are framework-neutral pure functions; application code performs reads/writes in explicit actions.

### Opaque bit packing

The compact viewer descriptor was clever, but meaning lived in component comments and UI convention. The new manifest uses typed fields first. Legacy uint48 packing remains as a validated utility only when gas savings justify it.

## Contract replacement map

| Legacy area | Replacement |
| --- | --- |
| Keel manager object/link/viewer ABI | `KeelHold`, `KeelIndex`, typed Keel Object/Viewer/Link/Seed registries, and `keel.runtime@1`. |
| `OneMint` staged drop manager | `OneMintController` for shared-allocation stages; `KeelMintGate` for modular gates/signers. |
| Raw signed claims | EIP-712 `MintAuthorization`. |
| Custom ERC721B/C/G/S/SB experiments | OpenZeppelin-based `KEEL721`. |
| Monolithic SVG contracts | Typed resources and recursive immutable objects. |
| Backpack/equipment transfer coupling | Separate escrow inventory following live character ownership; no KEEL721 transfer hook. |
| Mandatory transfer/game coupling | Optional independent game/staking contracts. |
| Keel Snake inline runtime proof | Sandboxed verified viewer and example interactive artifact. |
| QTER/controller reward experiments | Out of protocol core; rebuild as a separately audited economics module. |
| Crypto Mafia rules/game manager | Out of presentation core; use explicit game modules and verifiable randomness. |

## What was intentionally not ported

- Legacy token economics and emissions.
- Insecure pseudo-random reveal/game assignment.
- Project-specific Mafia/Snake gameplay state.
- Hardcoded administrator addresses.
- Custom hand-rolled ERC-721 implementations.
- Unfinished auction and proof-of-work mint branches.
- Mandatory staking behavior inside ownership primitives.

Those can be rebuilt as separate modules after their rules are specified and tested. Keeping them out of the core is a security improvement, not lost functionality.
