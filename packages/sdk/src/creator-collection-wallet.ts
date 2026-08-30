import { canonicalJson } from "@keel/protocol";
import {
  encodeFunctionData,
  keccak256,
  numberToHex,
  parseAbi,
  stringToHex,
  type Address,
  type Hex,
} from "viem";

import {
  buildKeelCreatorCollectionCall,
  configuredKeelCreatorDeployment,
  keelSharedTokenId,
  resolveKeelCreatorDeploymentRecords,
  type KeelCreator1155ConfigInput,
  type KeelCreator721ConfigInput,
  type KeelCreatorCollectionCallInput,
  type KeelCreatorCollectionOperation,
  type KeelCreatorDeploymentPair,
  type KeelCreatorDeploymentRecord,
} from "./creator-collections.js";
import { ZERO_ADDRESS } from "./types.js";
import { normalizedAddress, uint, UINT128_MAX } from "./validation.js";

/** Review-only protocol for a creator collection wallet batch. */
export const KEEL_CREATOR_COLLECTION_WALLET_PROTOCOL = "keel.creator-collection-wallet@1" as const;
export const KEEL_CREATOR_OPERATION_PROTOCOL = "keel.creator-operation@1" as const;
export const KEEL_CREATOR_ITEM_WALLET_PROTOCOL = "keel.creator-item-wallet@1" as const;

const ZERO = ZERO_ADDRESS as Address;
const BYTES32 = /^0x[0-9a-f]{64}$/u;
const HASH = /^0x[0-9a-f]{64}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

const CREATOR_FACTORY_ABI = parseAbi([
  "function createERC721((string name,string symbol,uint256 maxSupply,address royaltyReceiver,uint96 royaltyBps,bytes32 metadataDigest) config) returns (uint256 collectionId,address tokenContract)",
  "function createStandardERC721((string name,string symbol,uint256 maxSupply,address royaltyReceiver,uint96 royaltyBps,bytes32 metadataDigest) config) returns (uint256 collectionId,address tokenContract)",
  "function createERC1155((string name,string symbol,address royaltyReceiver,uint96 royaltyBps,bytes32 metadataDigest) config) returns (uint256 collectionId,address tokenContract)",
  "function createSharedERC1155(string name_,bytes32 metadataDigest) returns (uint256 collectionId,uint128 sharedCollectionId)",
  "function registerExternalCollection(address tokenContract,string name_,bytes32 metadataDigest) returns (uint256 collectionId)",
]);

const DEDICATED_1155_ABI = parseAbi([
  "function createItem(uint128 maxSupply_) returns (uint256 tokenId)",
  "function announceMetadataURI(uint256 tokenId)",
]);

const SHARED_1155_ABI = parseAbi([
  "function createItem(uint128 collectionId,uint128 maxSupply_,address royaltyReceiver,uint96 royaltyBps) returns (uint256 tokenId)",
  "function announceMetadataURI(uint256 tokenId)",
]);

type CollectionCall = ReturnType<typeof buildKeelCreatorCollectionCall>;

export type KeelCreatorFactoryCollectionCall = CollectionCall & {
  readonly data: Hex;
};

export type KeelCreatorFactoryCallInput = KeelCreatorCollectionCallInput;
export type KeelCreatorFactoryCallBuilderInput = Omit<KeelCreatorCollectionCallInput, "operation">;

export interface KeelCreatorWalletCall {
  readonly to: Address;
  readonly data: Hex;
  /** EIP-5792 hex quantity. Creator collection calls never transfer ETH. */
  readonly value: Hex;
}

export interface KeelCreatorWalletSendCalls {
  readonly method: "wallet_sendCalls";
  readonly params: readonly [{
    readonly version: "1.0";
    readonly chainId: Hex;
    readonly from: Address;
    readonly calls: readonly KeelCreatorWalletCall[];
  }];
}

export interface KeelCreatorCollectionWalletBatch {
  readonly schema: typeof KEEL_CREATOR_COLLECTION_WALLET_PROTOCOL;
  readonly status: "review-only";
  readonly chainId: number;
  readonly owner: Address;
  readonly creator: Address;
  /** Direct EIP-5792 uses the creator wallet as executor. */
  readonly executor: Address;
  readonly factoryAddress: Address;
  readonly rendererAddress: Address;
  readonly creatorNonce: string;
  readonly planDigest: Hex;
  readonly chunkCount: number;
  readonly operationCount: number;
  readonly cursor: 0;
  readonly calls: readonly KeelCreatorWalletCall[];
  readonly factoryCall: KeelCreatorFactoryCollectionCall;
  readonly walletRequest: KeelCreatorWalletSendCalls;
  readonly walletApproval: "one-wallet-approval";
  readonly signing: "not-performed";
  readonly submission: "not-performed";
  readonly consequence: string;
}

export interface KeelCreatorCollectionWalletBatchInput {
  readonly chainId: number;
  readonly creator: Address;
  readonly executor?: Address;
  readonly deployment: KeelCreatorDeploymentPair;
  readonly creatorNonce: bigint | number | string;
  readonly operation: KeelCreatorCollectionOperation;
  /** A future multi-call extension may add dependent operations. */
  readonly operationCount?: number;
}

export interface KeelCreatorCollectionWalletReviewInput {
  readonly chainId: number;
  readonly creator: Address;
  readonly executor?: Address;
  readonly instance?: string;
  readonly creatorNonce: bigint | number | string;
  readonly operation: KeelCreatorCollectionOperation;
  readonly operationId?: string;
  readonly now?: number;
}

function positiveChainId(value: number, label = "chainId"): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive safe integer.`);
  return value;
}

function address(value: Address, label: string): Address {
  const result = normalizedAddress(value, ZERO, label);
  if (result === ZERO) throw new TypeError(`${label} cannot be zero.`);
  return result;
}

function decimal(value: bigint | number | string, label: string): string {
  if (typeof value === "string" && !DECIMAL.test(value)) throw new TypeError(`${label} must be canonical decimal text.`);
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
  let result: bigint;
  try {
    result = BigInt(value);
  } catch {
    throw new TypeError(`${label} must be an unsigned integer.`);
  }
  if (result < 0n) throw new RangeError(`${label} cannot be negative.`);
  return result.toString();
}

function boundedUint128(value: bigint | number | string, label: string): bigint {
  const canonical = decimal(value, label);
  return uint(BigInt(canonical), 0n, label, UINT128_MAX);
}

function encodeFactoryCall(call: CollectionCall): Hex {
  return encodeFunctionData({
    abi: CREATOR_FACTORY_ABI,
    functionName: call.functionName,
    args: call.arguments as never,
  });
}

function encodedFactoryCall(input: KeelCreatorFactoryCallBuilderInput, operation: KeelCreatorCollectionOperation): KeelCreatorFactoryCollectionCall {
  const review = buildKeelCreatorCollectionCall({ ...input, operation });
  return Object.freeze({ ...review, data: encodeFactoryCall(review) });
}

/** Builds the default ERC-721A lane. It never signs or submits. */
export function buildKeelCreatorERC721ACall(input: KeelCreatorFactoryCallBuilderInput & { readonly config: KeelCreator721ConfigInput }): KeelCreatorFactoryCollectionCall {
  return encodedFactoryCall(input, { kind: "dedicated-erc721", config: input.config });
}

/** Builds the conventional standard ERC-721 compatibility lane. */
export function buildKeelCreatorStandardERC721Call(input: KeelCreatorFactoryCallBuilderInput & { readonly config: KeelCreator721ConfigInput }): KeelCreatorFactoryCollectionCall {
  return encodedFactoryCall(input, { kind: "dedicated-erc721", implementation: "erc721", config: input.config });
}

/** Alias with the contract's default method name for callers that do not care about the implementation label. */
export function buildKeelCreatorERC721Call(input: KeelCreatorFactoryCallBuilderInput & { readonly config: KeelCreator721ConfigInput }): KeelCreatorFactoryCollectionCall {
  return buildKeelCreatorERC721ACall(input);
}

/** Builds a dedicated creator-owned ERC-1155 collection call. */
export function buildKeelCreatorERC1155Call(input: KeelCreatorFactoryCallBuilderInput & { readonly config: KeelCreator1155ConfigInput }): KeelCreatorFactoryCollectionCall {
  return encodedFactoryCall(input, { kind: "dedicated-erc1155", config: input.config });
}

/** Builds a logical collection in the shared ERC-1155 namespace. */
export function buildKeelCreatorSharedERC1155Call(input: KeelCreatorFactoryCallBuilderInput & { readonly name: string; readonly metadataDigest: Hex }): KeelCreatorFactoryCollectionCall {
  return encodedFactoryCall(input, { kind: "shared-erc1155", name: input.name, metadataDigest: input.metadataDigest });
}

/** Builds a directory registration call for a creator-controlled external collection. */
export function buildKeelCreatorBYORegistrationCall(input: KeelCreatorFactoryCallBuilderInput & { readonly tokenContract: Address; readonly name: string; readonly metadataDigest: Hex }): KeelCreatorFactoryCollectionCall {
  return encodedFactoryCall(input, { kind: "external", tokenContract: input.tokenContract, name: input.name, metadataDigest: input.metadataDigest });
}

/** Builds any supported factory call while preserving the SDK's canonical validation. */
export function buildKeelCreatorFactoryCall(input: KeelCreatorFactoryCallInput): KeelCreatorFactoryCollectionCall {
  return encodedFactoryCall(input, input.operation);
}

function freezeCalls(calls: readonly KeelCreatorWalletCall[]): readonly KeelCreatorWalletCall[] {
  return Object.freeze(calls.map((call) => Object.freeze({ ...call })));
}

function creatorCollectionPlan(input: {
  readonly chainId: number;
  readonly owner: Address;
  readonly creator: Address;
  readonly executor: Address;
  readonly factoryAddress: Address;
  readonly rendererAddress: Address;
  readonly creatorNonce: string;
  readonly operationCount: number;
  readonly chunkCount: number;
  readonly calls: readonly KeelCreatorWalletCall[];
  readonly factoryCall: KeelCreatorFactoryCollectionCall;
}) {
  return Object.freeze({ schema: KEEL_CREATOR_COLLECTION_WALLET_PROTOCOL, ...input });
}

function creatorCollectionPlanDigest(input: Parameters<typeof creatorCollectionPlan>[0]): Hex {
  return keccak256(stringToHex(canonicalJson(creatorCollectionPlan(input))));
}

/**
 * Creates exactly one EIP-5792 wallet request for a creator collection.
 * The factory call is the only call in this first phase; item/metadata work
 * is deliberately represented as a separate dependent plan because a newly
 * created clone address and item id must be read back before they are used.
 */
export function buildKeelCreatorCollectionWalletBatch(input: KeelCreatorCollectionWalletBatchInput): KeelCreatorCollectionWalletBatch {
  const chainId = positiveChainId(input.chainId);
  if (input.deployment.chainId !== chainId) throw new TypeError("The deployment chain does not match the wallet batch chain.");
  const creator = address(input.creator, "creator");
  const executor = address(input.executor ?? creator, "executor");
  const factoryAddress = address(input.deployment.factoryAddress, "factoryAddress");
  const rendererAddress = address(input.deployment.rendererAddress, "rendererAddress");
  const creatorNonce = decimal(input.creatorNonce, "creatorNonce");
  const operationCount = input.operationCount ?? 1;
  if (operationCount !== 1) throw new RangeError("The creator collection batch currently contains exactly one factory operation.");
  const factoryCall = buildKeelCreatorFactoryCall({
    chainId,
    creator,
    factoryAddress,
    operation: input.operation,
  });
  const calls = freezeCalls([{ to: factoryAddress, data: factoryCall.data, value: "0x0" }]);
  const plan = creatorCollectionPlan({
    chainId,
    owner: creator,
    creator,
    executor,
    factoryAddress,
    rendererAddress,
    creatorNonce,
    operationCount,
    chunkCount: calls.length,
    calls,
    factoryCall,
  });
  const planDigest = creatorCollectionPlanDigest(plan);
  const walletRequest: KeelCreatorWalletSendCalls = {
    method: "wallet_sendCalls",
    params: [{
      version: "1.0",
      chainId: numberToHex(BigInt(chainId)),
      from: creator,
      calls,
    }],
  };
  return Object.freeze({
    schema: KEEL_CREATOR_COLLECTION_WALLET_PROTOCOL,
    status: "review-only",
    chainId,
    owner: creator,
    creator,
    executor,
    factoryAddress,
    rendererAddress,
    creatorNonce,
    planDigest,
    chunkCount: calls.length,
    operationCount,
    cursor: 0,
    calls,
    factoryCall,
    walletRequest,
    walletApproval: "one-wallet-approval",
    signing: "not-performed",
    submission: "not-performed",
    consequence: "Creates one creator collection directory record; it does not mint an item or create a sale.",
  });
}

export interface KeelCreatorMetadataAnnouncementCall {
  readonly schema: typeof KEEL_CREATOR_ITEM_WALLET_PROTOCOL;
  readonly status: "review-only";
  readonly chainId: number;
  readonly from: Address;
  readonly to: Address;
  readonly tokenId: string;
  readonly call: KeelCreatorWalletCall;
  readonly walletApproval: "one-wallet-approval";
  readonly signing: "not-performed";
  readonly submission: "not-performed";
}

/** Builds the post-binding announcement call once the exact item id is known. */
export function buildKeelCreatorMetadataAnnouncementCall(input: {
  readonly chainId: number;
  readonly creator: Address;
  readonly collectionAddress: Address;
  readonly tokenId: bigint | number | string;
}): KeelCreatorMetadataAnnouncementCall {
  const chainId = positiveChainId(input.chainId);
  const from = address(input.creator, "creator");
  const to = address(input.collectionAddress, "collectionAddress");
  const tokenId = decimal(input.tokenId, "tokenId");
  const data = encodeFunctionData({ abi: DEDICATED_1155_ABI, functionName: "announceMetadataURI", args: [BigInt(tokenId)] });
  return Object.freeze({
    schema: KEEL_CREATOR_ITEM_WALLET_PROTOCOL,
    status: "review-only",
    chainId,
    from,
    to,
    tokenId,
    call: Object.freeze({ to, data, value: "0x0" }),
    walletApproval: "one-wallet-approval",
    signing: "not-performed",
    submission: "not-performed",
  });
}

export interface KeelCreator1155ItemBindingPlan {
  readonly schema: typeof KEEL_CREATOR_ITEM_WALLET_PROTOCOL;
  readonly status: "review-only";
  readonly chainId: number;
  readonly from: Address;
  readonly collectionAddress: Address;
  readonly collectionKind: "dedicated" | "shared";
  readonly collectionId?: string;
  readonly itemIndex?: string;
  readonly expectedTokenId?: string;
  readonly createCall: KeelCreatorWalletCall;
  readonly announcement: {
    readonly phase: "same-wallet-batch-when-token-id-is-prechecked" | "post-create-readback";
    readonly event: "ItemCreated" | "SharedItemCreated";
    readonly call?: KeelCreatorMetadataAnnouncementCall;
  };
  readonly calls: readonly KeelCreatorWalletCall[];
  readonly walletRequest: KeelCreatorWalletSendCalls;
  readonly walletApproval: "one-wallet-approval";
  readonly signing: "not-performed";
  readonly submission: "not-performed";
}

/**
 * Plans dedicated/shared ERC-1155 item creation and its URI announcement.
 * Without an exact expected token id, only createItem is put in the batch;
 * the announcement is explicitly gated on the ItemCreated read-back. When a
 * caller has already read the next id, both calls can be approved together.
 */
export function buildKeelCreator1155ItemBindingPlan(input: {
  readonly chainId: number;
  readonly creator: Address;
  readonly collectionAddress: Address;
  readonly collectionKind: "dedicated" | "shared";
  readonly maxSupply: bigint | number | string;
  readonly collectionId?: bigint | number | string;
  readonly itemIndex?: bigint | number | string;
  readonly royaltyReceiver?: Address;
  readonly royaltyBps?: bigint | number | string;
  readonly expectedTokenId?: bigint | number | string;
}): KeelCreator1155ItemBindingPlan {
  const chainId = positiveChainId(input.chainId);
  const from = address(input.creator, "creator");
  const collectionAddress = address(input.collectionAddress, "collectionAddress");
  const maxSupply = boundedUint128(input.maxSupply, "maxSupply");
  const expectedTokenId = input.expectedTokenId === undefined
    ? input.collectionKind === "shared" && input.collectionId !== undefined && input.itemIndex !== undefined
      ? keelSharedTokenId(boundedUint128(input.collectionId, "collectionId"), boundedUint128(input.itemIndex, "itemIndex")).toString()
      : undefined
    : decimal(input.expectedTokenId, "expectedTokenId");
  if (expectedTokenId !== undefined && BigInt(expectedTokenId) === 0n) throw new RangeError("expectedTokenId must be positive.");

  let createData: Hex;
  let event: "ItemCreated" | "SharedItemCreated";
  const optionalCollectionId = input.collectionId === undefined ? {} : { collectionId: decimal(input.collectionId, "collectionId") };
  const optionalItemIndex = input.itemIndex === undefined ? {} : { itemIndex: decimal(input.itemIndex, "itemIndex") };
  if (input.collectionKind === "dedicated") {
    createData = encodeFunctionData({ abi: DEDICATED_1155_ABI, functionName: "createItem", args: [maxSupply] });
    event = "ItemCreated";
  } else {
    if (input.collectionId === undefined) throw new TypeError("collectionId is required for a shared ERC-1155 item.");
    const royaltyReceiver = normalizedAddress(input.royaltyReceiver, ZERO, "royaltyReceiver");
    const royaltyBps = uint(input.royaltyBps === undefined ? 0n : BigInt(decimal(input.royaltyBps, "royaltyBps")), 0n, "royaltyBps", (1n << 96n) - 1n);
    if (royaltyBps > 10_000n || (royaltyBps !== 0n && royaltyReceiver === ZERO)) throw new RangeError("royalty configuration is invalid.");
    createData = encodeFunctionData({ abi: SHARED_1155_ABI, functionName: "createItem", args: [boundedUint128(input.collectionId, "collectionId"), maxSupply, royaltyReceiver, royaltyBps] });
    event = "SharedItemCreated";
  }

  const createCall = Object.freeze({ to: collectionAddress, data: createData, value: "0x0" as Hex });
  const announcementCall = expectedTokenId === undefined ? undefined : buildKeelCreatorMetadataAnnouncementCall({
    chainId,
    creator: from,
    collectionAddress,
    tokenId: expectedTokenId,
  });
  const calls = freezeCalls(announcementCall === undefined ? [createCall] : [createCall, announcementCall.call]);
  const walletRequest: KeelCreatorWalletSendCalls = {
    method: "wallet_sendCalls",
    params: [{ version: "1.0", chainId: numberToHex(BigInt(chainId)), from, calls }],
  };
  return Object.freeze({
    schema: KEEL_CREATOR_ITEM_WALLET_PROTOCOL,
    status: "review-only",
    chainId,
    from,
    collectionAddress,
    collectionKind: input.collectionKind,
    ...optionalCollectionId,
    ...optionalItemIndex,
    ...(expectedTokenId === undefined ? {} : { expectedTokenId }),
    createCall,
    announcement: Object.freeze({
      phase: announcementCall === undefined ? "post-create-readback" as const : "same-wallet-batch-when-token-id-is-prechecked" as const,
      event,
      ...(announcementCall === undefined ? {} : { call: announcementCall }),
    }),
    calls,
    walletRequest,
    walletApproval: "one-wallet-approval",
    signing: "not-performed",
    submission: "not-performed",
  });
}

export type KeelCreatorOperationStatus = "prepared" | "submitted" | "pending" | "unknown" | "confirmed" | "failed" | "cancelled";

export interface KeelCreatorOperationReceipt {
  readonly transactionHash: Hex;
  readonly status: "pending" | "success" | "reverted";
  readonly blockNumber?: string;
  readonly operationIndexes: readonly number[];
}

export interface KeelCreatorOperationReadback {
  readonly collectionId: string;
  readonly tokenContract: Address;
  readonly creator: Address;
  readonly factoryAddress: Address;
  readonly rendererAddress: Address;
  readonly creatorNonceBefore: string;
  readonly creatorNonceAfter?: string;
}

export interface KeelCreatorOperationEnvelope {
  readonly schema: typeof KEEL_CREATOR_OPERATION_PROTOCOL;
  readonly operationId: string;
  readonly status: KeelCreatorOperationStatus;
  readonly chainId: number;
  readonly owner: Address;
  readonly creator: Address;
  readonly executor: Address;
  readonly factoryAddress: Address;
  readonly rendererAddress: Address;
  readonly creatorNonce: string;
  readonly planDigest: Hex;
  readonly chunkCount: number;
  readonly operationCount: number;
  readonly cursor: number;
  readonly calls: readonly KeelCreatorWalletCall[];
  readonly factoryCall: KeelCreatorFactoryCollectionCall;
  readonly walletRequest: KeelCreatorWalletSendCalls;
  readonly walletBatchId?: string;
  readonly walletBatchIds?: readonly string[];
  readonly transactionHashes: readonly Hex[];
  readonly receipts: readonly KeelCreatorOperationReceipt[];
  readonly completedChunkIndexes: readonly number[];
  readonly completedOperationIndexes: readonly number[];
  readonly failedChunkIndexes: readonly number[];
  readonly failedOperationIndexes: readonly number[];
  readonly readback?: KeelCreatorOperationReadback;
  readonly lastError?: string;
  readonly updatedAt: number;
  readonly walletApproval: "one-wallet-approval";
  readonly signing: "not-performed" | "performed";
  readonly submission: "not-performed" | "submitted";
}

function safeTimestamp(value: number | undefined): number {
  const result = value ?? Date.now();
  if (!Number.isSafeInteger(result) || result < 0) throw new RangeError("updatedAt must be a non-negative safe integer.");
  return result;
}

function operationId(value: string | undefined, digest: Hex): string {
  const result = value ?? `keel-creator-${digest.slice(2, 18)}`;
  if (!OPERATION_ID.test(result)) throw new TypeError("operationId is invalid.");
  return result;
}

/** Creates a JSON-safe durable operation record from a reviewed batch. */
export function createKeelCreatorOperationEnvelope(input: {
  readonly batch: KeelCreatorCollectionWalletBatch;
  readonly operationId?: string;
  readonly now?: number;
}): KeelCreatorOperationEnvelope {
  const batch = input.batch;
  const now = safeTimestamp(input.now);
  return Object.freeze({
    schema: KEEL_CREATOR_OPERATION_PROTOCOL,
    operationId: operationId(input.operationId, batch.planDigest),
    status: "prepared",
    chainId: batch.chainId,
    owner: batch.owner,
    creator: batch.creator,
    executor: batch.executor,
    factoryAddress: batch.factoryAddress,
    rendererAddress: batch.rendererAddress,
    creatorNonce: batch.creatorNonce,
    planDigest: batch.planDigest,
    chunkCount: batch.chunkCount,
    operationCount: batch.operationCount,
    cursor: 0,
    calls: batch.calls,
    factoryCall: batch.factoryCall,
    walletRequest: batch.walletRequest,
    walletBatchIds: Object.freeze([]),
    transactionHashes: Object.freeze([]),
    receipts: Object.freeze([]),
    completedChunkIndexes: Object.freeze([]),
    completedOperationIndexes: Object.freeze([]),
    failedChunkIndexes: Object.freeze([]),
    failedOperationIndexes: Object.freeze([]),
    updatedAt: now,
    walletApproval: "one-wallet-approval",
    signing: "not-performed",
    submission: "not-performed",
  });
}

/**
 * Resolves the selected chain from the generated deployment registry and
 * returns both the single EIP-5792 review and its durable recovery record.
 * Missing or ambiguous deployment records fail closed before a wallet request
 * is returned.
 */
function preparedCreatorCollectionWalletReview(
  configured: ReturnType<typeof configuredKeelCreatorDeployment>,
  input: KeelCreatorCollectionWalletReviewInput,
) {
  if (configured.status !== "configured") {
    return Object.freeze({
      schema: "keel.creator-collection-wallet-review@1" as const,
      status: "blocked" as const,
      code: configured.status === "missing" ? "creator-deployment-missing" as const : "creator-deployment-ambiguous" as const,
      chainId: input.chainId,
      issue: configured.issue,
      walletApproval: "not-requested" as const,
      signing: "not-performed" as const,
      submission: "not-performed" as const,
    });
  }
  const batch = buildKeelCreatorCollectionWalletBatch({
    chainId: input.chainId,
    creator: input.creator,
    ...(input.executor === undefined ? {} : { executor: input.executor }),
    deployment: configured.deployment,
    creatorNonce: input.creatorNonce,
    operation: input.operation,
  });
  const durableOperation = createKeelCreatorOperationEnvelope({
    batch,
    ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  return Object.freeze({
    schema: "keel.creator-collection-wallet-review@1" as const,
    status: "review-only" as const,
    deployment: configured.deployment,
    rendererReadbackRequired: true as const,
    caveat: "Before submission, re-read KeelCreatorFactory.metadataRenderer and require an exact match with the recorded renderer address.",
    batch,
    durableOperation,
    walletApproval: "one-wallet-approval" as const,
    signing: "not-performed" as const,
    submission: "not-performed" as const,
  });
}

export function prepareKeelCreatorCollectionWalletReview(input: KeelCreatorCollectionWalletReviewInput) {
  return preparedCreatorCollectionWalletReview(configuredKeelCreatorDeployment(input.chainId, input.instance), input);
}

/** Test and private-chain equivalent of the generated-registry preparation path. */
export function prepareKeelCreatorCollectionWalletReviewFromRecords(
  records: readonly KeelCreatorDeploymentRecord[],
  input: KeelCreatorCollectionWalletReviewInput,
) {
  return preparedCreatorCollectionWalletReview(resolveKeelCreatorDeploymentRecords(records, input.chainId, input.instance), input);
}

function assertSubmissionState(state: KeelCreatorOperationEnvelope): void {
  if (state.status === "confirmed") throw new Error("This creator operation is already confirmed; no duplicate wallet submission is allowed.");
  if (state.status === "cancelled") throw new Error("This creator operation was explicitly cancelled; prepare a new review.");
  if (state.walletBatchId !== undefined || state.status === "submitted" || state.status === "pending" || state.status === "unknown") {
    throw new Error("This creator operation was already submitted or timed out; reconcile its wallet batch before retrying.");
  }
  if (state.status !== "prepared" && state.status !== "failed") throw new Error("This creator operation is not ready for a wallet submission.");
  if (state.status === "prepared" && state.transactionHashes.length > 0) {
    const revertedHashes = new Set(state.receipts.filter((receipt) => receipt.status === "reverted").map((receipt) => receipt.transactionHash));
    if (state.receipts.some((receipt) => receipt.status !== "reverted") || state.transactionHashes.some((transactionHash) => !revertedHashes.has(transactionHash))) {
      throw new Error("A prepared creator retry has unresolved or successful transaction history; another wallet approval is not allowed.");
    }
  }
}

export function assertKeelCreatorSubmissionAllowed(state: KeelCreatorOperationEnvelope): true {
  assertSubmissionState(state);
  return true;
}

function hash(value: string, label: string): Hex {
  if (!HASH.test(value)) throw new TypeError(`${label} must be a transaction hash.`);
  return value.toLowerCase() as Hex;
}

function uniqueHashes(values: readonly Hex[]): readonly Hex[] {
  return Object.freeze([...new Set(values.map((value) => value.toLowerCase() as Hex))]);
}

/** Records the wallet_sendCalls id exactly once; it does not submit anything. */
export function recordKeelCreatorWalletSubmission(state: KeelCreatorOperationEnvelope, input: {
  readonly walletBatchId: string;
  readonly transactionHashes?: readonly Hex[];
  readonly now?: number;
}): KeelCreatorOperationEnvelope {
  if (input.walletBatchId.trim().length === 0 || input.walletBatchId.length > 256) throw new TypeError("walletBatchId is invalid.");
  if (state.walletBatchId !== undefined && state.walletBatchId !== input.walletBatchId) throw new Error("A different wallet batch id cannot replace the durable submitted operation.");
  if (state.walletBatchId === undefined) assertSubmissionState(state);
  const transactionHashes = uniqueHashes([...state.transactionHashes, ...(input.transactionHashes ?? []).map((value) => hash(value, "transactionHash"))]);
  const walletBatchIds = Object.freeze([...new Set([...(state.walletBatchIds ?? []), input.walletBatchId])]);
  return Object.freeze({
    ...state,
    ...(state.walletBatchId === undefined ? { walletBatchId: input.walletBatchId } : {}),
    walletBatchIds,
    transactionHashes,
    status: state.status === "confirmed" || state.status === "failed" || state.status === "cancelled" ? state.status : "submitted",
    signing: "performed",
    submission: "submitted",
    updatedAt: safeTimestamp(input.now),
  });
}

function operationIndexes(input: readonly number[] | undefined, operationCount: number): readonly number[] {
  const indexes = input ?? Array.from({ length: operationCount }, (_, index) => index);
  if (indexes.length === 0 || indexes.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= operationCount)) throw new RangeError("Receipt operation indexes are outside the reviewed operation plan.");
  return Object.freeze([...new Set(indexes)].sort((left, right) => left - right));
}

function contiguousCursor(completed: readonly number[], operationCount: number): number {
  const values = new Set(completed);
  let cursor = 0;
  while (cursor < operationCount && values.has(cursor)) cursor += 1;
  return cursor;
}

function sameReadback(state: KeelCreatorOperationEnvelope, readback: KeelCreatorOperationReadback): boolean {
  return address(readback.creator, "readback.creator") === state.creator
    && address(readback.factoryAddress, "readback.factoryAddress") === state.factoryAddress
    && address(readback.rendererAddress, "readback.rendererAddress") === state.rendererAddress
    && decimal(readback.creatorNonceBefore, "readback.creatorNonceBefore") === state.creatorNonce
    && address(readback.tokenContract, "readback.tokenContract") !== ZERO
    && DECIMAL.test(readback.collectionId);
}

function mergeReceipt(receipts: readonly KeelCreatorOperationReceipt[], next: KeelCreatorOperationReceipt): readonly KeelCreatorOperationReceipt[] {
  const index = receipts.findIndex((receipt) => receipt.transactionHash.toLowerCase() === next.transactionHash.toLowerCase());
  if (index === -1) return Object.freeze([...receipts, next]);
  const existing = receipts[index]!;
  if (canonicalJson(existing.operationIndexes) !== canonicalJson(next.operationIndexes)) throw new Error("A receipt cannot change operation indexes in the durable creator operation.");
  if (existing.status === next.status) {
    if (existing.blockNumber !== undefined || next.blockNumber === undefined) return receipts;
  } else if (existing.status === "pending") {
    // Pending is an observation, not a terminal receipt. Replace it in place.
  } else if (next.status === "pending") {
    return receipts;
  } else {
    throw new Error("A terminal receipt cannot change status in the durable creator operation.");
  }
  const updated = [...receipts];
  updated[index] = next;
  return Object.freeze(updated);
}

/**
 * Explicitly unlocks only a fully reverted, zero-progress operation. Receipt,
 * transaction, and wallet-batch history remain durable for later inspection.
 */
export function prepareKeelCreatorFailedOperationRetry(
  state: KeelCreatorOperationEnvelope,
  input: { readonly now?: number } = {},
): KeelCreatorOperationEnvelope {
  if (state.status !== "failed" || state.walletBatchId === undefined) throw new Error("Only a submitted failed creator operation can be prepared for retry.");
  if (state.completedOperationIndexes.length > 0 || state.cursor !== 0 || state.readback !== undefined) throw new Error("A creator operation with confirmed progress or read-back cannot be retried as a whole batch.");
  const receiptsByHash = new Map(state.receipts.map((receipt) => [receipt.transactionHash, receipt]));
  if (state.transactionHashes.length === 0 || state.transactionHashes.some((transactionHash) => receiptsByHash.get(transactionHash)?.status !== "reverted")) {
    throw new Error("Every submitted transaction requires a confirmed reverted receipt before retrying a creator operation.");
  }
  const { walletBatchId: _completedBatchId, lastError: _lastError, ...durable } = state;
  return Object.freeze({
    ...durable,
    status: "prepared",
    signing: "not-performed",
    submission: "not-performed",
    failedChunkIndexes: Object.freeze([]),
    failedOperationIndexes: Object.freeze([]),
    updatedAt: safeTimestamp(input.now),
  });
}

/**
 * Reconciles a submitted batch after a receipt, RPC timeout, or reload. A
 * timeout without a receipt becomes `unknown` and remains submission-locked;
 * callers must reconcile before they can ask the wallet anything again.
 */
export function reconcileKeelCreatorOperation(state: KeelCreatorOperationEnvelope, input: {
  readonly walletBatchId?: string;
  readonly receipt?: {
    readonly transactionHash: Hex;
    readonly status: "pending" | "success" | "reverted";
    readonly blockNumber?: bigint | number | string;
    readonly operationIndexes?: readonly number[];
  };
  readonly readback?: KeelCreatorOperationReadback;
  readonly timedOut?: boolean;
  readonly now?: number;
}): KeelCreatorOperationEnvelope {
  if (input.walletBatchId !== undefined && state.walletBatchId === undefined) {
    throw new Error("Reconciliation cannot establish a wallet batch; record the durable wallet submission first.");
  }
  if ((input.receipt !== undefined || input.readback !== undefined || input.timedOut === true) && state.walletBatchId === undefined) {
    throw new Error("A durable submitted wallet batch is required before creator receipt or read-back reconciliation.");
  }
  if (input.walletBatchId !== undefined && state.walletBatchId !== undefined && input.walletBatchId !== state.walletBatchId) throw new Error("The reconciled wallet batch does not match the reviewed operation.");
  if (state.status === "confirmed") return state;
  let receipts = state.receipts;
  let transactionHashes = state.transactionHashes;
  let completedOperationIndexes = [...state.completedOperationIndexes];
  let failedOperationIndexes = [...state.failedOperationIndexes];
  let lastError = state.lastError;
  if (input.receipt !== undefined) {
    const transactionHash = hash(input.receipt.transactionHash, "transactionHash");
    const indexes = operationIndexes(input.receipt.operationIndexes, state.operationCount);
    const receipt: KeelCreatorOperationReceipt = Object.freeze({
      transactionHash,
      status: input.receipt.status,
      operationIndexes: indexes,
      ...(input.receipt.blockNumber === undefined ? {} : { blockNumber: decimal(input.receipt.blockNumber, "blockNumber") }),
    });
    receipts = mergeReceipt(receipts, receipt);
    transactionHashes = uniqueHashes([...transactionHashes, transactionHash]);
    if (input.receipt.status === "success") {
      completedOperationIndexes = [...new Set([...completedOperationIndexes, ...indexes])].sort((left, right) => left - right);
    } else if (input.receipt.status === "reverted") {
      failedOperationIndexes = [...new Set([...failedOperationIndexes, ...indexes])].sort((left, right) => left - right);
      lastError = "The wallet batch receipt reverted; no creator operation was confirmed.";
    }
  }
  if (input.readback !== undefined && !sameReadback(state, input.readback)) {
    lastError = "The creator collection read-back does not match the reviewed owner, factory, renderer, or nonce.";
  }
  const completedChunkIndexes = completedOperationIndexes.filter((index) => index < state.chunkCount);
  const cursor = contiguousCursor(completedOperationIndexes, state.operationCount);
  const allOperationsComplete = completedOperationIndexes.length >= state.operationCount;
  const hasFailure = failedOperationIndexes.length > 0 || lastError?.startsWith("The creator collection read-back") === true;
  const confirmed = allOperationsComplete && input.readback !== undefined && lastError === undefined;
  const status: KeelCreatorOperationStatus = confirmed
    ? "confirmed"
    : hasFailure
      ? "failed"
      : input.timedOut === true && input.receipt === undefined
        ? "unknown"
        : input.receipt?.status === "pending"
          ? "pending"
          : state.walletBatchId === undefined && input.walletBatchId === undefined
            ? state.status
            : "pending";
  return Object.freeze({
    ...state,
    status,
    transactionHashes,
    receipts,
    completedChunkIndexes: Object.freeze(completedChunkIndexes),
    completedOperationIndexes: Object.freeze(completedOperationIndexes),
    failedChunkIndexes: Object.freeze(failedOperationIndexes.filter((index) => index < state.chunkCount)),
    failedOperationIndexes: Object.freeze(failedOperationIndexes),
    ...(input.readback === undefined ? {} : { readback: input.readback }),
    ...(lastError === undefined ? {} : { lastError }),
    cursor,
    updatedAt: safeTimestamp(input.now),
    signing: state.signing === "not-performed" && (input.walletBatchId === undefined && state.walletBatchId === undefined) ? "not-performed" : "performed",
    submission: state.submission === "not-performed" && input.receipt === undefined && input.walletBatchId === undefined ? "not-performed" : "submitted",
  });
}

export interface KeelCreatorOperationRecoveryKey {
  readonly chainId: number;
  readonly owner: Address;
  readonly executor: Address;
  readonly factoryAddress: Address;
  readonly rendererAddress: Address;
  readonly creatorNonce: string;
  readonly planDigest: Hex;
  readonly chunkCount: number;
  readonly operationCount: number;
  readonly cursor: number;
}

export function creatorOperationRecoveryKey(state: KeelCreatorOperationEnvelope): KeelCreatorOperationRecoveryKey {
  return Object.freeze({
    chainId: state.chainId,
    owner: state.owner,
    executor: state.executor,
    factoryAddress: state.factoryAddress,
    rendererAddress: state.rendererAddress,
    creatorNonce: state.creatorNonce,
    planDigest: state.planDigest,
    chunkCount: state.chunkCount,
    operationCount: state.operationCount,
    cursor: state.cursor,
  });
}

function sameRecoveryKey(left: KeelCreatorOperationRecoveryKey, right: KeelCreatorOperationRecoveryKey): boolean {
  return left.chainId === right.chainId
    && left.owner.toLowerCase() === right.owner.toLowerCase()
    && left.executor.toLowerCase() === right.executor.toLowerCase()
    && left.factoryAddress.toLowerCase() === right.factoryAddress.toLowerCase()
    && left.rendererAddress.toLowerCase() === right.rendererAddress.toLowerCase()
    && left.creatorNonce === right.creatorNonce
    && left.planDigest.toLowerCase() === right.planDigest.toLowerCase()
    && left.chunkCount === right.chunkCount
    && left.operationCount === right.operationCount
    && left.cursor === right.cursor;
}

export function matchesKeelCreatorOperationRecovery(state: KeelCreatorOperationEnvelope, candidate: KeelCreatorOperationRecoveryKey): boolean {
  return sameRecoveryKey(creatorOperationRecoveryKey(state), candidate);
}

export type KeelCreatorRecoverySelection =
  | { readonly status: "none" }
  | { readonly status: "matched"; readonly operation: KeelCreatorOperationEnvelope }
  | { readonly status: "ambiguous"; readonly operations: readonly KeelCreatorOperationEnvelope[]; readonly issue: string }
  | { readonly status: "mismatch"; readonly operations: readonly KeelCreatorOperationEnvelope[]; readonly issue: string };

/**
 * Selects a durable operation only when every identity field matches. Any
 * related but different record is a safe mismatch, not permission to open a
 * second operation.
 */
export function selectKeelCreatorOperationRecovery(records: readonly KeelCreatorOperationEnvelope[], candidate: KeelCreatorOperationRecoveryKey): KeelCreatorRecoverySelection {
  const related = records.filter((record) => record.chainId === candidate.chainId
    && record.owner.toLowerCase() === candidate.owner.toLowerCase()
    && record.executor.toLowerCase() === candidate.executor.toLowerCase()
    && record.factoryAddress.toLowerCase() === candidate.factoryAddress.toLowerCase()
    && record.rendererAddress.toLowerCase() === candidate.rendererAddress.toLowerCase()
    && record.creatorNonce === candidate.creatorNonce);
  const matches = related.filter((record) => matchesKeelCreatorOperationRecovery(record, candidate));
  if (matches.length === 1) return Object.freeze({ status: "matched", operation: matches[0]! });
  if (matches.length > 1) return Object.freeze({ status: "ambiguous", operations: Object.freeze(matches), issue: "More than one durable creator operation matches the exact owner, executor, plan, counts, and cursor." });
  if (related.length > 0) return Object.freeze({ status: "mismatch", operations: Object.freeze(related), issue: "A related creator operation exists but its plan, counts, or cursor differ; no new wallet action is safe." });
  return Object.freeze({ status: "none" });
}

/** JSON serialization is canonical and contains no bigint values. */
export function serializeKeelCreatorOperationEnvelope(state: KeelCreatorOperationEnvelope): string {
  return canonicalJson(state);
}

function journalObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function journalIndexes(value: unknown, limit: number, label: string): readonly number[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  const indexes = value.map((entry) => {
    if (!Number.isSafeInteger(entry) || (entry as number) < 0 || (entry as number) >= limit) throw new RangeError(`${label} contains an index outside the reviewed plan.`);
    return entry as number;
  });
  const canonical = [...new Set(indexes)].sort((left, right) => left - right);
  if (canonicalJson(indexes) !== canonicalJson(canonical)) throw new TypeError(`${label} must be sorted and unique.`);
  return Object.freeze(canonical);
}

function journalWalletCall(value: unknown, label: string): KeelCreatorWalletCall {
  const call = journalObject(value, label);
  const to = address(call.to as Address, `${label}.to`);
  if (typeof call.data !== "string" || !/^0x(?:[0-9a-f]{2})*$/u.test(call.data)) throw new TypeError(`${label}.data must be lowercase hex bytes.`);
  if (call.value !== "0x0") throw new TypeError(`${label}.value must be zero.`);
  return Object.freeze({ to, data: call.data as Hex, value: "0x0" as Hex });
}

function journalFactoryCall(
  value: unknown,
  chainId: number,
  creator: Address,
  factoryAddress: Address,
): KeelCreatorFactoryCollectionCall {
  const call = journalObject(value, "factoryCall") as unknown as KeelCreatorFactoryCollectionCall;
  if (call.schema !== "keel.creator-collection-call@1" || call.status !== "review-only") throw new TypeError("factoryCall has an unsupported review schema.");
  if (call.chainId !== chainId || address(call.from, "factoryCall.from") !== creator || address(call.to, "factoryCall.to") !== factoryAddress) throw new TypeError("factoryCall does not match the durable owner, chain, or factory.");
  if (call.valueWei !== "0" || call.walletApproval !== "required" || call.signing !== "not-performed" || call.submission !== "not-performed") throw new TypeError("factoryCall contains an unsafe value or execution state.");
  if (!Array.isArray(call.arguments) || !["createERC721", "createStandardERC721", "createERC1155", "createSharedERC1155", "registerExternalCollection"].includes(call.functionName)) throw new TypeError("factoryCall function or arguments are unsupported.");
  if (typeof call.data !== "string" || !/^0x(?:[0-9a-f]{2})+$/u.test(call.data)) throw new TypeError("factoryCall calldata is invalid.");
  let expectedData: Hex;
  try {
    expectedData = encodeFactoryCall(call);
  } catch {
    throw new TypeError("factoryCall arguments cannot be encoded by the KEEL creator ABI.");
  }
  if (expectedData !== call.data) throw new TypeError("factoryCall calldata does not match its reviewed function and arguments.");
  return Object.freeze(call);
}

/** Strict fail-closed parser for a record loaded from a journal or draft. */
export function parseKeelCreatorOperationEnvelope(value: unknown): KeelCreatorOperationEnvelope {
  let input: unknown = value;
  if (typeof value === "string") {
    try {
      input = JSON.parse(value) as unknown;
    } catch {
      throw new TypeError("The creator operation journal record is not valid JSON.");
    }
  }
  const record = journalObject(input, "The creator operation journal record");
  if (record.schema !== KEEL_CREATOR_OPERATION_PROTOCOL) throw new TypeError("The creator operation journal schema is unsupported.");
  if (typeof record.operationId !== "string" || !OPERATION_ID.test(record.operationId)) throw new TypeError("The creator operation id is invalid.");
  if (typeof record.chainId !== "number") throw new TypeError("The creator operation chain is invalid.");
  positiveChainId(record.chainId);
  for (const field of ["owner", "creator", "executor", "factoryAddress", "rendererAddress"] as const) address(record[field] as Address, field);
  if (record.owner !== record.creator) throw new TypeError("The direct creator wallet operation owner and creator must match.");
  for (const field of ["creatorNonce"] as const) decimal(record[field] as string, field);
  for (const field of ["planDigest"] as const) {
    if (typeof record[field] !== "string" || !BYTES32.test(record[field])) throw new TypeError(`${field} must be bytes32.`);
  }
  for (const field of ["chunkCount", "operationCount", "cursor", "updatedAt"] as const) {
    if (typeof record[field] !== "number" || !Number.isSafeInteger(record[field]) || record[field] < 0) throw new TypeError(`${field} is invalid.`);
  }
  const chunkCount = record.chunkCount as number;
  const operationCount = record.operationCount as number;
  const cursor = record.cursor as number;
  if (chunkCount !== 1 || operationCount !== 1 || cursor > operationCount) throw new TypeError("The creator operation counts or cursor are invalid for protocol v1.");
  if (!Array.isArray(record.calls) || record.calls.length !== chunkCount) throw new TypeError("The creator operation calls do not match its chunk count.");
  const calls = Object.freeze(record.calls.map((call, index) => journalWalletCall(call, `calls[${index.toString()}]`)));
  const factoryCall = journalFactoryCall(record.factoryCall, record.chainId, record.creator as Address, record.factoryAddress as Address);
  if (calls[0]!.to !== record.factoryAddress || calls[0]!.data !== factoryCall.data) throw new TypeError("The wallet call does not match the reviewed factory call.");
  const completedOperationIndexes = journalIndexes(record.completedOperationIndexes, operationCount, "completedOperationIndexes");
  const failedOperationIndexes = journalIndexes(record.failedOperationIndexes, operationCount, "failedOperationIndexes");
  const completedChunkIndexes = journalIndexes(record.completedChunkIndexes, chunkCount, "completedChunkIndexes");
  const failedChunkIndexes = journalIndexes(record.failedChunkIndexes, chunkCount, "failedChunkIndexes");
  if (completedOperationIndexes.some((index) => failedOperationIndexes.includes(index))) throw new TypeError("An operation cannot be both completed and failed.");
  if (canonicalJson(completedChunkIndexes) !== canonicalJson(completedOperationIndexes.filter((index) => index < chunkCount))) throw new TypeError("Completed chunk indexes do not match completed operations.");
  if (canonicalJson(failedChunkIndexes) !== canonicalJson(failedOperationIndexes.filter((index) => index < chunkCount))) throw new TypeError("Failed chunk indexes do not match failed operations.");
  if (cursor !== contiguousCursor(completedOperationIndexes, operationCount)) throw new TypeError("The creator operation cursor is not the confirmed contiguous cursor.");
  if (!["prepared", "submitted", "pending", "unknown", "confirmed", "failed", "cancelled"].includes(record.status as string)) throw new TypeError("The creator operation status is invalid.");
  if (record.walletApproval !== "one-wallet-approval" || !["not-performed", "performed"].includes(record.signing as string) || !["not-performed", "submitted"].includes(record.submission as string)) throw new TypeError("The creator operation execution state is invalid.");
  if (record.walletBatchId !== undefined && (typeof record.walletBatchId !== "string" || record.walletBatchId.length === 0 || record.walletBatchId.length > 256)) throw new TypeError("walletBatchId is invalid.");
  const walletBatchIds = record.walletBatchIds === undefined ? [] : record.walletBatchIds;
  if (!Array.isArray(walletBatchIds) || walletBatchIds.some((id) => typeof id !== "string" || id.length === 0 || id.length > 256) || new Set(walletBatchIds).size !== walletBatchIds.length) throw new TypeError("walletBatchIds is invalid.");
  if (record.walletBatchId !== undefined && !walletBatchIds.includes(record.walletBatchId)) throw new TypeError("The active wallet batch is absent from durable batch history.");
  if (["submitted", "pending", "unknown"].includes(record.status as string) && record.walletBatchId === undefined) throw new TypeError("A submitted creator operation requires an active wallet batch id.");
  if (!Array.isArray(record.transactionHashes)) throw new TypeError("transactionHashes must be an array.");
  const transactionHashes = uniqueHashes(record.transactionHashes.map((value) => hash(value as string, "transactionHash")));
  if (transactionHashes.length !== record.transactionHashes.length) throw new TypeError("transactionHashes must be unique.");
  if (!Array.isArray(record.receipts)) throw new TypeError("receipts must be an array.");
  const receipts = Object.freeze(record.receipts.map((value, index) => {
    const receipt = journalObject(value, `receipts[${index.toString()}]`);
    if (!["pending", "success", "reverted"].includes(receipt.status as string)) throw new TypeError("A receipt status is invalid.");
    const transactionHash = hash(receipt.transactionHash as string, "receipt.transactionHash");
    if (!transactionHashes.includes(transactionHash)) throw new TypeError("A receipt hash is absent from transaction history.");
    const operationIndexes = journalIndexes(receipt.operationIndexes, operationCount, "receipt.operationIndexes");
    if (operationIndexes.length === 0) throw new TypeError("A receipt must identify at least one reviewed operation.");
    const blockNumber = receipt.blockNumber === undefined ? undefined : decimal(receipt.blockNumber as string, "receipt.blockNumber");
    return Object.freeze({ transactionHash, status: receipt.status as KeelCreatorOperationReceipt["status"], operationIndexes, ...(blockNumber === undefined ? {} : { blockNumber }) });
  }));
  if (new Set(receipts.map((receipt) => receipt.transactionHash)).size !== receipts.length) throw new TypeError("Only one current receipt may exist for each transaction hash.");
  const walletRequest = journalObject(record.walletRequest, "walletRequest");
  if (walletRequest.method !== "wallet_sendCalls" || !Array.isArray(walletRequest.params) || walletRequest.params.length !== 1) throw new TypeError("The durable wallet request is not EIP-5792 wallet_sendCalls.");
  const params = journalObject(walletRequest.params[0], "walletRequest.params[0]");
  if (params.version !== "1.0" || params.chainId !== numberToHex(BigInt(record.chainId as number)) || params.from !== record.owner || canonicalJson(params.calls) !== canonicalJson(calls)) throw new TypeError("The durable wallet request does not match its chain, owner, or calls.");
  const expectedPlanDigest = creatorCollectionPlanDigest({
    chainId: record.chainId as number,
    owner: record.owner as Address,
    creator: record.creator as Address,
    executor: record.executor as Address,
    factoryAddress: record.factoryAddress as Address,
    rendererAddress: record.rendererAddress as Address,
    creatorNonce: record.creatorNonce as string,
    operationCount,
    chunkCount,
    calls,
    factoryCall,
  });
  if (record.planDigest !== expectedPlanDigest) throw new TypeError("The durable creator plan digest does not match its exact calls and identity.");
  if (record.lastError !== undefined && (typeof record.lastError !== "string" || record.lastError.length === 0)) throw new TypeError("lastError is invalid.");
  const parsed = Object.freeze({
    ...record,
    calls,
    factoryCall,
    walletRequest: Object.freeze({ method: "wallet_sendCalls" as const, params: Object.freeze([Object.freeze({ version: "1.0" as const, chainId: params.chainId as Hex, from: params.from as Address, calls })]) }),
    walletBatchIds: Object.freeze(walletBatchIds as string[]),
    transactionHashes,
    receipts,
    completedChunkIndexes,
    completedOperationIndexes,
    failedChunkIndexes,
    failedOperationIndexes,
  }) as unknown as KeelCreatorOperationEnvelope;
  if (parsed.readback !== undefined && !sameReadback(parsed, parsed.readback)) throw new TypeError("The durable creator read-back does not match the reviewed operation.");
  if (parsed.status === "prepared" && (parsed.walletBatchId !== undefined || parsed.completedOperationIndexes.length > 0 || parsed.failedOperationIndexes.length > 0 || parsed.readback !== undefined || parsed.signing !== "not-performed" || parsed.submission !== "not-performed")) throw new TypeError("A prepared creator operation contains current submission, progress, or read-back state.");
  if (parsed.status === "prepared" && parsed.transactionHashes.length > 0) {
    const revertedHashes = new Set(parsed.receipts.filter((receipt) => receipt.status === "reverted").map((receipt) => receipt.transactionHash));
    if (parsed.receipts.some((receipt) => receipt.status !== "reverted") || parsed.transactionHashes.some((transactionHash) => !revertedHashes.has(transactionHash))) throw new TypeError("A prepared creator retry contains unresolved or successful transaction history.");
  }
  if (parsed.status === "confirmed" && (parsed.cursor !== parsed.operationCount || parsed.readback === undefined || parsed.failedOperationIndexes.length > 0)) throw new TypeError("A confirmed creator operation lacks complete progress and exact read-back.");
  const successfulReceiptIndexes = new Set(receipts.filter((receipt) => receipt.status === "success").flatMap((receipt) => receipt.operationIndexes));
  if (parsed.completedOperationIndexes.some((index) => !successfulReceiptIndexes.has(index))) throw new TypeError("Confirmed creator progress has no successful receipt proof.");
  if (parsed.status === "failed" && parsed.failedOperationIndexes.length === 0 && parsed.lastError === undefined) throw new TypeError("A failed creator operation has no recorded failure.");
  if (parsed.status === "failed" && parsed.walletBatchId === undefined) throw new TypeError("A failed creator operation requires its active durable wallet batch until explicit retry preparation.");
  return parsed;
}
