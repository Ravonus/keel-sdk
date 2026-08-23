# Recursive On-Chain Storage

## Goals

Ethereum storage should support reusable, independently verifiable browser artifacts without assuming one transaction, one contract runtime, one storage array, or one oversized `eth_call` response.

## Immutable byte containers

`Ingot` stores:

```text
0x00 || payload
```

The leading `STOP` byte makes the runtime inert. Clients read payload bytes with `EXTCODECOPY`, starting at byte 1.

`KeelHold` uses this mechanism for three objects:

1. content chunks;
2. compact leaf descriptors containing payload-carrier addresses;
3. compact composite descriptors containing child object IDs.

That removes unbounded identifier arrays from Solidity storage.

## Chunks

`castSlug(bytes)` accepts at most 23,000 bytes. The chunk ID is `keccak256(payload)`. Identical chunks deduplicate to the existing bytecode pointer. `castSlugs(bytes[])` publishes at most three carriers per transaction; the full-size worst case measured 14,181,827 gas, below the Fusaka `2^24` transaction gas limit.

## Bytecode-native descriptors

A single immutable descriptor commits all object metadata and ordered references. A leaf stores 20-byte carrier addresses directly; a composite stores 32-byte child object IDs:

```text
KEEL3 header || media type || carrier[0..n]
KEEL3 header || media type || objectId[0..n]
```

The object ID still commits to the ordered index digest, so child order is immutable and content-addressed. Metadata no longer occupies several storage slots and leaf readers do not need one contract call per chunk ID.

Clients page leaf carrier addresses with `getObjectSlugPointers`, fetch carriers directly with concurrent `eth_getCode`, strip the leading `STOP`, concatenate, decompress, and verify. Composite clients page IDs with `getObjectPartIds`.

## Bounded fanout

Every object node has between 1 and 128 children. A builder must form a balanced tree when more IDs are needed.

For fanout `F` and `N` leaves, depth is approximately:

```text
ceil(log_F(N))
```

With `F = 128`, even very large practical objects remain shallow while each creation transaction stays bounded.

## Leaf objects

`weldObject` commits to:

- ordered carrier descriptor and index digest;
- final decoded digest;
- decoded byte length;
- stored byte length;
- compression;
- media type.

Clients:

1. page carrier addresses;
2. read immutable carrier bytecode concurrently;
3. concatenate stored bytes;
4. decompress once;
5. verify decoded length and digest.

For uncompressed objects, the contract enforces stored length equals decoded length.

## Composite objects

`weldComposite` references child objects. Its decoded bytes are the ordered concatenation of each child’s decoded bytes. Children may be leaves or composites.

The contract enforces that child decoded lengths add to the declared root length. The client still reconstructs and verifies the root digest; the EVM does not decompress arbitrary media.

```text
root
├── branch A
│   ├── leaf 0
│   └── leaf 1
└── branch B
    ├── leaf 2
    └── leaf 3
```

## Compression

For flat objects, the entire object may use gzip, deflate, or Brotli. For recursive plans, each leaf segment is compressed independently, allowing bounded verification and streaming. Composite nodes use no additional compression and concatenate decoded children.

The builder evaluates supported compression modes and keeps compression only when it reduces stored bytes.

## Source integration

An Keel on-chain source declares:

- chain ID;
- `KeelHold` address;
- root object ID;
- compression metadata where applicable;
- final decoded-byte integrity.

`createKeelHoldObjectReader()` walks the graph with limits for depth, nodes, bytes, page size, and concurrent carrier reads. It caches verified nodes and returns the exact decoded bytes to the manifest resolver.

Creator iframe code never performs RPC calls. After verification, the same bytes are exposed under `keel://`, `/content/`, `/onchain/`, and EIP-155 aliases.

## Reuse

Chunks are content addressed. Shared libraries, fonts, shaders, palettes, models, and other byte ranges can reuse existing carriers across objects and artifacts. Manifests can also reference a common on-chain object directly.

## Measured read profile

Studio probes its configured RPC with a non-mutating state-override `eth_call` under a 16,777,215-gas envelope. It finds the zero-work return ceiling, then applies a per-resource curve that charges quadratic ABI memory expansion, copying, and every planned cold descriptor/carrier read. On the verified local Anvil profile, 2,936,832 raw bytes returned successfully. A representative 64-carrier Solidity assembly returned 1,449,984 bytes; the next aligned 4 KiB page failed under the same gas envelope.

This is a one-response compatibility measurement, not the Keel object-size limit. The normal viewer pages descriptors and reads 23 KB carriers concurrently, so large recursive HTML systems do not depend on one oversized return value.

## Limits and operational guidance

- Do not treat “arbitrarily large” as “free” or “safe to load without limits.”
- Keep leaf sizes appropriate for RPC/mobile clients.
- Keep fanout ≤128; the builder enforces it.
- Use paged reads.
- Declare realistic decoded/aggregate byte limits in the manifest.
- Reconstruct and verify every upload plan before broadcasting.
- Verify chain ID, store address, object ID, decoded digest, and media type in deployment records.
