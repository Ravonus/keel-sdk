# Keel cross-chain mint — Tezos inbound

How an EVM-side Keel token mints a native counterpart **on Tezos L1**.

This document describes the trust model, key-rotation policy, and the off-chain
attestor daemon for the Tezos-inbound direction. It is the counterpart of the
EVM bridge `packages/contracts/src/modules/keel-cross-chain-mint/KeelCrossChainMintBridge.sol`.

- Contract: `packages/tezos/contracts/keel_tezos_cross_mint_attestor.py`
  (module `keel_tezos_cross_mint_attestor_module`,
  contract `KeelTezosCrossMintAttestor`)
- Tests: `packages/tezos/tests/test_keel_tezos_cross_mint_attestor.py`
- Deployment target: `packages/tezos/targets/compile_cross_mint_attestor.py`
- Mint surface it drives: `KeelIPWrappedFA2.mint_from_keel`
  in `packages/tezos/contracts/keel_ip_wrapped_fa2.py`

---

## 1. Trust model

**This is attested proof from a NAMED attestor set — it is explicitly NOT the
CRE DON.**

The Chainlink CRE workflow (`cre/attested-anchor-workflow`) and the
KeystoneForwarder can only deliver DON-signed reports to **EVM** chains. Chainlink
CRE cannot write to Tezos. So the EVM bridge's `onReport` path — DON signs, the
forwarder calls the target collection — has no Tezos equivalent, and none of the
Tezos-inbound security can lean on the DON.

Instead, a **k-of-n attestor set** stands in for the DON on the Tezos side:

| | EVM inbound (`onReport`) | Tezos inbound (`submit_cross_mint`) |
|---|---|---|
| Who vouches | Chainlink DON | Named attestor set registered on-chain |
| Delivery | KeystoneForwarder push | Any permissionless relayer |
| Verification | Workflow identity + forwarder sender | k-of-n signatures verified on-chain |
| Authority binding | pinned workflow owner/name/id | pinned attestor keys + threshold |

A threshold `k` of the `n` registered attestor keys co-sign a mint authorization
off-chain. Anyone may then submit the authorization plus its signatures; the
contract verifies the signatures on-chain and mints. **The security of a
Tezos-inbound mint rests entirely on the honesty of the registered attestor set
and the threshold `k` — not on the CRE DON, which never touches Tezos.**

### What the attestors are attesting to

Each authorization commits to the tuple the reviewer specified:

```
(source EVM chain id, source collection address, source token id,
 keel object id, recipient tz address, nonce)
```

plus `min_signatures` (the `k` the co-signers agree to) and `attestor_epoch`
(the registry version they signed against). The exact bytes each attestor signs
are produced by the on-chain view `authorization_payload`, which packs, with
domain separation:

```
pack(record(
  domain            = "keel.tezos.crossmint.auth.v1",
  chain_id          = <Tezos chain id>,      # binds to this network
  authority         = <this attestor KT1>,   # binds to this deployment
  source_chain_id, source_collection, source_token_id,
  keel_object_id, recipient, nonce,
  min_signatures, attestor_epoch,
  data_digest       = sha256(data)))         # commits the free-form mint payload
```

Binding `chain_id` and `authority` (the contract's own address) means a
signature is inert on any other network or any other attestor deployment.

### Security posture mirrored from the EVM bridge

The externally visible semantics match `KeelCrossChainMintBridge.sol`:

1. **Route opt-in per (source chain, source collection).** A collection can only
   mint on Tezos after governance calls `set_route(..., enabled=True)`. Absent or
   disabled routes are rejected (`ROUTE_MISSING` / `ROUTE_DISABLED`). A route
   grants nothing by itself — the attestor must also be the `executor` of the
   target `KeelIPWrappedFA2`.

2. **Permanent one-mint-per-source-token dedup**, keyed by
   `sha256(TOKEN_DOMAIN, this_contract, source_chain_id, source_collection,
   source_token_id)`. Folding in the contract's own address makes the same source
   token mintable once per Tezos deployment and unreplayable across deployments —
   the analog of the EVM key folding in `localNetwork` and `address(this)`.

   **Reopen only if the mint call itself fails** — for free on Tezos. The dedup
   (and nonce) flags are written *before* the `mint_from_keel` operation is
   emitted. On Tezos an inter-contract call runs *after* the entrypoint returns;
   if it fails, the whole transaction reverts atomically and those writes never
   persist. So the dedup is committed **iff** the mint succeeded, exactly the
   property the EVM contract achieves with an explicit `try/catch` that reopens
   `_minted[tokenKey]` on the mint reverting. (There is no other way to reopen —
   there is no admin "clear dedup" entrypoint, matching the EVM's permanence.)

3. **Identity is bound to the attested keel object id, never to free-form
   data.** The minted token's `resource_object_id` is set from the signed
   `keel_object_id`. The free-form `data` is forwarded to the mint surface but
   only its `sha256` is recorded as provenance and only its digest is in the
   signed payload — it cannot influence token identity. This is a stronger form
   of the EVM's "mintData must carry the object id at the route's offset" check:
   here identity comes straight from the signed authorization, so there is no
   offset to get wrong.

4. **Append-only attestor registry** (see §2).

5. **Nonce replay guard**, distinct from the token dedup: keyed by
   `sha256(NONCE_DOMAIN, this_contract, source_chain_id, source_collection,
   nonce)`. A nonce is single-use per (source chain, collection). This rejects a
   *different* source token that reuses a spent nonce, even though the token
   dedup would let it through.

### Differences from the EVM path (intentional)

- **Revert vs. skip.** The EVM `onReport` processes a *batch* from one DON report
  and *skips* bad items (emitting `CrossMintSkipped`) so the forwarder never
  retries the whole report. The Tezos attestor processes **one** authorization
  per call submitted by a permissionless relayer, so it simply **reverts** on bad
  input (`ROUTE_*`, `SUB_THRESHOLD`, `SOURCE_TOKEN_MINTED`, `NONCE_CONSUMED`). A
  reverted submission costs the relayer gas and mints nothing.
- **No custody.** Like the EVM bridge, nothing is locked or wrapped. The Tezos
  token is a native mint bound to the same attested object id; the source token
  is untouched.

---

## 2. Key rotation policy (append-only)

The attestor registry mirrors the EVM verifier registry's **append-only** rule:
attestors can be added and retired, but **a past authorization's attestor set is
fixed**, and a key binding is never rebound or deleted.

Storage: `attestors : big_map[key_hash, {public_key, registered_epoch,
retired_epoch: option}]`, plus a monotonic `epoch` counter.

- **Add** — `register_attestor(public_key)` (admin only). Refuses a key that is
  already present (`ATTESTOR_EXISTS`): a `key_hash` is bound to its `public_key`
  **once and never rebound**. Stamps `registered_epoch = epoch`, then bumps
  `epoch`.
- **Retire** — `retire_attestor(signer)` (admin only). The record is **kept**;
  only `retired_epoch = epoch` is stamped, and only once (`ATTESTOR_RETIRED` on a
  second attempt). Then `epoch` bumps. Nothing is ever deleted.
- **Threshold floor** — `set_min_threshold_floor(k)` (admin, `k >= 1`). A
  governed lower bound on `min_signatures`. Raising it can only make an
  already-signed authorization fail **closed** (never open).

### Why a past authorization's set is fixed

Every mutation bumps `epoch`, sealing an immutable registry version. Each
authorization pins the `attestor_epoch` it was signed against, and verification
counts a signer only if it was **active as of that epoch**:

```
registered_epoch <= attestor_epoch  AND
(retired_epoch is None  OR  attestor_epoch < retired_epoch)
```

Because records are append-only and `retired_epoch` is monotonic and set once,
membership-as-of any past epoch is deterministic and can never change. An
authorization may only reference an epoch that already exists
(`attestor_epoch <= current epoch`); a future epoch is meaningless and rejected.

### Rotation procedure

1. `register_attestor` the new key(s). `epoch` advances.
2. Have attestor daemons re-read `current_epoch` and sign new authorizations
   against the new epoch.
3. `retire_attestor` the outgoing key(s). `epoch` advances again.
4. In-flight authorizations that were collected against an old epoch and still
   rely on a now-retired key must be **re-collected** against the current epoch —
   retirement is forward-effective for any authorization pinned at or after the
   retirement epoch. (This matches the EVM `onReport` re-checking live workflow
   identity: a config change can invalidate not-yet-delivered work.)

There is deliberately **no** entrypoint that overwrites a key, changes a signer's
`public_key`, or deletes a record. The only emergency lever beyond retirement is
`pause()` / `unpause()`, which halts all `submit_cross_mint` calls, and
`lock_configuration()`, a one-way freeze of the mint target (routes and the
registry stay mutable, mirroring the EVM `lockConfiguration`).

---

## 3. How `CrossMintRequested` feeds the attestors

> The off-chain attestor daemon is **out of scope for this deliverable** — only
> its responsibilities are sketched here. Do not treat this section as an
> implementation.

The EVM bridge's source side emits, from `requestCrossMint`:

```solidity
event CrossMintRequested(
  bytes32 indexed objectId, address indexed collection, uint256 tokenId,
  uint32 targetNetwork, address recipient, uint64 objectRevision,
  uint64 nonce, bytes mintData);
```

An **attestor daemon** — one process per attestor key, `n` independent operators
— watches this event and co-signs when (and only when) it can independently
re-derive the same facts the EVM contract required. Each daemon:

1. **Watches** `CrossMintRequested` on each supported source EVM chain, filtered
   to `targetNetwork` values that mean "Tezos" in the deployment's routing table.

2. **Independently re-verifies** the request against source-chain state, never
   trusting the event alone:
   - the emitting collection is the one it expects for that route;
   - `objectId` / `objectRevision` exist and are **anchored** for the Tezos
     target (the same attested-anchor property the EVM source gate checks);
   - the requester owned `tokenId` and controlled the object at request time.
   The Tezos object bytes can be cross-checked through the existing on-chain
   readback views `get_keel_object` / `read_keel_object` (see
   `apps/studio/src/server/services/community-replication-source-service.ts`).

3. **Maps** the EVM request to a Tezos authorization:
   `source_chain_id = <source EVM chain id>`,
   `source_collection = <collection, 20 bytes>`,
   `source_token_id = tokenId`,
   `keel_object_id = objectId`,
   `recipient = <the tz address the requester designated>`,
   `nonce = <the request nonce>`,
   `min_signatures = k`, `attestor_epoch = current_epoch()`,
   `data = <mint payload for the target collection>`.
   The recipient is a **Tezos** address; how a requester expresses their intended
   tz recipient (a field in `mintData`, an off-chain registry, etc.) is a
   deployment policy the daemon and the source UI agree on — the attestor
   contract only ever mints to the `recipient` inside the signed authorization.

4. **Fetches the exact payload** to sign from the attestor contract's
   `authorization_payload` view (so every operator signs byte-identical data
   including `chain_id` and `authority`), signs it with its attestor key, and
   publishes its signature to a shared collection point (a relayer service, a
   gossip topic, etc.).

5. Does **not** submit. Submission is permissionless: once `k` signatures exist,
   any relayer calls `submit_cross_mint(authorization, signatures)`. A dishonest
   or buggy relayer cannot forge a mint (it lacks `k` keys) and cannot double-mint
   (dedup + nonce). At worst it wastes its own gas on a reverting call.

### Responsibilities summary

| Concern | Owner |
|---|---|
| Re-verify source ownership + anchoring | each attestor daemon, independently |
| Decide the tz recipient mapping | source UI + daemon policy (agreed, off-chain) |
| Produce byte-exact signing payload | `authorization_payload` view |
| Hold and rotate attestor keys | attestor operators (see §2) |
| Enforce k-of-n, dedup, nonce, identity | the on-chain contract |
| Submit the assembled call | any permissionless relayer |

---

## 4. Deploy & test

Wiring: deploy `KeelTezosCrossMintAttestor(admin, mint_target, threshold_floor)`
and deploy the target `KeelIPWrappedFA2` with its `executor` set to the
attestor's address (so `mint_from_keel` accepts the attestor as sender). If
the addresses are circular at construction time, deploy the attestor with a
placeholder mint target and call `set_mint_target` once the wrapped FA2 exists,
then `lock_configuration`.

Run the scenario tests (SmartPy 0.24, the package's `.venv`):

```sh
cd packages/tezos
PYTHONPATH="$PWD" .venv/bin/python tests/test_keel_tezos_cross_mint_attestor.py
```

Emit the standalone deployment target:

```sh
cd packages/tezos
ADMIN=tz1... MINT_TARGET=KT1... MIN_THRESHOLD_FLOOR=2 \
  PYTHONPATH="$PWD" .venv/bin/python targets/compile_cross_mint_attestor.py
```

### Test coverage

The suite (`tests/test_keel_tezos_cross_mint_attestor.py`) covers:

- **happy path** — 2-of-3 mint succeeds; token minted to the recipient; provenance
  bound to the attested `keel_object_id` (not `data`); dedup + nonce recorded;
  a second source token with a fresh nonce mints again;
- **route opt-in** — a submission before `set_route` is rejected (`ROUTE_MISSING`);
- **sub-threshold** — one valid signature under a 2-of-3 threshold is rejected;
  duplicate signatures from one signer cannot inflate the count;
- **duplicate source token** — re-minting the same source token (fresh nonce, full
  valid set) is permanently barred (`SOURCE_TOKEN_MINTED`);
- **unknown / retired attestor** — a signature from an unregistered key does not
  count; after retiring a key, authorizations pinned to the new epoch no longer
  count it, while the surviving active set still mints;
- **nonce replay** — a different source token reusing a spent nonce is rejected
  (`NONCE_CONSUMED`);
- **append-only registry** — non-admin governance rejected; re-registering a key
  rejected; retiring an unknown key and double-retiring rejected; threshold floor
  cannot drop below 1; `lock_configuration` freezes the mint target.
