# Keel attested anchors

Attested anchors upgrade foreign-chain carrier claims from `client-proof` to
`attested-proof` (see `KEEL_PORTABLE_ROOT.md`, Trust classes): a
decentralized oracle network — not a trusted reviewer key — confirms that the
exact bytes a Keel object revision commits to exist at a located write on a
foreign chain, and only then does the anchor finalize on the home chain. This
is a storage-layer verification system, not a token bridge: nothing moves,
nothing is wrapped, and the claim being verified is always "these bytes, at
this location, hash to the digests the object registry already holds."

An object can hold anchors on every enabled network simultaneously. Anchors
are permanent one-way records: once verified they are never reinterpreted,
and retiring a family or verifier only stops new requests.

## Contract set

| Contract | Role |
| --- | --- |
| `KeelAttestedAnchorRegistry` | Anchor lifecycle, append-only chain-family and verifier registries, contributor stats, `keel.anchor.v1` roots |
| `KeelChainlinkFunctionsVerifier` | Chainlink Functions consumer adapter; pins per-family verification JavaScript by KeelHold chunk id |
| `KeelLocalFunctionsRouter` | Development-network router double (never deploy where a real router exists) |
| `KeelAnchorReplicationBridge` | Deployed as a replication registry's `proofVerifier`; accepts pending carrier proofs from verified anchors |

## Anchor lifecycle

1. **Request** (permissionless). Any contributor calls `driveAnchor` with the
   object revision, the foreign source coordinates (`family`, `network`,
   `registry`, `objectKey`, `revision`, `eventDigest`), a pinned verifier id,
   and one locator per verification task. A wrong contributor can poison
   nothing: every task digest is copied from commitments the object registry
   already holds, so foreign bytes either hash to them or verification fails.
   - **Content mode** (no chunk ids): one task, expected digest = the
     revision's SHA-256 `decodedDigest`.
   - **Chunked mode**: one task per stored chunk with expected digest =
     `slugId` (keccak256 of stored chunk bytes). The submitted id list must
     hash to the exact `indexDigest` KeelHold committed to. This is how
     Ordinals payloads larger than one inscription (~390KB standard relay)
     anchor: one inscription per chunk, each verified independently, the
     anchor completing only when every chunk is confirmed on Bitcoin.
2. **Verify**. The pinned adapter reports per-task results under the request
   nonce. Only an affirmative on-chain refutation rejects an anchor; DON
   execution errors are retryable and never reach the registry.
3. **Finalize** (permissionless). Once every task verifies, anyone calls
   `setAnchor`. Finalization is deliberately not part of the last oracle
   callback: callbacks run under tight forwarded-gas budgets (Chainlink caps
   them at 300k) while finalizing a 128-chunk anchor credits every task. The
   anchor root is the fixed `keel.anchor.v1` codec, so verified anchors are
   interoperable with every portable-root consumer.
4. **Reopen**. Rejected and cancelled coordinates can be re-requested; a
   pending request abandoned past its 7-day claim lease can be taken over.
   Every generation bumps a nonce, so late oracle fulfillments for a stale
   request cannot touch its successor.

> Terminology: this "native stamp" is a stored registry receipt, not the
> visual "Keel stamp" seal button inside every published build. That UI —
> the verification shell — is mapped in `docs/KEEL_VERIFICATION_SHELL.md`,
> including how anchor rows from this registry reach its data tables.

## Native stamps: same-chain data needs no oracle

When a revision's bytes are committed in this chain's own KeelHold, the
registry verifies the hash linkage itself: `stampNative(objectId, revision)`
reads the descriptor and the store record, checks the digest chain, and mints
an instantly-Verified anchor in the same transaction — trust class 1,
`native-proof`, under the built-in `NATIVE_VERIFIER_ID` registered at
construction. No oracle, no pending state, no fee beyond gas. Native stamps
grant no contributor credit: nothing was replicated anywhere, so this is a
correctness attestation, not a contribution.

The oracle route exists for what the chain cannot read itself: foreign chains
(Tezos, Bitcoin, other EVMs) and off-chain sources. IPFS or plain-URI data
slots into the same machinery as an ordinary registered family (for example
`ipfs://` / `https://` locator schemes) whose workflow handler simply fetches
and hashes — the verifier is the price of the bytes living somewhere the
contract cannot see.

`objectAnchorStamp(objectId, revision)` returns the whole stamp in one read:
native status and root, the attested foreign-family constellation, and the
lineage's **live** frozen state. "Verified + frozen" is the permanent form;
"verified + not frozen" honestly stamps content whose lineage can still
append. Frozen-ness is never baked into the anchor — it is read from the
object registry at query time, so freezing later upgrades the stamp without
touching the anchor.

## Per-object anchor policy

Anchoring is on by default for every object on every family — including
families registered after the object was created — at zero storage cost: an
untouched policy slot means "all enabled", and since a verifier gates every
anchor, permissionless contribution is harmless by construction. The object's
Keel edit authority (or its creator, which keeps frozen lineages
manageable) can change this with one word via `setObjectAnchorPolicy`:

| Policy word | Meaning |
| --- | --- |
| `0` (default) | Every family enabled, present and future |
| restrict flag clear, family bits set | Named families disabled, everything else (including future ids) enabled |
| restrict flag (bit 0) set, family bits set | Only the named families enabled |
| restrict flag alone | Anchoring disabled for the object |

Family `f` maps to bit `f` (ids 1–255), so any number of switches ride in one
`uint256`. The policy gates new requests only — verified anchors are permanent
records and are never retroactively withdrawn.

## Chain families and verifiers are append-only

Families (`1` ethereum/`evm://`, `2` tezos/`tezos://`, `3` bitcoin/`ord://`
seeded; Solana, additional L2 identity spaces, and future chains get fresh
ids) can be registered and retired but never redefined. Verifier ids
permanently pin one adapter address, family mask, trust class, and spec
digest; fixing a bug means registering a new id. Anchors record the verifier
they were accepted under, so upgrading a verifier can never reinterpret an
existing anchor or silently change its trust class — the same rule
`KEEL_PORTABLE_ROOT.md` imposes on verifier registries.

## Verifier routes: CRE (live networks) and Functions (local/dev)

Chainlink Functions sunset on June 30 2026 (testnets June 15). The Functions
adapter and its local router double remain the development route — anvil
demos and the Foundry suite run against them unchanged — while live networks
use `KeelCreReportVerifier`, a Chainlink Runtime Environment (CRE)
receiver registered as its own verifier id. The registry needed no changes:
this is the append-only verifier registry doing its job.

The CRE flow inverts delivery without changing the UX: `beginVerification`
emits `VerificationRequested`; a CRE workflow (TypeScript compiled to WASM,
project in `cre/attested-anchor-workflow/`) triggers on that event via an EVM
log trigger, performs the same multi-endpoint verification the Functions
sources define, and returns a DON-signed report through Chainlink's
KeystoneForwarder. The adapter accepts a report only from the forwarder
(which enforces f+1 DON signatures over an n ≥ 3f+1 signer set) and only when
the report metadata's workflow identity matches the pinned workflow owner and
name — with the exact workflow build id as an opt-in strict pin, since the id
rotates on every workflow update. Reports carry an array of task results, so
one DON write can settle many chunk tasks; stale or duplicate results are
skipped, never reverted, because the forwarder retries failed transmissions.

CRE quotas that shape usage: 5 HTTP calls per run and 100KB per response
(stored KeelHold chunks are ≤23KB, so chunked mode always fits; content
mode suits payloads under ~90KB), 5KB report payload, 5M gas per on-chain
write. Building and `cre workflow simulate --broadcast` against Sepolia are
self-serve; production DON deployment is early-access gated
(`cre account access`).

## Chainlink Functions integration

The adapter encodes requests byte-identically to Chainlink's
`FunctionsRequest.encodeCBOR` and hands the DON the exact JavaScript pinned
for the family — published verbatim to KeelHold, addressed by
`slugId = keccak256(source)`, and therefore auditable from chain state alone.
Sources live in `@keel/protocol` (`CHAINLINK_FUNCTIONS_SOURCE_*_V1`):

- **evm-v1**: reads the foreign Keel registry's revision descriptor at the
  `finalized` tag from two independent RPC providers that must agree.
- **tezos-v1**: runs the `read_keel_object` view at Tenderbake finality on
  two independent RPC providers; the locator's base58 chain id must decode to
  the anchor's `u32be` network.
- **ordinals-v1**: fetches the raw reveal transaction from two independent
  Esplora endpoints, parses the inscription envelope from witness data itself
  (never trusting an indexer's body extraction), enforces confirmation depth,
  and hashes the envelope body.

Every source returns at most 41 bytes — `status (1 verified / 2 refuted) ||
observed digest (32) || byte length (u64be)` — inside the DON's 256-byte
response cap. Endpoint failures and disagreements throw, which the adapter
treats as retryable; refutation is reserved for confirmed, deep, definitive
on-chain mismatches.

Trust honestly stated: this is `attested-proof`. It binds anchors to the
Chainlink Functions DON's threshold consensus plus agreement between the
independent HTTP endpoints each node queries. It is not a light client. A
future `native-proof` verifier (e.g. an SPV witness-commitment path for
Bitcoin) can be registered as a new verifier id without touching the registry.

## Community replication bridge

`KeelAnchorReplicationBridge` translates verified anchors into carrier
proof reviews. Deploy new `KeelCommunityReplicationRegistry` instances with
the bridge as their immutable `proofVerifier`; when a contributor's pending
carrier proof matches a Verified anchor — same object revision, carrier's
family, exact claimed locator — anyone may call `applyVerifiedAnchor` to
accept it. The bridge holds no other authority and can reject nothing.

## Deployment

`apps/studio/scripts/deploy-attested-anchors.ts` deploys the stack, publishes
the verification sources to KeelHold, configures family routes and request
config, and registers the verifier (id
`keccak256("keel.verifier.chainlink-functions.v1")`, trust class 3). Local
anvil runs get the router double; real networks require
`ATTESTED_FUNCTIONS_ROUTER`, `ATTESTED_DON_ID`, and a funded Functions
subscription with the adapter added as a consumer. Register the registry and
adapter in `chain_contracts` (`keel-attested-anchor-registry`,
`keel-chainlink-functions-verifier`) so the indexer projects anchors into
`indexed_attested_anchors` / `indexed_attested_anchor_tasks`.

## Golden vectors

`test/KeelAttestedAnchorRegistry.t.sol` pins cross-language
`keel.anchor.v1` roots for all three seeded families (Ethereum vector
shared with `KeelPortableAnchorRegistry`, Tezos mainnet `0x7a06a770`,
Bitcoin mainnet magic `0xf9beb4d9`), and
`test/KeelChainlinkFunctionsVerifier.t.sol` pins the exact CBOR request
bytes the DON receives. Any codec or encoding change must ship new vectors.
