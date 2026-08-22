# Keel collection verification

Status: implementation contract for the Vault/Keel gauntlet. A source build
or self-authored receipt is not an approval; every release fingerprint still
requires an independent critic.

## Product rule

Keel does not require immutable art. It requires a durable, inspectable
presentation route. An NFT may activate new art, viewer, metadata, or game
revisions through Keel while collectors retain the complete version history,
content commitments, publisher authority, and activation policy.

Verification therefore keeps these claims separate:

1. **Route binding** — can `tokenURI(tokenId)` ever be redirected away from the
   bound Keel registry/resolver and collection/token scope?
2. **Current revision** — do the active manifest, viewer, metadata, assets, and
   portable roots match the on-chain Keel revision?
3. **Revision governance** — who may publish or activate a revision, and is the
   lineage creator-governed, timelocked, multisig-governed, append-only, or
   frozen?
4. **Mint authority** — is minting active, paused, public, role-gated, owner-
   controlled, timelocked, or permanently disabled?
5. **Supply policy** — current outstanding supply, lifetime minted and burned
   counts when the contract proves them, maximum/reserved/remaining supply,
   burn behavior, and whether any authority can change those limits. An absent
   counter is `unknown`, never an inferred zero.
6. **Upgrade authority** — immutable runtime or proxy; implementation, admin,
   beacon, and any remaining upgrade authority.

A tracked creator-governed art revision is not a verification failure. A route
that can silently leave Keel is a route-binding failure.

## Three onboarding paths

### New contracts: official hooks

New collections use the official Keel collection-verification hook and
policy registry. The collection permanently delegates its token presentation
route to Keel. The hook exposes exact versioned policy state for presentation,
mint, supply, and upgrades. The verifier reads that state at the same pinned
block used to resolve the viewer.

The official hook is the automatic and lowest-cost path. An arbitrary contract
that merely implements similarly named getters does not qualify. The verifier
must bind the official policy registry/module identity, protocol version, exact
collection runtime identity, and the actual `tokenURI` result.

For the Vault collection, presentation scope is explicitly collection scope
zero. Token-scope fallback and local token snapshots are disabled. Every
KeelIndex revision has one append-only binding from its exact manifest
digest to the portable graph root and exact portable anchor root. The canonical
manifest bytes repeat that root/anchor tuple, so the deployment preflight and
clients can verify the bytes, while the native registry independently verifies
the on-chain revision tuple and `portableRoot -> anchorRoot` index. Native
content receipts store a domain-separated digest over chain, collection,
registry, scope, revision, manifest digest, portable root, and anchor root.

Native-green Vault metadata uses content-addressed
`keel://sha256/<portable-root>/...` viewer and thumbnail routes. It does not
embed a mutable HTTPS viewer or image base. An HTTPS marketplace mirror is a
delivery compatibility layer only and cannot receive native-green status unless
the client verifies response bytes against the same committed graph.

Native inspection is permissionless and observes hook state plus `tokenURI` in
the transaction's execution block. Its receipt key is derived only from that
canonical observed state; callers cannot choose an evidence root, expiry, or
overwrite a different `latestReceipt`. After the observation block is mined,
any caller may seal the receipt with the exact EVM `blockhash` for that block.
An unsealed receipt is not current. This two-step lifecycle keeps the claimed
block honest without using `blockhash` as mint entropy.

### Existing contracts: contract-specific adapter

An already-deployed collection may commission a public contract-specific
adapter and audit. The fee pays for analysis and adapter authorship, never for a
green verdict. The adapter is bound to the exact chain, collection address,
runtime code hash, implementation/proxy state, storage/method policy, and a
content-addressed evidence root.

The on-chain registry records a separate verdict for each facet. Immutable
code may receive a permanent route result. Proxy or mutable state receives a
conditional result with explicit recheck/revocation conditions. The adapter and
evidence format are public so collectors and independent services can reproduce
the result.

The native registry does not accept proxy identity reported by the collection
itself: EVM code cannot read another account's EIP-1967 or beacon storage slots.
Until a code-specific adapter supplies independently reproducible slot proofs,
proxy policies are rejected from the native lane and may only appear as
explicitly labeled attested evidence. A getter claiming `implementation()` or
`admin()` is never sufficient.

### No hook or adapter

Bring-your-own contracts remain allowed. Keel can still verify any resolved
content commitments, but contract-control facets must read:

> Not verifiable — this custom contract does not expose an approved Keel
> hook or adapter.

Unknown behavior is never inferred as immutable, renounced, fixed-supply, or
safe.

## Why ownership renunciation is insufficient

`owner() == address(0)` proves only one observation for one known ownership
interface. Other mint roles, AccessControl admins, proxy or beacon admins,
custom setters, fallback-routed selectors, token overrides, and separate policy
registries may remain active. A native result must be derived by an approved
code-specific hook/adapter that checks every relevant control surface.

## Proof classes

- `native-proof`: exact official hook/approved adapter state is verified on-
  chain under the pinned chain and block context.
- `attested-proof`: deterministic evidence is signed by the configured unique
  threshold of auditors. It never becomes native merely because it is signed.
- `client-proof`: the viewer independently checks current bytes and roots, but
  the destination contract does not verify all source-chain state.
- `unverified`: missing hook/adapter, unknown authority, malformed context, or
  failed content/pointer proof.

An optional signed receipt binds the chain ID, collection, runtime and proxy
identity, block number and hash, adapter/policy version, token scope, current
`tokenURI` hash, Keel roots/revisions, every facet, evidence root, unique
signers, challenge nonce, issuance, and expiry. The challenge seed prevents
replay; it does not replace exhaustive checks with randomness.

## Collector UI

The embedded marketplace viewer uses the small faded Keel seal. Hover or
click reveals a summary. Our site hides only that in-art seal through the parent
protocol and renders the same authoritative proof in external chrome.

The detail panel reports, independently:

- **Keel route:** locked / redirectable by an identified authority / unknown.
- **Active presentation:** revision, roots, activation block, and byte checks.
- **Revision policy:** publisher, activation authority, timelock, lineage, and
  freeze state.
- **Minting:** active/paused/disabled, price or gate where provable, and authority.
- **Supply:** current outstanding, lifetime minted, burned, maximum, reserved,
  remaining mintable, burn policy, and cap authority. Each unavailable
  subfield is labeled unknown rather than collapsing the whole row or guessing
  zero.
- **Upgrades:** immutable or exact proxy/implementation/admin state.

Green means the stated facet is proven. Amber means the current state verifies
but a named authority may change it under the displayed policy. Gray `Not
verifiable` is used when no approved hook/adapter proves that control surface.
Red and the large blocking warning are reserved for a proof that was attempted
and failed or contradicted the pinned observation, not merely because Keel
supports tracked revisions.

The color is not a moral judgment about the observed state. A provably active,
fixed public mint can be green and say `Public mint active`; an authority that
can change mint rules is amber and names that authority. A burned token count,
an active mint, or a creator-governed Keel revision is never red merely for
existing. Red means the claimed proof failed or contradicted the pinned-chain
observation. Unsupported control surfaces remain `Not verifiable`, not red and
not an inferred zero.

Every row includes chain, pinned block number/hash, proof class, adapter/hook
version, evidence digest, and the exact authority or reason it cannot be proven.
