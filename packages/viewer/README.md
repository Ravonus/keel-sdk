# `@keel/viewer`

Host-side verification, content virtualization, and sandboxed browser execution for Keel artifacts.

## Registry-trusted resolution

```ts
import {
  createKeelIndexPresentationReader,
  resolveArtifactFromRegistry,
} from "@keel/viewer";

const readArtifactPresentation = createKeelIndexPresentationReader(
  async ({ chainId, address, functionName, args, signal }) => {
    return readContract({ chainId, address, functionName, args, signal });
  },
);

const artifact = await resolveArtifactFromRegistry(anchor, {
  adapters: {
    readArtifactPresentation,
    fetch: trustedFetch,
    readOnchainObject,
    callContract,
    authorizeRemoteSource,
  },
  sourceAllowlist: ["artist.example", "https://cdn.example/releases/"],
});
```

This enforces:

```text
KeelIndex → manifest digest → resource digest → verified bytes
```

`createKeelIndexPresentationReader()` calls `activePresentation` and, by default, `presentationMatches`.

## Verified gateway

```ts
import {
  createVerifiedContentFetchHandler,
  createVerifiedContentGateway,
} from "@keel/viewer";

const gateway = createVerifiedContentGateway(artifact);
const response = gateway.resolve("/content/model", "GET");

// Fetch API / Service Worker / Next.js route adapter:
const handle = createVerifiedContentFetchHandler(gateway);
const webResponse = handle(new Request("https://viewer.example/content/model"));
```

The gateway exposes exact committed aliases only. It supports `/content/`, `/onchain/`, `/ipfs/`, `oca://`, declared source URIs, and custom aliases. It never performs runtime network fallback.

## Mounting

```ts
import { mountArtifact } from "@keel/viewer";

const mounted = mountArtifact(container, artifact, {
  deterministicViewport: "scale",
});
```

The generated iframe:

- has an opaque unique origin;
- never receives `allow-same-origin`;
- receives no wallet/provider;
- uses deny-by-default CSP both inside `srcdoc` and through the iframe `csp` attribute where supported;
- is marked `credentialless` to remove ambient cookies/storage credentials;
- materializes static verified references;
- virtualizes dynamic fetch/XHR/DOM content references;
- blocks WebSocket, EventSource, workers, beacon, forms, ordinary anchor navigation, and window opening;
- applies replay inputs when declared.

Creator code may access verified bytes through `__OCA_CONTENT__` and runtime information through `__OCA_RUNTIME__`.

## External sources

External HTTPS/IPFS/Arweave sources are allowed as host-side transports. The accepted decoded bytes must match the manifest digest. Automatic redirects are disabled. Literal private/special networks are denied by default.

Use `authorizeRemoteSource` to add DNS/IP resolution, egress firewall, certificate pinning, or organization policy before a fetch.

## Electron egress guard

For strong desktop isolation, use a dedicated session/partition:

```ts
import { installElectronViewerEgressGuard } from "@keel/viewer";

const guard = installElectronViewerEgressGuard(viewerSession);
```

The guard cancels all renderer requests below the iframe layer. Retrieve and verify remote/on-chain content in a separate trusted process/session, then pass only the `ResolvedArtifact` into the viewer.

## Recursive on-chain objects

`createKeelHoldObjectReader()` converts a bounded chain client into `readOnchainObject`. It pages carrier addresses from immutable descriptors, reads 23 KB carrier bytecodes concurrently with `eth_getCode`, walks composite nodes, decompresses leaves, verifies lengths/digests, caches nodes, and enforces depth/node/byte/page/concurrency limits.

## Portable viewers

`loadVerifiedViewerBundle()` accepts only a mirror bundle matching its declared digest. `viewerLaunches()` expands optional launch templates without making one domain the protocol trust root.

## Global sprite and material tools

Creator scripts, games, and coding agents use the same exported reader API as
the verified sandbox:

```ts
import {
  applyAtlasMaterialMap,
  decodeAtlasMaterialMapBits,
  decodeMaterialBits,
  packSpriteFrames,
  resolveMaterialProfile,
} from "@keel/viewer";

const packed = packSpriteFrames({
  maxWidth: 512,
  padding: 1,
  frames: [
    { width: 48, height: 48, durationMs: 125, originX: 24, originY: 40 },
    { width: 24, height: 20, durationMs: 80, originX: 12, originY: 18 },
  ],
});

const pixels = applyAtlasMaterialMap(
  rgbaBytes,
  decodeAtlasMaterialMapBits(materialMapBytes),
  resolveMaterialProfile(decodeMaterialBits(materialProfileBytes), tokenSeed),
);
```

`oca-atlas-material-map@1` supports named, priority-ordered RGBA ranges. Several
source ranges can share one material region (for example gold shadow, mid, and
highlight), other ranges can resolve independently, and `action: "preserve"`
keeps authored accents fixed. Range matching is intentionally tolerant of
lossy WebP/AVIF output. `packSpriteFrames()` retains per-frame dimensions,
duration, and origin so small muzzle flashes, hats, and effects do not consume
a full 48x48 cell.

Human-readable JSON stays beside the compact hashed/on-chain form. Compile it
with the repository-wide CLI:

```sh
pnpm reader-asset:compile material-map material-map.json material-map.ocam
pnpm reader-asset:compile material-profile material-profile.json material-profile.ocmp
pnpm reader-asset:compile sprite-pack sprite-frames.json sprite-atlas.ocaa
```

The sprite-pack command also writes `sprite-atlas.ocaa.layout.json` for creator
inspection. These functions perform no network access and are safe to reuse in
the SDK, Studio, a local dev sandbox, or an immutable viewer resource.
