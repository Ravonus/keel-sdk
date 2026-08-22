# Vault Arcade Art Bible

This is the production contract between the game, artists, asset generators, and Keel manifests. It is intentionally stricter than a mood board: an asset that looks good but breaks registration, direction order, color policy, or render passes is not shippable.

## Visual direction

- Original top-down neon occult science-fantasy.
- Compact roguelike arena readability at small sizes.
- Dark stone and armor with restrained cyan and magenta emissive accents.
- Crisp pixel-art edges; no photographic texture, soft painterly blur, logos, or borrowed characters.
- Gameplay accepts diagonal movement, but production character art uses four
  authored facings: south, west, north, and east. It is never a side-scroller.

## Character rig

All character assets share one registration point and four authored directions in this exact order:

1. south
2. west
3. north
4. east

Diagonal movement chooses the dominant cardinal facing; the runtime never
mirrors or invents a missing authored direction.

Handedness is also authored, never mirrored. Rig v1 has anatomical
`dominantHand: right`: the character's right hand remains the firing hand in
south, west, north, and east. Turning west must not swap the weapon to the
left hand. The pistol stance is literally one-handed: the anatomical right
hand owns the weapon socket and the left arm stays neutral/free. Rifles, SMGs,
staves, and heavy guns use separate `combat-two-hand` stances where the left
hand becomes support. Directional approval records `leftHand` and `rightHand`
separately; a plausible pose with swapped hand ownership is rejected.

Perspective owns visibility. In the north row, the character aims screen-up,
away from the viewer. The right firing hand is therefore occluded by the
torso/head or appears beyond the upper silhouette; it must never be painted
across the visible back. In the south row the right forearm is foreshortened
toward the viewer while the left arm remains neutral. Pistol frames never
cross either forearm over the body centerline.

The nine independently replaceable contract slots are:

| Contract slot | Semantic layer      | Requirement                                                  |
| ------------- | ------------------- | ------------------------------------------------------------ |
| 0             | Hair / headgear     | Never contains face, body, or armor                          |
| 1             | Base body           | Blank head; no eyes, nose, mouth, ears, beard, or expression |
| 2             | Legs / boots        | Lower-body overlay only                                      |
| 3             | Shirt / torso armor | Torso overlay only; no weapon                                |
| 4             | Complete face       | Eyes, nose, mouth, ears, mask, or visor live here            |
| 5             | Weapon              | Weapon geometry only; no armor, torso, legs, or helmet       |
| 6             | Add-on one          | Independent foreground or background effect                  |
| 7             | Add-on two          | Independent foreground or background effect                  |
| 8             | Add-on three        | Independent foreground or background effect                  |

A seed chooses starter definitions and per-slot colors. An equipped definition replaces only its own slot. A face change must not alter hair; a weapon change must not alter armor.

## Render passes

One equipment definition may contain multiple exact resources and draw passes:

1. `background`: cape backs, wings, tails, back-mounted equipment.
2. `body`: base body, legs, torso, hair.
3. `foreground`: face, weapon, cape collar/clasp, particles, front effects.

A cape should normally provide `cape-back` and `cape-front` resources under one definition. The back renders before the body; the collar/front renders after it. Never solve overlap by baking the torso into the cape.

## Color policy

Every layer declares one immutable policy in its asset manifest:

- `fixed`: authored colors are preserved exactly.
- `tintable`: neutral white/grayscale pixels accept a runtime hex color through luminance multiplication.
- `palette`: the creator declares a finite set of authored colors; a seed or owner chooses only from that set.

Emissive cyan/magenta details are normally fixed even when the underlying cloth or metal is tintable. A tint operation must target only the declared mask/pass.

Most production equipment should be tintable or use an authored palette. Fixed color is reserved for deliberate accents, materials, identity marks, and effects. A tintable layer with fixed accents publishes separate grayscale and accent masks so runtime color never destroys the authored glow.

## Rarity, colors, and sets

Rarity is attached to an exact item trait and its allowed color range, never to a universal color table. Cyan may be common for one set and extremely rare for another. Sets declare affinity groups so matching body, armor, weapon, face, and effect combinations can be scarce without making every individual component equally scarce.

Each catalog definition commits:

- trait/shape weights;
- allowed color ranges and weights for that item;
- fixed accent masks;
- set IDs and matching-set affinity weights;
- incompatibilities and mutually exclusive combinations;
- the deterministic selection algorithm version.

The mint receipt stores or derives the selected definition IDs and color values from the committed seed. Changing weights requires a new catalog revision and cannot rewrite existing characters or equipment.

The compact runtime material codec is `oca-material-bits@1`. It supports four explicit policies:

- `locked`: exact RGB bytes are never recolored.
- `palette`: choose from a weighted authored list.
- `ramp`: commit exact dark, mid, and light colors for deterministic shading.
- `range`: choose bounded hue, saturation, and lightness from the mint seed, then derive a three-stop material ramp.

The character catalogue is not limited to the nine interoperable equipment slots. `oca-trait-catalog-bits@1` gives every named attribute a stable numeric ID and weighted options; verified JSON holds human names and descriptions. Vault Arcade revision 1 includes nine core slots plus fifteen custom attributes for lineage, scenes, auras, trails, projectiles, voice, music, animation, effects, emotes, affinities, shaders, and SFX. A later catalogue revision may append more attributes without changing the ERC-721.

The current catalogue has 24 attributes with 16 options each: `16^24 = 2^96` discrete combinations before bounded material colors. The mint registry can reject a visual fingerprint already used by another token, so the uniqueness promise does not rely on probability alone.

## Runtime size budget

- Hard ceiling: 8 MiB of decoded runtime assets for one complete playable map build, including inherited dependencies.
- The creator pipeline must count recursive assets before publication and fail closed above the ceiling.
- WebP is preferred for pixel and raster layers; AVIF is preferred when it materially wins after visual comparison. Lossy settings are allowed only after alpha edges, animation, and palette masks pass visual checks.
- Reused Keel objects count once in storage estimates, but the reader budget counts every unique decoded dependency required by that build.
- Recommended targets: core runtime under 1 MiB, active character rig under 2 MiB, map/tiles/effects/audio under 4 MiB, and at least 1 MiB headroom for creator extensions.

## Atlas and animation rules

- Runtime format: WebP with alpha.
- Canonical authored gameplay cell: 48×48 pixels, displayed at 96×96 with
  nearest-neighbor scaling. Higher-resolution hero previews are separate
  preview assets and never silently replace gameplay bytes.
- Direction and animation frame are independent axes. Four directions never
  means four total animation frames.
- A clip with `n` frames contains `4 × n` registered cells for every visual
  slot it affects. An eight-frame attack therefore contains 32 cells per layer.
- Prefer one clip per atlas while authoring. A later deterministic packer may combine clips without changing their frame manifests.
- Every atlas declares direction order, clip name, frame count, frame rectangles, FPS, loop behavior, semantic slot, and anchors.
- Animated WebP/AVIF may be used for previews, but gameplay sheets still expose deterministic frame metadata.
- All direction cells in one rig use identical bounds and registration.
- Idle, walk, attack, hit, and death animation sets may have different frame
  counts but must retain the same four-direction order.
- Nearest-neighbor sampling is mandatory for pixel art.

## Canonical stance and clip library

Stances describe rig posture and compatible equipment anchors. Clips animate within one stance.

| Stance            | Required use                  | Notes                                           |
| ----------------- | ----------------------------- | ----------------------------------------------- |
| `explore`         | default movement              | relaxed weapon position and readable silhouette |
| `combat-one-hand` | swords, pistols, small tools  | weapon hand and off-hand anchors                |
| `combat-two-hand` | rifles, staves, great weapons | both hands bind to weapon-authored anchors      |
| `cast`            | spells and effects            | independent hand, origin, and target anchors    |
| `interact`        | doors, loot, switches         | reach and carry poses                           |
| `downed`          | hit, death, revive            | floor/contact anchor remains stable             |

Minimum production clips:

| Clip            | Suggested frames per direction | Loop | Required anchors/events                           |
| --------------- | -----------------------------: | ---- | ------------------------------------------------- |
| `idle`          |                              4 | yes  | root, face, both hands, weapon, effect            |
| `walk`          |                              6 | yes  | root, feet, hands, weapon; left/right foot events |
| `run`           |                              8 | yes  | root, feet, hands, weapon                         |
| `dodge`         |                              6 | no   | root path, invulnerability start/end              |
| `attack-light`  |                              8 | no   | windup, hit-start, hit-end, recovery              |
| `attack-heavy`  |                             12 | no   | windup, charge, hit-start, hit-end, recovery      |
| `attack-ranged` |                              8 | no   | muzzle/origin and fire event                      |
| `cast`          |                             10 | no   | both hands, effect origin, release event          |
| `hit`           |                              3 | no   | impact event                                      |
| `death`         |                             10 | no   | collision-disable and final-pose events           |
| `interact`      |                              6 | no   | hand/contact event                                |

Frame metadata, not timing guesses, owns gameplay events. Art may contain anticipation and follow-through frames without widening the damage window.

## Anchors and collision

Every frame manifest declares normalized or pixel coordinates for `root`, `leftFoot`, `rightFoot`, `leftHand`, `rightHand`, `weaponGrip`, `weaponTip`, `muzzle`, `face`, `effectOrigin`, and `hurtbox`. Equipment never guesses attachment from image bounds. A two-handed weapon declares a compatible stance and binds both hand anchors. Capes and particles may exceed the hurtbox without changing collision.

The base-body silhouette may not grow equipment geometry during animation.
Backpacks, tanks, holsters, rear plates, capes, and shoulder packs belong to
equipment definitions and render passes. Any unexplained rear protrusion fails
the manager review even when its color happens to match the base body.

## Variation system

Species, body types, faces, hair, armor, weapons, and add-ons are variation families, not baked full characters. Each variation declares its compatible rig version and stances, exact supplied clips/directions/frames, missing-clip policy, color regions, render passes, anchor overrides, and source/processed digests. Missing clips are normally incompatible; the renderer must never silently stretch one direction or pose into another.

Generate one family and one clip at a time. Approve registration before generating the next clip, then use the approved sheet as the visual reference for all overlay layers.

### Lancer rotor chassis invariant

The approved Lancer base is a floating machine, not a humanoid rig. Its two
long lower fork prongs are rigid chassis rails and may never move as feet or
legs. Its two large side plates are rigid armor housings and may never flap or
articulate as hands, arms, or wings. The small two-blade assembly around the
short top mast is the continuous-motion rotor. A basic loop keeps the body,
core aperture, side armor, lower prongs, silhouette, registration, scale, and
camera pixel-locked while only that top rotor turns.

Animation acceptance is one group at a time. A generated clip stays a review
candidate until the manager shows every direction playing and a human approves
it. Mechanical frame counts, file presence, or provider completion cannot
promote it. The original `idle-hover`, `move-glide`, `charge-attack`,
`hit-recoil`, and `death-collapse` PixelLabs groups are rejected because they
articulate the lower prongs and side armor as creature limbs. They must not be
loaded by gameplay.

The first PixelLabs rotor-only repair group is also rejected: visual inspection
showed changes outside the rotor in every direction. The replacement review
path uses Codex ImageGen direction strips, preserves the approved base as the
runtime fallback, and requires explicit human approval in the mob manager.

The first SOUTH attack candidate is rejected because silhouette length changes
without a visible stored-energy buildup read as a wobble, not an attack.
Revision 2 must show core ignition, inward particles, illuminated inner prong
edges, a maximum-charge hold, one compact plasma discharge, then aftershock and
recovery. The rigid chassis may recoil as one object; no housing or prong may
articulate.

Animation generation is blocked until the semantic layer review is approved:

```sh
pnpm --filter @keel/studio asset:pixellab-preflight -- \
  --review ../../examples/demos/vault-arcade/generated-attribute-proxy/base-layer-review.json
```

The preflight requires every structural and semantic check to pass. A correct
grid, alpha mask, or ground line cannot override baked face, armor, backpack,
weapon, or other wrong-layer pixels.

## Source generation workflow

Generate on a solid chroma field, retain the generator output as source evidence, remove the chroma with a soft matte/despill pass, visually inspect alpha edges, then publish WebP bytes and the human-readable atlas manifest as separate Keel objects.

Current chroma conversion command:

```sh
python3 remove_chroma_key.py \
  --input source.png \
  --out final.webp \
  --auto-key border \
  --soft-matte \
  --transparent-threshold 12 \
  --opaque-threshold 220 \
  --despill \
  --force
```

## Generation prompt: environment atlas

> Create an original production sprite atlas for a top-down four-direction roguelike arena fighter with diagonal movement. Pixel art, crisp nearest-neighbor edges, solid chroma background, generous clean spacing. Include modular floors, cracked floors, walls, corners, doors, gates, portals, traps, terminals, crystals, pickups, debris, projectiles, and occult science-fantasy props. Dark stone and metal with restrained cyan and magenta emissive accents. No text, logos, UI, or copyrighted characters.

## Generation prompt: nine-slot character rig

> Create an original modular pixel-art component sheet for a top-down four-direction roguelike arena fighter with diagonal movement. Exactly four directions ordered south, west, north, east. Exactly nine independent layers: blank-face base body, legs/boots only, shirt/torso armor only, hair/headgear only, complete face only, weapon only, add-on one, add-on two, add-on three. Every cell uses the exact same registration point. The base head has no facial features. The weapon layer has no armor or body. Grayscale regions are tintable; authored emissive effects are fixed. Solid chroma background. No text, UI, logos, or copyrighted characters.

## Generation prompt template: one directional animation clip

> Create an original modular pixel-art `[CLIP]` animation sheet for the approved Vault Arcade `[STANCE]` rig. Exactly four directional rows ordered south, west, north, east. Exactly `[FRAME_COUNT]` chronological frames per row from anticipation through recovery. This sheet contains only the `[SLOT]` layer. Preserve the supplied reference rig's 48×48 cell, root at `[24,46]`, silhouette, blank-face rule, hand anchors, and registration point in every cell. `[FRAME_EVENTS]`. Transparent output. No text, UI, logos, copyrighted characters, or pixels from other equipment slots.

## Single-direction repair board contract

A failed direction is repaired alone. Never pay to regenerate a complete
turnaround or every direction when only one direction failed. The manager
builds one explicit repair board with three visual rows:

1. `STANCE` is one clean static target-direction view, never a rejected animation.
2. `ACTION` is the approved opposite-direction identity and chronology.
3. `OUTPUT` fixes the number, order, and dimensions of returned cells.
   The board contains references, frame labels, and empty output cells—not prose
   instructions. The separate generator prompt owns the anatomy, occlusion,
   semantic-layer, and failure rules and points to Board Rows A/B/C. The board and
   prompt must always be submitted together. For a West-facing right-handed body socket, the anatomical
   right firing arm is the far/rear arm, begins behind the torso, and extends
   screen-left. The anatomical left arm is near/foreground and remains down at
   the hip. The near arm must visibly overlap the torso edge while the firing arm
   originates behind it. A result using the foreground arm to point is rejected
   even if its silhouette otherwise looks plausible.

When the opposite direction is already correct, that approved sequence owns
the action. The repair is the same character performing the same action after
a 180-degree turn, with strict `F1 -> F1` through `F9 -> F9` correspondence.
This is not a pixel mirror: mirroring swaps anatomical hands. A one-hand action
must remain one-hand in every frame—exactly one arm is raised, the hands never
meet, and no support grip may appear.

The repair request declares exact output math before generation. The current
West sidearm repair is one `828x92` transparent strip containing nine `92x92`
cells at boundaries `0,92,184,276,368,460,552,644,736,828`. It may not return
the instruction board, another direction, labels, borders, a contact sheet, or
an opaque background. Normalizing a generator image to those dimensions is a
mechanical operation only and can never approve the visual result.

Every repair prompt includes explicit failure clauses for wrong hand,
identity drift, extra semantic layers, equipment/effects, geometry, alpha,
root drift, and frame count. The manager first runs mechanical checks and then
requires human motion/anatomy review. Only the repair board may be marked
`approved-generation-input`; generated sprite pixels remain candidates until
both gates pass.

Canonical current files:

- board: `examples/demos/vault-arcade/generated-attribute-proxy/west-sidearm-repair-board-v1.png`
- exact prompt: `examples/demos/vault-arcade/rig/west-sidearm-repair-prompt-v1.txt`
- board builder: `apps/studio/scripts/build-vault-west-repair-board.ts`

## Procedural still rig

Vault Arcade does not need to store a rendered sheet for every action. The
production runtime stores one still cell per approved layer and direction plus
the compact `sidearm-still-rig.json` pose timeline. The verified
`procedural-sprite-rig.js` resource deterministically generates the nine-frame
layer atlases in the browser.

Hands are separate semantic layers, never inferred from a full-character
generation. The anatomical-right firing arm stays the same asset in every
direction. Only depth changes: East draws left arm, body, right arm; West draws
right arm, body, left arm. The weapon remains a separate final layer. Until the
isolated arm stills pass visual review, the legacy full-body still is only a
runtime compatibility input and must not be called approved sidearm art.

## Correction prompts learned during production

Blank base face:

> Change only the base body row. Remove every eye, eyebrow, nose, mouth, beard, ear detail, tattoo, visor, and facial expression. Leave a neutral blank skin-colored head designed to receive the separate complete-face overlay. Preserve every other row and registration point.

Weapon isolation:

> Change only the weapon row. Remove torso armor, shoulders, body, legs, helmet, and armored arms. Leave only the independent weapon geometry and a minimal neutral grip where required. Equipping it must not change any other character layer.

## Acceptance checklist

- [ ] Eight authored directions read correctly in motion without mirroring.
- [ ] Base head is blank and face overlay supplies all features.
- [ ] Weapon has no armor/body pixels.
- [ ] Every slot can be removed without punching accidental holes in another slot.
- [ ] Background equipment renders behind the body and foreground parts render above it.
- [ ] Tinting changes only declared grayscale regions.
- [ ] Fixed-color details remain unchanged.
- [ ] WebP alpha edges show no chroma fringe at 1x and 8x zoom.
- [ ] Atlas metadata exactly matches the published bytes.
- [ ] Preview scene exercises all directions, animation timing, and at least one slot swap.
- [ ] Source image, processing receipt, decoded WebP digest, and atlas manifest digest are recorded before publication.
- [ ] Recursive decoded runtime graph is no more than 8 MiB and reports remaining headroom.
- [ ] Trait, color-range, and set-affinity weights are committed and reproducible from a known seed.

## Provenance for the current v2 starter assets

- Environment atlas source prompt: generated in built-in image-generation mode, then chroma-keyed to `examples/demos/vault-arcade/assets/vault-tiles.webp`.
- Tintable equipment atlas source prompt: generated in built-in image-generation mode, then chroma-keyed to `examples/demos/vault-arcade/assets/tintable-kit.webp`.
- Historical v2 character rig: generated as an eight-direction sheet, corrected
  once to blank the base face, and corrected again to isolate weapon geometry
  before chroma removal into
  `examples/demos/vault-arcade/assets/character-parts-eight-direction.webp`.
- Current candidate base rig: PixelLab character
  `b9c2e6c8-6b5e-4dbd-9b33-ce1ea5b3c54f`, packed into 120 grounded
  48×48 cells at
  `examples/demos/vault-arcade/assets/base-character-atlas-v1-q50.webp`.

## Game atlas and animation authority

The biome atlases are grayscale world-content candidates, not approved animated
actors. Their six semantic rows are fixed as floor, wall, object, enemy,
boss-part, and effect. Runtime recoloring may target those grayscale values, but
must not relabel a static enemy or boss cell as a finished movement set.

Every creature, boss, or other object that needs direction or motion follows the
same two-stage production gate:

1. PixelLabs produces one identity-locked eight-direction master.
2. ImageGen receives that approved master and produces separately reviewed idle,
   move, attack, hit, and death loops. Each loop remains a candidate until the
   animation manager approves actual pixels and motion.

The current Prism Garden, Signal Crypt, and Void Engine sheets were generated in
built-in ImageGen mode as exact 6x6 grayscale pixel-art atlases. The prompt for
each sheet fixed all six semantic rows and changed only its biome vocabulary:
glass/moss/crystal/root; crypt/rune/sarcophagus; or reactor/conduit/iris. Their
lossless source PNGs, quality-70 runtime WebPs, hashes, sizes, and prompt summaries
are recorded in
`examples/demos/vault-arcade/generated-attribute-proxy/assets/game/biomes/biome-atlas-manifest-v2.json`.
