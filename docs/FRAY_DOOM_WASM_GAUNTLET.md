# FRAY Doom WASM Optimization Gauntlet

**Status:** active planning and baseline sprint. No production auction, public-chain
publication, generated art promotion, generated audio promotion, or release approval
is claimed by this document.

This is the acceptance contract for turning the pinned Doom-compatible WASM lane into
a small, fast, controller-complete, independently reviewed FRAY auction artifact backed
by Keel on Ethereum.

## 1. Product claim

The accepted release must let a collector open the FRAY auction viewer and start the
game after one content-bearing JSON-RPC `eth_call` to one Keel entrypoint. The normal
auction page may perform its separately labelled ownership, auction, and metadata reads;
those calls must not be described as the game-content read.

The one content call must return one immutable, self-describing container containing all
game content required after the FRAY bootstrap has loaded:

- the optimized engine WASM;
- the approved IWAD/PWAD or equivalent FRAY content pack;
- the exact generated art and sound assets consumed by the game;
- the action/binding defaults and runtime configuration;
- a member table with media types, byte lengths, offsets, compression, and SHA-256;
- source, license, model/provenance, and build-recipe commitments.

After the call, the viewer may not fetch game bytes from IPFS, a CDN, a gateway, another
contract call, a per-carrier RPC request, a service worker, or an existing browser cache.
The FRAY bootstrap and auction chrome are host code, not hidden game content. The proof
must say this plainly.

The auction/token record must independently bind the expected Keel target and container
commitment: object identifier/derivation, stored-container SHA-256, portable root, and decoded
manifest/provenance root. These expected values come from the immutable auction integration,
not from the same RPC response that supplies the game bytes. A separately labelled metadata
read may carry the commitment; it cannot be treated as a second source of game content.

Before execution, the viewer must:

1. enforce a compressed response limit, recompute the stored-container digest and object
   derivation, and compare the RPC target and results to the independently auction-bound
   commitment before parsing any member;
2. parse the container without evaluating content-supplied JavaScript;
3. enforce per-member and total decoded byte limits, then decompress with a pinned decoder;
4. recompute and compare the decoded manifest/provenance root and every decoded member length
   and SHA-256 to the independently auction-bound values;
5. reject missing, duplicated, overlapping, truncated, trailing, substituted, or
   commitment-mismatched content before WebAssembly compilation or instantiation;
6. instantiate the verified engine in the existing egress-denied Keel sandbox.

## 2. Current baseline: facts, not release claims

The present repository already has a real Doom lane:

| Fact | Current evidence | Boundary |
| --- | --- | --- |
| Upstream | `jacobenget/doom.wasm` at `31cc1af9656a8184830090c4e9f268383f5d7e15` | Source is GPL-2.0; game data is a separate rights surface. |
| Existing decoded artifact | 4,559,862 bytes, SHA-256 `0x666989bd996b8ec9a294003f0e8f08838d9a1ce721083c093378f0d18b8fef66` | Reconstructed from the checked-in Keel plan; `WebAssembly.validate` passes. |
| Embedded content | The pinned build embeds the 4,196,020-byte `DOOM1.WAD` at module offset 301,124; it is 92.02% of the current WASM, and WAD sentinels such as `PLAYPAL`, `E1M1`, and `DSPISTOL` are present | The raw WAD is not checked in, but its compiled bytes are in the distributed WASM. |
| Current Ethereum plan | compression `none`, 199 carriers, two leaf objects and one composite | This is not the desired compressed release. |
| Current one-call receipt | one `KeelHold.haulObject(bytes32)`, 4,559,862 returned bytes, 500,000,000 call gas, 281 ms | RPC is `localhost` with chain ID `11155111`; this is not public Sepolia/provider/browser proof. |
| Current reader | `KeelHold.haulObject` reconstructs only objects whose compression is `None` | Switching the object enum to Brotli makes the current reader revert. |
| Existing decoder | `brotli-dec-wasm@2.3.2`, 208,439-byte decoder WASM, already embedded by the standalone Keel viewer builder | Decoder bytes, initialization time, peak memory, and security limits must be counted. |
| Current engine build | WASI SDK 24, C `-g -Os`, link strip, Binaryen merge plus `wasm-metadce` | No accepted `-Oz`/LTO/`wasm-opt` frontier exists yet. |
| Current browser shell | keyboard only, `setInterval` at 35 Hz, JavaScript per-pixel BGRA-to-RGBA loop, no save support | It is a reference shell, not the FRAY runtime. |
| Current audio | `FEATURE_SOUND` is disabled | Replacing sound lumps alone would still produce a silent game. |

An exploratory whole-binary compression sweep on the exact baseline produced:

| Candidate | Stored bytes | Raw ratio | 23,000-byte carriers | Round trip |
| --- | ---: | ---: | ---: | --- |
| Brotli q1 | 2,176,215 | 47.73% | 95 | pass |
| Brotli q4 | 1,958,146 | 42.94% | 86 | pass |
| Brotli q6 | 1,873,591 | 41.09% | 82 | pass |
| Brotli q9 | 1,843,957 | 40.44% | 81 | pass |
| Brotli q11 | 1,541,562 | 33.81% | 68 | pass |
| gzip level 9 | 1,949,797 | 42.76% | 85 | pass |

These measurements are builder observations on one Apple Silicon host, not a benchmark
approval. The repository's earlier 16,777,215-gas read curve passed at 1,449,984 bytes
and failed at 1,454,080 bytes. The current q11 candidate is 91,578 bytes above that
measured passing point.

The Sprint 01 **local feasibility milestone** is no more than 1,350,000 stored bytes and
no more than 64 carriers. It is not the public-provider release ceiling. Until target
providers are freshly profiled, the public-read fallback is 1,048,576 bytes and the
release target is its 80% safety value: **838,860 bytes**. Once provider profiles exist,
the release ceiling becomes the lower of:

- 80% of the smallest reproducibly passing target-provider cutoff; and
- the byte size that executes within 13,421,772 gas, 80% of the 16,777,215 reference
  read budget.

No manager may weaken the ceiling to make a candidate pass. A changed ceiling needs a
new measurement packet and independent storage-critic approval.

## 3. Rights and product identity gate

Open engine source does not make Doom's WAD art, maps, sounds, music, writing, names, or
branding open source. The paid/public FRAY artifact must have a source and license row for
every shipped member.

The preferred shippable lane is:

- keep the GPL-2.0 engine and publish the corresponding modified source/build recipe;
- use a permissively licensed Doom-compatible content base such as Freedoom only as an
  audited starting point, or build a clean-room FRAY mini-IWAD;
- generate new FRAY art and sound from gameplay-role specifications, not by cloning
  protected Doom pixels or waveforms;
- use original FRAY naming, presentation, and packaging;
- keep commercial/shareware Doom WADs in local compatibility testing only unless a
  documented right explicitly covers this on-chain commercial distribution.

Freedoom is a useful rights-safe compatibility reference, but its complete IWAD is much
larger than the current shareware payload. It is not automatically the size winner.
Sprint 01 must compare a pruned, attribution-preserving content pack with a clean-room
single-level/episode pack before the manager selects the shippable content lane.

The rights gate returns `NEEDS_EVIDENCE` when a source, license, contributor notice,
model term, or redistribution right is missing. A legal uncertainty cannot be traded
against technical quality.

## 4. Target package architecture

The primary candidate is a versioned binary container, not a WASM module with a giant
embedded data segment:

```text
FRAY auction viewer bootstrap
  -> one eth_call: readStoredObject(containerObjectId)
     -> fixed header + canonical member table
        -> engine.wasm.br
        -> fray-game.wad.br
        -> bindings.json.br
        -> provenance.json.br
  -> bounded Brotli decode
  -> SHA-256/length verification per decoded member
  -> instantiate smaller engine.wasm
  -> provide verified WAD bytes through the existing loading imports
  -> run inside verified, egress-denied iframe
```

Why this is the leading design:

- removing the WAD from the WASM data segment reduces WebAssembly validation/compile work;
- one call can still return the engine and all content;
- members can be decompressed and retired independently to lower peak memory;
- art/audio rebuilds do not require recompiling the engine;
- member hashes make binary bisection and rollback precise;
- the engine already supports host-provided IWAD/PWAD bytes.

The container experiment must compare:

- one whole-container Brotli stream;
- independently compressed members;
- raw engine plus compressed content;
- Brotli qualities 4, 6, 9, and 11;
- the embedded WASM decoder against native `DecompressionStream("brotli")` when present.

Chromium support for native Brotli decompression cannot be assumed. Capability detection
may select a native decoder only after its output passes the same digest and limit tests;
the pinned decoder remains the portable path until the browser matrix proves otherwise.

## 5. Optimization layers

Each layer is an isolated experiment with one primary changed variable. A smaller build
that fails fidelity, startup, memory, accessibility, or proof gates is not an optimization.

### L0 — freeze and reproduce the baseline

- pin source commit, toolchain images by digest, Binaryen version, Node/pnpm lock, and WAD/content digest;
- rebuild twice in isolated directories and require byte-identical outputs or document
  every nondeterministic section before proceeding;
- preserve the current WASM, WAD directory, demo/save fixtures, and reference captures;
- record imports, exports, sections, data segments, code/data split, and source-to-binary recipe;
- create deterministic demo/save/checksum and frame/audio-event oracles.

### L1 — compiler, linker, and WASM structure frontier

Test `-Os`, `-Oz`, LTO, function/data sections with garbage collection, symbol/debug/name
section removal, Binaryen `wasm-opt` size profiles, export reduction, static data pruning,
memory/table limits, and WAD de-embedding. Never combine flags until their individual
fidelity and size effects are known.

For each candidate record raw bytes, Brotli bytes, compile time, instantiate time,
first-frame time, steady frame time, memory growth, and deterministic demo output.

### L2 — game-content inventory and pruning

Parse the WAD directory into a complete, deterministic manifest containing every lump's
name, namespace, size, offset, decoded dimensions/rate, palette/transparency semantics,
gameplay role, source, license, input digest, and reachability. Inventory:

- maps and nodes;
- sprites by actor/weapon/effect, direction, rotation, and frame;
- patches, textures, flats, skies, fonts, menus, HUD, status, intermission, and palettes;
- SFX, music, demo, text, and metadata lumps.

Prove any removal with map traversal, state-table reachability, demo playback, and full
level-completion tests. Do not remove secrets, difficulty variants, death frames, weapon
states, UI states, or accessibility cues because they were absent from one capture.

### L3 — compression and storage layout frontier

- compare whole and per-member compression including decoder overhead;
- sweep Brotli quality/window/mode and record encode/decode p50/p95;
- measure carrier count, contract write gas, reader gas, ABI copy cost, RPC hex expansion,
  browser parse cost, and peak live buffers;
- construct the Pareto frontier for stored bytes, first frame, p95 frame time, and peak memory;
- add malformed, truncated, overlong, duplicate-member, overlap, and decompression-bomb tests.
- add a malicious-RPC substitution test in which a different, internally self-consistent
  container and manifest are returned; the auction-bound commitment check must reject it
  before parsing members or compiling WebAssembly.

No EVM-side Brotli decompression is planned. Ethereum returns committed stored bytes;
the verified browser performs bounded decompression and checks decoded commitments.

### L4 — one-call Keel read surface

Add a separately named read surface whose semantics are stored bytes, not decoded bytes.
It must allocate by `storedByteLength`, copy leaf carriers once into one output buffer,
support the approved object shape, reject cycles/depth/length mismatch, and leave the
existing decoded/read semantics intact.

Proof order is mandatory:

1. focused Solidity tests;
2. local optimized build and local chain boundary curve;
3. actual container one-call hash proof;
4. fresh calls against at least two public Sepolia RPC providers;
5. FRAY's exact browser path with RPC instrumentation proving one content `eth_call`;
6. only then, an approval-gated public publication or auction action.

The receipt must include block tag/hash, chain ID, RPC origin, target, calldata, gas,
response byte count, elapsed time, RPC method counts, decoded member hashes, console log,
and source/artifact/runtime-bytecode fingerprints.

### L5 — browser runtime and rendering

- replace the timer with a `requestAnimationFrame` accumulator that preserves Doom's
  35 Hz simulation and caps catch-up work;
- move frame conversion off the hot JavaScript per-pixel loop by testing a WebGL shader,
  direct compatible RGBA output, and an `OffscreenCanvas` worker path;
- pause/resume safely on visibility and focus changes without simulation spirals;
- persist saves with a versioned, bounded IndexedDB adapter;
- handle orientation, resize, context loss, audio unlock, background/resume, and memory pressure;
- keep a Canvas 2D fallback and integer scaling for low-end/compatibility devices.

Acceptance devices include desktop Chromium/Firefox/WebKit, real iOS Safari, real Android
Chrome, and at least low/mid/high device tiers. Report cold and warm startup, p50/p95 frame
time, missed 35 Hz ticks, input latency, memory high-water mark, thermal degradation, and
crash/reload behavior.

### L6 — unified controls and binding UI

Every input maps to semantic actions first; only the adapter translates actions to the
engine's exported Doom key values.

Required actions include movement, turn, strafe, fire, use, run, automap, menu, pause,
weapon slots/cycle, confirm, cancel, and save/load controls supported by the build.

Required adapters:

- keyboard using physical `KeyboardEvent.code` defaults with a visible layout-aware label;
- standard Web Gamepad API mapping for Xbox, PS5/DualSense, and generic controllers;
- a versioned data-only controller-profile format for nonstandard devices;
- multi-pointer mobile touch controls with safe-area-aware editable layout;
- optional pointer-lock mouse look/turn only if fidelity tests approve it.

The UI must support capture-to-bind, conflicts, clear/cancel, reset, device switch/lock,
hot-plug/reconnect, multiple pads, dead zones, sensitivity, invert, touch scale/opacity,
and versioned local persistence. Auto-detection may suggest a device and prompt glyph set;
it may not silently replace an active player's custom bindings. Controller plugins are
allowlisted data, never fetched executable code.

Mobile proof covers landscape/portrait policy, thumb reach, multi-touch chords, pointer
cancel, browser gestures, safe areas, 44 CSS-pixel targets, reduced motion, flash limits,
contrast, focus order, accessible names, and non-audio gameplay cues.

### L7 — ImageGen art pipeline

No art generation begins until the complete WAD/lump manifest and rights gate pass.
Every generated file starts as a candidate outside the live runtime.

For each sprite family or visual asset:

1. write a functional visual specification: gameplay role, silhouette, directions, frames,
   timings, dimensions, pivots, masks, palette indices, and invariants;
2. define the restrained FRAY palette: blue and rose leads, limited supporting colors,
   clean CRT/synthwave accents, preserved readability and animation semantics;
3. generate or edit with Codex ImageGen using one built-in call per distinct asset/family;
4. save project-bound candidates in a versioned candidate directory without overwriting
   the active asset;
5. create contact sheets and in-game motion captures;
6. have an independent art critic review identity, direction, silhouettes, pivots, alpha,
   seams, weapon alignment, hit/death readability, photosensitivity, and mobile scale;
7. let the manager promote only the critic-passed hash.

Original Doom pixels are not used as direct edit targets for a public derivative asset
unless the rights packet explicitly permits that use. The preferred clean-room process
uses semantic role specifications and permissively licensed FRAY/Freedoom references.

Source masters remain lossless. The runtime target is not predetermined as WebP or AVIF:
vanilla Doom consumes indexed patch/flat/sprite lumps, and adding a WebP/AVIF decoder may
increase the net artifact. The codec experiment must compare:

- WAD-native indexed/paletted lumps inside the outer Brotli container;
- lossless WebP where alpha/edge behavior survives and a net decoder win exists;
- lossy WebP/AVIF only for color imagery where visual diff, decoder support, and net bytes pass;
- PNG for masks, fonts, UI, and assets where lossy coding damages semantics.

An image codec wins only on total stored bytes plus decoder, decode time, peak memory, and
in-game fidelity. “Every spritesheet changed” means every manifest entry is either replaced
by an approved hash or carries a documented not-applicable exception; filenames are not
used as the completeness oracle.

### L8 — FAL sound pipeline and browser audio

First implement sound playback. The leading runtime design is a minimal Doom sound bridge
that preserves event/channel/volume/separation/stop semantics and uses Web Audio after an
explicit user gesture. The implementation must work without `SharedArrayBuffer`, because a
marketplace iframe cannot assume cross-origin isolation. An AudioWorklet/mixer path may be
tested, but its headers and fallback must be proven in the actual FRAY host.

Then inventory every SFX and music event. For each generated sound record FAL endpoint,
model/version, prompt, negative prompt, seed, inference settings, duration, source references,
cost receipt, raw WAV hash, processed hash, sample rate, channels, loudness, peak, and loop
metadata. Do not upload protected Doom recordings as audio-conditioning inputs. Generate
from the event's functional description: cue identity and timing may remain analogous;
the waveform and production must be original FRAY material.

The current preferred candidate service is FAL's Stable Audio SFX path, but the exact model
is pinned only after a small audition packet. Keep lossless masters, then compare Doom-native
DMX/PCM, Opus, AAC, and other browser/runtime encodings including decoder cost. Test clipping,
simultaneous voices, resampling, spatial separation, mute/volume, autoplay unlock, Bluetooth
latency, background/resume, and non-audio cue parity. Music is a separate declared scope and
cannot be silently bundled into the SFX claim.

### L9 — FRAY auction integration

The FRAY release binds exact collection/token, auction, viewer, Keel object and its
derivation, stored-container SHA-256, portable root, decoded manifest/provenance root,
decoded member hashes, engine source commit, content license manifest, and runtime bytecode.
The viewer must receive those expected commitments independently of the content response and
compare them fail closed before parsing or execution. The public page must show a concise
collector-facing verification summary with expandable technical details.

The current checkout only exposes a review-only FRAY upload plan and an approval envelope;
it does not contain a proved live FRAY auction-to-Keel bridge, implemented approval-request
API, or Ethereum-mainnet chain profile. Before integration, a dependency packet must identify
the actual FRAY site repository, auction contracts, deployed chain scope, viewer entrypoint,
and authorized local test path. Until then, F0 is `NEEDS_EVIDENCE`, not estimated from the
SDK types.

Proof must include:

- clean local SDK/MCP/FRAY and viewer builds before any remote action;
- local auction fixture without claiming it is real;
- testnet transaction receipts and independent indexer/contract read-back;
- fresh desktop and mobile browser playback from the actual auction page;
- wallet/authenticated state separately labelled;
- one-content-call instrumentation and no undeclared network egress;
- append-only revision/rollback behavior.

No agent may publish, bid, fund, sign, deploy, or create a live auction without the relevant
action-time approval. No AWS or managed-site rollout starts before its relevant local build
is clean.

## 6. Fidelity and performance oracle

The baseline oracle must make “did not break the game” executable:

- deterministic demo playback and end-state checksums;
- save/load round trips at fixed checkpoints;
- level starts/exits, doors, lifts, secrets, keys, switches, teleports, pickups, damage,
  weapon cadence/ammo, enemy states, death, intermission, menus, pause, and automap;
- seeded input traces replayed against baseline and candidate;
- selected frame hashes plus perceptual diffs with explicit cosmetic masks;
- audio event traces even before final sound generation;
- long-run soak, focus loss, suspend/resume, and repeated new-game cycles.

Cosmetic assets may differ only after the manifest says which pixels/sounds are allowed to
differ. Simulation state, collision, timing, RNG, damage, ammo, level topology, and event
ordering remain fixed unless a separately scoped gameplay change is approved.

Performance receipts use fixed scenarios, cold/warm runs, controlled load, and p50/p95.
They include source/build fingerprint, browser/device/OS, power state, viewport/DPR, input
device, raw/stored/wire sizes, startup stages, frame time, input latency, audio latency,
memory, and errors. A faster high-end desktop cannot approve a failing mobile tier.

## 7. Agent gauntlet

### Roles

| Role | May produce | May close own gate? |
| --- | --- | --- |
| Source and rights researcher | source/license inventory and risks | No |
| Storage worker | contract/SDK implementation and read receipts | No |
| Engine worker | source patches, builds, fidelity/size receipts | No |
| Runtime worker | container, rendering, save, and browser receipts | No |
| Controls worker | action system, adapters, binding UI receipts | No |
| Art inventory worker | exhaustive visual manifest | No |
| ImageGen designer/operator | prompts, candidates, provenance | No |
| Audio inventory/bridge worker | event manifest and playback implementation | No |
| FAL designer/operator | prompts, candidates, provenance | No |
| Integration worker | assembled candidate and cross-layer tests | No |
| Specialist critic | exact-fingerprint review in assigned domain | Only another agent's packet |
| Release manager | schedules work; accepts/rejects passed gates | Cannot override critic failure |
| Final judge | reruns sampled evidence and returns final verdict | Must not have authored release artifacts |

If a manager or critic edits the artifact under review, they become a worker for that
artifact and a new independent critic is required.

### Ledger states

Technical gate state is one of:

- `PENDING`
- `BUILDER_PASS` — evidence packet produced; not approval
- `CRITIC_PASS` — an independent critic accepted the exact packet fingerprint
- `FAIL`
- `NEEDS_EVIDENCE`

Only `CRITIC_PASS` can close a technical gate. A manager separately records `ACCEPT` or
`REJECT` for promotion after all required critic passes. A manager cannot turn `FAIL` or
`NEEDS_EVIDENCE` into an acceptance.

### Evidence packet contract

Every builder packet contains:

- one bounded claim and its negative-then-positive proving test;
- repository HEAD, initial dirty-tree digest, upstream URL/commit, patch digest, toolchain
  lock, command transcript, and environment;
- source, WASM, WAD/container, asset/audio, manifest, contract artifact, deployed bytecode,
  viewer, and FRAY adapter SHA-256 values relevant to the claim;
- raw machine-readable measurements and human-readable captures;
- known failures, skipped surfaces, and proof boundary;
- rollback target and a command to reproduce or bisect the claim.

The critic recomputes the packet fingerprint before review. Any mismatch is
`NEEDS_EVIDENCE`, never a pass.

### Secret and credential boundary

API keys, wallet private keys, mnemonics, RPC credentials, signed URLs, bearer/session
tokens, raw authorization headers, and provider secrets are runtime inputs only. They are
never written into commands, shell history, logs, screenshots, receipts, hashes, generated
provenance, prompts, or committed files. Evidence records sanitized provider/model identifiers,
local artifact hashes, costs, and redacted request IDs instead.

Every promotable packet must run a fail-closed secret scan over its source, command transcript,
logs, receipts, captures, and provenance. A suspected secret produces `FAIL` and quarantine;
redaction after fingerprinting invalidates the fingerprint and requires a new packet and review.
FAL, RPC, wallet, and deployment credentials are loaded through approved local runtime secret
channels without echoing their values. The release manager may not waive this gate.

## 8. Stage ledger

| Gate | Required independent review | Initial state |
| --- | --- | --- |
| G0 source, toolchain, binary, and rights baseline | source/rights critic | PENDING |
| G1 reproducible baseline and fidelity oracle | engine critic | PENDING |
| G2 engine/WAD split container | engine + runtime critics | PENDING |
| G3 size/performance Pareto frontier under read budget | performance critic | PENDING |
| S0 stored-byte reader contract and SDK | storage/security critics | PENDING |
| S1 local one-content-call boundary proof | storage critic | PENDING |
| S2 two-provider public Sepolia one-call proof | storage + security critics | PENDING |
| C0 unified action and binding model | controls/accessibility critic | PENDING |
| C1 keyboard/gamepad/touch physical-device matrix | controls/accessibility critic | PENDING |
| A0 exhaustive visual manifest and rights map | art + rights critics | PENDING |
| A1 ImageGen pilot family | art critic | CLOSED until A0 |
| A2 complete generated visual set | art + gameplay-readability critics | CLOSED until A1 |
| A3 atlas/WAD/runtime integration | art + performance critics | CLOSED until A2 |
| U0 audio bridge and event trace | audio + runtime critics | PENDING |
| U1 FAL pilot SFX family | audio + rights critics | CLOSED until U0 |
| U2 complete generated SFX set | audio + gameplay-cue critics | CLOSED until U1 |
| I0 integrated desktop/mobile release candidate | integration critics | PENDING |
| F0 real FRAY testnet auction page | release + security critics | PENDING |
| J0 final fingerprinted rerun | final judge | PENDING |

Closed generator gates are safeguards, not project completion. They open only when all
upstream gates named in the table have `CRITIC_PASS` and manager `ACCEPT`.

## 9. Rollback and immutable release discipline

- keep the current artifact and each accepted stage content-addressed;
- one experiment per patch/commit and one machine-readable receipt per experiment;
- feature-flag engine/container/audio/control changes until independent review;
- retain a known-good package fingerprint and a scripted bisect/replay path;
- never mutate an auction's committed bytes; publish an append-only Keel/viewer revision;
- rollback means restoring the exact engine, content, bindings, decoder, viewer, and contract
  fingerprint, not merely reverting the UI;
- preserve the existing dirty workspace and use an isolated worktree/snapshot for code changes.

Kickoff evidence limitation: the manager recorded the primary HEAD and a status-entry count,
but did not capture the complete initial porcelain path stream or its digest before planning
began. Therefore the claim that no pre-existing primary-checkout path was overwritten remains
`NEEDS_EVIDENCE`; it must not be inferred from later status counts. The manager-authored primary
changes are limited to the three planning documents and the baseline observation receipt. All
implementation and review packets use the isolated worktree. Other primary-checkout changes,
including concurrent MCP and skill edits, are unowned by this gauntlet and must be preserved.

## 10. Proof boundaries

The final report has separate rows for source inspection, rights evidence, reproducible
local build, unit tests, deterministic gameplay, local-chain call, public RPC, browser,
physical device/controller, ImageGen provenance, FAL provenance, wallet/authenticated flow,
testnet transaction, FRAY auction, managed deployment, and public on-chain immutable bytes.
No row substitutes for another.
