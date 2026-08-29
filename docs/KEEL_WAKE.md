# KEEL Wake

Status: experimental and not configured for production publication.

KEEL Wake is KEEL's explicitly selected Ethereum-history storage mode. It
changes how immutable bytes are retrieved, but it does not create a second
viewer or execution model. After retrieval and verification, Wake bytes enter
the same manifest, resolver, `/content/<resource-id>` gateway, sandbox iframe,
and host-capability flow as native KEEL bytes.

The default remains `native-carrier-v1`. Wake is selected only as
`history-inscription-v1`; there is no automatic fallback or cost-based mode
switch.

## Locators

The canonical whole-object locator is:

```text
keel://wake/eip155/<chain-id>/<coordinator>/<publication-id>
```

The canonical stored transport-chunk locator is:

```text
keel://wake/eip155/<chain-id>/<coordinator>/<publication-id>/chunk/<index>
```

Chain IDs and indexes use canonical unsigned decimal. The coordinator is a
lowercase Ethereum address. Queries, fragments, trailing slashes, alternate
numeric spellings, and mixed-case addresses are rejected.

A whole-object locator means: recover every committed batch, validate its
canonical transaction and receipt evidence, validate chunk order, offsets and
digests, concatenate the exact stored bytes, validate the stored digest,
decompress within configured limits, and validate the decoded digest.

A chunk locator is only a transport, repair, and replication coordinate. It is
never an executable object, manifest source, resource source, or availability
claim. Creator code receives verified bytes through `/content/<resource-id>`;
the iframe does not receive Wake transport locators.

Bitcoin Ordinals retain `ord://`. Tezos and other chain families retain their
own canonical locators. They are not renamed to Wake and must not be described
as Ethereum storage.

## Recursive KEEL graph

A verified Wake object is an ordinary KEEL manifest or resource after the
retrieval boundary. It can therefore participate in the same recursive object
graph as native KEEL objects. Wake-to-Wake references use canonical whole-object
locators and share the existing resolver's resource, depth, decoded-byte,
stored-byte, timeout, and cycle limits.

Cross-family recursion is adapter-bound. An `ord://`, Tezos, L2, archive, or
future-chain reference becomes usable only when the host has a reader that:

1. binds the exact chain/network and protocol identity;
2. retrieves immutable evidence through the declared locator;
3. checks finality or the declared confirmation rule;
4. validates ordering, lengths, and the committed digest; and
5. returns bytes only after verification.

The digest is shared graph integrity; the adapter is retrieval and provenance.
A missing adapter or unavailable evidence fails closed. The resolver never
silently substitutes another chain, indexer, archive, or URI.

## Publication flow

```text
explicit storage selection
        |
        v
one managed-publication planner
        |
        +-- native-carrier-v1 ------> immutable carrier bytecode
        |
        `-- history-inscription-v1 -> bounded publishBatch calldata
                                      + native commitment/cursor/status

chain history or verified archive
        |
        v
canonical evidence reader -> stored digest -> decompress -> decoded digest
        |
        v
existing KEEL manifest/resolver -> verified /content routes -> sandbox iframe
```

The planned publication ID is an input to `openPublication`. The coordinator
rejects a stale expected ID before creating state, so a competing publication
cannot cause precomputed batch calls to target a different object.

## Native contract record

The coordinator commits the owner, initial/current executor, plan digest,
storage mode, decoded and stored SHA-256 digests, decoded and stored lengths,
compression, media-type hash, ordered chunk digests, ordered batch chunk
counts, cursors, first/final publication blocks, escrow accounting, and terminal
status.

Each batch binds the publication ID, mode, plan digest, batch index, first chunk
index, stored-byte offset, ordered payloads, ordered SHA-256 chunk digests, and
`keccak256(msg.data)`. The contract rejects wrong actors, plans, modes, indexes,
offsets, counts, and digests before advancing the cursor.

The contract cannot read historical payload bytes. A later contract call can
check supplied bytes against stored commitments, but this does not make the
historical bytes contract-readable.

## Gas formula

For an EIP-7623 transaction:

```text
tokens = zero_calldata_bytes + 4 * nonzero_calldata_bytes
normal = 21,000 + 4 * zero_calldata_bytes + 16 * nonzero_calldata_bytes
floor  = 21,000 + 10 * tokens
charged = 21,000 + max(4 * tokens + execution_gas, 10 * tokens)
```

Event topics, event data, hashing, commitment writes, cursor writes, managed-job
control, and finalization belong to execution gas. They do not add to a
floor-dominated transaction until normal intrinsic plus execution exceeds the
calldata floor. Executor escrow is not transaction gas and is quoted separately
from the publisher's actual transaction fee.

## Trust and availability

Native carrier bytes are Ethereum-state-readable and contract-readable. Wake
payload bytes are Ethereum-history-readable and viewer-verified. A database or
indexer row is never payload authority; it is a reconstructable read model and
must retain chain, block, transaction, receipt, log, batch, chunk, digest,
confirmation, reorg, retrieval-source, and archival provenance.

An indexer may cache verified bytes, but a response is accepted only when it
matches the Ethereum commitment and the expected decoded integrity. Missing,
partial, reordered, duplicated, conflicting, pruned, or reorged evidence fails
closed. The iframe is not created with executable content until verification is
complete.

Open-source software is not itself an archival guarantee. Production enablement
requires a durable indexer, reorg-safe cursors, at least one independent verified
replica, and two working retrieval paths. Until those gates are reproduced,
Studio keeps Wake publication blocked and must describe archival status as
unknown rather than permanent.

## Rollout boundary

Local Anvil publication, reconstruction, and viewer unit tests are simulations.
They do not prove public RPC retention, an archive replica, NFT metadata/viewer
integration, or a live deployment. No production route may be enabled merely
because local gas savings pass the cost threshold.
