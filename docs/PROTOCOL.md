# Keel Manifest Protocol

## Identifiers

- Manifest schema: `keel-manifest@2`
- Canonicalization: `RFC8785`
- Runtime protocol: `keel-runtime@1`
- Viewer protocol: `keel-viewer@1`
- Content gateway: `keel-content-gateway@1`
- Registry anchor: `keel-artifact-registry@1`
- Object index encoding: `keel-object-index@1`

## Manifest commitment

The committed manifest digest is:

```text
SHA-256( UTF-8( RFC8785(parsed JSON value) ) )
```

It is **not** the hash of the pretty-printed file bytes. Whitespace and property order in the transport file do not matter after parsing. RFC 8785 provides interoperable property ordering and ECMAScript-compatible primitive serialization.

The implementation rejects:

- non-finite numbers;
- lone UTF-16 surrogate code points;
- unsupported values such as `undefined`, functions, or symbols;
- schema/canonicalization mismatches.

## Minimal shape

```json
{
  "schema": "keel-manifest@2",
  "canonicalization": "RFC8785",
  "id": "artifact-id",
  "name": "Artifact name",
  "entrypoint": { "resource": "viewer", "mode": "html" },
  "resources": [],
  "fallback": { "image": "preview", "animation": "viewer" },
  "runtime": {},
  "revision": {},
  "provenance": {}
}
```

Use the TypeScript types and parser rather than constructing unvalidated objects in production.

## Resource graph

Each resource declares:

- unique ID;
- semantic role;
- Internet media type;
- whether it is executable;
- optional original name and description;
- optional virtual aliases;
- ordered source fallbacks;
- optional extension data.

Supported roles include entrypoint, fallback, preview, original, script, style, font, image, audio, video, model, shader, data, and library.

## Source types

### Inline

Bytes are encoded as UTF-8, Base64, or Base64URL and may be compressed. Integrity is mandatory.

### URI

A URI may be:

- `https://...`
- `ipfs://...`
- `ipns://...`
- `ar://...`
- manifest-relative `./...` or `../...`

HTTP, data, blob, file, and JavaScript URI sources are rejected. A URI is only a retrieval location; decoded-byte integrity is mandatory.

### On-chain object

```json
{
  "kind": "onchain",
  "chainId": 8453,
  "store": "0x...",
  "objectId": "0x...",
  "compression": "brotli",
  "integrity": { "algorithm": "sha256", "digest": "0x..." }
}
```

The host calls the configured `readOnchainObject` adapter. Optional chunk hints are bounded to 128 and are not the canonical index; `KeelHold` commits its ordered index in bytecode.

### Contract call

A fixed chain, target, calldata, decode mode, compression, and digest are declared. The host performs the read. Creator code receives only the verified result, not RPC access.

### Composite

A composite concatenates verified resource parts with an optional separator. It has its own mandatory digest and may contain at most 128 parts. Deeper graphs should be balanced.

## Integrity

Supported algorithms:

- `sha256`
- `keccak256`

`none` exists as a low-level type for non-protocol utilities but is rejected for v2 resource sources and viewer bundles. Digests are lowercase `0x`-prefixed bytes32. `byteLength`, when supplied, refers to decoded bytes.

Verification order:

1. retrieve encoded bytes;
2. enforce encoded limits;
3. decompress if declared;
4. enforce decoded limits;
5. verify decoded byte length;
6. verify digest;
7. admit the resource into the resolved graph.

## Runtime

`runtime.engine` pins the runtime/viewer protocol and may list hash-verified viewer mirrors.

`runtime.determinism` is either:

- `live`: browser state and timing are intentionally live;
- `replay`: seed, random algorithm, viewport, DPR, clock, locale, and timezone are fixed.

`runtime.content` must declare:

```json
{
  "protocol": "keel-content-gateway@1",
  "mode": "verified-only",
  "externalSources": "host-verified",
  "manifestTrust": "digest",
  "blockUndeclared": true,
  "resourcePathPrefix": "/content/",
  "onchainPathPrefix": "/onchain/",
  "ipfsPathPrefix": "/ipfs/"
}
```

There is no `network` capability in v2. External resources are declared, retrieved, and verified by the trusted host.

Optional runtime capabilities are limited to downloads, pointer lock, fullscreen, clipboard write, gamepad, audio autoplay, and WebAssembly. They do not grant raw networking or same-origin access.

## Registry anchor

Registry-trusted manifests include:

```json
{
  "anchor": {
    "protocol": "keel-artifact-registry@1",
    "kind": "artifact-registry",
    "chainId": 1,
    "registry": "0x...",
    "collection": "0x...",
    "tokenId": "123",
    "revision": 2
  }
}
```

The token ID is a decimal string to avoid unsafe JavaScript number conversion. The manifest anchor must match the contract request and active revision.

## Revision and compatibility

A manifest declares revision number, optional parent/digest, compatibility range, policy, activation time, freeze state, and notes. Registry state is authoritative for activation and ownership policy; the manifest declaration allows independent clients to audit intent and compatibility.

## Virtual references

Creator content may reference declared resources through:

- `keel://id`
- `/content/id`
- `/content/<manifest-id>/id`
- an explicit alias
- the exact declared IPFS/Arweave/HTTPS URI
- `/ipfs/<cid>/<path>`
- `/onchain/<chain>/<store>/<object>`
- EIP-155 object aliases

The viewer does not fetch these at runtime. It maps them to bytes that were already verified.

## Conventional NFT metadata

A compatible token may expose:

```json
{
  "image": "...",
  "animation_url": "...",
  "external_url": "...",
  "oca_schema": "keel-manifest@2",
  "oca_manifest": "...",
  "oca_manifest_digest": "0x..."
}
```

Non-Keel clients use conventional fields. Keel clients verify the richer commitment.
