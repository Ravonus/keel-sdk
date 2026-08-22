# Runtime and Viewer Portability

## Why runtime versioning matters

An interactive artifact is not only bytes. Browser behavior, viewer logic, timing, viewport, locale, and randomness can change the output. `keel-manifest@2` makes those inputs explicit.

## Engine declaration

```json
{
  "engine": {
    "protocol": "keel-runtime@1",
    "viewerProtocol": "keel-viewer@1",
    "renderer": "browser",
    "viewerMirrors": []
  }
}
```

The runtime/viewer protocol identifies expected semantics. It is not a claim that every browser version renders every pixel identically; it gives independent viewers a shared contract and an upgrade boundary.

## Viewer mirrors

A mirror declares an ID, URI, integrity, immutability hint, and optional launch template:

```json
{
  "id": "ipfs-viewer",
  "uri": "ipfs://bafy.../viewer.js",
  "integrity": { "algorithm": "sha256", "digest": "0x..." },
  "immutable": true,
  "launchUrlTemplate": "https://viewer.example/?manifest={manifest}&digest={digest}"
}
```

`loadVerifiedViewerBundle()` tries mirrors in order and accepts only bytes matching the declared digest. The viewer domain is therefore a delivery mirror, not the protocol trust root.

A production launcher should verify the bundle before executing it and isolate the launcher/update path from creator content.

## Determinism modes

### Live

```json
{ "determinism": { "mode": "live" } }
```

Live mode intentionally permits wall-clock and host viewport behavior. The viewer warns that captures may differ.

### Replay

Replay mode fixes:

- 256-bit seed;
- `xoshiro128ss` pseudorandom stream;
- viewport width and height;
- device-pixel ratio;
- fixed or frame-based clock;
- locale;
- timezone.

The bootstrap replaces or constrains `Math.random`, crypto random values/UUID, `Date`, `performance.now`, requestAnimationFrame timestamps, language, selected `Intl` constructors, and DPR where the browser allows it.

Replay mode improves reproducible captures and audits. It does not promise GPU/driver/font-engine pixel identity across every platform. Projects requiring archival pixel equality should specify a reference browser build, ship exact fonts/shaders, and publish reference captures/hashes.

## Deterministic viewport mounting

`mountArtifact()` supports:

- `scale`: preserve the declared viewport and scale it into the host;
- `fixed`: use exact declared pixels and allow overflow;
- `host`: use host dimensions; unsuitable for deterministic capture.

## Sandbox tokens

The iframe always requires scripts. Optional tokens are narrowly derived from declared capabilities:

- downloads;
- pointer lock.

Feature policy may separately expose fullscreen, gamepad, clipboard write, or autoplay. `allow-same-origin` is never granted. WebAssembly adds only the CSP `wasm-unsafe-eval` permission and must be explicitly declared.

## Runtime APIs

Creator code receives frozen objects:

```js
__KEEL_RUNTIME__
__KEEL_CONTENT__
```

`__KEEL_RUNTIME__` reports the engine, determinism, content policy, manifest ID/digest, registry verification state, and revision.

`__KEEL_CONTENT__` exposes only verified resources and returns copied bytes rather than mutable shared buffers.

## Long-term preservation

For durable artifacts, publish:

1. manifest and digest;
2. all source digests;
3. at least one reconstructable immutable source;
4. viewer bundle digest and multiple mirrors;
5. runtime protocol version;
6. replay inputs when appropriate;
7. exact original assets;
8. conventional poster metadata, preferably the automatic on-chain SVG or an exact custom poster;
9. source code and build instructions;
10. reference captures for visually sensitive work.
