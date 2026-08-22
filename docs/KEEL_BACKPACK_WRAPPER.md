# Keel backpack wrapper

Status: v1 design. No contract in this document is deployed. The claim
separation, the derived-parameter rule, and the trap list are the load-bearing
parts; the interfaces are a sketch that implementation is expected to sharpen.

Every legacy collection gets its own backpack at an address anyone can compute
before it exists. Anyone inits it. Anyone then sends a token to that address and
gets back a wrapper token that renders the collection's art from this chain,
inside the Keel verification shell, with the original contract named and
checked. The wrapper trades with the original inside it. A frozen wrapper can
never give the original back. A wrapper that no longer holds the original —
because the owner took it out, or because the legacy contract reached in and
took it — stops being tradable.

## Product rule

The wrapper makes **two independent claims**, and it must never let a viewer
collapse them into one badge:

1. **Preservation** — these exact bytes are on this chain, and at block `N` they
   were the bytes the original token's route resolved to. This claim is
   permanent. Nothing the legacy contract does later can make it false.
2. **Custody** — the original token is held by this backpack right now, and the
   backpack is the only thing that can move it. This claim is live, and it can
   end.

Almost every failure mode here is a place where one claim is true and the other
is not. A hollow wrapper still preserves the art perfectly. A sealed wrapper
around a token that never had provable art preserves nothing. Both are
legitimate states and both must read honestly.

## One backpack per collection

`KeelBackpackFactory.init(collection)` is permissionless and deterministic:
the clone address is `CREATE2` over `keccak256(chainId, collection)`, so there
is exactly one canonical backpack per collection, computable by anyone before
anyone deploys it. A second one cannot exist, so there is no "which wrapper is
the real one" problem to arbitrate later.

**Init takes no discretionary parameters.** That is the whole reason the
canonical address can be trusted sight-unseen. Everything is derived:

- standard detected by ERC-165 (`0x80ac58cd` → ERC-721 lane, `0xd9b67a26` →
  ERC-1155 lane; neither → revert, see *Trap 6*),
- wrapper token ids mirrored from the original,
- name/symbol derived from the original's,
- every custody rule written into the code, identical for every backpack.

If init could take arguments, the first caller would squat the canonical address
with custody or presentation terms of their choosing and the collection could
never take it back. So it takes none, and there is nothing to choose: every
backpack in the protocol behaves identically, and reading one is reading all of
them.

**Nothing is configurable, because there is no owner.** The backpack is
deployed into the void: no admin role, no `claimCollection`, no upgrade path, no
pause. Presentation does not need one — the wrapper renders whatever the proof
ledger holds for that id, and filling the ledger is permissionless, so the
render route is derived rather than administered. A collection with opinions
about its own presentation contributes to the ledger like anyone else.

An owner could be added later as a strictly-additive lever (publish an alternate
rendition, never change or remove the derived one). Adding an authority later is
possible; removing one is not, so v1 ships without.

### Wrapping is one transfer

```
legacy.safeTransferFrom(you, backpack, tokenId)
    → onERC721Received mints wrapper #tokenId to you, state Sealed
```

No approve step, no separate deposit call, no frontend that has to sequence two
transactions. `approve` + `wrap()` exists as well for contracts that route
transfers oddly, and `data` may carry an alternate recipient.

**The wrap does not wait for proofs.** The wrapper mints Sealed with an empty
proof ladder and pins the block observation of `tokenURI` at that moment.
Filling the ladder is permissionless and asynchronous — every link is content-
addressed or proof-carrying, so no authority is involved and anyone may pay to
prove and store any token's art. A collection's community can preserve the whole
collection without holding any of it. That is a better property than gating the
mint on proofs would give.

### Mirrored ids, and why not ERC-721A

Wrapper `#1234` wraps original `#1234`. One-to-one, self-evident in every
marketplace UI, and the one-wrapper-per-original invariant becomes free because
the id *is* the key — no `underlyingKey → activeWrapper` bookkeeping, no way for
a stale wrapper to claim a token another wrapper holds.

ERC-721A cannot do this. Its batch discount comes from sequential ids and lazily
initialized ownership slots; arbitrary ids are exactly what it does not support.
So the choice is real: **mirrored ids or ERC-721A batch mints, not both.**

Recommendation is mirrored ids. 721A's saving applies only to multi-token wraps
in one transaction, and it charges for it at every subsequent transfer (the
ownership walk-back), which is the operation these tokens are minted to do.
Batch wrapping stays cheap anyway — the expensive part of a wrap is the legacy
`safeTransferFrom`, which 721A does not make cheaper.

### The ERC-1155 lane

Originals there are fungible: amount `N` of id `X`, no per-unit identity. So the
1155 backpack mirrors the id and holds a balance, and two things differ from the
721 lane:

- **Redeem burns the wrapper unit.** No hollow state. With fungible units there
  is no identity worth preserving, and burning keeps a strict invariant:
  wrapper supply of `X` always equals vault balance of `X`. The art stays
  on-chain either way, which is the point.
- **Freeze moves tranches.** Frozen and redeemable units cannot be
  distinguished if they share an id, so freezing burns from the redeemable id
  and mints an equal amount of a derived frozen id (`keccak(FROZEN_DOMAIN, X)`).
  The frozen id has no redeem path at all. Fungibility stays intact within each
  tranche and the two are never confusable.

## What is proven, and by what

The route from a legacy token to on-chain bytes is four links. They do not all
have the same trust root, and pretending they do is the main way this kind of
system lies.

| link | claim | lane | trust root |
| --- | --- | --- | --- |
| A. token → pointer | `legacy.tokenURI(id)` was `U` at block `N` | native EVM read + `blockhash` seal | the chain |
| B. pointer → metadata bytes | bytes `M` are named by CID in `U` | `KeelIpfsCidVerifier` | content addressing (none) |
| C. metadata → asset pointer | `M`'s `image` field names CID `A` | read from `M` itself | none — `M` is already proven |
| D. asset pointer → on-chain bytes | KeelHold object `O` is named by CID `A` | `KeelIpfsCidVerifier` | content addressing (none) |

**There is no oracle, no proving system, and no external trust root anywhere in
this ladder.** A CID is a hash of its content, so every link is a computation
this chain runs for itself. See `docs/KEEL_IPFS_ANCHORS.md`; the encoding
traps there (dag-pb link ordering, omitted empty `Data`, the 262144/262145
boundary) apply unchanged, and `KeelBase58` adds the `Qm...` encoding needed
to compare a computed CID against the string a `tokenURI` actually returned.

Link C looks like it needs a zkVM and does not, which is easy to get wrong. Once
B has established that object `M` is byte-for-byte the token's own metadata,
reading a field out of `M` is reading bytes this chain already holds and has
already verified — not parsing hostile input of unknown provenance. The scanner
refuses to guess: a key appearing more than once in key position reverts rather
than picking one, because a wrong field would bind the wrong art permanently.

**Where the bytes came from never matters.** This is the question the design
turns on. We never establish that a submitter fetched anything from IPFS,
because a CID is not a location — it is the hash. The token committed on-chain
to `ipfs://QmABC`; someone hands us bytes; we hash them the way `ipfs add`
does. If we get `QmABC`, those bytes *are* that content, and no other bytes are.
A gateway, a hard drive, or a stranger are all equally acceptable sources.

For a 10,000-token collection, or any collection whose tokens share one asset,
links B–D are proven once per *asset* and referenced by every id that resolves
to it.

**Oversize assets split across transactions.** CID hashing costs ~7 gas/byte, so
a large file exceeds a block. The IPFS DAG is a Merkle tree, which makes this a
non-problem rather than a limit: hash one 256 KiB leaf per transaction (~1.9M
gas), keep its digest, and combine the leaf digests into the root in a final
cheap call. `KeelIpfsCid.leafDigest` / `rootDigestFromLeaves` are the two
halves, and `test/KeelIpfsCidIncremental.t.sol` pins the property that makes
it safe — incremental hashing must land on exactly the digest the single-shot
path produces, or an incremental verification would approve a CID the one-shot
verifier rejects.

A zk proof was the obvious alternative here, and the arithmetic rules it out:

| | gas/byte |
| --- | --- |
| storing the bytes (code deposit + calldata) | ~216 |
| verifying the CID | ~7 |

Verification is **3% of the bill**. A SNARK would shave most of that 3% while
adding a proving pipeline, a pinned vkey, and a new trust root to a ladder that
currently has none. It only pays off if the bytes stay off-chain — and then
nothing has been preserved, which is the product.

### Which links can actually be followed

Trust is not the limiting factor — coverage is. What a `tokenURI` returns
decides whether the ladder can be climbed at all:

| tokenURI form | status |
| --- | --- |
| `ipfs://Qm…` bare CIDv0 | proven (`proveMetadata`) |
| `ipfs://Qm…/1234.json` directory | proven (`proveMetadataViaDirectory`) |
| `ipfs://bafybei…` / `bafkrei…` CIDv1 | proven (`proveMetadata`) |
| `ipfs://bafybei…/1234.json` CIDv1 directory | refused by name (`CidV1NotYetSupported`) |
| `ipfs://Qm…/a/b.json` nested | refused (`MultiSegmentPathUnsupported`) |
| `https://…` | attested lane only — see *Centralized sources* |
| `ar://`, data URIs | refused |

The directory row matters most: it is how the majority of collections publish,
and it needs no new trust root because the directory is itself a block named by
its own CID. `KeelDagPb` verifies the listing against the CID that named it
before reading a single entry out of it — content addressing, one level up.

CIDv1 carries the same sha2-256 digest in a base32 envelope, so `KeelBase32`
closes it: both file codecs are tried — dag-pb (`bafybei…`, which wraps content
in a UnixFS node) and raw (`bafkrei…`, which does not). Trying both is not loose,
because the codec byte lives inside the encoded string, so a full-string match
implies the codec matched too.

What remains is the CIDv1 *directory*: its link table carries CIDv1 hashes, and
`KeelDagPb` reads only the 34-byte CIDv0 multihash form.

### What is not proven, ever

- **HTTPS-hosted art has no native lane, and zk does not rescue it.** A URL is
  not a commitment, so hashing tells you nothing about what was served. Links
  B–D can then only ever be *attested* — someone saw those bytes at that host at
  that time — labeled `attested-proof`, never green. A zk proof does not change
  this: proving an HTTPS response means proving a TLS transcript, which
  establishes "a server said X at time T". That is an attestation with more
  machinery, not a native lane.
- **A directory CID.** `ipfs://<cid>/1234.json` names a directory, and proving a
  file inside one means walking the directory node. Refused by name
  (`DirectoryCidUnsupported`) rather than waved through.
- **Availability.** A verified CID says the name is correct for bytes the chain
  holds. It says nothing about any peer still pinning the original. Once the
  bytes are in KeelHold this stops mattering, which is the entire point.
- **That the legacy contract is safe.** See *Trap 2*.

## Custody: why the backpack is not a token-bound account

The obvious build is ERC-6551: give each wrapper a token-bound account and drop
the original in. `KeelStakeObjectManager` already carries that wiring
(`BackpackConfig`, `ensureBackpack`).

It cannot express freeze. A generic TBA has an executor — the token owner — and
the whole design of a TBA is that the executor can move what the account holds.
"Frozen" implemented on top of a TBA is a flag that some path can clear, and a
guarantee that depends on a flag nobody can audit in one place is not a
guarantee.

So the original is escrowed **by the backpack contract itself**, and freeze is a
property of the code rather than of state: when a slot is frozen there is no
reachable path that transfers the original out. One withdraw function, one
guard, no admin override, no `recoverERC721` that can reach a tracked slot.
`KeelEquipmentInventory.recoverUntrackedERC721` is the right precedent —
recovery exists, and it can only touch assets that arrived without a deposit
record.

A 6551 account may still be attached as an unproven **side pocket** for extras.
It is presented separately and never contributes to the custody claim.

## States (ERC-721 lane)

```
              safeTransferFrom            freeze
   (none) ──────────────────────→ Sealed ─────────→ Frozen
                                    │  ▲            (terminal)
                           withdraw │  │ redeposit(same token)
                                    ▼  │
                                 Hollow
                                    │
                     custody lost   │  (from any state)
                                    ▼
                               Compromised
```

- **Sealed** — original escrowed, withdrawable immediately by the current
  wrapper owner. Freely transferable. Not a stored value: it is `ownerOf`
  agreeing that the backpack still holds the original.
- **Frozen** — one-way, set only by the current owner, never by an admin.
  Withdrawal reverts forever. The KeelIndex scope is frozen in the same
  call, so presentation and custody freeze together.
- **Hollow** — the owner withdrew the original. Transfers revert. The token is
  bound to the account that emptied it. It can still be burned, and it can be
  refilled by redepositing the same id, which restores Sealed and
  transferability. `hollowCount` is monotonic, so the history stays visible.
- **Compromised** — `underlying.ownerOf(id) != address(this)` with no
  withdrawal on record. Custody was taken, not given. Transfers revert, and the
  owner cannot clear it. This is the state that answers the thing we cannot
  prevent: we can't stop a collection with an admin path from pulling its token
  back out, but we can make the wrapper it left behind permanently untradable
  the instant it happens.

Transfers are gated in `_update`, allowing mint and burn. `custodyOf` re-reads
`underlying.ownerOf` on every call and reports `Compromised` rather than
returning a cached `Sealed` — custody is never answered from memory, so the lock
does not depend on anyone noticing and poking a function. The lock is also
announced through **ERC-5192** (`locked(uint256)` plus `Locked`/`Unlocked`) so
marketplaces render it as locked instead of discovering it as a failed sale.

## Gas

Because the backpack is per-collection and ids are mirrored, the two facts a
generic wrapper would have to store — which collection, which token id — cost
nothing: one is the contract address, the other is the token id. That is what
pays for giving up ERC-721A, and it pays more than the batch discount did.

**A wrap writes no custody storage at all.** Sealed is not a stored value, it is
a derivation: the wrapper exists and `underlying.ownerOf(id) == address(this)`.
So `onERC721Received` is `_safeMint` and an event, nothing else — roughly a bare
ERC-721 mint on top of the legacy `safeTransferFrom` we do not control. The
packed custody word is written lazily, only by the rare operations that need it
(freeze, withdraw, redeposit, pin), and a token that is simply wrapped and held
forever never writes it.

**One word when it is written.** With no timelock there is no
`withdrawalReadyAt`: the custody enum (3 bits), `hollowCount` (16), and
`observedBlock` (48) leave ample room for a 128-bit commitment to
`keccak(blockHash, codeHash)` in the same slot, and ~60 bits spare. The full 32-byte
values go in the event, where log data costs 8 gas/byte instead of 20,000 per
slot, and anyone can verify them against the commitment. Two SSTOREs saved, no
claim weakened — a second preimage on 128 bits is not a threat model.

**The observation pin is separate from the wrap.** Pinning `tokenURI` at wrap
time is not what makes link A honest; recording *which* block was observed is.
So `pinObservation` is its own permissionless call that anyone can batch with
the proof work they were already paying for, and the wrap stays minimal.

**`wrapBatch` recovers what ERC-721A promised.** One 21k base fee instead of N,
one cold `_balances` write instead of N (20k, then 5k), and warm access to the
legacy contract after the first call (2,600 → 100). At N=50 that is roughly 1.9M
gas against 50 separate wraps, which is the same order as the batch discount
721A would have given — without giving up mirrored ids.

**No `ERC721Enumerable`.** It adds ~50–70k per mint and taxes every transfer
forever, to answer a question the indexer and `Transfer` logs already answer.
Nothing else in `packages/contracts` uses it either.

**The real cost is the art, and it is irreducible.** Most NFTs are not layered
or generative — they are a rasterized PNG at the end of a URL, and this system
copies those exact bytes onto the chain. That is the product. It also means
every clever trick is off the table, for one reason: the proof is a CID, the CID
is a hash of the exact bytes, so any transformation breaks it.

- **Re-encoding is forbidden.** PNG → WebP/AVIF would cut 50–80%, and it would
  also mean the bytes on chain are not the bytes the token pointed at. There is
  no proof left to make. This is the obvious suggestion and it is fatal.
- **Brotli does nothing here.** It earns 60–80% on the metadata JSON, on SVG,
  and on HTML, and roughly nothing on a PNG/JPEG/WebP — those are already
  compressed, and the stored form must decompress to the exact original anyway.
  Compress the JSON, expect zero on the image.
- **Per-asset, not per-token** remains true and remains the only structural
  saving: links B–D are proven and stored once per unique asset, referenced by
  every id that resolves to it.

Storing it is already solved and needs nothing new: `KeelHold` takes 23,000
bytes per chunk, 3 chunks per transaction (`MAX_BATCH_SLUGS`, sized to fit
~15M gas), 128 chunks per leaf object for 2.9 MB, and composite objects past
that up to `MAX_READ_DEPTH`. A 200 KB PNG is 9 chunks: three `castSlugs` calls
and a `weldObject`. Identical chunks across assets already collapse to one
pointer, because `_castSlug` is keyed by `keccak256(data)`.

What chunking does not change is the price. The ~200 gas/byte is the EVM's code
deposit cost for `Ingot`, a protocol constant no storage scheme can
route around — splitting the bytes changes how many transactions carry them,
not what a byte costs. That 200 KB PNG is ~46M gas however it is sliced — see
*Cost, and where to run this* for what that is actually worth.

Which leaves the chain and its gas price as the only real variable, and at
current L1 prices that variable is not a problem to solve.

## Traps

**1. The listing race is not a trap, and needs no timelock.** Owner lists a
sealed wrapper, a buyer commits, owner withdraws the original just before
settlement: the `_update` gate makes the sale revert and the buyer keeps their
funds. The residue — a buyer paying gas for a reverted fill — is exactly what
already happens on every marketplace when any seller transfers a listed token
away, and the seller gains nothing by doing it. A two-step timelocked exit would
buy no safety the gate does not already provide, at the cost of the last
configurable parameter in the protocol. There is none: withdrawal is immediate,
and the contract layer is what makes it safe.

**2. Wrapping does not make a legacy NFT safe.** If the original collection is
upgradeable, has an admin transfer path, or has a burn path, it can reach into
the vault. `Compromised` catches the outcome; nothing catches the cause.
`underlyingCodeHash` is pinned at wrap time, which catches metamorphic and
self-destruct cases and **does not catch a proxy implementation swap** — EVM
code cannot read another account's EIP-1967 slot, so per
`docs/KEEL_COLLECTION_VERIFICATION.md` upgrade authority stays
`Not verifiable` until a code-specific adapter supplies reproducible slot
proofs. This is the honest limit of "keeps them safe": the *art* becomes
unremovable, the *token* does not.

**3. The pointer moves after wrapping — and that is correct.** Link A is a
sealed historical observation, not a live invariant. If the legacy `tokenURI`
changes later, nothing proven becomes false; the wrapper is a preservation
snapshot of block `N`. The viewer shows a divergence row comparing the wrap
observation to the current read. Divergence is information, not failure.

**4. Canonical-address squatting.** Handled by construction: one deterministic
address per collection, an init that takes no arguments, and no owner to
inherit. Being first confers nothing at all — the initializer walks away with
exactly what everyone else has.

**5. CID profile.** Content added under a non-default `ipfs add` profile
(CIDv1, raw leaves, different chunker) will not match and must fail rather than
produce a plausible wrong CID. The browser preflight computes the CID with the
same reference implementation before any gas is spent, so profile mismatches
surface as "we cannot name these bytes", not as a failed transaction.

**6. Not everything is ERC-721 or ERC-1155.** CryptoPunks and other
pre-standard collections implement neither interface and cannot be wrapped by
the generic backpack; they need a per-collection adapter, which is out of scope
for v1. Init reverts on an unrecognized standard rather than deploying a
backpack that cannot accept anything. Multi-asset and HTML/interactive
originals are likewise v1-rejected at deposit rather than half-supported.

## Contracts

New:

- **`KeelBackpackFactory.sol`** — deterministic permissionless init, ERC-165
  standard detection, clones of the two implementations.
- **`KeelBackpack721.sol`** — the wrapper ERC-721 and the escrow in one
  contract. Mirrored ids, `onERC721Received` wrap path, the state machine, the
  `_update` gate, ERC-5192, `tokenURI` routed through the presentation route the
  way `KEEL721` does.
- **`KeelBackpack1155.sol`** — the fungible lane. Mirrored ids, redeemable
  and frozen tranches, burn-on-redeem.
- **`KeelBackpackProofLedger.sol`** — shared across every backpack. Per
  `(backpack, tokenId)`, the four-link ladder with a status and lane per link,
  the pinned `(blockNumber, blockHash)` wrap observation, `underlyingCodeHash`,
  and the KeelHold object holding the asset. Append-only, permissionless
  writes, since every link carries its own proof.
- **`KeelPixelFingerprintRegistry.sol`** — format-independent fingerprints.
  A byte hash answers "same file"; this answers "same picture", which is what
  tells a re-encode apart from a repaint when a collection's CID moves. Records
  contradict rather than overwrite: fixed bytes decode to fixed pixels, so a
  second different answer means one of them is wrong.
- **`KeelCreatorCommitmentRegistry.sol`** — the strongest answer for art that
  was never content-addressed. One Merkle root covers a whole collection, so a
  creator publishes once rather than once per token, and each holder supplies a
  proof. Authority is resolved on-chain (`owner()` or `DEFAULT_ADMIN_ROLE`) and
  *recorded*, so a viewer can name it. Append-only revisions, never edits.
- **`KeelUriAttestationRegistry.sol`** — DON-attested digests for locations
  that are not commitments, plus the observation/change history that makes them
  worth something. Trust anchored exactly as `KeelCreReportVerifier` does it:
  only the forwarder may deliver, and the report's workflow identity must match
  the pinned owner/name.
- **`libraries/KeelDagPb.sol`** — reads a UnixFS directory listing back.
  `KeelIpfsCid` builds dag-pb nodes; this parses one, narrowly, refusing
  anything it cannot honestly read rather than half-understanding a node.
- **`libraries/KeelBase32.sol`** — CIDv1 `bafybei…` / `bafkrei…` encoding,
  covering the form `ipfs add` produces by default today. Vectors come from the
  `multiformats` reference library, converted from the same long-published CIDv0
  constants.
- **`libraries/KeelBase58.sol`** — CIDv0 `Qm...` encoding, so a computed CID
  can be compared against the string a `tokenURI` actually returned. Encode
  only: decoding would mean validating an attacker-supplied alphabet and length
  before it could be trusted, while encoding starts from a digest this chain
  computed itself.

Reused unchanged: `KeelHold`, `KeelArtifactRegistry`,
`KeelIpfsCidVerifier`, `KeelAttestedAnchorRegistry`,
`KeelSp1GatewayProofVerifier`, `KeelIndex`,
`KeelHarnessBuilder`, `KeelCollectionVerificationRegistry`,
`KeelLinkRegistry`.

Sketch:

```solidity
// factory
function predictBackpack(address collection) external view returns (address);
function init(address collection) external returns (address backpack);

// KeelBackpack721 — token id mirrors the original
enum Custody { None, Sealed, Frozen, Hollow, Compromised }

function onERC721Received(address, address from, uint256 tokenId, bytes calldata data)
    external returns (bytes4);              // mints #tokenId to from (or data recipient)
function wrap(uint256 tokenId, address to) external;    // approve + pull variant
function wrapBatch(uint256[] calldata ids, address to) external;
function pinObservation(uint256 tokenId) external;     // permissionless, batchable
function freeze(uint256 tokenId) external;              // one-way, owner only
function withdraw(uint256 tokenId) external;           // immediate; reverts when Frozen
function redeposit(uint256 tokenId) external;          // Hollow → Sealed
function locked(uint256 tokenId) external view returns (bool);        // ERC-5192
function custodyOf(uint256 tokenId) external view returns (Custody);  // live ownerOf read
```

## Viewer integration

The shell is not modified. It gains data, and one panel type.

- **Injection fields** (`keel-injection@1`, allowlisted in
  `packages/viewer/src/keel-adapter.ts`): `backpack.custodyState`,
  `backpack.underlyingCollection`, `backpack.underlyingTokenId`,
  `backpack.frozen`, `backpack.hollowCount`, `backpack.observedBlock`,
  `backpack.assetObjectId`, `backpack.proofLadder`.
- **Presentation** (`keel-verification-presentation@1`): one new panel type
  `custody`, beside the existing `staking`. The `object-trail` panel carries the
  four-link ladder. `contract-facets` carries the targeted read of the legacy
  contract — address, code hash, `tokenURI` at wrap vs now, ERC-165 results, and
  whatever the collection-verification registry can prove about route, mint,
  supply, and upgrade authority. Presentation may rearrange these; it may never
  add a claim.
- **Resolver**: `ResolvedBackpackCustody`, alongside `ResolvedIPControl`, and
  included in `ResolutionAudit`.

Seal color follows the existing doctrine, applied to two rows rather than one:

| custody | preservation | seal |
| --- | --- | --- |
| Frozen | native (B–D verified) | green |
| Sealed | native | green |
| any | attested (HTTPS source) | amber, never green |
| Sealed/Frozen | ladder incomplete | amber — custody proven, art not yet preserved |
| Hollow | native | amber with a blocking banner: art preserved, custody void |
| Compromised | native | red — custody contradicted a pinned observation |
| any | failed/contradicted proof | red |

Red stays reserved for a proof that was attempted and failed. Hollow is not a
failed proof; it is a true statement about an empty wrapper.

## The unwrapped frame, and where the artwork actually ends

An emptied wrapper still shows the art. It was preserved and that has not
stopped being true; what changed is that it cannot be traded. So the frame says
so continuously rather than hiding it behind a click.

Drawing that frame around the viewport is wrong, and drawing it around the
painted rectangle is only half right. Most avatar artwork carries its own
backdrop with rounded corners — a Bored Ape is a 631x631 PNG whose coloured
field is a rounded rectangle of radius ~24 with transparent corners. Squaring
that off cuts through the artwork's own shape.

So the shape is measured, not assumed. `measureBackdrop` in
`packages/viewer/src/keel-asset-view.js` takes an RGBA buffer and answers
three questions from the pixels alone:

1. **Is there a backdrop at all?** If the four corners disagree, the art bleeds
   to its corners and there is nothing to trace. A photograph gets the painted
   rectangle, which is the honest answer.
2. **Where does it end?** Walk in from each edge to the first line carrying more
   than a couple of non-background pixels.
3. **How curved are the corners?** Trace each corner's arc as the *uncovered
   length* of each row, then fit `r - sqrt(r² - (r-y)²)` over it. Four corners
   that disagree, or an arc the circle model cannot explain, are refused rather
   than averaged into an invented radius.

Two details carry most of the accuracy. Edges are antialiased, so a fixed
threshold treats a 9%-covered pixel as solid and pulls every arc inward by about
a pixel — which on a shallow curve is most of the answer. Measuring the
uncovered length of a row instead places the edge wherever it actually falls,
with no rounding and no half-pixel convention to get wrong. And the fit is
refined below one pixel, because the true radius rarely lands on an integer at
probe resolution.

Measured against synthetic shapes of known radius it is accurate to 0.15px from
r=3 to r=96, and a hard corner reads exactly zero. See
`packages/viewer/test/backdrop.test.mjs`, which includes a real BAYC PNG.

| ape | shape | radius | field | fit |
| --- | --- | --- | --- | --- |
| 1 | rounded | 24.35px | `rgb(239,151,44)` | 99% |
| 2 | rounded | 23.65px | `rgb(23,230,183)` | 100% |
| 3 | rounded | 24.00px | `rgb(111,93,112)` | 100% |
| 4 | rounded | 24.10px | `rgb(162,229,244)` | 100% |
| 5 | rounded | 24.35px | `rgb(113,114,52)` | 100% |

Five files, five different answers. Nothing about any collection is hard-coded.

**Two places consume it.** The viewer measures for itself at render time and
strokes an SVG path along the result, so it is never trusting a stored number.
The wrapper's `image` field — the static preview a marketplace renders, where no
script runs — reads `Backdrop` off the ledger and emits a `<rect rx>` or an
`<ellipse>`. That record is a claim, not a proof: measuring pixels on-chain
would cost more than the artwork did. It is bounded to shapes that fit the
canvas, restricted to the address that paid to preserve the art, attributed on
the record, and re-runnable by anyone over the same on-chain bytes. Where it has
not been set, the frame is a plain rectangle, because a guessed curve would be a
lie about somebody's work.

## Studio flow

0. **Browser preflight, free.** Read `tokenURI`, fetch metadata and asset,
   recompute both CIDs locally with the reference implementation, and show the
   result before a wallet is opened. A gateway is a transport, never a witness.
1. Wrap: one `safeTransferFrom` to the predicted backpack address, which the UI
   inits first if it does not exist yet. Wrapper arrives in the same
   transaction.
2. Write asset bytes to KeelHold (chunked transactions, resumable). Skipped
   entirely when another token already preserved the same asset.
3. Prove link B (`proveMetadata`), then bind the asset (`bindAsset`). Oversize
   assets verify one leaf per transaction and finalize.
4. Publish the KeelIndex revision.
5. Optionally freeze — presented as terminal, because it is.

Steps 2–4 are permissionless, so the UI must also offer them for tokens the
connected wallet does not own.

## Centralized sources

A `tokenURI` of `https://api.example.com/1234` names a location, not a
commitment. There is no hash to check, the server can serve anything, and it can
serve something different tomorrow. No amount of machinery fixes that, and the
tempting answers are worse than they look:

- **zkTLS** proves a server presenting a valid certificate for that domain
  returned `X` at time `T`. That is an attestation whose trust root is the
  certificate authorities, not a proof of what the token's art *is*. Heavy, and
  it does not answer the question.
- **A DON or oracle committee** makes the same claim with a weaker trust root.

The thing both miss: **for an HTTPS collection, the collection's own admin is the
maximum achievable trust root.** That account already decides what the URL
serves and can change `tokenURI` at will. Nobody can be more authoritative about
the canonical bytes than the party who controls them.

So the useful move is not to prove the fetch, it is to let that admin commit:
one transaction publishing "the canonical bytes for token N are sha256 X",
signed by the same authority that controls the route. After that the HTTPS link
is irrelevant — the commitment is the anchor and bytes verify against it
natively. It costs a creator one transaction and upgrades their whole collection
from unprovable to as-trustworthy-as-the-collection-itself, which is the ceiling.

For collections whose admin will never act, the attested lane is what remains,
and CRE is the rigorous version of it: `KeelUriAttestationRegistry` takes
DON-signed reports through the same KeystoneForwarder path
`KeelCreReportVerifier` already uses. Each node fetches the URL, hashes the
bytes locally, and consensus runs over the 32-byte digest — the payload never
crosses consensus, so the file's size is irrelevant to the DON. CRE's
`identical` aggregator requires every node to agree, so a host serving different
bytes to different nodes fails consensus and produces no report at all; that
silence is a signal a single fetcher would have missed.

The bytes are still checked on-chain. The DON contributes only the target
digest; whether a submitted object matches it is arithmetic this chain does
itself, exactly as on the native lane.

Two rules keep this honest:

- **The attested lane is unreachable where content addressing works.**
  `proveMetadataAttested` refuses an `ipfs://` URI outright
  (`NativeLaneAvailable`). Without that guardrail anyone could quietly trade a
  fact for an opinion.
- **A ladder is only as strong as its weakest link.** `weakestLane` returns the
  minimum across links, never an average, and it is what a viewer should colour
  from. One attested link makes the whole preservation claim attested, however
  many others were recomputed from bytes. `ladderComplete` means every link is
  proven — it does not mean native.

What the registry adds beyond a single fetch is the part that compounds: run the
workflow on a cron trigger and `observations` accumulates while `changes` stays
at zero. "Unchanged across 104 weekly observations" is the strongest statement
that can exist about HTTPS-hosted art, and `changes` rising above zero is the
single most useful fact this system can report about such a collection. Neither
is a CID, and neither ever renders green.

This is exactly why the two claims stay separate. A wrapper around an HTTPS
collection still delivers perfect *custody* — the token is escrowed and
tradability is enforced — and a *snapshot* of bytes someone observed. What it
cannot deliver is "these are provably the token's art", and the viewer has to
say so in those words.

## Cost, and where to run this

All-in on-chain byte cost is roughly **225 gas/byte**: ~200 for the
`Ingot` code deposit, ~16 calldata, ~7 for the CID check. That part is a
protocol constant and does not move.

Gas *price* is the volatile input, so the cost is quoted as gas and multiplied
at whatever the chain is doing, rather than baked into a number that goes stale:

| asset | gas | @ 0.05 gwei | @ 1 gwei | @ 10 gwei |
| --- | --- | --- | --- | --- |
| 100 KB | 23.0M | 0.0012 ETH | 0.023 ETH | 0.23 ETH |
| 200 KB | 46.1M | 0.0023 ETH | 0.046 ETH | 0.46 ETH |
| 1 MB | 236M | 0.0118 ETH | 0.236 ETH | 2.36 ETH |

Measured rather than modelled, from the demo deployment of five real apes
(2026-08-21, mainnet base fee 0.347 gwei):

| | gas | at mainnet |
| --- | --- | --- |
| a full ape end to end — artwork plus all four proof links | ~44M | **0.0153 ETH** |
| artwork alone, 120–171 KB | 27–39M | 0.0094–0.0134 ETH |
| the whole 60-transaction demo, five apes | 127.8M | 0.0444 ETH |

**Quote these against mainnet, never against a testnet.** Sepolia has no fee
market — its base fee sits on a floor that has been running three to four times
above mainnet — so the same deployment billed 0.1645 ETH there. Using that
number would say a preserved ape costs 0.045 ETH when it costs about a third of
that, which is an argument against the product built out of a testnet artifact.

At the low end of that range L1 is simply affordable and needs no workaround —
a typical PFP costs a few dollars to put on chain permanently. At the high end
it is a different product. The design does not depend on which: the same
contracts run on L1 or any L2, and an L2 is always cheaper if a collection wants
to wrap at volume or wants a price that does not track L1 congestion.

The one real exposure is that a large asset spans several transactions, so a
spike mid-upload raises the cost of the remainder. The upload is resumable, so
the mitigation is to stop and continue later rather than to change chains.

For assets too large to store at all — multi-hundred-megabyte video, say —
`KeelLinkRegistry` already models the fallback: put a smaller rendition
on-chain as `Preview` and publish the full one as a verified `HighResolution`
locator. Note what that costs: the preview is a *different file* with a
different CID, so link D proves the preview, not the original, and the wrapper
must say exactly that. A tiered wrapper that labels itself is honest; one that
implies it stored fidelity it did not is the failure mode this whole document
exists to avoid.

## Build order

1. ~~`KeelBackpackFactory` + `KeelBackpack721` with escrow, mirrored ids,
   the `onERC721Received` wrap, the state machine, `_update` gate, and
   ERC-5192 — no proofs.~~ **Done.** `src/KeelBackpackFactory.sol`,
   `src/KeelBackpack721.sol`, `test/KeelBackpack.t.sol` (29 tests).
   Measured: a solo wrap is ~57k gas on top of the legacy transfer, a batch of
   three is ~40% cheaper per token, and the live custody read costs ~5.7k on
   every wrapper transfer — that number is the price of the guarantee and is
   not cacheable by construction.
2. ~~`KeelBackpackProofLedger` plus links A, B, D on the native lanes.~~
   **Done.** `src/KeelBackpackProofLedger.sol`,
   `src/libraries/KeelBase58.sol`, `test/KeelBackpackProofLedger.t.sol`
   (19 tests), `test/KeelBase58.t.sol`. All four links landed native — the
   zk lane was removed rather than deferred.
3. ~~Directory traversal, and the attested lane~~ **Partly done.**
   `src/KeelUriAttestationRegistry.sol` plus `proveMetadataAttested` /
   `bindAssetAttested` / `weakestLane` on the ledger, with the
   `NativeLaneAvailable` guardrail, and the CRE workflow in
   `cre/uri-attestation-workflow` — simulated against live endpoints, with
   digests checked against `shasum -a 256` byte for byte, including a 1.27 MB
   file fetched across 7 Range slices. Route classification lives on-chain in
   `classifyUri` / `classifyToken`, which the workflow mirrors.
   Directory traversal: **Done.** `src/libraries/KeelDagPb.sol`, plus
   `proveMetadataViaDirectory` and `bindAssetViaDirectory`. Next in this step:
   CIDv1/base32, then the incremental leaf-by-leaf lane for assets past the
   single-transaction ceiling (library halves and their equivalence test exist;
   the session bookkeeping does not).
4. `KeelBackpack1155` with tranches and burn-on-redeem.
5. Viewer injection fields, `custody` panel, resolver, seal rules.
6. Studio flow with the browser preflight first.

## Release gates

- Every state transition covered by a Foundry test, including the ones that
  must revert.
- A `Compromised` transition demonstrated against a mock upgradeable collection
  that pulls its token back out of the vault.
- The oversize lane proved against a real >4 MiB asset end to end, not a mock.
- A collection whose metadata is deliberately ambiguous, shown being refused
  rather than guessed at.
- The CRE workflow simulated end to end before any testnet deploy.

## Measured against a real collection

`test/KeelBaycDirectory.t.sol` runs the directory lane against Bored Ape
Yacht Club's actual blocks — `tokenURI(1)` is
`ipfs://QmeSjSinHpPnmXmspMjwiXyN6zS4E9zccariGR3jxcaWtq/1`, a CIDv0 directory,
the shape this document claimed was most common. The gateway that served the
fixtures is not trusted for any of it: every block is re-hashed on-chain and
compared to the CID mainnet commits to.

Two things a mock would never have shown:

- **The directory is one flat dag-pb node with 10,000 links**, far past the
  174-link DAG width, and not HAMT-sharded. `KeelDagPb`'s original 1,024-link
  cap would have rejected the most-referenced NFT collection there is.
- **Scanning it costs ~44M gas**, which does not fit in a mainnet block. The
  directory lane silently would not have worked for high token ids. Hence
  `linkAt`: the caller passes the entry's byte offset and the contract verifies
  it rather than trusting it — the node's CID is checked first, so its bytes are
  fixed, and a hint pointing anywhere else either fails to parse or yields a
  different name and is refused. The hint can only save work, never change the
  answer. Measured: **under 100k gas instead of 44M**, same digest.

## Renditions, and the second axis

Full on-chain is always offered and always the default. Nothing below replaces
it; a collection that wants the byte-exact original can always have it, at any
size it can afford.

For files large enough that storing the original is genuinely out of reach, a
**rendition** is offered instead — a losslessly re-encoded copy (WebP), smaller,
with a DON-verified claim that it decodes to the same pixels as the file the
token committed to. Each node decodes both images and agrees on a hash of the
pixel buffer; lossless decode is exactly specified, so honest nodes converge and
`identical` consensus applies. This needs a Go workflow — `image/png` is in the
standard library and `golang.org/x/image/webp` reads VP8L — because the
TypeScript runtime is QuickJS with no image codecs, and it is bounded by WASM
memory, since a 4000x4000 RGBA buffer is 64 MB.

**A rendition is labeled differently and never renders green.** Not as a matter
of taste: it is a claim about *different bytes*, and no amount of evidence makes
different bytes the same bytes.

That is the modeling point, and it is easy to get wrong. Preservation has two
independent axes, and one enum cannot carry both:

| axis | question | values |
| --- | --- | --- |
| **kind** | what are these bytes? | `Original` / `Rendition` |
| **lane** | how well is that established? | `Native` / `Committed` / `Attested` |

`weakestLane` answers the second and must never be asked the first. A rendition
verified by a DON and an original verified by a DON share a lane and are not the
same claim — one is the work, the other is a faithful copy of it. So the ladder
carries `assetKind` beside the lane, the viewer shows both, and a rendition
always names the original's CID so the difference stays legible rather than
being something a reader has to infer.

Where the threshold sits — the file size at which a rendition is offered — is a
front-end policy and stays out of the contracts. A tunable in a canonical
contract is a governance surface, and the same reasoning that keeps `init`
parameterless keeps this out of the chain.

### What this is not

- **Not a way to make ordinary art cheaper.** At current gas a 200 KB original
  is single-digit dollars, and trading the strongest claim in the system for
  ~25% off that is a bad deal. The rendition path exists for files that cannot
  go on-chain at all, not for files that would rather not.
- **Not a downscaled preview.** Downscaling is not pixel-identical, so the claim
  would have to be perceptual similarity, which has no clean threshold and does
  not belong in a proof. A thumbnail is a display asset, labeled as such,
  claiming nothing.

### The part worth having regardless

A pixel-buffer hash is format-independent, which is something no byte hash can
be. Recorded *alongside* link D rather than instead of it, it costs nothing and
answers a question the byte proof cannot: whether a collection that changed its
CID changed the encoding or the art. A divergent CID says something moved; a
matching pixel hash says it was only the encoding, and a differing one says the
picture itself changed. That is additive, so it cannot weaken anything.

## Known limitations

Proving is write-once and permanent, which is the design and not a gap: the
bytes land on this chain once, and what the legacy route does afterwards cannot
make an already-proven ladder untrue. `routeDiverged` reports a route that moved;
nothing needs re-proving.

- **Hosts that ignore HTTP Range.** The CRE HTTP capability caps a response near
  250 KB. The cap is per request, so the workflow pulls large bodies in Range
  slices and folds them into a streaming sha256 — verified against a 1.27 MB
  file across 7 slices. A server that ignores `Range` returns the whole body and
  fails the cap, and the workflow refuses rather than reporting a partial hash.
- The rendition lane above is partly built: `KeelPixelFingerprintRegistry`
  exists and is tested, and it is already useful on its own as the additive
  fingerprint. Still missing are the Go CRE workflow that produces the
  fingerprints and the `assetKind` field that would let a rendition be bound as
  an asset.
- CIDv1 *directories* and nested paths are refused by name, and are eligible for
  *neither* lane: they are content-addressed data this contract cannot read yet,
  and attesting them would trade a permanent claim for a temporary convenience.
  `classifyUri` is what keeps that distinction honest — "starts with `ipfs://`"
  is not the same set as "provable here", and conflating the two drops those
  collections through both lanes with nowhere to go.
- ERC-1155 originals are rejected at init.
- An independent browser/RPC receipt per deployment. A source build and a green
  unit test do not prove a deployed contract.
- A wrapped token whose legacy `tokenURI` is changed after wrapping, shown
  rendering correctly with a visible divergence row. This is the demonstration
  that sells the product; it should exist before launch, not after.
