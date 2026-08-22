# FRAY Doom Sprint 01 — Baseline, Size Frontier, and One-Call Prototype

**Sprint state:** started; evidence gathering only. The sprint does not authorize a public
deployment, live auction, wallet signature, ImageGen asset promotion, or paid FAL batch.

## Sprint outcome

Produce one independently reviewed candidate that proves, locally:

1. the pinned engine can be rebuilt reproducibly without its embedded shareware WAD;
2. one versioned container can carry the engine, an approved test content pack, bindings,
   and provenance in one Keel stored-byte read;
3. the candidate is at or below the local 1,350,000-byte / 64-carrier milestone, while
   recording that public release remains gated by the stricter provider-derived target;
4. deterministic gameplay behavior matches the frozen baseline for the approved fixture;
5. the browser shell plays on keyboard, one standard gamepad, and a minimal mobile control
   overlay through one semantic action layer;
6. the exact source/artifact/evidence fingerprint receives independent critic passes and a
   manager promotion decision.

Public RPC, full art replacement, full sound replacement, polished controls, production
FRAY auctioning, and deployment are later gates. Sprint 01 creates the safe foundation for
them.

## Starting evidence

- Repository baseline: `afddfbf6b5efb96dc31c2c641f28a846f69c6261` with a large pre-existing dirty tree.
- Pinned upstream source is cloned in the ignored workbench at
  `tmp/fray-doom-gauntlet/upstream/doom.wasm` and resolves to
  `31cc1af9656a8184830090c4e9f268383f5d7e15`.
- Existing Keel artifact: 4,559,862 bytes, SHA-256
  `0x666989bd996b8ec9a294003f0e8f08838d9a1ce721083c093378f0d18b8fef66`.
- Existing local receipt: one raw `haulObject` call, 500,000,000 call gas, 281 ms.
- Exploratory q11: 1,541,562 bytes and 68 carriers; still above the provisional budget.
- Existing 208,439-byte Brotli decoder can be reused as a measured candidate.
- Existing audio is disabled; existing reference shell is keyboard-only.
- Existing FRAY support is review-only planning/approval-envelope code; the actual FRAY site
  and auction-contract bridge are an unresolved integration dependency.

These are `BUILDER_PASS` observations only. The receipt is
`evidence/fray-doom-sprint-01-baseline-observations.json` and still requires exact-digest
critic review.

## Work isolation

The primary checkout already contains unrelated Keel, CRE, Tezos cross-mint, studio,
SDK, generated-contract, and MCP work. Sprint implementation must use a dedicated
`codex/`-prefixed branch and isolated worktree created only after recording:

- primary repository HEAD;
- porcelain status and path count;
- intended worktree path and branch;
- the list of files this sprint may change.

No worker may reset, clean, switch, broadly stage, regenerate all contract artifacts, stop
shared services, or overwrite existing Doom evidence in the primary checkout. The gauntlet
manager authored only the three new planning documents and one baseline observation receipt
there. Other modified paths, including concurrent MCP and skill edits, are unowned and must be
preserved. Because kickoff recorded only a count rather than the complete initial porcelain
path stream and digest, non-overwrite proof for the pre-existing primary tree is
`NEEDS_EVIDENCE`; no later snapshot may be presented as the missing initial proof. All sprint
implementation and review packets belong in the isolated worktree.

## Packet queue

### S01-01 — source and rights lock

**Worker:** source/rights researcher  
**Critic:** independent source/rights critic

Deliver:

- exact upstream tree, commit, submodule, dependency, container-image, and license lock;
- exact explanation of the embedded `DOOM1.WAD` path and current metadata wording;
- complete current WAD directory/lump manifest with per-lump source/license state;
- comparison of local-only shareware, Freedoom Phase 1, and clean-room FRAY mini-IWAD lanes;
- a recommended shippable lane and unresolved legal questions.

Pass requires every shipped/tested source to be labelled and the public candidate to contain
no unapproved Doom WAD bytes. This packet cannot approve the final product.

### S01-02 — reproducible baseline build

**Worker:** engine worker  
**Critic:** independent engine critic

Deliver:

- WASI/Binaryen/toolchain images pinned by digest;
- two isolated builds from the exact upstream commit and content digest;
- byte comparison plus documented nondeterminism if any;
- imports/exports/sections/code/data report;
- baseline browser smoke, deterministic input trace, frame/state receipt, and source hash.

Negative test: mutate one source byte or content digest and prove the fingerprint gate fails.

### S01-03 — fidelity oracle

**Worker:** gameplay test worker  
**Critic:** independent gameplay critic

Deliver deterministic traces for menu/start, movement/turn/strafe, fire/use, pickup, door,
secret, damage/death/restart, pause/automap, level exit, and save/load where supported.
Record simulation checkpoints and selected frame hashes. Cosmetic-difference masks remain
empty in Sprint 01.

Negative test: a deliberate one-tic input shift or damage change must fail the oracle.

### S01-04 — engine/content split

**Worker:** engine worker  
**Critics:** engine critic and runtime critic

Produce a WASM build with no embedded default WAD. It must fail closed when no host content
is supplied, then run the approved fixture through the existing WAD import interface. Compare
raw/Brotli bytes, compile/instantiate/first-frame time, and peak memory against baseline.

Negative test: missing or wrong content hash prevents `initGame`.

### S01-05 — container v1

**Worker:** runtime/container worker  
**Critics:** runtime and security critics

Specify and implement a canonical bounded container with fixed magic/version, member count,
offset/length/compression/media type/digest, and provenance root. Compare whole-stream and
per-member Brotli. Parser fuzz/property tests cover truncation, overlap, duplicate names,
overflow, trailing bytes, unknown compression, decompression bomb, and digest mismatch.

Before parsing members or compiling WebAssembly, the verifier must compare the response target,
stored-container digest/object derivation, portable root, and decoded manifest/provenance root
to an expected commitment independently bound by the auction/token integration. Internal
container hashes alone are not authenticity evidence.

Negative test: each malformed class is rejected before WASM compilation or WAD exposure. A
malicious RPC's different but internally self-consistent container is also rejected against the
auction-bound commitment.

### S01-06 — size frontier

**Worker:** benchmark worker  
**Critic:** independent performance critic

Run single-variable candidates for `-Os`, `-Oz`, LTO, export/section pruning, Binaryen size
passes, WAD de-embedding, content pruning approved by S01-01, and Brotli q4/q6/q9/q11.
Produce a Pareto frontier over:

- raw/stored/wire bytes and carrier count;
- encode/decode, compile, instantiate, first-frame, p50/p95 frame time;
- peak browser memory and decoded-buffer lifetime;
- deterministic fidelity result.

Target: at most 1,350,000 stored bytes and 64 carriers without a red fidelity or mobile
memory result for the Sprint 01 local milestone. Public release remains gated at 838,860
bytes until fresh provider profiling replaces the 1 MiB fallback, and at 13,421,772 gas
until a separately approved budget supersedes it. The critic may return `NEEDS_EVIDENCE`;
it may not move a target.

### S01-07 — stored-byte reader prototype

**Worker:** storage worker  
**Critics:** storage and security critics

Implement a new stored-byte read function without changing `haulObject` semantics. Add focused
Solidity tests for raw, Brotli-marked stored bytes, maximum carriers, composites if retained,
depth/cycle/length failures, and digest separation. Add SDK ABI and typed read support only for
the new function.

Negative test: asking decoded `haulObject` to read a compressed object still fails, while the
new stored-byte surface returns the exact compressed hash.

### S01-08 — local one-call curve and receipt

**Worker:** storage benchmark worker  
**Critic:** independent storage critic

Publish the exact candidate to an isolated local chain, binary-search the real getter boundary,
then perform one cold content `eth_call`. Instrument all RPC methods and prove no chunk/code
fallback calls. Record request, response, gas, elapsed time, stored/container/member hashes,
runtime bytecode, block, and candidate fingerprint.

Negative test: disable the one-call entrypoint and show the viewer fails rather than falling
back to per-carrier reads or a gateway. Substitute a different self-consistent container at the
RPC boundary and prove the auction-bound stored and decoded commitments reject it before parse,
compile, or instantiation.

### S01-09 — runtime hot-path prototype

**Worker:** browser runtime worker  
**Critic:** independent performance/runtime critic

Replace the reference timer with a bounded 35 Hz accumulator. Compare direct RGBA engine output,
WebGL swizzle, and worker/offscreen paths against the reference JavaScript pixel loop. Preserve a
Canvas 2D fallback. Test focus/visibility/orientation/context-loss and repeated restart.

Negative test: a one-second background gap cannot produce an unbounded catch-up spiral.

### S01-10 — action layer and three input adapters

**Worker:** controls worker  
**Critic:** independent controls/accessibility critic

Implement the semantic action model, keyboard adapter, standard gamepad adapter, and minimal
safe-area touch overlay behind a feature flag. Include binding schema/version/persistence,
conflict handling, active-device indicator, auto-suggestion without silent reassignment,
hot-plug, dead zone, and manual device lock.

Physical acceptance in Sprint 01 requires one keyboard, one Xbox-or-PS5 standard-mapped pad,
and one real touch phone. The full matrix remains C1.

Negative test: conflicting remap and gamepad disconnect preserve the user's prior binding and
release stuck actions.

### S01-11 — art and audio manifests; generators remain closed

**Workers:** art inventory worker and audio inventory worker  
**Critics:** art/rights critic and audio/rights critic

Generate exhaustive visual and audio/event manifests from the selected content pack. Specify
FRAY palette, clean-room prompt rules, animation/event invariants, pivot/loop requirements,
candidate directories, and ImageGen/FAL provenance schemas.

No bulk generation occurs. A0 and U0 must pass before the manager may open one small ImageGen
pilot and one paid FAL audition packet. Sound generation additionally waits for the audio bridge
design, because silent runtime assets are not an integration proof.

Before any external generation or RPC/wallet-backed proof, add a fail-closed secret scan that
covers commands, logs, receipts, captures, prompts, and provenance. API keys, signed URLs,
tokens, raw authorization headers, RPC credentials, wallet keys, and mnemonics are never
fingerprinted or recorded; sanitized service/model IDs, local output hashes, redacted request
IDs, and cost receipts are the evidence surface.

### S01-12 — independent sprint integration verdict

**Worker:** integration worker  
**Critics:** storage, engine, runtime, controls, rights, and security critics  
**Manager:** release manager  
**Final judge:** agent that authored none of the candidate artifacts

Assemble only packets whose exact fingerprint has `CRITIC_PASS`. Rerun the local one-call,
fidelity, desktop browser, physical phone, and controller checks on the assembled hash. The
final judge samples raw receipts and returns `CRITIC_PASS`, `FAIL`, or `NEEDS_EVIDENCE`.
The manager then records `ACCEPT` or `REJECT`; acceptance opens Sprint 02 but does not authorize
public deployment.

## Review rounds and concurrency

Use at most three parallel workers alongside the manager:

1. Round A: S01-01 source/rights, S01-02 baseline build, S01-03 oracle design.
2. Critic A: independent reviews of all three exact fingerprints.
3. Round B: S01-04 engine split, S01-05 container, S01-07 stored reader.
4. Critic B: engine/runtime/storage/security review.
5. Round C: S01-06 frontier, S01-08 one-call proof, S01-09 runtime hot path.
6. Critic C: performance/storage/runtime review.
7. Round D: S01-10 controls and S01-11 manifests.
8. Critic D, integration S01-12, then final judge and manager decision.

A worker may continue only after upstream packets have `CRITIC_PASS` and manager `ACCEPT`.
Workers never use their own report as approval evidence.

## Sprint exit receipt

The manager's exit record must contain:

- exact accepted source/container/engine/content/decoder/reader/runtime/input hashes;
- the complete state and manager decision for S01-01 through S01-12;
- size/performance/fidelity table and device proof boundaries;
- rights and license manifest status;
- unresolved failures and deferred public/FAL/ImageGen gates;
- the secret-scan result and sanitized external-service provenance boundary;
- rollback fingerprint;
- a statement that no public deployment/live auction occurred, unless a later explicit
  action-time approval and separate release receipt exists.
