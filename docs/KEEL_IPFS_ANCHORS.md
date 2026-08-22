# Keel IPFS Anchors

IPFS anchoring needs no oracle and no proof. A CID *is* a hash of the content,
so the content-to-CID binding is a computation, not an observation — and the
bytes are already on-chain in KeelHold. The verifier just runs the same
hashing `ipfs add` runs and compares.

That puts IPFS in the same trust class as `stampNative`: no DON, no proving
fleet, no external dependency, permissionless submission, settled in one
transaction.

| verifier | trust root |
| --- | --- |
| `NATIVE_VERIFIER_ID` | same-chain hash linkage |
| **`KeelIpfsCidVerifier`** | **none — content addressing** |
| `KeelZkAggregationVerifier` | Bitcoin proof-of-work |
| `KeelCreReportVerifier` | DON + the explorer it queried |

## What it does and does not claim

It proves: **these bytes hash to this CID.**

It does not prove **availability** — that any peer is still pinning the content.
That is a liveness claim about the network rather than a fact about the bytes,
and it genuinely does need an oracle. Do not read a verified IPFS anchor as
"retrievable"; read it as "this CID is the correct name for content the chain
already holds."

## There is no single canonical CID

The same file has many valid CIDs depending on options: CID version, raw vs
dag-pb leaves, chunker size, DAG layout. The library implements the `ipfs add`
default profile —

- CIDv0, dag-pb leaves, balanced DAG
- 256 KiB chunker (`size-262144`)
- 174-link DAG width

— plus the trivial raw-block CIDv1 form (`0x01 0x55 0x12 0x20 <sha256>`).
Content added under other options will not match, and that is a correctness
property, not a limitation to paper over.

Content large enough to need a *deeper* DAG (>174 chunks, ~44.5 MB) reverts with
`DagTooDeep` rather than returning a plausible wrong CID. A wrong CID here would
be a false anchor.

## Encoding details that decide correctness

Three things where the obvious implementation is wrong:

**dag-pb serializes Links (field 2) before Data (field 1).** A field-number-ordered
encoder produces a different hash. This is a known quirk of the format, not a
mistake in the spec.

**The UnixFS `Data` field is omitted when empty, not emitted zero-length.**
Emitting `0x12 0x00` for an empty file yields
`QmaRwA91m9Rdfaq9u3FH1fdMVxw1wFPjKL38czkWMxh3KB` instead of the published empty
file CID `QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH`.

**A 262144-byte file stays a single block.** The tree — links, `Tsize`,
`blocksizes` — appears only at 262145. Both sides of that boundary are pinned by
tests, because an off-by-one there changes every large file's CID.

## Verification of the implementation

Golden vectors come from a real IPFS implementation (`npx ipfs-only-hash
--cid-version=0`), not from our own reading of the spec. Two of them
additionally match long-published constants:

| content | CID |
| --- | --- |
| empty file | `QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH` |
| `hello world\n` | `QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o` |
| 262144 B | `QmVd4QReNMazp6UaYkZFsCXp3X6hTybajbJtB97t1WDGPr` |
| 262145 B | `QmQLTSHVUpYyRsKYrZvhsQpVihEDhGMMdGWEgTGaWA95j8` |
| 536633 B | `QmamKibo6UjVZyzVuCSpL7d3U67pkkaXutHfXwMdtmyvCK` |

Generator: `zk/keel-anchor-prover/scripts/ipfs-cid-reference.py`. It asserts
the empty-file CID on every run, so an encoding regression fails loudly before
any vector is emitted.

## Cost

Roughly **7 gas per byte**. Measured: 256 KiB ≈ 1.9M gas, 512 KiB ≈ 5.0M gas.
Practical up to a few MB; `maxVerifiableBytes` (default 4 MiB) turns "exceeds the
block limit" into a clear revert.

## Flow

1. Register an IPFS family with `registerChainFamily(id, "ipfs", "ipfs")` — the
   scheme is stored bare, the registry appends `://` when validating locators.
2. `driveAnchor` with `source.objectKey` = the claimed CIDv0 digest. A CIDv0
   digest is exactly 32 bytes, so it fits `objectKey` without encoding games.
3. Anyone calls `verifyIpfsAnchor(anchorId, taskIndex, keelHoldObjectId)`.

The caller-supplied KeelHold id needs no trust: the content is rejected unless
its digest matches the digest the registry already recorded for the task, so a
substituted object cannot get past the check. Only whole-content tasks
(`DIGEST_KIND_DECODED_SHA256`) are accepted — a CID covers the whole file, so a
per-chunk task would need its own CID.
