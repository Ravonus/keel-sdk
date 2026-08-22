# Vault viewer surface boundary

Vault Arcade has three separate surfaces. They must not be collapsed into one HTML artifact.

## 1. Host transaction surface

The host application owns wallet connection and the `enterMap(characterId, mapId)` transaction. A successful transaction changes canonical registry state; browser-local pairing is never authoritative.

The registry escrows the character and records:

- `characterMap(characterId)`;
- `characterMapBuildRevision(characterId)`;
- `stakerOf(characterId)`;
- map occupancy and character pagination.

No portable character or map viewer contains a stake button.

## 2. Character collection viewer

`vault-keel-viewer-bundled.html` is the single-file character viewer. The host injects the verified Keel character context. The viewer renders the exact seeded orb, corrected weapon masks, weapon material attributes, FX, and verification proof.

Its optional combat showcase is intentionally not a map:

- one empty presentation arena whose seeded scene recipe selects the background, grid/accent palette, ambience, and post-filter;
- grid is the common scene, with constellation, reactor, and void-horizon alternatives;
- movement inside the viewer stage;
- three deterministic training-drone archetypes;
- no tiles, rooms, missions, shops, doors, or map generation;
- the arena stays dormant until the character fires;
- survival waves intensify only to demonstrate the character and equipped weapon.

When the character is staked, `characterAnimationContext(characterId)` tells the host which map and immutable build revision owns its live assignment. That assignment belongs to host/map routing; the standalone character viewer does not render staking or map-pairing UI.

## 3. Map collection viewer

`vault-game.html` is the map/game viewer. It accepts verified injected context only. The host resolves:

- `mapCharacterRuntime(mapId, characterId)` for the pinned map build and exact character recipe;
- `mapCharacterSeed(mapId, characterId)` for the build-bound deterministic game seed.

The map viewer runs the selected map build. It has no wallet UI, stake button, seed-pairing form, or browser-local assignment fallback. Local seed controls live only in `vault-game-harness.html` and are explicitly development-only.

## State flow

1. Host reads character and map ownership/state.
2. Owner submits `enterMap(characterId, mapId)` through the host wallet flow.
3. Registry records the character assignment and pinned map build revision.
4. Character viewer resolves standalone or staked presentation from registry state.
5. Map viewer resolves the exact staked character recipe and map seed from registry state.
6. `leaveMap(characterId)` returns the character and removes that map assignment.

The permanent HTML artifacts are renderers and game runtimes. They are not transaction coordinators.
