# Agent Handoff — Start FRAY Doom Sprint 01

Use this handoff to start or resume the gauntlet. It is intentionally strict: completing a
task produces evidence; it does not authorize self-approval.

## Manager handoff

```text
You are the release manager for FRAY Doom Sprint 01 in
/Users/ravonus/dev/keel-sdk.

Read completely before acting:
- docs/FRAY_DOOM_WASM_GAUNTLET.md
- docs/FRAY_DOOM_SPRINT_01.md
- examples/demos/doom-wasm/README.md
- packages/contracts/src/modules/keel-hold/KeelHold.sol
- scripts/prepare-doom-wasm-onchain.mjs
- scripts/publish-doom-wasm-ethereum.mjs
- scripts/verify-doom-wasm-ethereum.mjs
- evidence/fray-doom-sprint-01-baseline-observations.json

The primary checkout is heavily dirty with unrelated Keel/CRE/Tezos/studio/SDK work.
Do not reset, clean, switch it, regenerate broad contract outputs, broadly stage, or stop
shared services. Before implementation, record the status and create a dedicated
codex/fray-doom-sprint-01 branch in an isolated worktree. The pinned upstream source is
already cloned read-only at tmp/fray-doom-gauntlet/upstream/doom.wasm and must resolve to
31cc1af9656a8184830090c4e9f268383f5d7e15.

Kickoff did not capture a complete initial porcelain path stream/digest, only a count. Keep
the primary-tree non-overwrite claim at NEEDS_EVIDENCE. The manager authored only these three
planning documents and the baseline observation receipt in the primary checkout; preserve
all other modified paths, including concurrent MCP and skill edits.

Run Round A only:
1. Assign S01-01 to a source/rights researcher.
2. Assign S01-02 to a separate engine/reproducibility worker.
3. Assign S01-03 to a separate gameplay-oracle worker.

Workers may create bounded implementation/evidence packets but must return BUILDER_PASS,
FAIL, or NEEDS_EVIDENCE and must never approve their own work. Freeze a packet fingerprint
covering source, patch, toolchain, artifacts, commands, receipts, and captures. After the
three workers stop, assign independent critics who did not author the reviewed artifacts.
Only CRITIC_PASS closes a technical gate. Record a separate manager ACCEPT/REJECT; never
override FAIL or NEEDS_EVIDENCE.

Do not start public RPC publication, live auction creation, wallet signing, managed rollout,
bulk ImageGen, or paid FAL generation in Round A. The relevant local build is a hard gate
before any AWS or managed release action.

Never place API keys, signed URLs/tokens, raw authorization headers, RPC credentials, wallet
keys, or mnemonics in commands, logs, evidence, fingerprints, prompts, or provenance. Use
approved non-echoing runtime secret channels and require a fail-closed secret scan of every
promotable packet.

Create a read-only dependency note identifying the actual FRAY site repository, auction
contracts, and local integration route. The current checkout's FRAY code is review-only and
must not be mistaken for an implemented auction bridge.

Report exact file paths, hashes, tests, known failures, and proof boundaries. Do not call the
game/release complete.
```

## Round A worker packets

### Worker A — source and rights

```text
Act as the S01-01 evidence-only worker. Do not approve or manage your own work.
Inspect the exact upstream clone and the reconstructed current artifact. Produce a complete
source/toolchain/content/license packet, a WAD lump inventory, and a comparison of local-only
shareware, Freedoom-derived, and clean-room FRAY mini-IWAD release lanes. Distinguish GPL
engine obligations from WAD/art/audio/map/name rights. Verify that the current WASM contains
the embedded fallback WAD and explain the existing keptOutsideRepository metadata precisely.
Return one packet fingerprint plus BUILDER_PASS, FAIL, or NEEDS_EVIDENCE.
```

### Worker B — reproducible engine baseline

```text
Act as the S01-02 engine worker. Do not approve or manage your own work. Work only in the
manager-provided isolated worktree/source snapshot. Pin the WASI SDK and Binaryen inputs by
digest, perform two clean local builds of the exact baseline, and compare outputs. Record
imports, exports, sections, raw/Brotli bytes, and the embedded-WAD boundary. Run a focused
browser smoke without claiming public deployment. Add a negative fingerprint test. Return
one packet fingerprint plus BUILDER_PASS, FAIL, or NEEDS_EVIDENCE.
```

### Worker C — gameplay fidelity oracle

```text
Act as the S01-03 gameplay-oracle worker. Do not approve or manage your own work. Build a
deterministic input/demo/save and frame/state oracle for the pinned baseline covering menu,
movement, turn, strafe, fire, use, pickup, doors, secrets, damage/death/restart, pause,
automap, and level exit. Preserve the 35 Hz simulation. Prove the oracle fails for a deliberate
one-tic or state mutation. Return source/tests/receipts/captures under one packet fingerprint
plus BUILDER_PASS, FAIL, or NEEDS_EVIDENCE.
```

## Independent critic packet

```text
You are an independent critic. You must not have authored or edited the artifact under
review. Read the gauntlet and sprint documents completely. Recompute the submitted packet
fingerprint before reviewing it. Rerun a representative negative and positive test, inspect
raw evidence, and check dirty-tree isolation and proof boundaries. Return exactly one of
CRITIC_PASS, FAIL, or NEEDS_EVIDENCE with blocking findings and the fingerprint reviewed.
Never mark the overall sprint or product complete.
```

## Manager promotion packet

```text
For each technical gate, verify that the worker fingerprint and critic fingerprint match.
If the critic result is CRITIC_PASS and all upstream gates required by the sprint are also
CRITIC_PASS, record manager ACCEPT or REJECT with rationale. A manager cannot waive FAIL,
NEEDS_EVIDENCE, a fingerprint mismatch, a rights gap, or a missing proof surface. If the
manager edits the artifact, invalidate the review and assign a new independent critic.
```

## Current proof boundary for the next agent

- The exact source is downloaded and pinned in an ignored workbench.
- The current checked-in Keel plan reconstructs a valid, WAD-bearing 4.56 MB WASM.
- Exploratory compression strongly favors Brotli q11 at 1,541,562 bytes. It is 91,578 bytes
  above the prior measured passing read point, 191,562 bytes above Sprint 01's 1,350,000-byte
  local milestone, and 702,702 bytes above the 838,860-byte public fallback target.
- Existing one-call evidence is localhost/local-chain evidence only.
- The local 1,350,000-byte milestone is not the public threshold; use the 838,860-byte
  fallback target and 13,421,772-gas target until fresh provider profiling is critic-approved.
- Container-internal hashes are not authenticity proof: compare the response target, stored
  digest/object derivation, portable root, and decoded manifest/provenance root to commitments
  independently bound by the auction before parsing, compilation, or instantiation. A malicious
  self-consistent RPC substitution must fail this gate.
- No source rebuild, fidelity oracle, stored-byte reader, public RPC proof, controller proof,
  ImageGen asset, FAL sound, FRAY auction, or deployment is approved yet.
