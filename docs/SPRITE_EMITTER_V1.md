# Keel Sprite Emitter v1

**Status:** active draft. It requires implementation and independent replay
review before deployment.

`oca-sprite-emitter@1` composes approved static or animated grayscale sprite
masters with a bounded deterministic particle simulation. It can attach to any
character, weapon, projectile, door, prop, pickup, mob, boss, map event, or
sprite-based UI event.

## Identity and no-reroll rule

Every recipe pins:

- emitter preset ID and revision;
- sprite bundle ID and revision;
- sprite asset ID and selection revision;
- FX catalog revision and map-generation epoch;
- grayscale material target and palette mode;
- seed-domain version.

Old maps keep those values forever. New presets/assets append new revisions;
they never change the selection modulus or dependency graph of an old epoch.

## Seed domain

The event seed is SHA-256 over fixed-width bytes:

```text
"oca.sprite-emitter.v1" ||
mapGenerationEpoch:u32be || mapSeed:bytes32 || mapId:bytes32 ||
emitterPresetId:u32be || emitterRevision:u32be ||
eventKind:u16be || worldEntityIndex:u32be || eventOrdinal:u32be
```

For collectible-owned FX, the token recipe selects the base emitter and sprite.
The map/event tuple changes only its environmental emission trace; it does not
mutate the NFT's stored identity.

Random dimension `n` uses counter-based SplitMix64 seeded from the first eight
bytes of the event seed:

```text
z = seed64 + (n + 1) * 0x9e3779b97f4a7c15  mod 2^64
z = (z xor (z >> 30)) * 0xbf58476d1ce4e5b9 mod 2^64
z = (z xor (z >> 27)) * 0x94d049bb133111eb mod 2^64
random64(n) = z xor (z >> 31)
```

Each particle and property has a fixed counter assignment. Implementations must
not call `Math.random`, wall time, frame time, RPC head state, or unordered
collection iteration.

## Integer simulation

- Simulation rate: 60 integer ticks/second.
- Positions, velocity, acceleration, scale, drag, and curve values: signed
  Q16.16 integers.
- Angles: unsigned 16-bit turns (`0..65535` maps to `0..2π`).
- Trigonometry uses one versioned integer lookup table or an equivalently pinned
  integer algorithm. Authoritative traces must not call host floating-point
  `sin`/`cos` functions.
- Fixed-point products use checked wide intermediates and fail closed on
  overflow before narrowing; JavaScript `number` multiplication is not an
  authoritative wide-integer operation.
- Color channels and alpha: `u8`.
- Counts, burst sizes, frame indexes, and lifetimes: bounded unsigned integers.
- A renderer may interpolate display frames, but the authoritative simulation
  advances only whole ticks.

## Recipe fields

The canonical recipe contains these bounded sections:

| Section | Required fields |
| --- | --- |
| sprite | bundle/revision, asset/selection revision, static or ordered frames |
| animation | per-frame tick duration, `once`, `loop`, or `ping-pong`, bounded seed-driven phase offset |
| spawn | static/burst/rate mode, max live/total particles, start/end ticks, bounded count/timing jitter and initial-position shape/ranges |
| motion | speed range, velocity cone, acceleration, drag, gravity, turbulence |
| transform | bounded start/end scale ranges, rotation and angular-velocity ranges, stable pivot |
| appearance | grayscale LUT/material target, seed-selectable pinned palette, alpha curve, blend mode |
| extras | optional trail length/width and bounded point-light radius/intensity |

V1 hard limits are 512 live particles, 4,096 total particles per event, 3,600
ticks, 64 animation frames, 16 curve points per channel, and 64 trail samples
per particle. Loaders may enforce lower limits. Any exceeded limit fails closed.

## Sprite-master rules

- Static masters are allowed when the event intentionally needs one glint,
  shard, fleck, or decal.
- Animated masters contain at least two non-identical frame digests and explicit
  integer timing.
- Recolorable masters use neutral black/gray/white luminance plus alpha. Runtime
  palettes/materials supply hue, glow, gradient, and intensity.
- The renderer must apply the selected material target and particle color to
  decoded master pixels. A palette field that is validated but not consumed is
  a failed build.
- Every non-tile frame has reviewed bounds, transparent padding, and a stable
  pivot. Neighboring contact-sheet pixels or opaque crop borders fail the build.
- Procedural emission changes placement/motion/appearance; it does not fabricate
  or silently approve new source artwork.

## Required proofs

1. Same map/event/recipe produces byte-identical emission traces and final
   render hashes in repeated TypeScript runs.
2. TypeScript, Solidity metadata/viewer inputs, and SmartPy/Python fixtures
   derive the same event seed and first 128 random words.
3. Different map seeds materially change every enabled preset dimension:
   palette, density, timing, spawn position, motion, scale, rotation, and
   animation phase.
4. Appending an emitter or sprite revision leaves all old epoch traces and
   dependency roots unchanged.
5. Browser capture shows the grayscale master, recolored animation, and complete
   generated emitter over a contrasting background with zero clipped pixels.
