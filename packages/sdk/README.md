# `@keel/sdk`

Framework-neutral types, validation, ABIs, and EIP-712 helpers for the Keel contracts. The package deliberately does not depend on a wallet stack; its output can be passed to viem, ethers, wagmi, a relayer, or a smart-account client.

## Choose Inline, Hybrid, or IPFS without changing storage

KEEL uses a small uncompressed **boot shell** plus a digest-bound **resource
graph**. Heavy child scripts, modules, assets, and data may be Brotli/Gzip/
Deflate-compressed; the committed browser/WASM decoder expands them only after
their stored bytes verify. The Solidity builder does not decompress Brotli.
Gzip/Deflate use a capability-checked browser decoder path; Brotli uses an
exact declared KEEL decoder module, normally the reusable thin WASM module
published once per chain. Creator plans reference that module and must not
carry another copy.

For Node-side publication planning, `@keel/sdk/inline-viewer-graph` builds the
once-per-chain Gzip shell/module fragments and the creator's ordered composite
root. It reports creator publication bytes separately and rejects a shared
fragment that is missing from the selected chain/store.

- **Inline** means `animation_url` is the complete onchain-assembled
  `data:text/html` document. It has no gateway, IPFS, `/content`, or RPC fetch.
- **Hybrid** can still be entirely native KEEL storage. Its boot shell resolves
  exact onchain objects through an RPC reader.
- **IPFS** is an explicit external delivery selection and is never inferred
  from Hybrid.

Use `assessKeelInlinePresentation` from `@keel/sdk/presentation` before wallet
review. It enforces the uncompressed root, 2 MB reconstruction ceiling,
self-contained document, and configured-builder boundary. The exact builder
read must also pass the 30M-gas public-RPC safety check. See
[`docs/KEEL_PRESENTATION.md`](../../docs/KEEL_PRESENTATION.md) for the complete
contract and SDK terminology.

## Stage creator projects without manufacturing a shell

`stageKeelStudioProject` treats an omitted `viewer` as the canonical KEEL Inline
graph selector (`keel-verification-shell`) and sends the existing canonical
publication intent. `viewer: "none"` is the explicit artifact/storage-only
opt-out and suppresses that intent. During later Studio preparation, the
selected chain resolves the catalog-backed, pre-encoded Inline graph and must
fail closed if that catalog is incomplete. Agents may stage only creator
resources and modules; they must never manufacture or upload a local file
declared as the default KEEL shell, a protected-harness wrapper, or a local
replacement wrapper when catalog resolution fails. A creator-authored HTML file
is ordinary project content, not a replacement shell.

For one standalone image, video, or self-contained GLB, the canonical Inline
composition is fixed: registered `keel-verification-shell`, registered
`keel.asset-display@1`, then the direct creator media entrypoint. It is never a
zero-module project and never writes a creator `index.html` wrapper. Use
`buildKeelInlineNormalMediaDocument` to prepare that graph and
`buildKeelRegisteredInlineNormalMediaTokenURIGraph` only after the selected
chain supplies the exact shell-prefix, asset-display, and shell-suffix objects.
The display module renders image and video data URLs and a self-contained GLB
with WebGL; it has no network or wallet authority. AVIF and WebP entries are
decoded onto their intrinsic-size canvas so a collector can right-click and
save a PNG without adding a project-specific viewer.

## Discover a Studio before uploading

`fetchStudioCapabilities` reads the non-mutating
`/.well-known/keel-capabilities` document and rejects unknown fields or
unsupported protocol versions. Use it before sending source bytes or opening a
wallet so a client can distinguish a ready chain from a selectable but blocked
one and can see the Studio's real staging, sandbox, quote, and MSP boundaries:

```ts
import { fetchStudioCapabilities } from "@keel/sdk";

const capabilities = await fetchStudioCapabilities("https://studio.example");
const sepolia = capabilities.chains.find((chain) => chain.network === "sepolia");
if (sepolia?.status !== "ready") throw new Error(sepolia?.reason ?? "Sepolia is unavailable");
```

## Build a campaign safely

```ts
import {
  buildCampaign,
  createMintAuthorizationTypedData,
  SignatureMode,
} from "@keel/sdk";

const campaign = buildCampaign({
  target: collection,
  payout: treasury,
  maxSupply: 2_000n,
  maxPerWallet: 3n,
  unitPrice: 10_000_000_000_000_000n,
  creatorSigner,
  signatureMode: SignatureMode.Either,
});

const typedData = createMintAuthorizationTypedData(chainId, manager, {
  campaignId,
  account,
  signer: creatorSigner,
  maxQuantity: 3n,
  unitPrice: campaign.unitPrice,
  nonce: 0n,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 3_600),
});
```

The SDK normalizes addresses and hex, validates enum values, enforces Solidity ABI widths, rejects unsafe JavaScript numbers, checks signer/gate consistency, and caps custom-gate configuration to the on-chain limit. Use `bigint` for quantities, prices, timestamps, IDs, and nonces.

## One wallet request for ETH, Tezos, and QR transports

`createKeelWalletRequest` creates a canonical, digest-bound transaction intent
for either Ethereum or Tezos. It does not connect to a wallet or submit a
transaction. The same envelope can be handed to an injected/wagmi adapter,
Ledger-backed browser wallet, TezConnect adapter, encrypted local signer, or a
QR renderer:

```ts
import { createKeelWalletRequest, encodeKeelWalletRequestQr } from "@keel/sdk";

const request = await createKeelWalletRequest({
  protocol: "keel-wallet-request@1",
  requestId: "manifest-claim-001",
  label: "Publish the verified manifest",
  family: "ethereum",
  chainId: 1,
  to: registry,
  data: calldata,
  valueWei: "0",
  transport: "ledger",
});
const qrValue = await encodeKeelWalletRequestQr(request);
```

The request and its SHA-256 integrity are normalized before encoding; tampered
QR payloads fail verification. Connector implementations remain application
boundaries and must show the request to the user before signing. Tezos
parameters are bounded, canonical Micheline JSON, and transport hints are
family-checked (`tezconnect` for Tezos, injected for Ethereum).

## Bind Fray auction economics before Studio or wallet review

`materializeFrayAuctionIntent` resolves a versioned Fray policy into one full
economic object. It carries the source SHA-256, exact chain, native atomic unit,
reserve, bid increment, timing, royalties, patron caps, edition size, pricing
mode, and extension rules. `createFrayAuctionIntent` then commits those fields
to an RFC 8785 / SHA-256 envelope:

```ts
import {
  createFrayAuctionIntent,
  materializeFrayAuctionIntent,
} from "@keel/sdk";

const intent = materializeFrayAuctionIntent({
  source: {
    algorithm: "sha256",
    digest: sourceSha256,
    byteLength: sourceBytes.byteLength,
  },
  family: "ethereum",
  network: "sepolia",
  chainId: 11_155_111,
  presetId: 2,
});
const envelope = await createFrayAuctionIntent(intent);
```

Money is canonical integer text in `wei` or `mutez`; floating-point values are
never hashed or passed as authority. Preset IDs and labels are presentation
only. Handoffs, Studio review, quotes, and wallet authorization must carry and
verify the complete envelope. A preset whose terms do not match
`fray-auction-policy@1`, a mixed chain/currency, an altered source, or any
changed economic field fails closed. The v1 profiles preserve the current Fray
Studio execution values for both Ethereum and Tezos rather than the previously
divergent MCP descriptions.

## Batch wallet intents

`createKeelWalletIntentPlan` turns strict, ready-for-review Ethereum adapter
operations into one deterministic envelope containing one normalized wallet
request per operation. It binds the adapter source plan digest, requires one
chain and target, preserves operation order, and reports `chainReady: false`,
`signing: "not-performed"`, and `submission: "not-performed"`. The batch never
signs, submits, calls RPC, or emits a QR payload; its QR field is an explicit
unsupported/size caveat. Tezos inputs return `tezos-adapter-required`, and
`tezconnect` on Ethereum returns `transport-mismatch`. Use
`verifyKeelWalletIntentPlan` before handing individual requests to a
connector. The creator must inject the adapter's canonical ABI validator as
`validateCalldata` (for example a viem decode/re-encode function) plus the
adapter's full `validateAdapterOperation` receipt/graph check; without either
proof the SDK returns `adapter-validation-required` and does not produce wallet
requests. The SDK remains viem-free and never derives object IDs, signs, calls
RPC, or submits.

## Link an account wallet to an agent for collection creation

`createKeelWalletLink` creates a review-only, digest-bound authorization
envelope for the exact `KeelFactory.castDieFor` operation. The target
pins the Ethereum chain, factory deployment/version hashes, the
`keel-factory-config-keccak@1` configuration digest encoding, and the creator's
on-chain authorization nonce. Only bounded preparation/read/request scopes and
`create-collection` are accepted; signing and submission scopes are rejected.
Links expire within 30 days, carry an explicit revocation nonce and rotation
sequence, and never transfer custody or auto-approve an agent. Tezos returns a
contract-specific adapter deferral.

The envelope's revocation field is review metadata, not an on-chain revocation
authority. To revoke an unused authorization on the deployed factory, the
account must call `invalidateCreatorNonce(nextNonce)` and use a fresh nonce for
future links. Connectors must suppress typed-data output for links marked
revoked or expired and require the account's current nonce/explicit approval.

The account wallet can review/sign the exact EIP-712 payload from
`createCollectionAuthorizationTypedData`; the helper only returns typed data:

```ts
const typedData = createCollectionAuthorizationTypedData(chainId, factory, {
  creator: account,
  agent,
  nonce: 0n,
  deadline,
  configDigest, // KeelFactory.dieConfigDigest(config)
});
```

The standalone SDK link envelope carries the target's `configDigest` but does
not invent or fetch a `CollectionConfig`; callers must bind an external,
verified KeelFactory config receipt before presenting it for account signature.

`verifyKeelWalletLink` checks canonical integrity, expiry, not-yet-valid
windows, revocation, and deployment/config bindings. It does not sign, call
RPC, or mutate the factory; a future connector must still require the account's
explicit signature and display the full target before submitting.

## Bind a chain descriptor to a review envelope

`createKeelPublishReviewPlan` accepts the verified, deferred descriptor
returned by the offline MCP `chain-plan` tool and produces a canonical
`keel-publish-plan@1` envelope. It binds the source commitment,
Ethereum target, operation shapes, and SHA-256 envelope integrity while keeping
`chainReady: false`, `signing: "not-performed"`, and
`submission: "not-performed"`. It intentionally does not derive Keccak IDs,
encode ABI calldata, perform Tezos packing, query a chain, or expose a private
key. Use `verifyKeelPublishReviewPlan` before handing the envelope to a
future contract-specific adapter; generic Tezos descriptors fail closed until
that adapter exists. Its `identifierSemantics` field makes clear that builder
logical IDs are not chain IDs, and local source paths are deliberately omitted
from the committed summary; adapters must bind their own workspace and
recompute byte/receipt proofs.

## Authorization semantics

The signed message binds:

- chain ID and manager through the EIP-712 domain;
- campaign ID, recipient account, and signer;
- cumulative maximum quantity;
- signed unit price;
- account/campaign nonce and deadline;
- optional context hash over mint/custom-gate payloads.

Creator signatures carry no protocol signer fee. Platform signatures are optional and are charged only when the accepted signer is the campaign's snapshotted platform signer.

A partially consumed authorization may be reused until its maximum quantity is reached, but only **one authorization digest can be active for a given account/campaign nonce**. The account can invalidate that nonce on-chain to cancel the remaining authorization. Use a fresh nonce whenever price, allowance, signer, deadline, or context changes.

The matching contract uses OpenZeppelin `SignatureChecker`, preserving EOA and ERC-1271 smart-wallet support.

## Build one ordered OneMint drop

```ts
import { OneMintStageKind, buildOneMintDrop } from "@keel/sdk";

const drop = buildOneMintDrop({
  target: creatorOwnedCollection,
  payout: creatorTreasury,
  supply: 1_000n,
  maxPerTransaction: 3n,
  maxPerWallet: 5n,
  metadataDigest: releaseDigest,
  stages: [
    {
      kind: OneMintStageKind.Public,
      startTime: 1_800_000_000n,
      endTime: 1_800_604_800n,
      unitPrice: 10_000_000_000_000_000n,
      metadataDigest: publicStageDigest,
    },
  ],
});
```

`buildOneMintDrop` mirrors `OneMintController.createDrop`: it rejects unsupported
legacy stage modes, non-contiguous schedules, disconnected signer/claim/payment
fields, invalid ABI widths, and stage limits that exceed the one shared drop
allocation. It returns immutable ABI-ready values. Use
`normalizeOneMintPerTokenMintData` to validate the Keel pre-receiver hook's
single-token, empty-batch, or exact per-token batch framing before encoding it
with the wallet library of your choice.

`OneMintStageKind.Public` is the signerless, open-for-all route. Signature-gated
stages continue to use the EIP-712 `allowlistMint` path. For a Merkle stage, use
`OneMintStageKind.Merkle`, create the drop with a zero signer, attach the root
onchain with `setStageMerkleRoot`, and have the wallet call `merkleMint` with its
allowance and proof. The contract records consumed Merkle allowance per wallet
and emits the root update so an indexer can rebuild the access state.

### ERC-1155 item drops and creator collections

`buildOneMintItemDrop` mirrors `OneMintController.createItemDrop`. It commits
the ERC-1155 item id in the reviewed operation, so collector `mintData` cannot
redirect a purchase to another item.

Use `buildKeelCreator721Config` or `buildKeelCreator1155Config` before encoding
a `KeelCreatorFactory` call. Both builders validate UTF-8 bounds, metadata
digests, royalties, and integer widths. Shared ERC-1155 token ids are
deterministic:

Factory deployment is a separate release step: deploy the ERC-721A, standard
ERC-721, and ERC-1155 implementations first, then pass those addresses with the
mint manager and renderer to the factory constructor. The generated
`KeelCreatorFactory` ABI contains that exact five-address constructor. Collection
wallet builders call an already deployed, read-back-verified factory; they do
not deploy or choose its implementations.

```ts
import {
  keelSharedCollectionIdOf,
  keelSharedItemIndexOf,
  keelSharedTokenId,
} from "@keel/sdk";

const tokenId = keelSharedTokenId(logicalCollectionId, itemIndex);
keelSharedCollectionIdOf(tokenId); // high 128 bits
keelSharedItemIndexOf(tokenId);    // low 128 bits
```

For an agent-assisted collection, use
`prepareKeelCreatorCollectionWalletReview`. It resolves one exact factory and
renderer pair from the generated chain registry, returns one review-only
EIP-5792 `wallet_sendCalls` request, and returns the durable operation envelope
that Studio must save before submission. The envelope explicitly tracks the
plan digest, cursor, receipts, completed and failed indexes, and read-back; a
timeout must be reconciled before another approval is allowed. Missing or
ambiguous deployments return `blocked` and no wallet request.

The creator token contract is only the ownership/supply shell. `tokenURI`,
ERC-1155 `uri`, and `contractURI` delegate to the shared KEEL renderer. The
verification shell, p5, gzip loader, and other reusable modules are not copied
into every creator collection or item; only project-specific object bindings
belong to the work. A complete inline `animation_url` may still be returned at
read time without duplicating those shared module bytes in token storage.

## Cool S release-readiness surface

The SDK exports the creator-owned Cool S shell, visual registry, target table,
metadata renderer, one-use duplicator, Inventory child Reader/Reservation
Engine, and reservable Vault supply ABIs. `COOL_S_DUPLICATOR_SLOT_V1` is `6`.
`coolSEquipmentSupplyRolesReady` accepts only candidate supplies where the
child Reservation Engine has both `MINTER_ROLE` and `RESERVER_ROLE` and the
parent Inventory has neither.

Phase 1 also exports the immutable Inventory descriptor-validator ABI and the
canonical five-field `equipmentDescriptor(uint256)` Vault surface (ERC-165 ID
`0x405b502e`). `coolSEquipmentDescriptorReady` requires the advertised
interface, a tuple matching the Inventory definition, and equality between
`definitionDescriptorCommitment` and the Inventory-computed descriptor-bound
commitment. Reservation Engine `policy(slot)` includes the materializer runtime
code hash and the SDK exposes `materializerRuntimeCodeHash(slot)` for direct
cross-checking.

`COOL_S_ENTROPY_PROOF_STATUS` is deliberately `g0-unproven`; it is not a
future-block, VRF, or fair-randomness claim. Linked-library deployment records
use `CoolSLinkedLibraryDeployment` for `KeelHarnessContextDispatch`,
`KeelCollectionFreezeValidation`, and
`KeelMintBoundEquipmentProvision`. Library addresses remain deployment
evidence, not shell getter facts.
