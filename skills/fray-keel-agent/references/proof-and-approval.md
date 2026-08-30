# Proof, approval, and recovery boundaries

Use the smallest evidence set that proves the requested claim, and name what it
does not prove.

| Evidence | Proves | Does not prove |
| --- | --- | --- |
| SDK/unit tests | deterministic local functions, schemas, and fail-closed behavior | Solidity behavior, browser rendering, deployment |
| Forge tests | EVM contract behavior in the test environment | public deployment, current RPC state, hosted UI |
| Module build/test/index | source-to-output receipt, vectors, deterministic catalog | chain publication or carrier availability |
| Browser/runtime smoke | actual rendering and console/runtime behavior for that URL/build | onchain receipts unless independently read back |
| Transaction receipt | one transaction was included and succeeded | complete object graph, tokenURI parity, browser playback |
| Contract read-back | addresses, object bytes/digests, tokenURI, state at a block | visual/browser behavior |

Require both receipt and read-back for a publication claim. Require browser
evidence for a viewer/playback claim. For a shared module, require object bytes,
digest/length, graph/library/review registration, and selected-chain binding;
a plan or predicted object ID is insufficient.

## Approval boundary

Before a wallet request, show the exact chain, target contracts, collection
lane, storage/presentation mode, object/module commitments, operation count,
estimated and quoted costs with timestamps, and what the wallet will approve.
Keep setup/publication gas separate from tokenURI/read gas.

MCP and the skill do not sign, submit, claim faucet funds, store private keys,
or treat a plan as approval. Prefer a supported wallet batch only when the
connected wallet advertises it; otherwise explain sequential approvals. Never
report a mint, auction, sale, or upload as complete without receipts and the
appropriate contract read-back.

## Testnet funding

Use `keel-chain-guide` to show human faucet links. The creator opens the page and
claims funds. Recheck wallet network and balance before preparing an approval.

## Recovery

For an existing managed job, match owner, executor, plan digest, chunk count,
operation count, cursor, durable journal, and receipts before retrying. Reconcile
a timed-out transaction before resubmitting, retain failed indexes, and never
repeat confirmed chunks or operations. Missing or conflicting recovery state is
a safe stop, not permission to open a new job or request another approval.

For details about native carriers and experimental storage routes, read
[publication-modes.md](publication-modes.md).
