# `@keel/ethereum-adapter`

The upload-plan and preflight APIs in this package are offline, unsigned
adapters for the Keel `KeelHold` contract. They verify a materialized
upload plan against supplied chunk bytes, derive chunk/object IDs only through
injected Keccak/ABI codecs, and emit deterministic calldata descriptors. Those
APIs never use RPC, a wallet, a signer, or chain state.

Applications can inject the small codec interface (`keccak256`,
`encodeAbiParameters`, `encodeFunctionData`, and `validateFunctionData`) or use the tested
`createViemEthereumAdapterCodecs()` bridge shipped by this package. The bridge
uses the real viem ABI parser/encoder and the canonical `@keel/sdk` KeelHold
ABI. Missing codecs, compressed bytes without a decompressor, Tezos targets,
and mismatched bytes return a structured `deferred` result.

Compressed plans require an injected decompressor. The adapter checks each
decoded commitment and enforces a 256 MiB cumulative retained-byte budget; a
decompressor supplied by an application should enforce its own output limit
before allocating a large result.

The upload-plan/preflight APIs do not connect to RPC, simulate, sign, submit, or
create a WalletConnect/Beacon payload. Large
`castSlugs` calls exceed the SDK's custom QR budget and are reported as a
transport limitation rather than silently encoded as a QR request.

`createViemKeelFactoryConnectors` is the optional viem/Wagmi bridge for the
KeelFactory executor. Pass it two injected wallet clients (`accountClient` for
the creator's EIP-712 signature and `agentClient` for the linked submitter) and
one injected viem `publicClient`; it creates no transport and stores no keys.
The bridge normalizes viem receipts, chain timestamps, factory reads, and the
`chainId`-bound send request for `executeKeelFactoryCollection`.

## KeelFactory collection review

`normalizeKeelFactoryCollectionConfig` and `createKeelFactoryConfigDigest` accept
the complete JSON-safe `KeelFactory.CollectionConfig` tuple and reproduce the
contract's `keccak256(abi.encode(...))` digest with viem. A wallet-link
connector can compare that digest to its pinned target before showing account
signable typed data. The helper is local-only and never reads factory state or
signs.

## Read-only preflight and receipts

`preflightEthereumKeelHoldOperations(result, client)` accepts a successful
adapter result and a tiny injected read-only client (`getCode` plus
`readContract`). It checks deployed bytecode, chunk pointers, and composite
object existence without importing an RPC client or making a transport
decision; its local descriptor gate also re-decodes and re-encodes calldata
against the canonical viem KeelHold ABI and recomputes chunk/object IDs from
the operation bytes plus the explicit `storedByteLength` commitments. A preflight result is always `chainReady: false`; an unavailable
client, missing contract, malformed adapter descriptor, or missing chunk is a
structured failure. Missing pointers are reported as blocked existing-state
dependencies even when the unsigned plan contains a preceding `castSlugs` call;
the preflight does not pretend that an unsubmitted transaction has changed chain
state.

`verifyEthereumKeelHoldReceipts(result, receipts)` validates a local receipt
array's shape and positional operation bindings (operation ID, chain ID, and
target address). It does not fetch logs/state and does not prove inclusion or
finality. Both APIs explicitly report `signing: "not-performed"` and
`submission: "not-performed"`; a wallet, Ledger, WalletConnect, QR, or RPC
transport must remain a separate review gate.

## KeelFactory execution boundary

`executeKeelFactoryCollection` is the explicit, opt-in connector for the
account/agent wallet link. It accepts a verified `keel-wallet-link@1` plus
the normalized `KeelFactory.CollectionConfig`, and uses only injected
interfaces:

- `accountSigner` signs the exact `CollectionAuthorization` EIP-712 payload;
- `agentWallet` submits `castDieFor` from the linked agent address;
- `publicClient` supplies chain ID/timestamp, pinned factory reads, and the
  receipt.

Execute mode also requires an externally trusted `trustedDeployment` pin for
the expected chain, factory address, `FACTORY_VERSION`, and collection creation
code hash. The link's SHA-256 integrity is not an authorization proof.

The default mode is `dry-run`; it makes no connector calls and returns the
typed data plus unsigned calldata. `mode: "execute"` is the only path that can
sign or submit. Before signing it checks the linked account/agent identities,
chain IDs, on-chain factory version and collection creation-code hash, current
creator nonce, and chain deadline. It rechecks the nonce after signing, then
requires a successful receipt targeted at the pinned factory with matching
`DieCast` and `DieCastByAgent` events, config/admin/name/
symbol/max-supply fields, and the exact EIP-712 authorization digest.

Send and receipt uncertainty return `submission-unknown`/`receipt-unknown` and
are never retried automatically. A verified execution reports
`chainReady: true`, `signing: "performed"`, and `submission: "performed"`;
review and deferred results never claim those states. No private key, default
RPC transport, or MCP execution tool is provided. Callers must still pin the
factory commitments from a trusted deployment catalog before presenting the
typed data for approval.

The Sepolia proof deployment uses the size-bounded pair from
`@keel/contracts`: factory
`0x31f3689c7d5f1a322b7920b1bc452d4fb15713bd`, collection deployer
`0x3fff1caff8ea451f34a63ae262f76caf14b0d12d`, and agent
`0x1bF2d0B339b5850F88eCe7b14a2497c3Dc821C90`. The creator account
`0x404A6bd65EF48AE85Da7b0E9358715a34A401b05` signed one exact authorization;
the agent submitted it and produced collection
`0x5856e050e7f1eF7b6C941774BC9dd8f513dA3573` in transaction
`0x0fe02b5354d51d03488738da544c299086b3d10f43dd367fcaf61c0f9595b77f`.
This is a Sepolia proof record, not a mainnet deployment or a substitute for
the trusted deployment catalog. The local receipt manifest is ignored at
`apps/studio/.data/keel-factory-agent-sepolia/deployment.json`.

For a local end-to-end proof (deploy, account sign, agent submit, receipt
verification, replay rejection, and creator nonce invalidation), run:

```sh
pnpm keel:local:e2e
```

It starts a disposable Anvil instance with the code-size limit disabled for
the current KeelFactory build, then terminates it. No remote chain or browser
wallet is touched. The Studio `/launch/agent` surface is review-first: the
creator may sign the one-shot payload, while an agent executor remains a
separate explicit step. Its status panel reads the creator nonce and durable
`DieCastByAgent` receipts, and the creator can invalidate the current
nonce without exposing an account key to the agent.

Execute mode also requires the injected public client to simulate the exact
signed `castDieFor` calldata before the agent wallet may submit it.
The contract validates the creator signature, so this simulation necessarily
follows the account signature, but a rejected simulation returns
`simulation-rejected` and no transaction is sent.
