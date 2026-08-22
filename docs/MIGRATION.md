# Migration and Resurrection Plan

## Principle: migrate state and intent, not old bytecode patterns

The original deployments and repositories are valuable evidence of protocol intent. They should not be upgraded in place unless a specific deployed proxy and storage layout has been independently reviewed. The default path is new contracts plus registry references/adapters around existing NFTs.

## Phase 1 — inventory

For every legacy collection or artifact, record:

- chain and contract address;
- owner/admin/controller addresses;
- mint authority and remaining supply;
- current `tokenURI` behavior;
- source asset locations and known hashes;
- on-chain script/SVG/audio/storage contract addresses;
- expected mutability and who should control it;
- existing users, marketplaces, and URLs that must continue working;
- whether the existing mint contract can safely authorize a narrow manager/adapter.

Export this inventory as immutable JSON and hash it before migration work.

## Phase 2 — extract artifacts

1. Retrieve every source object from chain, IPFS, Arweave, and current servers.
2. Decode legacy compression, Base64, packed IDs, and generated-contract output.
3. Preserve raw source bytes before transforming anything.
4. Hash the final bytes a browser actually consumes.
5. Classify each item as entrypoint, fallback, preview, original, script, style, library, shader, sprite, font, audio, video, model, or data.
6. Replace hardcoded infrastructure URLs with manifest resources where possible.
7. Derive WebP/other previews without discarding originals.

Use `@keel/builder` to create manifests and flat/recursive upload plans. Reconstruct and verify the exact output before broadcasting storage transactions.

## Phase 3 — wrap an existing ERC-721

An existing token contract does not need to be replaced to gain rich presentation:

1. Deploy `KeelIndex`.
2. Register/claim the collection using its owner or `DEFAULT_ADMIN_ROLE`.
3. Publish a collection-level manifest revision with a canonical digest.
4. Activate it under a deliberate compatibility/policy configuration.
5. Add token-specific revisions only where needed.
6. Host a stable viewer route accepting chain, contract, and token ID.
7. Keep the old `tokenURI` available; legacy marketplaces remain unaffected.

A registry-aware indexer/viewer can surface richer presentation immediately, without waiting for every marketplace to understand custom manifest fields.

## Phase 4 — new collections

For new work:

1. Create `KEEL721` through `KeelFactory`.
2. Configure the conventional marketplace poster, manifest URI/digest, complete HTML viewer route, description, and royalties.
3. Grant `MINTER_ROLE` to `KeelMintGate` only when required.
4. Keep campaign creation with the admin or grant narrow `CAMPAIGN_CREATOR_ROLE`.
5. Publish/activate the registry revision.
6. Create bounded sale/claim campaigns.
7. Move admin roles to multisig/timelock and revoke deployment-only access.

## Phase 5 — distribution migration

Map each old drop stage to a campaign:

| Old mode | Modern campaign |
| --- | --- |
| Off / ended | Paused campaign or ended time. |
| Signature access list | Creator/platform EIP-712 signature. |
| FCFS | Public campaign. |
| Token mint | ERC-20 payment/gate or custom gate. |
| Airdrop/claim | Merkle allowance, optionally signed. |
| Premint | Admin mint or bounded creator campaign. |
| Auction | Separate audited auction adapter/module. |
| Proof of work | Separate gate only after economic/security review. |

Never reuse legacy signatures. The new domain, manager address, campaign ID, account nonce, and context binding are intentional replay protection.

A signer service should issue a fresh nonce whenever it changes price, maximum quantity, signer, deadline, or payload context. Only one partially consumed authorization digest may be active for a nonce.

## Phase 6 — presentation policy

Before publishing, decide:

- Is the collection presentation immutable after reveal?
- Can the creator add compatible revisions?
- Can each token owner customize presentation?
- Is either party allowed?
- Is a timelock required?
- Does the conventional local fallback need to freeze too?

Publish policy in both the manifest and registry. Confirm the exact active digest independently before freezing. For `KEEL721`, remember that local default freeze and external registry freeze are separate operations.

## Phase 7 — pilot launch

- Cap campaign quantity and value.
- Use a dedicated viewer origin.
- Monitor every role, campaign, revision, signer, withdrawal, pause, and freeze event.
- Keep global pause under multisig control.
- Maintain redundant source gateways plus at least one independently reconstructable source.
- Publish resolution audit output for reference artifacts.
- Rehearse signer loss, gateway outage, RPC outage, and pause/unpause procedures.
- Run an external audit and bug bounty before raising limits.

## Suggested first resurrection milestone

A useful first production milestone is deliberately narrow:

1. Choose one existing collection and one representative interactive artifact.
2. Build a manifest with conventional preview, exact original, and one executable entrypoint.
3. Store the entrypoint on `KeelHold` and retain IPFS as a verified fallback.
4. Register a collection-level revision without changing the old token contract.
5. Publish a read-only viewer and audit panel.
6. Add mint campaigns only after the presentation path has operated reliably.

That proves the core standard without coupling launch risk to a new economy or gameplay system.
