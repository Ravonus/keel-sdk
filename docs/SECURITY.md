# Security Model

This document describes intended defenses and remaining trust. It is not a third-party audit.

## Security properties

The design aims to ensure:

1. a registry-trusted artifact cannot mount without an actual registry presentation read;
2. the parsed manifest matches the committed RFC 8785 SHA-256 digest;
3. every accepted resource matches a cryptographic decoded-byte digest;
4. failed sources cannot silently replace committed content;
5. creator code has no direct wallet/provider or same-origin privilege;
6. undeclared runtime content names do not fall through to the public network;
7. on-chain object traversal is bounded and verified;
8. mint authorizations bind chain, manager, campaign, account, signer, price, quantity, nonce, deadline, and context;
9. admin and creator powers are explicit and revocable until intentionally frozen.

## Threat boundaries

### Creator content is hostile

Treat entrypoint HTML, JavaScript, SVG, WASM, models, fonts, and media as attacker-controlled even when their hash is correct. Integrity proves identity, not safety.

The viewer uses:

- an opaque unique-origin iframe;
- no `allow-same-origin`;
- restrictive CSP;
- no injected wallet/provider;
- verified data/blob materialization;
- deny-by-default dynamic content gateway;
- blocked raw networking/navigation APIs;
- iframe embedded-CSP requirement where supported and credentialless framing;
- runtime byte/resource/depth/time limits.

The host must not trust `postMessage` data from the artifact without validating sender window, expected protocol, message schema, size, and allowed operation.

### Browser sandbox limitations

A browser is a large attack surface. JavaScript patches and CSP reduce exposed paths but cannot prove that no browser version has an unmodeled request primitive or exploitable bug.

For strong egress containment:

- Electron: dedicated session/partition plus `installElectronViewerEgressGuard()`;
- Web: dedicated origin plus outbound proxy/firewall policy where possible;
- Native/kiosk: OS/container network isolation.

Resolve remote/on-chain bytes outside the isolated renderer.

### Host-side retrieval is privileged

A malicious manifest can point at hostile public hosts and attempt SSRF/DNS-rebinding behavior. Defaults reject private/literal special networks and URL credentials, allow only HTTPS, and disable automatic redirects. Production hosts should also:

- use `sourceAllowlist` when projects have known hosts;
- implement `authorizeRemoteSource` with DNS resolution and private/reserved IP rejection;
- enforce outbound firewall rules;
- cap response bytes and time;
- restrict TLS/certificate policy as needed;
- isolate IPFS gateways and RPC clients;
- log accepted/final locations.

### Registry and RPC trust

The registry commitment is only as reliable as the selected chain, RPC result, confirmation policy, and contract address. Hosts should pin chain ID and registry address, use trusted/finalized RPC reads, and independently verify deployed bytecode when appropriate.

`presentationMatches` confirms registry state but does not replace chain finality policy.

### Viewer bundle trust

Viewer mirrors are hash verified. The initial launcher that performs that verification remains trusted. Use multiple mirrors, publish bundle digests, and isolate viewer updates from artifact content.

## Manifest attacks

Defenses include:

- untrusted structural parsing;
- semantic reference validation;
- RFC 8785 canonicalization;
- mandatory source integrity;
- normalized alias restrictions;
- duplicate/collision detection;
- composite cycle detection;
- 128-child fanout;
- resource, recursion, byte, and timeout limits;
- registry anchor matching.

Do not accept a manifest object from application code and call `resolveArtifact()` as production trust unless its digest was verified externally. Direct resolution is a development/digest-trust path and emits a warning when no commitment is supplied.

## Resource attacks

The host verifies after decompression, which prevents a compressed stream from committing only to transport bytes. Decoded limits are enforced to reduce decompression bombs. Custom Brotli adapters must enforce the same maximum output size.

Media type is declarative and untrusted; the gateway adds `nosniff`, but active content remains hostile and must stay inside the sandbox.

## Virtual route attacks

Aliases must be normalized `/content/`, `/onchain/`, or `/ipfs/` paths without traversal, backslashes, queries, fragments, or control characters. Exact aliases are collision checked. Requests support only GET/HEAD.

Do not share one global route table between mutually untrusted artifacts. Scope routes to a resolved artifact/session.

## On-chain storage attacks

- Chunks and indexes are immutable bytecode.
- IDs are content addressed.
- Object IDs commit to index order and metadata.
- Fanout is bounded.
- Clients verify node type, lengths, compression, and digests.
- RPC adapters must bound page sizes, node count, depth, aggregate bytes, and time.

Contract records commit to digests but do not decompress/rehash arbitrary payloads in the EVM; client verification is mandatory.

## Contract administration

### KeelIndex

- Protect `DEFAULT_ADMIN_ROLE` and `REGISTRAR_ROLE` with multisig/timelock policy.
- Review creator/token-owner/timelock policies before activation.
- Confirm active digest and revision independently before freezing.
- Treat freezes as irreversible.

### KEEL721

- Restrict `MINTER_ROLE` to reviewed managers/adapters.
- Restrict `PRESENTATION_ROLE` and `CAMPAIGN_CREATOR_ROLE`.
- Understand local fallback freeze versus registry freeze.
- Validate royalty receiver and basis points.

### KeelMintGate

- Protect global admin and campaign admin roles.
- Review platform signer and fee recipient.
- Use EIP-712/`SignatureChecker`, not raw `ecrecover`.
- Treat fee-on-transfer/rebasing tokens as unsupported unless a reviewed adapter handles them.
- Monitor liabilities and withdrawals.

### OneMintController and mint capacity

- Treat a OneMint sales delegate as a high-trust operator, not as a narrow
  campaign creator.
- Require capacity-aware KEEL721 targets and close expired drops/campaigns to
  release unused reservation.
- Do not revoke `MINTER_ROLE` while a reservation exists; KEEL721 enforces this.

### Contract calls and CEI

- Follow Checks-Effects-Interactions for every state-changing entrypoint.
- Consume nonces, allocations, claims, escrow, and internal balances before a
  token transfer, mint callback, native-value call, or other external mutation.
- Keep native payouts pull-based and restore nothing after a successful call.
- Cancun deployments use EIP-1153 transient reentrancy guards. Do not deploy
  this bytecode to a chain that lacks EIP-1153 support.
- Treat external view calls as untrusted, fail-closed checks even though a
  static call cannot mutate contract state.
- Run the source-wide policy and measured user-path budgets described in
  `docs/GAS.md`; a cheaper result does not replace adversarial testing.

### Keel registries and equipment

- Verify every registry relationship and the capacity-aware Factory marker at
  deployment time.
- Keep Object/Viewer/Link/Seed commitments exact; never execute decoded legacy
  scripts during contract or indexer verification.
- Deploy Equipment inventory only for non-burnable KEEL721 collections until a
  coordinated pre-burn release protocol exists.
- Treat the KeelIndex collection controller as both catalog curator and
  untracked-ERC721 recovery trustee; use a multisig/timelock and monitor
  `UntrackedERC721Recovered`.
- The browser Keel route may call only the explicit view-method allowlist on
  enabled, correctly typed contracts.

## Deployment checklist

- [ ] Exact pinned Solidity compilation passes.
- [ ] Runtime bytecode sizes are under EIP-170.
- [ ] Foundry unit/fuzz/invariant tests pass.
- [ ] Static analysis findings are reviewed.
- [ ] `pnpm contracts:gas:check` passes without an unexplained snapshot refresh.
- [ ] Deployed bytecode and constructor args are verified.
- [ ] Admin roles are on intended multisig/timelock accounts.
- [ ] Registry/collection/manager addresses and chain IDs are pinned.
- [ ] Manifest parses and RFC 8785 digest matches independently.
- [ ] Every source has cryptographic decoded-byte integrity.
- [ ] Remote source allowlist, DNS/IP checks, redirect policy, and egress firewall are configured.
- [ ] RPC/IPFS gateways are bounded and monitored.
- [ ] Viewer runs on a dedicated origin or Electron session.
- [ ] Electron viewer session has the egress guard installed where applicable.
- [ ] Runtime byte/resource/depth/time limits are realistic.
- [ ] Revision policy and compatibility are intentional.
- [ ] Freeze procedure has been rehearsed.
- [ ] External audit is complete before meaningful value.

## Suggested analysis

```bash
pnpm verify
pnpm contracts:compile
pnpm contracts:gas:check
cd packages/contracts
forge build --sizes
forge test -vvv
forge test --fuzz-runs 10000
slither src
```

Suggested invariants include immutable object/index records, bounded object traversal, active revision linearity, frozen presentation stability, campaign supply/per-wallet limits, one-active-digest nonce semantics, authorization consumption, and pending withdrawal liabilities.
