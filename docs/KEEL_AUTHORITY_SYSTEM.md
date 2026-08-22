# Keel Authority System

## Ground truth

The earlier Keel contracts are not one upgradeable protocol behind a single
manager. They are a constellation of independently deployed, mostly immutable
contracts. `KeelMintGate` manages mint campaigns; it is not a protocol
governor or upgrade root.

The new authority layer deliberately does **not** proxy permanent artwork,
object data, ERC-721 storage, or every Keel contract. It provides a stable
governance and discovery root around those contracts:

- On EVM chains, `KeelManagerProxy` is the stable ERC-1967 address and
  `KeelManager` is UUPS-upgradeable only through two-thirds governance.
- On Tezos, the critical manager is immutable. Replaceable modules are selected
  by manager-owned addresses and code-hash commitments.
- Existing deployments do not become managed automatically. Their current
  owners and roles must explicitly transfer authority to the manager.

This keeps permanent collector data immutable while letting governance repair
the authority logic or select a replacement module.

## Quorum

Both chains use `ceil(2 * governorCount / 3)`, with 3 to 32 governors. Examples:

| Governors | Required |
| ---: | ---: |
| 3 | 2 |
| 4 | 3 |
| 5 | 4 |
| 6 | 4 |

Rounding up matters: four governors never means that two signatures can control
the system.

## EVM / Base

`packages/contracts/src/modules/keel-artifacts/KeelManager.sol` has four authority lanes:

1. **Governors** sign an EIP-712 action containing the exact target, value,
   calldata hash, current governance nonce, deadline, epoch, chain, and manager
   address. Signers must be active, sorted, unique, and meet the current
   two-thirds threshold. Governor changes advance the epoch.
2. **Admins** may execute only manager-approved target/function-selector
   capabilities and value limits.
3. **Moderators** use the same policy table but cannot execute an admin-only
   capability. Admins inherit moderator capabilities.
4. **Automation keys** must pass an active key window, an exact
   target/function policy, a second signer-specific capability window and value
   cap, an EIP-712 signature, and a per-key nonce. Any relayer may submit the
   signed request.

There are no wildcard policies. Lower tiers cannot receive governor management,
role management, policy management, module changes, unpause, or UUPS upgrade
selectors. Only time-bounded ERC-1271 digest approval/revocation can be exposed
on the manager itself. The manager also exposes its active execution lane to
downstream manager-owned contracts: governance is `1`, role execution is `2`,
and automation is `3`. Sensitive protocol configuration can therefore require
the multisig lane even when an ordinary admin capability exists for unrelated
operations.

The manager follows checks-effects-interactions: governance and automation
nonces are consumed before the external call, all externally calling lanes use
the reentrancy guard, and a failed downstream call reverts the nonce and all
state. An admin can pause lower-tier execution, and governors can invoke the
same emergency stop through a self-call; moderators intentionally cannot,
because a moderator-triggered pause could otherwise force timeout forfeits for
active hardcore sessions. While paused,
delegated/manual ERC-1271 approvals are invalid; fresh two-thirds governor
actions and governor signature envelopes remain available for recovery.

`KeelArtifactRegistry` binds to the manager at deployment. Its native
per-object contribution is off by default and can be changed only by a
manager call made through `executeGovernance`; role and automation lanes are
rejected by the execution-context check. Each successful logical object
creation must pay the exact configured amount, the amount is recorded in
`protocolFeesAccrued`, and `claimProtocolFees` follows pull-payment CEI by
decrementing accounting before the recipient call. The registry rejects
unsolicited native transfers and guards object creation, policy callbacks, and
fee claims against reentrancy.

`OneMintController.createDrop`, `updateDropSupply`, and `closeDrop` all reserve
or release capacity through external target calls and are explicitly
`nonReentrant`. Mint payments in both launchpad managers remain exact-pull
flows: the payout account calls `withdraw`, which clears its pending balance
before sending native ETH or ERC-20 funds. A failed recipient interaction
rolls the accounting back atomically.

The manager is not retroactively installed as the owner of existing contracts.
Every deployment must pass the manager (or a reviewed governance-controlled
handoff) as the relevant admin/owner before production value is accepted;
otherwise an old deployer EOA remains an independent authority that the
manager cannot revoke. The immutable object registry constructor now requires
the manager address, and the local/integration deployment paths pass it
explicitly. The Sepolia Vault demo additionally requires a three-address
`KEEL_MANAGER_GOVERNORS` value instead of silently inventing a quorum.

The module directory binds each active address to its deployed runtime code
hash, revision, and optional permanent freeze. A proxy's runtime hash identifies
the proxy, not its implementation, so production module entries should point to
immutable contracts or separately commit and monitor the implementation.

## Tezos

Tezos uses three contracts so a signature automation key can never inherit
arbitrary administrative execution:

- `KeelManager` stores the governor set and native proposals. A proposal
  contains an exact operation lambda, hash, deadline, epoch, and approvals. The
  proposal closes and consumes the governance nonce before emitting operations;
  Tezos atomic rollback restores both if a downstream operation fails.
- `KeelAccessController` is manager-owned. It gives admins and moderators
  exact `target + packed payload` capabilities, minimum tiers, and mutez caps.
  Managed targets expose `keel_manage(bytes)`. Older typed contracts need a
  small reviewed adapter instead of a universal untyped executor.
- `KeelSignatureAuthority` is manager-owned and cannot execute arbitrary
  calls. Governance may approve a digest manually. A time-bounded automation
  key may approve a digest only through its own signed, chain-bound, nonce-bound
  grant, with approval duration capped at 30 days. Pausing immediately makes
  stored approvals invalid until a manager-governed unpause.

The Tezos manager commits module addresses and expected 32-byte code hashes and
can permanently freeze an entry. Michelson cannot inspect another contract's
script hash, so deployment tooling must compare the compiled/originated
Micheline hash before submitting the governance proposal.

Focused local gate:

```sh
packages/tezos/scripts/test-keel-manager.sh
```

The standalone canonical Micheline sizes are checked against the 65,536-byte
limit.

## Base ASCII test artifact

`apps/studio/scripts/deploy-keel-base-opensea.ts` performs a canonical local
Solidity build before connecting to Base. It then deploys the manager
implementation and proxy, an `KeelIndex`, and a one-token `KEEL721` test
collection. Token 1 embeds the manager ASCII artwork as inline SVG/HTML metadata,
freezes it, transfers collection and registry authority to the manager, and
renounces the deployer's application roles.

Preflight, with no transaction authority:

```sh
pnpm --filter @keel/studio exec tsx scripts/deploy-keel-base-opensea.ts
```

Broadcast requires all of the following explicit environment values:

```text
KEEL_BASE_DEPLOYER_KEYSTORE=/absolute/path/to/foundry-keystore
KEEL_BASE_KEYSTORE_PASSWORD_FILE=/absolute/path/to/chmod-600-password-file
KEEL_GOVERNORS=0x...,0x...,0x...
KEEL_ADMINS=0x...
KEEL_MODERATORS=0x...              # optional
KEEL_MINT_RECIPIENT=0x...          # defaults to deployer
KEEL_BASE_BROADCAST=1
```

An explicit `KEEL_BASE_DEPLOYER_PRIVATE_KEY` is also supported for isolated
test wallets, but the encrypted-keystore path avoids exporting the raw key and
is preferred for a funded account. The deployer key is never read from a
repository fallback. The script verifies
Base chain ID 8453, balance, a conservative full-rollout gas budget, exact
constructor/calldata bindings, receipts, runtime code, manager threshold,
authority handoff, frozen presentation, conventional inline ERC-721 JSON,
poster SVG, HTML `animation_url`, and manifest digest. Pending transactions are
checkpointed before confirmation; resume follows the exact transaction hashes
and refuses changed inputs.

The initial manager has no lower-tier execution policies. Governors can act
directly and must approve each desired admin, moderator, automation, and module
policy after deployment. This fail-closed bootstrap prevents the deployer from
quietly creating broad delegated authority.

## Proof boundary

Passing local compilation and tests is source/build evidence, not an external
audit. A Base rehearsal is not a Base mainnet deployment, and an OpenSea URL is
not proof that OpenSea has indexed or rendered the token. Production value
still requires independent contract review, real governor custody procedures,
funded deployment authority, live transaction receipts, explorer verification,
and marketplace pixel/metadata verification.
