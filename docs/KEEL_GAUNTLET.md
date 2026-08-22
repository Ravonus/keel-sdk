# Keel — Build Brief and Verification Gauntlet

> Implementation update (2026-08-08): the author explicitly selected the
> contract-first branch of the open scope question in §9. The modern tree now
> has typed Object, Viewer, Link, Seed, Equipment, and OneMint layers plus a
> verified browser seam. See [Keel Contract Union](KEEL_CONTRACTS.md).
> The measurements and legacy observations below remain the pre-build baseline;
> tables saying the modern tree has “nothing” are historical snapshot text.

**Audience:** an autonomous coding agent with no prior context on this project.
**Status of this document:** every factual claim below was verified by running or
reading the code on 2026-08-07. Numbers are measurements, not estimates. Where
something is unverified or unfinished it says so explicitly.

Read this whole document before writing code. It is long because the project has
three source trees, a partially-finished 2023 prototype, and a set of traps that
will silently waste a day each if you rediscover them yourself.

---

## 1. The mission

Keel is a **general-purpose storage and verification layer for Ethereum**. NFTs
are one consumer of it, not the point of it.

The core loop it implements:

```
bytes → chunked immutable on-chain objects (content-addressed, deduped)
      → objects indexed into a "viewer" (an ordered set of object IDs)
      → viewer assembled at read time, with live chain data injected
      → committed digest verified byte-for-byte by the client
      → mounted in an isolated browser sandbox with no raw creator egress
```

The thing that makes it interesting, and the thing every deliverable must
preserve: **one engine can serve every token, and a token's unique payload can be
tens of bytes.** Verified measurement from the real files: two tokens of the same
game are 34,566 bytes each and differ by **87 bytes**. See §5.3.

**Final vision to build toward:** a front end that lets a developer exercise the
whole system interactively — index arbitrary scripts and objects, compose them
into viewers, publish them, and watch them resolve and render under verification
— with the historical `comet` / `three` / `fluid` / `matrix` artifacts wired in
as end-to-end mega-tests that prove the pipeline still works.

---

## 2. The three source trees

| Path | What it is | Treat it as |
| --- | --- | --- |
| `/Users/ravonus/dev/oca-modern` | The modern TypeScript reconstruction. Working, tested, deployable. | **The codebase you modify.** |
| `/Users/ravonus/dev/chainrougesolidity-inventory` | The real Keel contracts + the original encoded artifacts. From GitLab (`gitlab.com/ravonus/chainrougesolidity`), Sep 2023. | **Authoritative reference. Read-only.** |
| `/Users/ravonus/dev/chainrougesolidity-development` | Earlier snapshot, Mar 2023. Game-focused. 97 generated per-token game HTML files. | **Test material. Read-only.** |

Two public GitHub repos are also relevant but contain no source of value:
`Ravonus/oca_whitepaper` (prose MDX docs + original audio/sprite assets) and
`Ravonus/Keel-demo` (an old uploader UI). `Ravonus/soundbox` has the
zlib-licensed SoundBox player.

**Do not modify the two chainrouge trees.** Copy what you need into `oca-modern`.

---

## 3. State of `oca-modern` right now

Everything in this section is currently true and passing. **Do not regress it.**

```bash
pnpm verify          # green: TS builds, 110 Node tests, examples, doc links, Solidity policy
pnpm studio:check    # green: tsc --noEmit + eslint, zero errors
pnpm studio:build    # green: production Next.js build
pnpm studio:test:e2e # green: 9 ordinary Playwright tests; 3 seeded live Keel tests run separately
```

### 3.1 Local environment (already provisioned, may need restarting)

Docker is **not** used — the host has native Postgres and Foundry.

```bash
psql "postgresql://oca:oca@localhost:5432/oca_studio"   # role + db already created
anvil --host 127.0.0.1 --chain-id 31337 --block-time 1  # native, not docker
pnpm studio:db:migrate && pnpm contracts:compile
pnpm local:deploy && pnpm studio:seed && pnpm studio:index
pnpm studio                                              # http://localhost:3000
```

### 3.2 Bugs already found and fixed — do not reintroduce

Eight real defects were fixed. Five were blocking; three were silent.

1. **`Uint8Array<ArrayBufferLike>` vs DOM `BufferSource`** (TS 5.7+ made
   `Uint8Array` generic). Fixed with `toBufferSource()` in
   `packages/protocol/src/bytes.ts`. Used at the `subtle.digest`, `new Blob`,
   and `new Response` call sites.
2. **`drizzle/meta/_journal.json` was missing**, so `drizzle-kit migrate` exited
   1 silently and `pnpm local:setup` could never complete. Journal authored;
   `--> statement-breakpoint` markers added to `0000_initial.sql`.
3. **`server-only` threw in every `tsx` script** (deploy-local, seed, indexer).
   Fixed by adding `--conditions=react-server` to those package scripts.
4. **9 studio type errors** under `exactOptionalPropertyTypes`.
5. **Playwright used `127.0.0.1` but Next 16 only allows `localhost`** for dev
   assets, so pages never hydrated. Fixed with `allowedDevOrigins` in
   `next.config.ts`.
6. **`.gitignore` had an unanchored `artifacts/`**, which also matched
   `apps/studio/src/components/artifacts/`. Tailwind v4 honours `.gitignore`, so
   that entire directory was never scanned and every utility used *only* there
   was missing from the CSS — the artifact viewer rendered as a 300×150 sliver
   on every page. Anchored to `/packages/contracts/artifacts/`, plus an explicit
   `@source` in `globals.css`. **This class of bug is invisible; be suspicious of
   any broad ignore pattern.**
7. **`ArtifactViewer` crashed the page on every successful render.**
   `mountArtifact` calls `replaceChildren` on the same div React rendered its
   loading overlay into, so React's cleanup threw `NotFoundError`. Overlays are
   now siblings of a div the mount owns outright. **Never render React children
   into a node handed to `mountArtifact`.**
8. **The sandbox rejected its own rewritten URLs.** `replaceResourceUrls`
   rewrites `/content/…` inside text resources to `data:` URLs, but
   `verifiedFetch` then returned 403 for them — so any artifact fetching a
   declared resource from JavaScript broke. `verifiedFetch` now decodes `data:`
   inline. `connect-src 'none'` is unchanged.

### 3.3 Already added

- **`base85` (Z85) as a protocol `TextEncoding`.** `encodeBase85` /
  `decodeBase85` in `packages/protocol/src/bytes.ts`, wired into `decodeText`.
  Verified against all 19 top-level `.b85` files: 19/19 wrapper-aware decode,
  Brotli decompression, and payload re-encode round trips. `start.b85` uniquely
  preserves the historical `<b85>…</b85>` container that the original runtime
  strips before calling `de85`.
- **Four demo artifacts** in `examples/demos/`, published on-chain to local anvil
  and shown at `/demos`. These are *synthetic* — authored before the real
  material was found. Keep them as protocol conformance tests; they are not the
  final story. See §7.1.

---

## 4. Keel architecture (from the real contracts)

Source: `chainrougesolidity-inventory/contracts/`. Sizes: `ScriptStorage.sol`
2,410 lines, `CharacterMint.sol` 899, `KeelManager.sol` 826,
`BackpackManager.sol` 502, `MapMint.sol` 370, `ScriptStorageNFT.sol` 176,
`GameNFT.sol` 156, `Sound.sol` 141.

### 4.1 `ScriptStorage.sol` — the storage engine

State:

```solidity
mapping(uint48  => bytes[])   dataObjects;        // chunked payload per object
mapping(uint48  => DataObject) dataObjectInfo;    // metadata per object
mapping(uint48  => Version)    versions;          // per-object version history
mapping(uint256 => bytes[])    hashes;            // content hashes for verification
mapping(bytes32 => Link)       links;             // external sources
mapping(bytes32 => Viewer)     viewers;           // indexed object sets
mapping(address => uint256[])  contractViewers;
mapping(bytes32 => bool)       acceptedIds;
mapping(uint256 => bytes)      headObjects;
mapping(bytes32 => uint256[])  seedsAndVersionsData;
```

`DataObject` carries `owner`, packed `nameAndType` (bytes16 name + hashed mime),
**`tokenId` — object ownership can move to an NFT**, and a `packedData` field
holding: `hide`, on-chain-vs-IPFS view type, `isImmutable`, **`highResLink`,
`previewLink`, `hybridLink`**, and verifier state.

`Viewer` carries `bytes12 name`, `owner`, `contractAddress`, `uint96 range`
(template of forced IDs), `objectIds[]` (uint48 packed 5-per-uint256), and
**`history[]` — a pack of every parent viewer ID, so anyone can fork a viewer
from an existing one.**

### 4.2 Concepts oca-modern does **not** have

These are the reasons the reconstruction is thinner than the original. Each is a
candidate work item.

| Keel concept | Why it matters | oca-modern today |
| --- | --- | --- |
| **Tiered fidelity links** — `highResLink` / `previewLink` / `hybridLink` per object | One object, three qualities: cheap on-chain preview, high-res off-chain, hybrid | Only *ordered fallbacks* (weaker: same content, different transport) |
| **Per-object versions** — `versions[]`, `versionPush`, `getVersionedId`, mutability ∈ {Updatable, Version, None} | An object evolves independently of any token | Revisions exist only on the registry presentation |
| **Viewer lineage** — `Viewer.history[]` | Viewers are forkable and attributable | Nothing equivalent |
| **Token-owned objects** — `DataObject.tokenId` | Storage ownership transfers with an NFT | Objects have no owner |
| **On-chain seeds** — `createSeed`, `createMultiSeed`, `updateSeed`, `getSeed` | Per-token determinism derived on chain | Seeds are manifest-static |
| **Links as first-class** — hashed host, packed mutability + linkType | External storage described and constrained | Source policy exists but no link registry |
| **Inventory layer** — `Backpack`, `Equipment`, `EquipmentMix`, `Inventory`, `ERC1155P` | Composable equippable state feeding the render | Nothing |

### 4.3 What oca-modern has that Keel left unfinished

Keel is **~75% done by the author's own assessment**, and the missing quarter
is precisely the verification layer:

```solidity
function enableVerifier() public {}   // empty
function unverify()      public {}    // empty
function verify()        public {}    // empty
```

`pushDataObject`, `managerSetter`, `setDataObjectInfo`, and `setVersion` are
`public`/`external` with **no access control**.

oca-modern supplies the missing quarter: RFC 8785 canonicalization, exact-byte
verified gateway, CSP + egress-denied sandbox, registry commitment chain,
recursive `KeelHold` composites. **The two halves are complementary. The goal
is the union, not a rewrite of either.**

### 4.4 The index system (this is what the front end must expose)

Verified end-to-end path, from `NFTComet.sol` and `scripts/forgeHarness.ts`:

```
scripts/forgeHarness.ts:
  name      = "comet"                        → bytes12
  objectIds = packIds([2, 3, 4, 5, 6])       → 5 uint48 IDs packed into 1 uint256
  KeelManager.forgeHarness(contractAddress, nameBytes12, type, objectIds, ...)

NFTComet.tokenURI(tokenId):
  viewerId = keccak256(abi.encodePacked(bytes12("comet"), "viewer"))
  data[0]  = block.timestamp                 // live chain data injected at read time
  html     = scriptStorage.generateViewer(viewerId, tokenId, data)
  return "data:application/json;base64," + base64({ name, image: "data:text/html;base64," + base64(html) })
```

So: **N independently-stored objects → indexed into one named viewer → assembled
on chain at read time → live data injected → base64 → `data:text/html` →
iframe.** That is the mechanism the front end exists to make legible.

`packIds` (5 × uint48 per uint256) already has a modern equivalent —
`packUint48Ids` / `unpackUint48Ids` in `packages/protocol/src/packing.ts` — and a
parity test against the original implementation in `tests/demos.test.mjs`.

### 4.5 The encoding pipeline

```
source → brotli → Z85 (base85) → stored as a JS string literal on chain
```

Decoder is `chainrougesolidity-inventory/de85.js`. Alphabet is Z85 (ZeroMQ),
chosen so every character survives a JS string literal unescaped. Z85 costs 5
chars per 4 bytes (1.25×) vs base64's 1.333× — **~6.25% smaller**, which is the
175 KB → 163 KB step in the whitepaper.

---

## 5. Verified reference numbers

Assert against these. If a change moves them, that is a regression or a finding.

### 5.1 three.js (`chainrougesolidity-inventory/`)

| File | Bytes | Ratio |
| --- | --- | --- |
| `three.js` | 728,973 | — |
| `three.js.deflate.new-serialization` | 166,734 | 22.9% |

The whitepaper claimed "approximately 750kb" → "163kb". Confirmed.

### 5.2 The `.b85` artifact set (all round-trip verified)

| Artifact | b85 chars | decoded bytes | decompressed |
| --- | --- | --- | --- |
| `start-p5.b85` | 2,047 | 1,637 | 6,153 |
| `start-three.b85` | 2,452 | 1,961 | 8,004 |
| `start-genart.b85` | 1,673 | 1,338 | 3,494 |
| `shader-1.b85` | 1,223 | 978 | 3,399 |
| `fluid-main.b85` | 3,029 | 2,423 | 10,688 |
| `twgl.b85` | 24,153 | 19,322 | 93,431 |
| `webMatrix.b85` | 9,848 | 7,878 | 52,874 |

Others: `start-gpu`, `start-sphere`, `start-twgl`, `start-twgl2`, `start`,
`bab-start`, `fluid-{init,render,shaders,utils,capture.all,dat.gui}`.
All decompress with **brotli** after Z85 decode.

### 5.3 The game (`chainrougesolidity-development/websites/`)

97 files. 93 parse with the standard split; `gameStaked6-9` are a different
~73 KB format with no `var seeds` — investigate separately.

| Region | Distinct values across 93 tokens |
| --- | --- |
| head (`0 … var imgs`) | **1** |
| atlas (`var imgs … var seeds`) | **4** |
| engine (after `spriteData` … EOF) | **2** |
| per-token block | 93 (403–770 bytes) |

**Shared per token: ~34,163 bytes. Two unstaked tokens differ by 87 bytes.**
Staking injects a ~199-byte `canvasEffects` function (`bw`, `rainbowStrobe` —
see `effectBW.js`, `effectRainbowStrobe.js`) and the render visibly changes.

Split boundaries: `var imgs = {` … `var seeds = {` … `entities: { src: imgs.e, columns: 7 } };`

---

## 6. What to build

### 6.1 The front end

A developer-facing surface in `apps/studio` for exercising the system. Not a
marketing page — a test bench. It must let a human:

1. **Ingest** — drop in a raw file, or a `.b85` artifact, and see it decoded,
   decompressed, hashed, and chunked, with byte counts at each stage.
2. **Index** — select multiple stored objects and compose them into a named
   viewer, exactly as `forgeHarness.ts` does with `packIds([2,3,4,5,6])`. Show
   the uint48 packing.
3. **Assemble** — trigger a read-time assembly of that viewer with injected live
   data (block number / timestamp), and show the resulting HTML before it runs.
4. **Verify** — show the commitment chain: object digests → viewer digest →
   registry commitment → what the client re-checked.
5. **Render** — mount the result in the verified sandbox iframe.
6. **Inspect dedupe** — for a set of N tokens sharing objects, show bytes written
   once vs bytes per token. This is the money shot; make it unmissable.

Existing building blocks to reuse rather than reinvent: `ArtifactViewer`
(`apps/studio/src/components/artifacts/artifact-viewer.tsx`), the verified
gateway (`packages/viewer/src/gateway.ts`), `createSandboxDocument`
(`packages/viewer/src/sandbox.ts`), `buildChainDeploymentDescriptor`
(`apps/studio/src/server/deployment/service.ts`), and the publishing flow in
`apps/studio/scripts/seed-demos.ts`.

### 6.2 The mega-tests

Wire the historical artifacts in as end-to-end tests that exercise the *whole*
path — decode → store → index → assemble → verify → render — not unit slices.

Priority order:

1. **`comet`** — the canonical case. Five objects (`packIds([2,3,4,5,6])`)
   indexed into one viewer, assembled with `block.timestamp` injected. If this
   works, the index system works.
2. **`three`** — `start-three.b85` + the real 728,973-byte `three.js`. Proves
   large-payload chunking and the compression claim in one test.
3. **`fluid`** — 7 separate `.b85` modules (`init`, `main`, `render`, `shaders`,
   `utils`, `capture.all`, `dat.gui`). Proves multi-object indexing with real
   inter-module dependencies.
4. **`matrix`** / **`twgl`** / **`genart`** / **`p5`** / **`sphere`** / **`gpu`** —
   breadth. Each is a different renderer, and each should be a viewer.
5. **The game** — the dedupe proof. Publish ≥10 tokens; assert total on-chain
   bytes ≈ shared_once + N × per_token, not N × 34,566.

Corresponding contracts to read for expected behaviour: `NFTComet.sol`,
`NFTThree.sol`, `NFTFluid.sol`, `NFTMatrix.sol`, `NFTSpiral.sol`, `NFTPhil.sol`,
`NFTAll.sol`, `GENNFT.sol`.

---

## 7. Rules

### 7.1 Invariants — breaking any of these is a failed change

- `pnpm verify`, `pnpm studio:check`, `pnpm studio:build`, and
  `pnpm studio:test:e2e` all stay green. Never weaken a test to make it pass.
- **Verification is never optional.** No code path may render bytes that were not
  checked against a committed digest. The sandbox keeps `default-src 'none'` and
  `connect-src 'none'`.
- The four existing demos in `examples/demos/` keep working. They are protocol
  conformance tests now.
- Third-party licences stay documented in `examples/demos/LICENSES.md`. Note
  p5.js is **LGPL-2.1** in an otherwise-MIT repo; three.js is MIT; the SoundBox
  player is zlib.
- Do not modify the two chainrouge trees.

### 7.2 Traps

- Broad `.gitignore` patterns silently disable Tailwind scanning (§3.2 item 6).
- Never render React children into a node passed to `mountArtifact` (item 7).
- `tsx` scripts touching `~/server/db` need `--conditions=react-server`.
- Playwright must target `localhost`, not `127.0.0.1`, unless `allowedDevOrigins`
  covers it.
- `next build` rewrites `apps/studio/tsconfig.json` (adds `.next/dev/types`).
  Expected; don't fight it.
- Typed routes are generated at build time — a new route fails `tsc` until you
  run `pnpm studio:build` once.

---

## 8. The gauntlet loop

Run this loop per work item. **Do not batch items.** One item, full loop, commit,
next item. An item is not done until every gate passes.

```
┌─ 1. SCOPE ───────────────────────────────────────────────────────────
│  State the single claim this item will make true, and the exact
│  command or assertion that will prove it. If you cannot name the
│  proving command, the item is not scoped yet.
│
├─ 2. GROUND ──────────────────────────────────────────────────────────
│  Read the authoritative source in chainrougesolidity-inventory first.
│  Quote the specific lines you are implementing against. Do not infer
│  behaviour you can read.
│
├─ 3. BUILD ───────────────────────────────────────────────────────────
│  Smallest change that makes the claim true. Reuse the existing
│  building blocks in §6.1.
│
├─ 4. PROVE ───────────────────────────────────────────────────────────
│  Add the test BEFORE declaring done. It must fail without the change.
│  Verify it fails, then verify it passes.
│
├─ 5. GATE ────────────────────────────────────────────────────────────
│  pnpm verify && pnpm studio:check && pnpm studio:build && pnpm studio:test:e2e
│  Any red → back to 3. Never weaken a test to pass a gate.
│
├─ 6. OBSERVE ─────────────────────────────────────────────────────────
│  Render it in a real browser and look at it. Screenshot it.
│  "The test passes" is not evidence the feature works — bug 7 in §3.2
│  passed its tests while crashing every page it rendered on.
│
├─ 7. MEASURE ─────────────────────────────────────────────────────────
│  Record bytes on chain, dedupe ratio, compression ratio, resolve time.
│  Compare against §5. An unexplained movement is a finding, not noise.
│
└─ 8. REPORT ──────────────────────────────────────────────────────────
   One paragraph: claim, proof, measurement, and anything surprising.
   Surprises are the valuable output. Report them even when the gate is
   green — especially then.
```

### 8.1 Suggested item sequence

1. Decode the full `.b85` corpus into `examples/keel/` with a manifest of
   name → sizes → digests. Gate: round-trip test over every file.
2. Model one `.b85` artifact as a Keel artifact and render it at `/demos`.
   Gate: it renders; digest verified.
3. Build the index/compose UI (§6.1 steps 1–3).
4. `comet` mega-test: 5 objects → 1 viewer → assembled with injected data.
5. Dedupe view (§6.1 step 6) + the game dedupe test (§6.2 item 5).
6. `fluid` (7 modules) and `three` (large payload).
7. Only then consider the contract-layer gaps in §4.2, one at a time.

---

## 9. Open questions to resolve with the author

Do not guess these; they change the design.

1. **Contract scope.** Bring the §4.2 Keel concepts into
   `packages/contracts` (tiered links, per-object versions, viewer lineage,
   token-owned objects, on-chain seeds), or keep oca-modern's contracts as they
   are and prove only the storage/index/render layer?
2. **`gameStaked6-9`** are a different ~73 KB format. Superseded, or a variant
   that must be supported?
3. **p5.js LGPL-2.1** — acceptable in the tree, or drop that demo?
4. There may be a **third GitLab repo** with additional material. The two known
   chainrouge trees came from `gitlab.com/ravonus/chainrougesolidity`.
