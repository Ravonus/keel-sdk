# Mint and Access Campaigns

`KeelMintGate` is the modular campaign engine. `OneMintController` is the
separate recovered staged-drop engine for sales that require one allocation and
one wallet count across ordered phases.

## Campaign target

A campaign names:

- `target`: collection or action contract;
- `adapter`: zero for an `IOCAMintable` target, otherwise a target-specific adapter;
- `payout`: creator treasury;
- `paymentToken`: zero for native currency or a standard ERC-20;
- supply, wallet limit, price, and time window;
- access gates and signature policy;
- `metadataHash`: off-chain configuration/provenance commitment included in the campaign ID.

The manager never performs an unrestricted arbitrary call. Existing contracts need a narrow adapter that knows the expected mint interface, and that adapter/manager must be explicitly authorized by the target.

## Who may create a campaign

The caller must be one of:

- an account holding the manager's high-trust `CAMPAIGN_ADMIN_ROLE`;
- the target's `owner()` or OpenZeppelin-style `DEFAULT_ADMIN_ROLE`;
- an account accepted by the target's optional `IOCACampaignAuthorizer.isCampaignCreator` hook.

`KEEL721` exposes `CAMPAIGN_CREATOR_ROLE` through that hook, allowing campaign setup delegation without every collection-admin capability. Merely granting the manager `MINTER_ROLE` does not let arbitrary users create mint phases against the collection.

## Access gates

Bit flags enable any combination of:

- standard double-hashed Merkle leaves containing `(account, allowance)`;
- ERC-20 balance;
- ERC-721 collection balance;
- ownership of one specific ERC-721 token ID;
- ERC-1155 balance for a token ID;
- custom `staticcall` gate implementing `IOCAAccessGate`.

`GateLogic.All` requires every configured gate. `GateLogic.Any` accepts at least one. In `Any` mode, a failed Merkle proof does not impose the Merkle allowance when another gate grants access.

The contract requires access flags and gate configuration to match exactly. Unused gate addresses/data are rejected, and campaign-level custom gate configuration is capped at 4,096 bytes.

## Signature modes

- `None`: no signature.
- `Creator`: only the campaign's creator signer.
- `Platform`: only the platform signer snapshotted when the campaign is created.
- `Either`: creator takes precedence; platform classification applies only when the signer differs from the creator signer.

The authorization binds:

- campaign ID;
- recipient account;
- signer address;
- maximum cumulative quantity for that authorization;
- signed unit price, allowing explicit discounts or free claims;
- sequential account/campaign nonce;
- deadline;
- optional context hash over mint and custom-gate payloads.

The contract uses EIP-712 domain separation and OpenZeppelin `SignatureChecker`, supporting EOAs and ERC-1271 smart accounts.

## Partial authorization and nonce rule

A signed authorization can be used in multiple mints until `maxQuantity` is consumed. To prevent a signer from issuing several different partially consumable vouchers against one nonce, the manager permits only **one active authorization digest per account/campaign nonce**.

Consequences:

- reusing the exact same signed authorization is allowed until exhausted;
- a different price, signer, deadline, allowance, or context requires a new nonce;
- the account can invalidate its current nonce on-chain, immediately cancelling any remaining partial authorization;
- after exhaustion or nonce invalidation, the active digest is cleared for the next nonce.

Relayers/services should query `nonces`, `activeAuthorizationDigest`, and `authorizationUsed` before presenting a mint quote.

## Platform fee rule

Each campaign snapshots the platform signer, fee recipient, and fee basis points at creation. A fee accrues only when the accepted authorization is classified as platform-signed. Public, Merkle, token-gated, custom-gated, and creator-signed mints do not silently pay a signer fee.

Rotating the global platform signer affects newly created campaigns only. Existing campaigns retain their signing domain semantics.

## Payments

Funds remain in the manager only as accounted pull balances:

- creator proceeds accrue to campaign payout;
- platform fee accrues separately;
- recipients withdraw to an address they choose;
- native transfers use checks-effects-interactions and reentrancy protection;
- ERC-20 collection verifies that the exact expected amount arrived, rejecting fee-on-transfer behavior that could make liabilities exceed assets;
- exact native payment is required; accidental overpayment is not retained.

## Campaigns as phases

A loosely coupled staged sale can use multiple `KeelMintGate` campaigns.
Those campaigns have independent allocations. When every phase must share one
hard drop supply and one per-wallet count, use `OneMintController` instead.

## OneMint shared-allocation drops

`OneMintController` stores an ordered immutable stage array under one drop:

- Allowlist uses EIP-712/`SignatureChecker` authorization;
- Public provides FCFS minting;
- TokenPayment requires exact ERC-20 payment;
- Claim binds the complete ordered entitlement-ID list and verifies live
  ownership before one-time consumption;
- Premint is restricted to the drop authority.

Stage limits may narrow but never widen the drop defaults. All stages consume
the same `drop.minted` and `mintedBy[drop][wallet]` counters. Sales delegates are
full-trust operators able to configure payout and mint stages; never map the
narrow KEEL721 `CAMPAIGN_CREATOR_ROLE` to this authority.

ProofOfWork, Auction, NeuralPayment, and Airdrop retain their historical enum
numbers for decoding but are rejected as unsupported.

## Shared target capacity

Direct campaigns and OneMint drops reserve supply through `IOCAMintCapacity`.
`KEEL721` tracks reservations per manager and globally, consumes the calling
manager's reservation during `strikeFromManager`, and refuses an unreserved mint
that would invade another manager's allocation. Permanent close releases the
remaining reservation. A manager cannot lose `MINTER_ROLE` while its
reservation is nonzero.

Auctions, bonding curves, proof-of-work distribution, and project-specific economics belong in separate reviewed adapters/modules rather than hidden branches inside the core manager.
