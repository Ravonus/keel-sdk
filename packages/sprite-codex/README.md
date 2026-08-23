# @keel/sprite-codex

`@keel/sprite-codex` turns human-edited sprite manifests into deterministic, lossless WebP atlases plus a small binary codex. The codex describes permanent asset IDs, atlas slots, frames, pinned selection revisions, and delta/varint-encoded semantic pixel masks. The browser loader verifies both files before it exposes any sprite.

## Install

```sh
pnpm add @keel/sprite-codex
```

The compiler requires Node 22 or newer. The loader is browser-safe and has no Node or Sharp imports.

## Source manifest

```json
{
  "schema": "keel-sprite-source@1",
  "id": "my-game-items",
  "frame": { "width": 32, "height": 32 },
  "defaultDisplaySize": 32,
  "assets": [{
    "id": 1,
    "key": "starter-sword",
    "label": "Starter Sword",
    "slot": 0,
    "frameCapacity": 12,
    "frames": ["sprites/sword-0.png", "sprites/sword-1.png"]
  }],
  "selections": [{ "revision": 1, "activeAssetIds": [1] }],
  "masks": { "path": "regions.json", "root": "overrides" }
}
```

Asset `id`, `key`, and `slot` are permanent. `frameCapacity` reserves horizontal cells and cannot shrink. Once a lock exists, old frame bytes and authored masks cannot change or disappear. To replace art, allocate a new asset ID and slot. To retire art from new random rolls, append a selection revision that omits it; never edit an older revision or delete its pixels. Retirement is irreversible: the lock records retired IDs and rejects any later revision that tries to reactivate one. A token/game save pins the revision it used, so later additions and retirements cannot reroll it.

Sparse masks use the editor-friendly shape already used by Vault:

```json
{ "overrides": { "starter-sword": { "0": { "33": "blade", "34": "blade", "61": "fixed" } } } }
```

Frames may also address an exact cell in a human-authored sheet without first writing intermediate PNGs:

```json
{ "path": "turnaround.png", "x": 64, "y": 0, "width": 32, "height": 32 }
```

`width` and `height` must equal the bundle geometry. Vault's legacy near-white sheets can opt into the runtime-compatible flood fill with `"removeConnectedLightBackground": true`; the processed pixels are pinned by the lock. Different source geometry belongs in a different bundle instead of reserving a wasteful maximum-size cell.

## Compile

```sh
sprite-codex compile assets.sprite.json --out public/sprites --lock assets.sprite.lock.json
```

Outputs are `<id>.atlas.webp`, `<id>.codex.bin`, `<id>.build.json`, and `<id>.sha256`. The WebP is lossless; transparent reserved cells remain in place. Commit the source manifest and lock. CI can pass `--check` to validate against the lock without rewriting it.

`--check` requires `--lock` and that lock must already exist. Flags that require a value fail closed when the value is missing.

## Multi-bundle libraries

The library graph keeps character, shared equipment, and world geometry independently cacheable while resolving them through one API. Bundle and profile revisions are immutable snapshots:

```json
{
  "schema": "keel-sprite-library-source@1",
  "id": "my-game-v1",
  "bundles": [
    { "bundleId": 1, "revision": 1, "key": "character", "role": "standalone-character", "source": "character.sprite.json", "lock": "character.lock.json", "dependencies": [] },
    { "bundleId": 2, "revision": 1, "key": "world", "role": "world-tiles-48px", "source": "world.sprite.json", "lock": "world.lock.json", "dependencies": [] }
  ],
  "profiles": [
    { "id": "unstaked", "revision": 1, "roots": [{ "bundleId": 1, "revision": 1 }] },
    { "id": "staked", "revision": 1, "roots": [{ "bundleId": 1, "revision": 1 }, { "bundleId": 2, "revision": 1 }] }
  ],
  "inventoryRoots": [{ "path": "art", "label": "authored art and review candidates" }]
}
```

```sh
sprite-codex library game.sprite-library.json --out public/game --lock game.sprite-library.lock.json
```

The command compiles each bundle and emits a digest-pinned `<id>.library.json`. Its immutable runtime commitment points at `<id>.active-inventory.json`, which contains only explicitly referenced sources. The separate automatic `<id>.inventory.json` is an evolving provenance/approval report: paths identified as concepts, candidates, benchmarks, rejected work, or otherwise unreferenced remain hashed there and are never silently promoted. Adding an unreferenced file can update provenance without changing an old runtime graph, selection, or seed result.

```js
import { loadSpriteLibrary } from "@keel/sprite-codex/browser";

const library = await loadSpriteLibrary({
  graphUrl: "/game/my-game-v1.library.json",
  graphSha256: trustedGraphDigest,
  profileId: "unstaked",
  profileRevision: 1,
});

library.bundle("character").draw(context, { asset: "body", frame: 0 });
```

The loader verifies the graph, every referenced bundle build manifest, codex, and atlas before exposing them. Dependency closure is topologically resolved from the pinned profile, so an unstaked character does not download world bundles.

## Load and draw

```js
import { loadSpriteCodex } from "@keel/sprite-codex/browser";

const sprites = await loadSpriteCodex({
  codexUrl: "/sprites/my-game-items.codex.bin",
  atlasUrl: "/sprites/my-game-items.atlas.webp",
  codexSha256: build.codex.sha256,
  atlasSha256: build.atlas.sha256,
  // Optional: override a strict limit only when your trusted catalogue needs it.
  limits: { maxAtlasBytes: 8 * 1024 * 1024 },
});

sprites.draw(canvas.getContext("2d"), { asset: "starter-sword", frame: 1 });
const semanticRegions = sprites.regionMask(1, 1); // Map<pixelIndex, regionName>
const pinnedPool = sprites.selection(1).activeAssetIds;
```

`draw()` disables canvas smoothing and defaults to a 32×32 display. For CSS sprites:

```js
element.style.cssText = sprites.css("starter-sword", 1, 32);
```

This uses nearest-neighbor `image-rendering: pixelated` and scales atlas coordinates without resampling the underlying asset. Call `sprites.dispose()` when the atlas is no longer needed.

## Deterministic material stems

`keel-material-stem@1` generalizes the sprite runtime for layered generative materials. A stem can be sprite-based, procedural, or hybrid. It pins its bundle/asset/frame hashes or procedural kernel/parameter digest, runs on the common 60-tick clock, declares its RGBA channel meanings and alpha contract, and routes one or more contributions to named semantic surfaces.

Physical surface deposits, transparent physical films, and optical post-effects are separate contribution domains. A primary contribution may name an explicit counter-contribution on disjoint other or inverse layers. Resolution fails when a route references a missing target or resolves to nothing; selected contributions cannot use zero opacity.

`keel-material-composition@1` commits material regions, region-to-contribution assignments, declared adjacency topology, and exactly one transition for every adjacency. Each transition pins its oriented assignment/contribution endpoints, method ID/revision, parameter digest, and implementation digest. This lets a project prove that regional media remain distinct and that every declared material boundary uses a named implementation rather than a hidden global shader. The composition also limits autonomous clocks to at most two, distinguishes static, externally controlled, and autonomous stems, and preserves selected physical and optical contributions in diagnostics.

```js
import {
  deriveMaterialStemSeed,
  inspectMaterialPixels,
  sampleMaterialStem,
  validateMaterialComposition,
} from "@keel/sprite-codex/browser";

validateMaterialComposition(composition);
const seed = await deriveMaterialStemSeed(stem, {
  tokenSeed,
  collectionId,
  tokenId,
});

// Poster sampling uses the pinned poster frame. Visual completeness is an art
// evidence claim, not something the byte schema can infer. A first-visible
// phase origin is required to begin its live animation at local tick/frame zero;
// phase jitter is valid only with a start-tick origin.
const poster = sampleMaterialStem(stem, seed, composition.semanticTargets, { mode: "poster" });
const live = sampleMaterialStem(stem, seed, composition.semanticTargets, { mode: "live", globalTick });

// External clocks never advance from globalTick accidentally.
const pointerDriven = sampleMaterialStem(externalStem, externalSeed, composition.semanticTargets, {
  mode: "live",
  globalTick,
  externalTicks: { "pointer.effect": pointerTick },
});
inspectMaterialPixels(stem, decodedRgbaPixels);
```

The v1 per-stem seed is SHA-256 over this exact 156-byte preimage: UTF-8 `keel.material-stem.v1`, 32-byte token seed, 32-byte collection ID, big-endian uint256 token ID, SHA-256 of the UTF-8 stem ID, big-endian uint32 stem revision, and big-endian uint32 catalog revision. The checked cross-language vector for token seed `ab` repeated 32 bytes, collection ID `cd` repeated 32 bytes, token ID `18446744073709551617`, stem `film.holographic-glint`, revision 1, and catalog revision 3 is `529aa8d4d9e5dc8068a4f66d941165391f799413d811521435c51e09f28aeb50`.

Transparent sources must require real transparent pixels, can require partial-alpha pixels, and premultiplied sources are rejected when any color channel exceeds alpha. Runtime inspection accepts only genuinely one-byte-per-element `Uint8Array` or `Uint8ClampedArray` pixels, using typed-array intrinsic getters so a spoofed `Symbol.toStringTag` or wider typed array cannot cross the byte boundary. Opaque data atlases require linear RGBA channels and an entirely opaque alpha channel.

Stem and composition validators are closed commitment schemas: digest spellings are lowercase; unknown or inactive-union properties are rejected; inherited fields, accessors, hidden properties, non-current-realm prototypes, and Proxy-backed graphs are rejected; and only one concrete structured-cloned snapshot of own enumerable JSON data is used for validation and hashing. Regional assignments exactly cover every primary physical contribution's material-region routes—physical stacking must be modeled explicitly rather than leaking through a broad contribution route. Seed derivation snapshots and validates every preimage field synchronously before its first hash await, so mutation or a caller-controlled property trap cannot produce a never-validated hybrid seed. `materialStemDigest()` and `materialCompositionDigest()` therefore commit the same semantics across compliant implementations.

## Security and permanence model

- The loader rejects a codex or atlas whose SHA-256 differs from the caller's trusted build manifest.
- The codex also commits to the atlas digest, preventing a valid codex from being paired with another atlas.
- Streaming downloads, metadata, asset/frame/region/mask counts, WebP dimensions, and decoded pixels have strict configurable limits before image decode.
- SCX1 rejects non-canonical varints/JSON, duplicate identities, non-increasing mask pixels, invalid offsets, out-of-atlas frames, unknown selection IDs, and trailing data.
- The lock makes existing asset bytes, masks, slots, capacities, and selection snapshots append-only.
- The library lock likewise makes bundle revisions, dependency edges, and profile roots append-only; change means a new pinned revision.
- Full source provenance inventories exclude only the shared reserved compiler transaction/claim/staging grammars, the exact generated output, and generated locks; authored near-matching directory names remain inventoried. Library IDs use the same 128-character bound as the reserved transaction grammar.
- Transactional lock writes use a fixed-length SHA-256-derived temporary basename rather than embedding the library ID or destination basename, so every accepted ID remains independent of ordinary filesystem component limits.
- A digest proves byte identity, not availability. Permanent/on-chain applications still need to publish both files through their chosen durable carrier and pin the build-manifest hash in their registry.

The package is MIT licensed.
