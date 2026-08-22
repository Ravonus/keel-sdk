# Keel Portable Root and Cross-Chain Anchors

**Status:** protocol draft for the active cross-chain gauntlet. Implementations
and testnet deployments require independent review before this becomes stable.

## Goal

The same viewer, atlas, codex, sound, effect, or manifest must have one content
identity across the Ethereum and Tezos Keel systems. Those exact bytes may
optionally be mirrored through another storage carrier, including an Ordinals
inscription, without making that carrier a third Vault chain or runtime.

`portableRoot` proves byte identity. A chain-specific `anchorRoot` proves where a
claim was anchored. They are deliberately separate: mirroring bytes does not
change their identity, and a foreign-chain locator does not become an ownership
or state proof merely because it contains the same hash.

## Canonical portable manifest v1

Integers are unsigned big-endian. Strings are raw UTF-8 preceded by their stated
length. No Solidity ABI encoding, Michelson `PACK`, JSON key ordering, Unicode
normalization, or host-language object encoding participates in the root.

| Field | Encoding |
| --- | --- |
| domain | 26 fixed bytes: `keel.portable-object.v1` |
| resourceKind | `u8` |
| compression | `u8` |
| mediaTypeLength | `u16be` |
| mediaType | `mediaTypeLength` bytes |
| decodedByteLength | `u64be` |
| decodedSha256 | 32 bytes |
| metadataSha256 | 32 bytes |
| chunkRoot | 32 bytes |
| lineageId | 32 bytes |
| revision | `u64be` |
| parentPortableRoot | 32 bytes |
| editPolicy | `u8` |
| controllerId | 32 bytes |
| frozen | `u8`, only `0` or `1` |

```text
portableRoot = SHA256(canonicalPortableManifestBytes)
```

Every language implementation must pass the same checked-in golden vectors.
Decoders reject unknown versions, non-canonical booleans, length overflow,
trailing bytes, unsupported compression, and media types outside the committed
allowlist.

## Canonical decoded-content tree

`chunkRoot` is not publisher-supplied entropy and does not use chain carrier,
transaction, compression-frame, or inscription boundaries. Implementations
first decode the resource, split the exact decoded byte stream into consecutive
16,384-byte chunks, and build this SHA-256 tree.

```text
leaf[i] = SHA256(
  "keel.portable-chunk-leaf.v1" ||
  i:u32be || totalChunks:u32be || chunkLength:u32be || chunkBytes
)

node[level,start,count] = SHA256(
  "keel.portable-chunk-node.v1" ||
  level:u16be || start:u32be || count:u32be ||
  leftRoot:bytes32 || rightRootOrZero:bytes32
)
```

Nodes pair from left to right. An unpaired node uses 32 zero bytes for its
right root; `count` remains the number of real descendant leaves. Parent level
zero is immediately above leaves. Empty decoded content has the fixed root:

```text
SHA256("keel.portable-chunk-empty.v1" || 0:u32be || 0:u64be)
```

The manifest's `decodedByteLength`, `decodedSha256`, and `chunkRoot` must all
match the same decoded bytes. A resolver that verifies only one of the three
has not verified a portable object.

## Address-neutral recursive resource graph

A viewer, character, or world bundle is represented by canonical portable
graph bytes. The graph maps normalized relative ASCII paths to child
`portableRoot` values, so Ethereum contract addresses, Tezos KT1 addresses,
Bitcoin inscription IDs, gateways, and compression choices never change the
bundle identity.

```text
"keel.portable-graph.v1" ||
entrypointLength:u16be || entrypointUtf8 ||
entryCount:u32be ||
for each entry sorted by path UTF-8 bytes:
  pathLength:u16be || pathUtf8 || childPortableRoot:bytes32 ||
  role:u8 || executable:u8
```

Paths are 1..1,024 ASCII characters, begin with `[A-Za-z0-9]`, contain only
`[A-Za-z0-9._/-]`, do not end in `/`, and contain no empty, `.` or `..`
segment. Paths are unique after exact byte comparison; case is significant and
no Unicode or percent-decoding normalization occurs.
The entrypoint must exist, use role `0`, and be executable. Roles are entrypoint
`0`, script `1`, style `2`, image `3`, audio `4`, data `5`, font `6`, and other
`7`. `executable` is canonically `0` or `1`. `portableGraphRoot` is SHA-256 of
these exact bytes. The graph bytes themselves are stored as a normal portable
resource; recursive children are resolved by portable root and then verified
against their own manifest and decoded-content tree.

V1 hard limits are 256 MiB total decoded bytes, 64 MiB per object, 65,536
manifest bytes, 16,384 content leaves of at most 16,384 bytes each, 4,096 entries
in any one graph, 4,096 unique objects in the complete root-inclusive traversal,
4 MiB graph bytes, 1,024 path bytes, and 16 nested graph levels. Thus one graph
with no repeated roots can contain at most 4,095 children under the default
object ceiling even though the graph syntax itself permits 4,096 entries. Consumers may
declare smaller limits but never larger ones. Implementations process leaves
with bounded working memory rather than launching an unbounded operation per
leaf.

A portable graph resolver receives only a requested root and two retrieval
callbacks: one for that root's canonical portable-manifest bytes and one for
its decoded content. For every object it verifies, in order: manifest byte
limit, `SHA256(manifestBytes) == requestedRoot`, canonical manifest decode,
declared decoded-length limits, exact decoded length, decoded SHA-256, and
decoded chunk root. A resource of kind `9` must contain
`application/octet-stream` portable-graph bytes; the resolver then repeats the
same process for each child root. Active-stack cycles, depth, object count, and
total decoded bytes fail closed. Retrieval locators are adapter inputs and
never enter any portable hash.

The v1 numeric registries are fixed as follows:

- `resourceKind`: viewer `0`, atlas `1`, codex `2`, sound `3`, effect `4`,
  manifest `5`, metadata `6`, character `7`, world `8`, portable graph `9`.
- `compression`: none `0`, gzip `1`, Brotli `2`.
- `editPolicy`: immutable `0`, append-only `1`, controller-revision `2`.
- `sourceFamily`: Ethereum `1`, Tezos `2`, Bitcoin `3`.

The v1 media-type allowlist is `application/javascript`, `application/json`,
`application/octet-stream`, `application/zip`, `audio/mpeg`, `audio/ogg`,
`audio/wav`, `image/png`, `image/webp`, `text/css`, `text/html`, and
`text/javascript`. Adding a value requires a new codec version; an implementation
must not silently accept aliases or parameters.

## Chain-specific anchor

```text
anchorRoot = SHA256(
  "keel.anchor.v1" ||
  portableRoot ||
  sourceFamily ||
  sourceNetwork ||
  sourceRegistry ||
  sourceObjectKey ||
  sourceRevision ||
  sourceEventDigest
)
```

The v1 anchor codec is now fixed: the 17-byte domain, 32-byte portable root,
`sourceFamily` as `u8`, `sourceNetwork` as `u32be`, 32-byte source registry ID,
32-byte source object key, `sourceRevision` as `u64be`, and 32-byte source event
digest. Chain-native variable-width identifiers must first be converted to their
documented 32-byte ID (for example, a left-zero-padded Ethereum address). Network
and registry domains prevent replay across mainnet/testnet,
Ethereum/Tezos/Bitcoin, or two registries on one chain.

`sourceNetwork` is not application-selected. For Ethereum it is the EIP-155
chain ID and must fit `u32`. For Tezos it is the canonical four binary chain-id
bytes interpreted as `u32be`. For Bitcoin it is the canonical four-byte P2P
network magic interpreted as `u32be`. A chain identifier outside this registry
requires a later anchor codec version rather than truncation.

The Ethereum `KeelPortableAnchorRegistry` binds each anchor to two exact
Keel revisions: one containing the canonical portable-manifest bytes and one
containing the decoded object bytes. Both locator descriptors enter
`sourceEventDigest`. Locator binding prevents later substitution, but is not a
native byte proof: the client still reconstructs the immutable carriers and
checks manifest root, decoded length, decoded SHA-256, and chunk root. Every
child portable root in a recursive graph must have the same resolvable binding.

Ethereum computes the locator binding without ABI dynamic encoding:

```text
sourceRefDigest = SHA256(
  KECCAK256("keel.portable-source-ref.v1") ||
  objectId:bytes32 || revision:u64be || leftPad32(storeAddress) ||
  contentObjectId:bytes32 || decodedDigest:bytes32 ||
  metadataDigest:bytes32 || fidelitySetDigest:bytes32 ||
  mediaTypeDigest:bytes32 || byteLength:u64be ||
  digestAlgorithm:u8 || compression:u8 || leftPad32(publisherAddress)
)

sourceEventDigest = SHA256(
  KECCAK256("keel.object-revision.portable.v1") ||
  manifestSourceRefDigest || decodedSourceRefDigest
)
```

For this anchor, `sourceRegistry` is the left-padded Keel object-registry
address, `sourceObjectKey` is the manifest object ID, and `sourceRevision` is
its exact revision. The decoded source ID/revision are returned in the anchor
record and event; all four source coordinates are immutable.

## Ordinals commitment v1

This is an optional data-carrier format for bytes consumed by Ethereum or
Tezos Keel records. It does not define an Ordinals NFT, character contract,
viewer runtime, staking system, marketplace integration, or a third parity
deployment target for Vault.

An Ordinals inscription ID is the reveal transaction ID plus an inscription
index. The inscription body lives in SegWit/Taproot witness data, while the
ordinary Bitcoin transaction ID excludes witness. Therefore an ordinary tx
Merkle proof for the reveal does **not** authenticate the inscription bytes.

New Keel Ordinals reveals must also commit the portable root in a transaction
output payload:

| Field | Encoding |
| --- | --- |
| magic | 4 bytes: `STRP` |
| version | `u8` = `1` |
| flags | `u8` |
| envelopeIndex | `u32be` |
| revision | `u64be` |
| portableRoot | 32 bytes |
| targetDigest | 16 bytes |

V1 reserves every flag bit, so `flags` must be zero. The commitment is exactly
66 bytes before Bitcoin script encoding.

`targetDigest` binds the output to its complete chain anchor and is not an
arbitrary label:

```text
targetDigest = first16(SHA256("keel.ord-target.v1" || anchorRoot))
```

The `keel.anchor.v1` bytes and `anchorRoot` must accompany the portable
manifest. Verifiers recompute both and reject a STRP output whose 16-byte target
does not match. The golden vector uses this derivation.

A Bitcoin header-chain verifier plus transaction Merkle proof can authenticate
this output and portable root without claiming it verified the witness envelope.
Clients still fetch the exact inscription bytes and reject them unless decoded
length and SHA-256 match the portable manifest.

The repository's bounded local storage diagnostic is `pnpm vault:ord:regtest`.
It is not a Vault release gate or a separate Ordinals product lane. It starts
an isolated Bitcoin Core regtest daemon, mines the canonical 66-byte golden STRP
payload in an `OP_RETURN`, verifies the returned transaction Merkle proof, checks
the exact script bytes and anchor-derived target digest, stops the daemon, and
removes only its temporary datadir. Its receipt intentionally labels the result
`transaction-output-merkle-proof-not-witness-envelope-proof`.

A later full-proof tier may additionally verify the witness commitment,
coinbase proof, `wtxid`, Taproot control block/script, envelope index, parent
spend, and Ordinals tag semantics.

## Trust classes

Every resolver and UI must label a foreign anchor with one of these classes:

1. `native-proof`: destination-chain code verifies the source consensus/state
   proof under a pinned finality/reorg policy.
2. `optimistic-proof`: a bonded claim survives a challenge window.
3. `attested-proof`: a named bridge, oracle, or threshold signer attests it.
4. `client-proof`: the contract pins byte hashes; clients verify retrieved
   bytes, while source-chain inclusion and availability are not contract-proven.

Burn addresses, inscription locators, RPC responses, indexer results, or copied
transaction hashes are never promoted to `native-proof` without the required
verifier.

## Authority and upgrades

Immutable resources need only cross-chain hash equivalence. Append-only mutable
lineages additionally require either:

- a portable controller signature over root, lineage, revision, parent, policy,
  and frozen state, independently verified on each chain; or
- a source-chain ownership/state proof verified through a light client, validity
  proof, optimistic bridge, or explicitly named attestor.

The first option does not mean that the current foreign-chain NFT owner controls
updates. Owner-following authority is a dynamic state claim and requires the
second class of machinery.

Verifier registries are append-only. Existing object revisions pin their
verifier version. Upgrading a verifier cannot reinterpret an existing accepted
root or silently downgrade its trust class.

## Minimum adversarial suite

- Golden portable bytes/root parity in TypeScript, Solidity, SmartPy/Michelson,
  and any rollup kernel.
- Alternate encodings, trailing bytes, overflow, wrong domain/network/registry,
  wrong media type, digest, decoded length, compression, or chunk order.
- Missing chunks, duplicate chunks, decompression bombs, and unavailable
  carriers must fail closed.
- Invalid Bitcoin proof-of-work, linkage, difficulty transition, timestamp,
  cumulative work, Merkle branch, root output, confirmation depth, and reorg.
- An explicit negative vector proving txid/SPV alone cannot authenticate
  witness-carried inscription bytes.
- Cross-chain replay, revision gaps/forks, frozen append, controller rotation,
  signature malleability, verifier downgrade, and privileged bypass.
