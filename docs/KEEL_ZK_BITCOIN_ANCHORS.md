# Keel ZK Bitcoin Anchors

A third anchor verifier class: instead of trusting a DON's reading of an explorer
API, prove the whole claim in a zkVM and let Sepolia check the proof.

Sits alongside, not instead of, the existing verifiers. `registerAnchorVerifier`
is append-only, so this lands as a new verifier id with its own trust class and
nothing existing changes.

| verifier | trust root |
| --- | --- |
| `NATIVE_VERIFIER_ID` (class 1) | same-chain hash linkage |
| `KeelCreReportVerifier` | DON honesty **and** mempool.space honesty |
| `KeelZkAnchorVerifier` (this) | Bitcoin proof-of-work, from a pinned checkpoint |

## The claim being proven

> The bytes whose SHA-256 is `anchorRoot` were inscribed in a Bitcoin
> transaction included in a block that sits on a valid proof-of-work chain
> descending from checkpoint `C`, buried under `N` blocks of additional work.

Everything in that sentence is checked inside the guest program. The only input
taken on faith is `C`, and `C` is baked into the vkey — see *Trust root* below.

## Trap 1: txid does not commit to the witness

Inscriptions live in the taproot **witness**. A block's merkle tree commits to
**txid**, and for a segwit transaction the txid is computed over the
serialization *without* the witness. So "txid is in the block merkle root" says
exactly nothing about the inscription payload. A verifier built the obvious way
accepts forged content.

The real path needs two merkle proofs and a coinbase parse:

1. `wtxid = SHA256d(tx serialized WITH witness)` for the inscription tx.
2. Prove `wtxid` into the **witness merkle root** (coinbase's wtxid is `0x00..00`).
3. Prove the **coinbase txid** at index 0 into `header.merkle_root`.
4. Parse the coinbase outputs, find the `OP_RETURN` whose scriptPubKey begins
   `6a24aa21a9ed`, take the 32 bytes after it as `commitment`.
5. Check `SHA256d(witness_merkle_root || witness_reserved_value) == commitment`,
   where `witness_reserved_value` is the coinbase's 32-byte witness stack item.
6. Only now parse the witness script for the ordinal envelope.

Steps 3-5 are what actually bind witness data to the block header. Skipping them
is the difference between a proof and a decoration.

## Trap 2: the retarget off-by-one

Difficulty retargets every 2016 blocks, but the timespan is measured across
**2015** intervals, not 2016:

```
actual_timespan = timestamp[h-1] - timestamp[h-2016]
actual_timespan = clamp(actual_timespan, 1209600/4, 1209600*4)
new_target      = old_target * actual_timespan / 1209600     (capped at pow_limit)
```

That off-by-one is consensus. Getting it "right" breaks against real headers.

Two further details that bite:

- `nBits` is a compact mantissa/exponent encoding and is **not** injective over
  targets. Compare by re-encoding the computed target to compact form and
  checking equality with `header.bits`, never by comparing expanded targets.
- Between retargets every header's `bits` must be byte-identical to the epoch's.

## Trust root: a self-advancing anchor set

Validating from genesis is ~920k headers, order 2.3B cycles. Not a laptop job and
not necessary. Proofs instead extend from an **anchor point**:

```
AnchorPoint = { hash, height, bits, timestamp, epoch_start_timestamp }
```

Crucially the anchor is a **runtime input to the guest, not a compiled-in
constant**. The guest proves only "these headers descend from the anchor you
named" and makes no claim that the anchor is trustworthy. Deciding which anchors
count is the contract's job.

`KeelZkAnchorVerifier` holds a set of accepted anchor points. It is seeded
once at deployment with a pinned checkpoint, and `lockConfiguration()` then
freezes seeding permanently. After that the set grows **only as a side effect of
valid proofs**: every proof that verifies also establishes its tip, and that tip
is recorded as a new anchor point.

So the trust root advances without anyone's transaction. No operator key sits in
the loop after deployment, and there is no periodic "re-cut the checkpoint"
chore — the frontier moves whenever anybody anchors anything.

### Why the anchor must be checked field by field

A prover may name any origin at all; naming a fake one is free. The contract is
what makes the proof mean something:

```solidity
AnchorPoint memory origin = _anchorPoints[values.originHash];
if (!origin.exists) revert UnknownOrigin(values.originHash);
if (origin.height != values.originHeight || origin.bits != values.originBits
    || origin.timestamp != values.originTimestamp
    || origin.epochStart != values.originEpochStart) revert OriginRecordMismatch();
```

Checking only the hash would be a hole: a prover could keep a real block but
pair it with fabricated `bits`, defeating the difficulty rules the guest
enforces. Both cases are covered by tests.

### Why the epoch-start timestamp is carried

An earlier design required the anchor to sit on a retarget boundary, because
validating the first difficulty adjustment in range needs the timestamp of the
previous epoch's first block — and a boundary anchor *is* that block.

That restriction is incompatible with recording arbitrary proven tips, which
land wherever they land. Carrying `epoch_start_timestamp` in the anchor record
lifts it: any block can serve as an anchor. A boundary anchor must still declare
itself as its own epoch start, and claiming otherwise is rejected as
self-contradictory.

### Reorgs need no administrator either

Anchor points are **never removed**, and recording only ever moves the frontier
forward. If the newest recorded tip turns out to sit on an abandoned fork, no
valid chain extends from it — and provers simply fall back to an older accepted
point, which is still there. A reorg costs progress, never liveness, and never
requires an admin transaction. The seed remains a usable origin forever.

Cost is linear in `height - origin_height`, and because the frontier advances on
its own, proofs stay cheap indefinitely rather than degrading between manual
re-cuts.

## Public values

Committed by the guest, hashed into the zkVerify leaf:

```rust
struct PublicValues {
    // The anchor this proof extends from; the contract must already hold it.
    origin_hash: [u8; 32], origin_height: u32, origin_bits: u32,
    origin_timestamp: u32, origin_epoch_start: u32,

    // The tip this proof establishes; the contract may record it as the next
    // anchor. This pair is what makes the trust root self-advancing.
    tip_hash: [u8; 32], tip_height: u32, tip_bits: u32,
    tip_timestamp: u32, tip_epoch_start: u32,

    anchor_root:     [u8; 32],  // == registry expectedDigest
    payload_len:     u64,       // == verifiedByteLength
    block_hash:      [u8; 32],
    block_height:    u32,
    confirmations:   u32,
    cumulative_work: [u8; 32],  // U256 BE, origin..tip
}
```

Deliberately **not** bound to `(anchorId, nonce, taskIndex)`. The proof asserts a
fact about content, not about a request, so the adapter matches `anchor_root`
against whatever task expects that digest. This makes proofs reusable and
cacheable across tasks — the same inscription never needs proving twice — and
costs nothing in soundness, because a task is only satisfied by a proof of the
exact digest it asked for.

`sourceNetwork` is handled by the checkpoint, not a public input: a mainnet
checkpoint cannot chain to signet headers. The adapter maps network → pinned
checkpoint/vkey pair.

`cumulative_work` rather than raw confirmations is the honest security metric,
and difficulty is already validated, so summing it is nearly free. The adapter
enforces a per-family minimum.

## On-chain shape

`KeelZkAnchorVerifier` mirrors `KeelCreReportVerifier` against the same
registry interface (`anchorVerificationContext` / `submitTaskResult`), with one
simplification worth noting: **submission is permissionless.** There is no
forwarder to pin and no workflow identity to match, because the proof is
self-authenticating. Anyone can relay it.

```solidity
function submitZkAnchor(
    bytes32 anchorId,
    uint32  taskIndex,
    PublicValues calldata pv,
    bytes calldata proofData
) external;
```

The verifier holds only *policy* — checkpoint, digest match, confirmation and
work floors — and delegates *how the proof was checked* to a pluggable
`IKeelAnchorProofBackend`. The one-way `lockConfiguration()` pattern carries
over, freezing the backend and checkpoint instead of the forwarder and workflow
identity.

### Why the backend is pluggable

The destination chain decides which verification infrastructure exists, and the
two options have very different reach and cost:

| backend | cost | available |
| --- | --- | --- |
| `KeelZkVerifyProofBackend` | a Merkle path — sub-cent | where zkVerify relays; **not Ethereum mainnet** |
| `KeelSp1GatewayProofBackend` | ~300k gas (pairing check) | every chain SP1's gateway is on, mainnet included |

SP1's gateway is CREATE2-deployed at `0x397A5f7f3dBd538f23DE225B51f532c34448dA9B`
(Groth16) — the *same address* on Ethereum, Base, Arbitrum, OP, BSC and others.
So a Keel registry can settle proofs anywhere; zkVerify is the cheap path
where available, not the only path.

**Each backend pins its own program key, and they are not interchangeable.**
zkVerify wants `SP1VerifyingKey::hash_babybear`; the SP1 gateway wants the bn254
`vk.bytes32()`. Same guest program, two key representations — a single shared
key field across backends would be wrong by construction.

The proof formats differ too (`shrink` vs Groth16 wrap), but both derive from
the same compressed proof. The expensive work — proving the guest execution — is
shared, so settling on several chains does not multiply proving cost.

## Measured cost

Measured, not estimated — against a real 51-byte mainnet inscription at height
959,700, 84 blocks past the checkpoint, with 20 confirmations:

| | cycles |
| --- | --- |
| 104 headers + both merkle proofs + envelope + payload | **749,717** |

Dividing that total by the header count gives ~7,200 per header, and that number
is wrong — it charges the fixed cost of the inclusion proofs to the header walk.
Run `--headers N` at several counts and the two costs separate:

| headers | cycles | delta |
| --- | --- | --- |
| 84 | 632,539 | |
| 94 | 691,119 | 58,580 |
| 104 | 749,717 | 58,598 |

Dead linear, so:

| | cycles |
| --- | --- |
| per header (marginal) | **5,859** |
| fixed: both merkle paths + envelope + payload + guest boot | **~140,400** |

Extrapolating on the marginal rate rather than the average:

| checkpoint age | headers | cycles |
| --- | --- | --- |
| ~1 week | 1,008 | 6.0M |
| one epoch (2016) | 2,016 | 12.0M |
| ~1 month | 4,400 | 25.9M |

A monthly re-cut therefore costs roughly 26M cycles per proof, not the ~11M this
document first guessed. The earlier figure was optimistic by ~2.4x — and the
~32M this table previously showed was pessimistic by the same mistake in the
other direction, because it extrapolated the average instead of the slope.

The split matters for more than accuracy. The header walk is the dominant term
and it is *shared* by every anchor proven against the same segment, which is the
entire basis for batching — see below.

Proving the 750k-cycle fixture locally: **112s wall clock** (695s CPU across 14
cores), **5.55 GB peak RSS**. Memory is comfortable; time scales with cycles, so
a monthly-checkpoint proof lands on the order of an hour — a batch job, not an
interactive one. Some of the 112s is one-time proving-key setup, so the marginal
rate is better than a naive multiplication suggests.

## Batching: one proof, many anchors

The measurement above is the whole argument. A proof against a month-old
checkpoint costs ~26M cycles, and ~25.8M of that is the header walk — work that
says "this chain segment is real", not "this artwork is in it". Every anchor
proven against the same segment needs that same walk. Paying for it once per
artwork is paying 4,400 header hashes to place one 51-byte inscription.

So the guest should take N inclusion witnesses instead of one, and commit to all
of them at once:

```
cost(N) = 140,400  +  5,859 x headers  +  N x d
                      ^^^^^^^^^^^^^^^^
                      paid once, no matter how large N gets
```

At a monthly checkpoint that turns ~26M cycles per anchor into ~26M/N plus a
small per-anchor term. Fifty anchors in one proof is a ~50x reduction in the
dominant cost. The economics only improve as the checkpoint ages, which is
backwards from the usual incentive and exactly right here: the longer nobody
anchors, the more it pays to anchor together.

### Public values grow one field, not N

The batched guest commits `batch_root` in place of the single `anchor_root`, a
Merkle root over one leaf per anchor:

```
leaf_i = sha256(0x00 || anchor_root_i || payload_len_i
                     || block_hash_i  || block_height_i || confirmations_i)
node   = sha256(0x01 || left || right)
```

Everything else in `PublicValues` — origin, tip, cumulative work — is a property
of the shared chain segment and stays a single field.

Two details are load-bearing:

**Domain-separated leaves.** Bitcoin's own merkle tree duplicates the final odd
node, which is CVE-2012-2459 and why `merkle.rs` carries an explicit guard. This
tree is ours, so it does not have to inherit that bug: tagging leaves `0x00` and
internal nodes `0x01` makes a leaf and an internal node structurally impossible
to confuse, and the duplicate-node ambiguity disappears rather than being
guarded against.

**Per-leaf policy inputs.** Anchors in one batch sit in different blocks, so
confirmations differ per leaf. `block_height` and `confirmations` therefore live
in the leaf, not in the shared values, and `minConfirmations` is applied at
redemption against that leaf. Hoisting them would let a 2-confirmation anchor
ride in on a 200-confirmation sibling's policy check.

### On-chain: verify once, redeem N times

The split maps onto two entry points:

| | pays | when |
| --- | --- | --- |
| `submitZkAnchorBatch` | full proof verification (~300k gas via the gateway, or the aggregation Merkle check via zkVerify) | once per batch |
| `redeemBatchedAnchor` | `log2(N)` hashes, ~3-6k gas | once per anchor |

`submitZkAnchorBatch` performs exactly the checks `submitZkAnchor` performs
today — origin must be a known anchor point, field-by-field; family policy;
proof verification — then records `_verifiedBatches[batch_root]` along with the
shared chain facts and calls `_recordTip`. It settles no tasks.

`redeemBatchedAnchor` takes a leaf and its path, requires the root to be a
recorded batch, applies the per-leaf policy checks, requires
`leaf.anchor_root == expectedDigest` for the task, and calls `submitTaskResult`.

Redemption needs no replay guard for the same reason single submission needs
none: the registry settles the task on first success, so a second attempt is
turned away by `TaskNotPending`. A recorded batch root stays valid indefinitely,
which is a feature — an anchor request filed *after* a batch was proven can
redeem against it for the cost of a Merkle path, provided the digests match.

This is also why the existing verifier comment matters:

> the binding to this task is the digest match. That keeps proofs reusable
> across tasks expecting the same bytes

Batching is that property taken to its conclusion. Proofs are statements about
content, not about requests, so one statement can satisfy any number of requests
that happen to want the same bytes.

### The queue is a convenience, not a trust assumption

Off-chain, pending anchor requests group by `(family, network)` and a prover run
picks up everything queued. A batch closes on whichever comes first: a cycle
budget, a maximum wait, or someone paying to force it early.

None of that is consensus. The queue chooses *which* anchors share a proof; it
cannot make a bad anchor verify, cannot censor one permanently (anyone may prove
any anchor, alone or batched, at any time), and cannot forge a batch root without
producing a valid proof. A queue operator who vanishes costs latency, not
integrity — which is the same standard the rest of this design holds itself to.

Latency is the thing being spent, and it is the cheapest currency available
here: these are permanent records, not trades. Nobody is waiting on a
confirmation.

Cost splitting is the natural follow-on — each queued anchor escrows its share
of the estimated proof cost and the submitter is reimbursed on success — but the
batching above is worth building first, because it is what makes the per-anchor
cost small enough that splitting it is a refinement rather than a necessity.

### The vkey rotates whenever the guest changes

Adding the SHA-256 patch changed the vkey:

| build | vkey (bn254) |
| --- | --- |
| software SHA-256 | `0x0086971519228e238b424e01ac2281bbc693fba6668a49858a9517358d545892` |
| patched SHA-256 | `0x004d41db18e52dd129c6c236259afa2e1dd5218f46785036af0493210dedea96` |

Nothing about the *logic* changed — same public values, same result — but the
ELF differs, so the key does. This is the property the trust model leans on: the
vkey commits to the exact program, which is why compiling the checkpoint into
the guest puts the checkpoint under that commitment. It also means **every
dependency bump rotates the key**, and the on-chain backend must be reconfigured
in lockstep or verification simply stops matching.

### The SHA-256 precompile is not optional

Without SP1's patched `sha2`, the same fixture costs **3,539,789 cycles** — 4.7x
more, at ~34,000 cycles per header. The patch is what makes the header chain
affordable, and it needs two things that are easy to get wrong:

```toml
# program/Cargo.toml
[patch.crates-io]
sha2 = { git = "https://github.com/sp1-patches/RustCrypto-hashes", package = "sha2", tag = "sha2-v0.10.8-patch-v1" }
```

```toml
# lib/Cargo.toml — the version MUST be pinned to exactly what the patch supplies
sha2 = { version = "=0.10.8", default-features = false }
```

A `[patch]` only substitutes when the patched version satisfies the requirement.
An open `sha2 = "0.10"` resolves to 0.10.9, and the patched 0.10.8 then sits in
`Cargo.lock` **downloaded, locked, and entirely unused** — no warning, no error,
just a silently slower guest. The only signal is the cycle count not moving.

`sp1_build` also does not always rebuild the ELF when only a manifest changes.
If cycles do not move after a patch change, delete
`program/target/elf-compilation/.../keel-anchor-program` and rebuild before
concluding anything.

## Payload size

Hashing a 390KB payload in-circuit dominates the cycle count, and 128-chunk
objects would be brutal. The existing chunk architecture already solves this:
chunk digests are keccak'd and validated against `indexDigest`, so the guest
proves the **index** is inscribed and the existing on-chain chunk logic covers
the rest.

## zkVerify integration facts

These were read off zkVerify's own sources rather than inferred, because each
one silently breaks verification if guessed wrong.

**Proof type: `shrink`.** The SP1 pallet accepts shrink proofs, obtained by
calling `SP1Prover::shrink` on a `Compressed` proof. Not core, not the Groth16
wrap — which is the step that would need 64GB+, so this is what keeps proving on
a 36GB laptop.

**Verification key: `SP1VerifyingKey::hash_babybear`.** Eight BabyBear field
elements, each serialized little-endian, concatenated into 32 bytes. This is
*not* the bn254 `vk.bytes32()` that SP1's own Groth16 on-chain verifiers use.
Passing the bn254 value produces a well-formed leaf that matches no aggregation,
and the failure looks like "proof not found" rather than anything diagnostic.
This is why each proof route pins its own vkey: babybear on
`KeelZkVerifyProofVerifier`, bn254 on `KeelSp1GatewayProofVerifier`.

**Public values:** a plain vector of bytes, which is what `PublicValues::encode`
produces.

**Leaf (statement) digest**, mirroring `statementHash` in
`zkv-attestation-contracts`:

```solidity
keccak256(abi.encodePacked(
    PROVING_SYSTEM_ID,          // keccak256("sp1") — already a hash, used directly
    vkHash,                     // the babybear hash above
    sha256(bytes(version)),     // SHA-256 of e.g. "sp1:v5.0.0" — not keccak
    keccak256(publicInputBytes)
))
```

Three details that are easy to get wrong and were: the proving-system tag is
used directly rather than re-hashed, the version is hashed with SHA-256 while
everything around it uses keccak, and the version is a *string* rather than an
opaque constant. The exact version string zkVerify expects for SP1 still needs
confirming against a live submission; the zkVerify route stores it as a settable
string so it can be pinned once observed.

**Sepolia aggregation contract:** `0xEA0A0f1EfB1088F4ff0Def03741Cb2C64F89361E`
(`ZkVerifyAggregationProxy`). Verified live — the address holds code and
`verifyProofAggregation(uint256,uint256,bytes32,bytes32[],uint256,uint256)`
returns `false` for a bogus leaf rather than reverting, so the ABI matches.

## Deployment notes

- zkVerify relays to **Ethereum Sepolia** via system domain 0 (Bot mechanism), so
  no domain registration and no relayer to operate.
- zkVerify does **not** relay to Ethereum mainnet. Mainnet destinations are
  Apechain, Arbitrum One, Base, Horizen, OP Mainnet. On those chains deploy the
  adapter with `KeelZkVerifyProofVerifier`; anywhere else (Ethereum mainnet
  included) deploy it with `KeelSp1GatewayProofVerifier` and produce
  Groth16-wrapped proofs — the destination chain never blocks a deployment.
- SP1 `v5.x` and RISC Zero `v2.1-2.3` are verified directly — no Groth16 wrap,
  which is the step that would need 64GB+.
