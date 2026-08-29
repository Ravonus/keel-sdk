# Watermarks

A seeded watercolor PFP series painted with [p5.brush](https://github.com/acamposuribe/p5.brush)
on top of the p5.js shared module. One token seed derives everything:
palette, background, the base three attributes (Face, Eyes, Mouth), up to
seven optional attributes, and every imperfect stroke — so no two tokens can
ever land close, even when their trait lists match.

## Files

- `traits.js` — pure identity derivation. No p5, no DOM, no imports; the same
  module runs in the browser sandbox and the Node test suite. Emits the
  OpenSea-shape `attributes` list (`trait_type`/`value`) the protocol's
  `parseArtifactManifest` accepts. Background is deliberately **not** an
  attribute: the contract may swap it, so `deriveIdentity(seed, { background })`
  takes an override that never moves a trait.
- `portrait.js` — the renderer. Single WebGL canvas (p5.brush 1.x owns one
  context); layers live as `get()` snapshots: base washes, three ink "boil"
  frames, a blink frame. Resolution-independent — resize replays the recipe.
- `shared-module.mjs` — pins p5.brush 1.1.4 by digest and byte length, and
  builds the `shared-library` index entry once a carrier binding exists,
  mirroring `examples/agent-p5-project`.
- `tests/watermarks.test.mjs` — determinism, attribute-shape, rarity-bound,
  background-override, and vendored-digest commitments.

## Animation

Subtle by default, every token: a slow ping-pong boil of the ink, breathing,
blinks, and a gaze that follows the pointer. Bigger animations are rare and
ride rare traits: Flow Mane, Halo, Aura, Companion.

## Interaction

- **Hover** — the eyes follow; a faint wet trail ghosts the pointer.
- **Tap/click** — throws a paint splat in the token's own pigments; splats
  are committed into the painting and survive the boil.
- **Swipe/drag** — a gust of pigment streaks through in the swipe direction
  and nudges the ink before it settles back.

## Browsing seeds (gallery page only)

The corner seed bar (hidden inside a Keel token context) steps `?n=<index>`;
`?seed=0x…` pins an exact seed and `?bg=<style|index>` previews the
contract-driven background override.
