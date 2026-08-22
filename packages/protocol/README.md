# `@keel/protocol`

Shared types and deterministic utilities for Keel artifacts.

## Included

- `keel-manifest@2` types;
- RFC 8785 canonical JSON;
- canonical SHA-256 manifest roots;
- mandatory decoded-byte integrity for every source;
- untrusted JSON parsing and semantic validation;
- inline, URI, on-chain, contract-call, and composite sources;
- runtime/viewer/content-gateway/registry-anchor declarations;
- deterministic replay inputs;
- byte-accurate UTF-8/binary chunking;
- fixed-width cross-chain portable object, anchor, and Ordinals `STRP` codecs;
- Base64/Base64URL and hex utilities;
- legacy five-uint48 packing as an isolated compatibility helper.

## Canonical digest

```ts
import { canonicalJson, manifestIntegrity, parseArtifactManifest } from "@keel/protocol";

const manifest = parseArtifactManifest(JSON.parse(text));
const canonical = canonicalJson(manifest); // RFC 8785 text
const integrity = await manifestIntegrity(manifest); // SHA-256 of UTF-8 canonical bytes
```

Hash the parsed canonical value, not the pretty-printed file bytes.

## Verified content caches

`resolveKeelContent()` is the shared cache boundary for onchain scripts,
images, metadata, WASM, and other Keel bytes. Hosts supply a small adapter
for Postgres, Redis, IndexedDB, or a filesystem. Cache hits are re-hashed before
use, optional authoritative integrity is re-checked, and the result includes a
stable HTTP ETag. A corrupt or stale entry is ignored and reloaded.

```ts
const content = await resolveKeelContent({
  identity: {
    namespace: "collection-viewer",
    chainId: 11155111,
    source: collection,
    objectKey: tokenId,
    revision: "tokenURI",
    version: presentationDigest,
  },
  cache: postgresAdapter,
  allowedMediaTypes: ["text/html"],
  load: async () => decodeKeelDataUri(animationUrl, "text/html"),
});

// Serve content.bytes with Content-Type and content.etag, then execute it in
// the normal Keel sandbox. The cache never replaces or rewrites the source.
```

## Source integrity

All v2 sources require a cryptographic digest. The digest applies after declared decompression. `byteLength`, when present, is the decoded length.

The parser rejects the removed v1 `network` capability. Remote content is declared as a hashed source and retrieved by the trusted host.

## Virtual aliases

Resources may declare normalized aliases under `/content/`, `/onchain/`, or `/ipfs/`. Traversal, queries, fragments, backslashes, control characters, and alias collisions are rejected.

## Balanced graphs

Composite resources and on-chain chunk hints are limited to 128 children. Use the builder to create balanced trees for larger graphs.

## Portable object identity

```ts
import {
  PortableCompression,
  PortableEditPolicy,
  PortableResourceKind,
  encodePortableManifestV1,
  portableRootV1,
} from "@keel/protocol";

const manifest = {
  resourceKind: PortableResourceKind.Atlas,
  compression: PortableCompression.Brotli,
  mediaType: "image/webp",
  decodedByteLength: 56_024n,
  decodedSha256: "0x...", // all digest and identity fields are exact bytes32 hex
  metadataSha256: "0x...",
  chunkRoot: "0x...",
  lineageId: "0x...",
  revision: 1n,
  parentPortableRoot: "0x...",
  editPolicy: PortableEditPolicy.AppendOnly,
  controllerId: "0x...",
  frozen: false,
};

const canonicalBytes = encodePortableManifestV1(manifest);
const root = await portableRootV1(canonicalBytes);
```

The same checked-in binary vector is consumed by the TypeScript and Tezos
implementations. A portable root proves byte identity; it does not by itself
prove availability, foreign-chain inclusion, ownership, or update authority.
