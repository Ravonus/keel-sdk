# Keel IP control

This is the v1 design and implementation boundary for licensing and delivery
permissions on Keel objects. It answers two separate questions:

1. What legal license is attached to the work?
2. Which account may perform a particular operation on each exact object
   revision?

The control contract never makes compressed bytes confidential by itself. Any
portion that must be withheld is a separate sealed Keel object (usually a
child leaf), and the manifest binds that leaf directly.

## Object model

- A license is a sealed, immutable Keel object whose descriptor must use the
  Brotli marker. The stored object ID, decoded SHA-256, decoded length, stored
  length, compression, identifier, name, publisher, and standard/custom flag
  are committed in the license record.
- Standard licenses are administrator-published records. The first catalog
  entries should be CC0-1.0, MIT, Apache-2.0, BSD-2-Clause, and BSD-3-Clause.
  CC0 is the default open-license choice, but “open” access and CC0 are not
  the same thing: access is a policy, while the license is legal metadata.
- Custom licenses are creator-published records and may point at any creator
  owned Brotli license object.
- A policy is bound to one exact object ID and revision. Its zero object ID
  rule is the default; a child object ID may override that rule. This makes a
  public composite root plus private seed, endpoint, or membership leaves
  explicit and auditable.
- The action mask is `view=1`, `download=2`, `remint=4`, and
  `mint-to-backpack=8`. A policy can expose any subset of those actions.

## Access modes

| Mode | v1 behavior |
| --- | --- |
| Open | Anyone can use the actions enabled by the rule. The license still remains authoritative. |
| Allowlist | The creator updates an account/object allowlist. |
| Token | Access is evaluated against current live token ownership or balance. |
| Creator grant | The creator explicitly grants or revokes an action mask for an account. |
| External rule | A chain-local read-only rule is pinned by its code hash and asked for the live decision. |

Ethereum supports live ERC-20 balances, ERC-721 collection or exact-token
ownership, and ERC-1155 balances. ERC-721 and ERC-1155 contracts are checked
through ERC-165 before a rule is accepted, and failed live calls fail closed.
The optional signed capability path uses EIP-712 typed data, accepts EOA and
ERC-1271 contract-wallet signatures, and consumes a per-account nonce for
one-shot operations.

Tezos uses a delegated native FA2 adapter with the same `get_balance(owner,
token_id)` view shape for its synchronous token path. It supports the same
eight requirement limit, `all`/`any` logic, collection/exact matching fields,
live ownership changes, and action masks as Ethereum. The adapter boundary is
deliberate: callback-only FA2 contracts are not silently treated as verified.
Tezos creator grants are explicit, revocable, and optionally expiry-bound, and
the external-rule path uses a live `code_hash` plus `is_authorized` view just
like the EVM code-hash pin.

The EVM implementation is in
[`KeelIPControl.sol`](../packages/contracts/src/modules/keel-ip-control/KeelIPControl.sol). The
Tezos policy evaluator is in
[`keel_ip_control.py`](../packages/tezos/contracts/keel_ip_control.py),
and the Tezos license catalog is deliberately separate in
[`keel_ip_license.py`](../packages/tezos/contracts/keel_ip_license.py).

## Manifest and verifier boundary

The manifest extension is `keel.ip-control` / `keel-ip-control@1`.
It commits the chain, registry, policy ID, root object/revision, exact license
record, and a resource-to-object binding for every controlled resource.
Tezos additionally commits `network`, `licenseRegistry`, and, when live token
or external evaluation is needed, `tokenGate`. Both chains may commit an
`actionExecutor`. A resource that must be downloadable after it is withheld
from the render graph can also commit an exact `delivery` binding: chain,
network where applicable, Keel store, content object ID, decoded digest,
and filename.

The viewer reads the live policy, license record, and per-action status at one
chain snapshot. It verifies exact IDs, object revisions, license digest and
Brotli metadata, rule masks, and resource coverage. If the reader is missing,
the chain read fails, or any binding disagrees, controlled resources are
withheld. The resolver exposes the verified license, creator, policy version,
mode, and currently allowed actions through `ResolvedIPControl`, and includes
the result in `ResolutionAudit` for the Keel verifier UI.

The verifier reports permissions as capabilities, not as an automatic promise
that an operation has already happened. The chain-local action executors
recheck the live rule at execution time. Downloads for withheld bytes consume
a receipt bound to policy, resource, account, nonce, context, and executor;
the Studio delivery route then reconstructs and verifies the exact Brotli/
Keel object before returning it. The route accepts only a persisted canonical
manifest binding for the exact policy, resource, store, content object, and
decoded digest; account-bound requests also bind the declared executor and
delivery context into the consumed receipt. Public open downloads may use the
same route without a wallet receipt. Remints and backpack mints record
provenance back to the policy/resource pair.

## Standards alignment

- Ethereum object/token integrations use [ERC-165](https://eips.ethereum.org/EIPS/eip-165),
  [ERC-20](https://eips.ethereum.org/EIPS/eip-20),
  [ERC-721](https://eips.ethereum.org/EIPS/eip-721), and
  [ERC-1155](https://eips.ethereum.org/EIPS/eip-1155).
- Signed capabilities follow [EIP-712](https://eips.ethereum.org/EIPS/eip-712)
  and contract-wallet validation follows
  [EIP-1271](https://eips.ethereum.org/EIPS/eip-1271).
- Backpack minting is an action capability. A token-bound-account adapter can
  execute it using [ERC-6551](https://eips.ethereum.org/EIPS/eip-6551), but the
  IP registry does not pretend to be a token-bound-account registry.
- Tezos uses the [FA2 token model](https://docs.tezos.com/architecture/tokens/FA2),
  [TZIP-12](https://tzip.tezos.org/tzip-12/) where an adapter exposes the
  required balance view, and native [on-chain views](https://docs.tezos.com/smart-contracts/views).
  Browser operations use the [Beacon/TZIP-10 wallet flow](https://tzip.tezos.org/tzip-10/).
  The current token evaluator is intentionally narrower than arbitrary FA2
  callback/permit designs; unsupported callback-only rules are not treated as
  verified.

## Delivery sequence

1. Creator seals license text with Brotli in Keel.
2. Creator registers the standard or custom license and creates the root policy.
3. Creator adds child rules for protected seeds, endpoints, or membership
   payloads, then publishes a manifest with exact object IDs and revisions.
4. A wallet connects. The verifier reads the current owner/balance or explicit
   grant and returns the allowed action set for each resource.
5. The product offers only the returned operations: verified download, a
   remint flow, or a backpack mint flow. Ethereum uses the injected wallet;
   Tezos uses Beacon. Each executor rechecks the live rule and records the
   resulting object/token relationship.

## Release gates still required

- Register the initial standard-license catalog with the administrator's
  canonical Brotli license objects on each deployment.
- Deploy and record the EVM registry plus the Tezos license and policy
  addresses; wire those addresses into manifest generation and the indexer.
- Deploy and record the chain-specific action executors and mint targets for
  download, remint, and backpack mint; the source implementations and local
  target gates are present, but addresses cannot be invented in a manifest.
- Add an independent browser/RPC verification receipt for each live deployment;
  a source build and a unit test do not prove a public contract is deployed.
- Keep the Tezos target sweep green. The current focused targets are 64,249
  bytes for IP control, 25,450 for the license registry, 25,807 for the token
  gate, 34,914 for the action executor, 4,388 for wrapped FA2, and 6,515 for
  the backpack target, all under the 65,536-byte gate; unrelated pre-existing
  targets still need their own sweep result.
