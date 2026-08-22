# Keel L2 Anchors

Storage is cheap on an L2 and expensive on L1, but the guarantee runs the other
way. This document is about buying the cheap storage without silently buying the
weaker guarantee — and, where the guarantee *is* weaker, making that fact a
thing you can query rather than a thing you have to trust a marketing page for.

## The one primitive

A rollup posts its state root to its settlement chain as a matter of protocol.
So a contract on the settlement chain can read that root from the rollup's own
contract and walk a Merkle-Patricia proof against it. That needs exactly one
primitive — keccak — which the EVM has natively.

No prover. No oracle. No attestor set. `src/libraries/KeelMerklePatricia.sol`
is that walk, and it is a deliberate port of the Michelson implementation at
`packages/tezos/contracts/keel_eth_state_proof.py`. Both are checked against
the same real proof (mainnet block 25,797,214, WETH storage slot 0, straight
from `eth_getProof`); two independent implementations of the yellow paper
agreeing on real bytes is evidence, where either alone would only prove itself
self-consistent.

Measured: **127k gas** for that seven-node proof.

## A real anchor is two levels, not one

The Michelson fixture proves a *storage* slot, so its root is a contract's
storage root — already trusted, handed in from outside. A real L2 anchor cannot
assume that. It starts from the one thing the settlement chain commits to and
works down:

```
block hash --header--> stateRoot --account proof--> storageRoot --storage proof--> value
```

Every step is keccak and RLP, and each is bound to the one before it:

| step | library | binds by |
| --- | --- | --- |
| header -> stateRoot | `KeelBlockHeader` | `keccak256(header) == blockHash` |
| stateRoot -> storageRoot | `KeelMerklePatricia` + `KeelEthAccount` | trie walk keyed by `keccak256(account)` |
| storageRoot -> value | `KeelMerklePatricia` | trie walk keyed by `keccak256(slot)` |

Measured against real mainnet data (block 25,800,247, WETH slot 0): **383k gas**
for the whole chain, taking nothing on trust but the block hash. Fixture and
regenerator: `test/fixtures/eth-state-proof-vectors.json`,
`script/fetch-state-proof.sh`.

`KeelRlp` is shared by the header decoder and the trie walk deliberately. An
anchor proves a header and then walks a trie; if the two halves disagreed about
how RLP is read, the proof would not mean what it appears to mean.

## Where the two stacks differ

Both reduce to keccak, but they hand you different starting material:

- **OP Stack** (Base, OP Mainnet) commits an output root whose preimage is
  `keccak256(version || stateRoot || messagePasserStorageRoot || blockHash)`.
  The state root falls straight out of the preimage — no header needed.
- **Arbitrum** (Arbitrum One, ApeChain, Robinhood Chain) commits the L2 **block
  hash** in an assertion's `afterState.globalState`, not the state root. That
  costs one extra hop: prove the header against the hash, then read the state
  root out of it.

Three of the five target chains are Arbitrum-stack, so the header hop is the
common path, not the exceptional one. That is why `KeelBlockHeader` exists.

## Verified addresses, and why they are not constants

Every address below was read from the chain's own contracts, not copied from
documentation. That distinction earned its keep immediately.

**The published Arbitrum One rollup address is stale.** `0x5eF0D09d1E62...` is
what most sources cite. It still answers calls, returns a plausible
`latestConfirmed()`, and decodes into a well-formed node — but its
`deadlineBlock` sits about four million L1 blocks in the past. The canonical
bridge points somewhere else entirely:

```
bridge(0x8315177aB297bA92A06054cE80a67Ed4DBd7ed3a).rollup()
  -> 0x4DCeB440657f21083db8aDd07665f8ddBe1DCfc0
```

The live rollup runs BOLD: `latestNodeCreated()` reverts on it, and
`latestConfirmed()` returns an assertion hash rather than a node number. A
verifier hardcoded to the published address would check proofs against a state
root frozen a year and a half ago **and report success** — a silent staleness
hole, not a visible failure. So Arbitrum entries record the *bridge*, which is
canonical, and derive the rollup and outbox from it at use time.

| chain | contract | address | verified by |
| --- | --- | --- | --- |
| OP Mainnet | AnchorStateRegistry | `0x23B2C62946350F4246f9f9D027e071f0264FD113` | `OptimismPortal.anchorStateRegistry()` |
| Base | AnchorStateRegistry | `0x909f6cf47ed12f010A796527f562bFc26C7F4E72` | `OptimismPortal.anchorStateRegistry()` |
| Arbitrum One | Bridge | `0x8315177aB297bA92A06054cE80a67Ed4DBd7ed3a` | `Outbox.bridge()` round-trips |
| Robinhood Chain | Bridge | `0xDf8755334ce7A73cCF6b581C02eA649AE3E864b3` | closed triangle, below |
| Robinhood Chain | Rollup | `0x23A19d23e89166adedbDcB432518AB01e4272D94` | `bridge.rollup()` |
| Robinhood Chain | Outbox | `0xf0ce991ea4A0d2400A4AB49b20ae333f6Dce3DE9` | `bridge.allowedOutboxList(0)` |

Robinhood Chain's published addresses were confirmed by the chain rather than
taken on faith — every edge of the triangle closes:

```
bridge.rollup()             -> rollup     rollup.bridge() -> bridge
bridge.allowedOutboxList(0) -> outbox     outbox.bridge() -> bridge
                                          outbox.rollup() -> rollup
```

Its `latestConfirmed()` returns an assertion hash, so it runs BOLD like
Arbitrum One and takes the same header hop.

Both OP registries answer `getAnchorRoot()` live (v3.9.0 and v3.7.0), and
`l2Oracle()` reverts on both portals — confirming `L2OutputOracle` is the
legacy path and fault proofs are in force.

### Both commitment formulas, checked against live data

**OP Stack.** The output root reproduced exactly from a real dispute game —
game `0xD2E3834572cECbDD7fa5fF72DE8d13654F25CAd9` at L2 block 155,837,400:

```
keccak256(version || stateRoot || messagePasserStorageRoot || blockHash)
  == rootClaim()   ->  0xe982817f5e475e847416bb6aa2e5b10d1609c478e1cdd89760e3d80af7cf972f
```

**Arbitrum.** `Outbox.roots(sendRoot)` returns the L2 block hash of the
assertion that confirmed it. Checked by taking a live send root, querying the
mapping, and fetching the block it named: block 493,502,435, whose own
`sendRoot` matches the query. Note the returned hash is the *assertion
boundary* block, not whichever block you sampled the send root from — many
consecutive blocks share one send root, and expecting them to match is a
plausible way to mis-implement this.

Only the rollup can write that mapping, which is what makes reading it
trustless.

## Depth is the thing that varies

The proof above is one hop. It is one hop only when the chain settles directly
to the chain doing the verifying.

| chain | depth | settles to | data availability |
| --- | --- | --- | --- |
| Ethereum | L1 | — | — |
| Arbitrum One | L2 | Ethereum | blobs on L1 |
| Base | L2 | Ethereum | blobs on L1 |
| OP Mainnet | L2 | Ethereum | blobs on L1 |
| Robinhood Chain (4663; testnet 46630) | L2 | Ethereum | L1 |
| ApeChain | **L3** | **Arbitrum One** | calldata to parent |

ApeChain is the case that breaks a flat design. Its state root goes to Arbitrum
One, not to Ethereum, so proving an ApeChain-stored work on L1 is **two** walks:
the ApeChain root inside Arbitrum's state, then Arbitrum's root inside
Ethereum's. A verifier that assumes one hop is not merely slower on ApeChain —
it is wrong, and it is wrong in the direction of accepting things it should not.

Two facts worth recording because they change over time and were checked rather
than assumed:

- **ApeChain left AnyTrust.** It launched as an Optimium with a 5/7 data
  availability committee. Its `SequencerInbox` sequencer version has since
  flipped `0x88 -> 0x00`, meaning batches are posted as calldata to the parent
  rather than as DAC certificates. The committee is no longer the availability
  assumption. Re-check this before relying on it; it is a live parameter, not a
  property of the stack.
- **Robinhood Chain is new** (mainnet July 2026) and enforces compliance checks
  in-protocol. That is a transaction-inclusion consideration, not a data
  integrity one, but a preservation system should not pretend the two chains
  have the same censorship surface.

## Why the tier gets recorded on-chain

The temptation is to expose one boolean — anchored or not. That would be the
dishonest version. An anchor backed by Ethereum blob DA and an anchor backed by
a committee are not the same object, and the difference is exactly what someone
checking a work's provenance in ten years needs to see.

So the anchor record carries the settlement topology: depth, the parent chain,
the availability mode, and the proof system. Those make "how strong is this
anchor" a query against on-chain data rather than a claim.

This is the same discipline the rest of the anchor system already follows —
`KeelZkAnchorVerifier` checks a Bitcoin proof's origin field by field
precisely because accepting a matching hash alone would let a prover pair a real
block with fabricated difficulty. Recording a tier and recording an origin are
the same instinct: the proof must be about the thing you think it is about.

## What this does not buy

It does not make L2-stored bytes readable from an L1 `tokenURI`. Nothing does. A
proof makes bytes *checkable*; it does not make them *readable* from a `view`
call on another chain. Work that must render from L1 has to live in L1 state,
where `KeelHold`'s SSTORE2 layout is already the floor at ~200 gas/byte
against `SSTORE`'s ~625.

Blobs do not change this either, and are worth ruling out explicitly because
they look like the obvious answer:

- The EVM cannot read blob contents at all. `BLOBHASH` returns a versioned hash,
  and only for blobs on the currently-executing transaction; the point-evaluation
  precompile verifies a KZG opening. Neither yields the bytes.
- Blobs are pruned after ~4096 epochs (~18 days). A preservation system cannot
  rest on a store the protocol deletes by design.

The L2 route uses blobs the correct way — indirectly. The rollup posts its data
as blobs and passes the cost saving through, while its *state* (including your
contract bytecode) persists in the L2's own state. You get the blob economics
without the expiry.

## Deployment note

`evm_version = "prague"` in `foundry.toml` does not restrict where this deploys.
Prague adds no EVM opcodes — only precompiles (`0x0b`–`0x11`) and system
contracts — so solc emits byte-identical runtime code under cancun and prague
(verified by compiling the same source under both and comparing with metadata
stripped). Only `Bls12381.sol` needs a chain that actually has EIP-2537, and
only at runtime, on chains where Tezos consensus is verified.
