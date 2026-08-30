# Testing and readiness

This is the practical map for getting the SDK, sibling contracts, reusable
modules, and representative creative runtimes ready for testing. Run focused
checks while iterating, then the aggregate gates before a release or live test.

No command on this page authorizes an upload, deployment, signature, faucet
claim, auction, sale, or mint unless the command explicitly says so and the
creator approves that action at the time.

## Evidence levels

| Level | Evidence | Safe claim |
| --- | --- | --- |
| 1 | SDK/unit test | Local TypeScript/JavaScript behavior passed |
| 2 | Forge test | Solidity behavior passed in the Forge test environment |
| 3 | Module build/test/index | Exact source/output receipt and deterministic catalog passed |
| 4 | Browser/runtime smoke | The tested build rendered and behaved in that browser/URL |
| 5 | Receipt + contract read-back | The public chain included the transaction and returned the expected state/bytes |

Level 1 does not prove Levels 2–5. A receipt alone does not prove the complete
object graph, tokenURI parity, module binding, or browser playback. A browser
smoke does not prove the served bytes came from the chain.

## SDK gates

From `keel-sdk`:

```bash
pnpm install
pnpm build
pnpm test
```

The aggregate checks also inspect the canonical sibling `keel-contracts` and
`keel-site` checkouts:

```bash
pnpm check
pnpm verify
```

`pnpm test:conformance` requires the expected sibling repositories and fails if
they are unavailable. Do not replace that required integration path with a
skipped test:

```bash
pnpm test:conformance
```

Focused MCP/skill verification:

```bash
pnpm --filter @keel/mcp build
node --test tests/mcp.test.mjs
node packages/mcp/dist/cli.js --self-test --workspace .
skill_validator="${CODEX_HOME:-${HOME}/.codex}/skills/.system/skill-creator/scripts/quick_validate.py"
python3 "$skill_validator" skills/fray-keel-agent
python3 "$skill_validator" .agents/skills/fray-keel-agent
```

The bundled validator imports PyYAML; run it with a Python environment that has
that package. PyYAML is a maintainer-check dependency, not a runtime dependency
of the installed skill or MCP.

The self-test initializes the local stdio server and checks tools, prompts, and
static resources without starting a wallet flow or changing chain state.

## Contract gates

The contracts are a separate checkout. From `keel-sdk`, the expected sibling is
`../keel-contracts`:

```bash
cd ../keel-contracts
pnpm install
pnpm build
pnpm test
pnpm format
pnpm size:check
pnpm test:catalog
```

`pnpm size:check` is a deployment gate, not a unit-test substitute. It scans
the nested production module tree and must remain red while any deployable
runtime exceeds EIP-170; do not narrow the path or add an allowlist merely to
hide an oversized contract.

Focused Forge suites make failures easy to label:

```bash
# OneMint stages, reservations, allowlists, signatures, payments, limits, close
forge test --match-path 'test/modules/keel-mint-access/OneMintController.t.sol' -vvv

# OneMint across dedicated/shared creator collections
forge test --match-path 'test/modules/keel-mint-access/OneMintCreatorCollections.t.sol' -vvv

# Generic public/gated/signed mint campaigns
forge test --match-path 'test/modules/keel-mint-access/KeelMintGate.t.sol' -vvv

# Fray unique/patron outcomes, cancellation, and authority
forge test --match-path 'test/modules/keel-mint-access/FrayAuctionIssuer.t.sol' -vvv

# Fixed listings, bids, escrow, cancellation, settlement, and withdrawals
forge test --match-path 'test/modules/keel-market/KeelMarket.t.sol' -vvv

# ERC-721 metadata, tokenURI, mint hooks, prepared 1/1, shell graph
forge test --match-path 'test/modules/keel-die/KEEL721.t.sol' -vvv

# Creator ERC-721/ERC-721A/ERC-1155 factories and capacity integration
forge test --match-path 'test/modules/keel-die/KeelCreatorFactory.t.sol' -vvv

# Native chunks, object welds, recursion, deduplication, and read bounds
forge test --match-path 'test/modules/keel-hold/KeelHold.t.sol' -vvv

# Deterministic token seeds and no-reroll guarantees
forge test --match-path 'test/modules/keel-artifacts/KeelSeedRegistry.t.sol' -vvv
```

Test-only collections and renderers stay under the contracts checkout's
`test/` tree and use synthetic names. A creator's real collection, release
media, or deployment fixture must not be copied into the SDK or module catalog.

The contracts checkout excludes `test/fork/*` by default. A fork test requires
an explicit public RPC and still is not a deployment:

```bash
forge test --match-contract LiveSettlementTest \
  --no-match-path 'test/nothing/*' \
  --fork-url <mainnet-rpc>
```

Run gas and ABI/update workflows only when their scope is intentional. Do not
update a snapshot just to make a regression disappear:

```bash
pnpm gas:check
pnpm gas:report
```

## Contract module boundary and catalog

From `keel-sdk`, validate the authoritative module map:

```bash
pnpm keel:check
pnpm keel:list
```

From `keel-contracts`, validate the recorded module catalog:

```bash
pnpm test:catalog
```

For independently published JavaScript modules, use the builder CLI:

```bash
pnpm exec keel module build --all --root ./keel-modules
pnpm exec keel module test --all --root ./keel-modules
pnpm exec keel module index --root ./keel-modules \
  --repository https://github.com/you/keel-modules
```

Indexing must be a deterministic no-op on the second run. `verified` means the
readable source reproduces the shipped bytes. `deployed` requires chain records
and is independent. To re-fetch and reproduce registered third-party origins,
run the separately networked gate:

```bash
pnpm exec keel module verify --all --root ./keel-modules
```

These forms resolve the checkout-local CLI. A separately installed CLI can use
the same commands without the `pnpm exec` prefix.

Read [The KEEL module pipeline](KEEL_MODULE_PIPELINE.md) and
[Module assurance](KEEL_MODULE_ASSURANCE.md) before recording or publishing a
module.

## Creative runtime checks

### p5

```bash
pnpm --dir examples/agent-p5-project test
pnpm build
```

This proves the local project declaration and SDK build. Staging additionally
requires receipt-backed same-chain p5 and seeded-random bindings; publication
additionally requires receipts/read-back; rendering additionally requires a
browser smoke.

### Three.js

```bash
pnpm test:browser
pnpm verify:three-one-of-one
```

The browser gate serves the r180 fixture under a network-denied policy and runs
its browser-only probe; the probe file is not a standalone Node program. The
container gate is an offline, review-only publication proof. Neither command
proves a public viewer or wallet action.

### Doom WASM

Start with the source and input requirements in
`examples/demos/doom-wasm/README.md`. The managed-publication regression also
requires a fresh local Anvil listener, compiled sibling contract artifacts, and
the exact accepted Brotli container as an explicit local input:

```bash
# In a separate terminal, start a disposable local chain.
anvil --port 8545

# Then compile and run the verifier from the SDK workspace.
pnpm contracts:compile
KEEL_DOOM_STORED_INPUT_PATH=/absolute/path/to/release-candidate.bin.br \
  pnpm verify:doom-managed-local
```

The command validates the container digest/header before writing it to the
local chain. It never fetches the container from a public RPC unless
`KEEL_DOOM_SOURCE_RPC_URL` is explicitly supplied. Anvil and Tezos mockup
receipts are local evidence. Large full-payload reads may use a deliberately
raised local call budget; that is not a production RPC gas claim.

### Flash AS3 / Ruffle

From the sibling `../flash-keel` checkout:

```bash
npm run verify
```

This is the local pinned gate for the compiled SWF, preview, selected modern
Ruffle runtime, and project plan. Do not regenerate the onchain shell merely to
verify it: generated escaping can drift from receipt-pinned shell bytes. Do not
claim a planned Ruffle/decoder module is published until its object and registry
receipts are read back. Local verification does not prove hosted Ruffle playback
or the public tokenURI.

## Canonical shell checks

Every collector-facing viewer must use the one registered canonical shell. No
test fixture, starter, Flash loader, p5 file, Three.js entrypoint, or Doom shell
is a replacement. Read [The KEEL verification shell](KEEL_VERIFICATION_SHELL.md)
for the exact implementation map and existing regression tests.

The readiness rule is simple:

1. resolve the active builder from the selected-chain Studio Inline catalog;
2. derive the canonical shell ID with the SDK;
3. read back the exact registered prefix, suffix, metadata, existence flag, and
   `PreEncodedGraph` mode;
4. fail closed if any piece is absent or ambiguous;
5. separately smoke the reconstructed viewer in a browser.

## Before a public test

- Local build and focused tests pass.
- Contract suite for the exact path passes.
- Required module source/output receipts and catalog entries match.
- Every selected-chain module binding has object and registry receipt/read-back.
- Storage and presentation mode are explicit and unchanged from the reviewed
  plan.
- Canonical shell registration is read back from the active builder.
- Wallet request names the chain, targets, values, operations, and approval
  boundary exactly.
- Durable recovery state is saved before submission.
- After submission, receipts, object/module reads, collection/drop state,
  tokenURI, and browser/runtime behavior are verified as separate gates.
