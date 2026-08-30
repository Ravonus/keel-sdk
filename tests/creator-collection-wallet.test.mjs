import assert from "node:assert/strict";
import test from "node:test";

import {
  assertKeelCreatorSubmissionAllowed,
  buildKeelCreator1155ItemBindingPlan,
  buildKeelCreatorBYORegistrationCall,
  buildKeelCreatorCollectionWalletBatch,
  buildKeelCreatorERC1155Call,
  buildKeelCreatorERC721ACall,
  buildKeelCreatorMetadataAnnouncementCall,
  buildKeelCreatorSharedERC1155Call,
  buildKeelCreatorStandardERC721Call,
  createKeelCreatorOperationEnvelope,
  creatorOperationRecoveryKey,
  matchesKeelCreatorOperationRecovery,
  parseKeelCreatorOperationEnvelope,
  prepareKeelCreatorCollectionWalletReviewFromRecords,
  prepareKeelCreatorFailedOperationRetry,
  prepareKeelCreatorCollectionWalletReview,
  reconcileKeelCreatorOperation,
  recordKeelCreatorWalletSubmission,
  selectKeelCreatorOperationRecovery,
  serializeKeelCreatorOperationEnvelope,
} from "../packages/sdk/dist/index.js";

const creator = "0x1111111111111111111111111111111111111111";
const factory = "0x3333333333333333333333333333333333333333";
const renderer = "0x4444444444444444444444444444444444444444";
const token = "0x5555555555555555555555555555555555555555";
const digest = `0x${"aa".repeat(32)}`;
const deployment = { chainId: 31337, instance: "local", factoryAddress: factory, rendererAddress: renderer };
const base = { chainId: 31337, creator, factoryAddress: factory };

function oneOfOne() {
  return { name: "One", symbol: "ONE", maxSupply: 1, metadataDigest: digest };
}

function batch(overrides = {}) {
  return buildKeelCreatorCollectionWalletBatch({
    ...base,
    deployment,
    creatorNonce: 0,
    operation: { kind: "dedicated-erc721", config: oneOfOne() },
    ...overrides,
  });
}

test("all creator factory lanes encode one exact unsigned call", () => {
  const calls = [
    buildKeelCreatorERC721ACall({ ...base, config: oneOfOne() }),
    buildKeelCreatorStandardERC721Call({ ...base, config: oneOfOne() }),
    buildKeelCreatorERC1155Call({ ...base, config: { name: "Editions", symbol: "EDIT", metadataDigest: digest } }),
    buildKeelCreatorSharedERC1155Call({ ...base, name: "Shared", metadataDigest: digest }),
    buildKeelCreatorBYORegistrationCall({ ...base, tokenContract: token, name: "BYO", metadataDigest: digest }),
  ];
  assert.deepEqual(calls.map((call) => call.functionName), [
    "createERC721",
    "createStandardERC721",
    "createERC1155",
    "createSharedERC1155",
    "registerExternalCollection",
  ]);
  assert.ok(calls.every((call) => call.data.startsWith("0x") && call.signing === "not-performed" && call.submission === "not-performed"));
  assert.equal(calls[0].data.length > 10, true);
});

test("collection preparation is one EIP-5792 wallet batch and JSON-safe", () => {
  const prepared = batch();
  assert.equal(prepared.status, "review-only");
  assert.equal(prepared.walletApproval, "one-wallet-approval");
  assert.equal(prepared.walletRequest.method, "wallet_sendCalls");
  assert.equal(prepared.walletRequest.params[0].chainId, "0x7a69");
  assert.equal(prepared.walletRequest.params[0].calls.length, 1);
  assert.equal(prepared.walletRequest.params[0].from, creator);
  assert.equal(prepared.chunkCount, 1);
  assert.equal(prepared.operationCount, 1);
  assert.equal(prepared.cursor, 0);
  assert.equal(JSON.stringify(prepared).includes("BigInt"), false);
  assert.throws(() => batch({ operationCount: 2 }), /exactly one factory operation/u);
  const envelope = createKeelCreatorOperationEnvelope({ batch: prepared, now: 100 });
  const decoded = parseKeelCreatorOperationEnvelope(serializeKeelCreatorOperationEnvelope(envelope));
  assert.deepEqual(decoded, envelope);
  assert.equal(decoded.planDigest, prepared.planDigest);
});

test("registry preparation fails closed before a wallet request on an unconfigured chain", () => {
  const result = prepareKeelCreatorCollectionWalletReview({
    chainId: 11155111,
    creator,
    instance: "creator-v1",
    creatorNonce: "0",
    operation: { kind: "dedicated-erc721", config: oneOfOne() },
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.walletApproval, "not-requested");
  assert.equal(result.signing, "not-performed");
  assert.equal(result.submission, "not-performed");
  assert.equal("batch" in result, false);
  assert.equal("durableOperation" in result, false);
});

test("an exact configured registry produces one wallet batch and one durable envelope", () => {
  const result = prepareKeelCreatorCollectionWalletReviewFromRecords([
    { module: "keel-die", chainId: 31337, instance: "local", contract: "KeelCreatorFactory", address: factory },
    { module: "keel-die", chainId: 31337, instance: "local", contract: "KeelArtifactTokenRenderer", address: renderer },
  ], {
    chainId: 31337,
    creator,
    instance: "local",
    creatorNonce: "7",
    operation: { kind: "dedicated-erc721", implementation: "erc721", config: oneOfOne() },
    now: 100,
  });
  assert.equal(result.status, "review-only");
  assert.equal(result.batch.walletRequest.method, "wallet_sendCalls");
  assert.equal(result.batch.calls.length, 1);
  assert.equal(result.batch.factoryCall.functionName, "createStandardERC721");
  assert.equal(result.durableOperation.planDigest, result.batch.planDigest);
  assert.equal(result.durableOperation.factoryCall.data, result.batch.calls[0].data);
  assert.deepEqual(parseKeelCreatorOperationEnvelope(serializeKeelCreatorOperationEnvelope(result.durableOperation)), result.durableOperation);
});

test("item binding keeps metadata announcement behind exact item read-back or in the same reviewed batch", () => {
  const dedicated = buildKeelCreator1155ItemBindingPlan({
    chainId: 31337,
    creator,
    collectionAddress: token,
    collectionKind: "dedicated",
    maxSupply: 1,
  });
  assert.equal(dedicated.calls.length, 1);
  assert.equal(dedicated.announcement.phase, "post-create-readback");
  assert.equal(dedicated.announcement.event, "ItemCreated");
  const shared = buildKeelCreator1155ItemBindingPlan({
    chainId: 31337,
    creator,
    collectionAddress: token,
    collectionKind: "shared",
    collectionId: 7,
    itemIndex: 3,
    maxSupply: 1,
  });
  assert.equal(shared.calls.length, 2);
  assert.equal(shared.expectedTokenId, ((7n << 128n) | 3n).toString());
  assert.equal(shared.announcement.phase, "same-wallet-batch-when-token-id-is-prechecked");
  const announcement = buildKeelCreatorMetadataAnnouncementCall({ chainId: 31337, creator, collectionAddress: token, tokenId: 3 });
  assert.equal(announcement.call.data.slice(0, 10), "0x996effbe");
});

test("timeout is reconciled and locks the operation against duplicate wallet approval", () => {
  let state = createKeelCreatorOperationEnvelope({ batch: batch(), now: 100 });
  assert.doesNotThrow(() => assertKeelCreatorSubmissionAllowed(state));
  state = recordKeelCreatorWalletSubmission(state, { walletBatchId: "wallet-batch-1", now: 101 });
  assert.equal(state.status, "submitted");
  state = reconcileKeelCreatorOperation(state, { walletBatchId: "wallet-batch-1", timedOut: true, now: 102 });
  assert.equal(state.status, "unknown");
  assert.throws(() => assertKeelCreatorSubmissionAllowed(state), /reconcile|already submitted/u);
  assert.throws(() => recordKeelCreatorWalletSubmission(state, { walletBatchId: "wallet-batch-2" }), /different|already submitted|reconcile/u);
  state = reconcileKeelCreatorOperation(state, {
    walletBatchId: "wallet-batch-1",
    receipt: { transactionHash: `0x${"bb".repeat(32)}`, status: "success", blockNumber: 9 },
    now: 103,
  });
  assert.equal(state.status, "pending");
  assert.deepEqual(state.completedOperationIndexes, [0]);
  state = reconcileKeelCreatorOperation(state, {
    walletBatchId: "wallet-batch-1",
    readback: { collectionId: "1", tokenContract: token, creator, factoryAddress: factory, rendererAddress: renderer, creatorNonceBefore: "0", creatorNonceAfter: "1" },
    now: 104,
  });
  assert.equal(state.status, "confirmed");
  assert.equal(state.cursor, 1);
  assert.throws(() => assertKeelCreatorSubmissionAllowed(state), /already confirmed/u);
});

test("a pending receipt advances to success without losing its durable hash", () => {
  const transactionHash = `0x${"bd".repeat(32)}`;
  let state = createKeelCreatorOperationEnvelope({ batch: batch(), now: 100 });
  state = recordKeelCreatorWalletSubmission(state, { walletBatchId: "wallet-batch-pending", transactionHashes: [transactionHash], now: 101 });
  state = reconcileKeelCreatorOperation(state, { receipt: { transactionHash, status: "pending" }, now: 102 });
  assert.equal(state.status, "pending");
  state = reconcileKeelCreatorOperation(state, { receipt: { transactionHash, status: "success", blockNumber: 9 }, now: 103 });
  assert.equal(state.receipts.length, 1);
  assert.equal(state.receipts[0].status, "success");
  assert.equal(state.receipts[0].blockNumber, "9");
  assert.deepEqual(state.completedOperationIndexes, [0]);
});

test("receipt and read-back reconciliation require a durable submitted wallet batch", () => {
  const prepared = createKeelCreatorOperationEnvelope({ batch: batch(), now: 100 });
  assert.throws(() => reconcileKeelCreatorOperation(prepared, { walletBatchId: "forged-batch" }), /cannot establish a wallet batch/u);
  assert.throws(() => reconcileKeelCreatorOperation(prepared, {
    receipt: { transactionHash: `0x${"ef".repeat(32)}`, status: "success" },
  }), /durable submitted wallet batch/u);
  assert.throws(() => reconcileKeelCreatorOperation(prepared, { timedOut: true }), /durable submitted wallet batch/u);
});

test("reverted receipt persists explicit failed chunk and operation indexes", () => {
  let state = createKeelCreatorOperationEnvelope({ batch: batch(), now: 100 });
  state = recordKeelCreatorWalletSubmission(state, { walletBatchId: "wallet-batch-fail" });
  state = reconcileKeelCreatorOperation(state, {
    walletBatchId: "wallet-batch-fail",
    receipt: { transactionHash: `0x${"cc".repeat(32)}`, status: "reverted", operationIndexes: [0] },
  });
  assert.equal(state.status, "failed");
  assert.deepEqual(state.failedChunkIndexes, [0]);
  assert.deepEqual(state.failedOperationIndexes, [0]);
  assert.equal(state.completedOperationIndexes.length, 0);
  assert.equal(recordKeelCreatorWalletSubmission(state, { walletBatchId: "wallet-batch-fail" }).status, "failed");
  const receipts = state.receipts;
  const transactionHashes = state.transactionHashes;
  state = prepareKeelCreatorFailedOperationRetry(state, { now: 200 });
  assert.equal(state.status, "prepared");
  assert.equal(state.signing, "not-performed");
  assert.equal(state.submission, "not-performed");
  assert.equal(state.walletBatchId, undefined);
  assert.deepEqual(state.receipts, receipts);
  assert.deepEqual(state.transactionHashes, transactionHashes);
  assert.deepEqual(state.failedOperationIndexes, []);
  assert.deepEqual(parseKeelCreatorOperationEnvelope(serializeKeelCreatorOperationEnvelope(state)), state);
  assert.doesNotThrow(() => assertKeelCreatorSubmissionAllowed(state));
  state = recordKeelCreatorWalletSubmission(state, { walletBatchId: "wallet-batch-retry", now: 201 });
  assert.deepEqual(state.walletBatchIds, ["wallet-batch-fail", "wallet-batch-retry"]);
});

test("recovery requires owner, executor, plan, counts, and cursor to match", () => {
  const state = createKeelCreatorOperationEnvelope({ batch: batch(), now: 100 });
  const key = creatorOperationRecoveryKey(state);
  assert.equal(matchesKeelCreatorOperationRecovery(state, key), true);
  assert.equal(selectKeelCreatorOperationRecovery([state], key).status, "matched");
  const cursorMismatch = { ...key, cursor: 1 };
  const mismatch = selectKeelCreatorOperationRecovery([state], cursorMismatch);
  assert.equal(mismatch.status, "mismatch");
  const ambiguous = selectKeelCreatorOperationRecovery([state, state], key);
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(selectKeelCreatorOperationRecovery([], key).status, "none");
});

test("journal parsing rejects impossible progress, forged calls, and malformed arrays", () => {
  const envelope = createKeelCreatorOperationEnvelope({ batch: batch(), now: 100 });
  for (const mutation of [
    { calls: [] },
    { operationCount: 0 },
    { cursor: 999 },
    { completedOperationIndexes: [1] },
    { completedOperationIndexes: [0, 0] },
    { walletRequest: { method: "wallet_sendCalls", params: [] } },
    { planDigest: `0x${"ff".repeat(32)}` },
    { factoryCall: { ...envelope.factoryCall, data: `0x${"00".repeat(4)}` } },
  ]) {
    assert.throws(() => parseKeelCreatorOperationEnvelope({ ...envelope, ...mutation }));
  }

  const receiptHash = `0x${"ac".repeat(32)}`;
  const successfulPrepared = {
    ...envelope,
    transactionHashes: [receiptHash],
    receipts: [{ transactionHash: receiptHash, status: "success", operationIndexes: [0] }],
  };
  assert.throws(() => parseKeelCreatorOperationEnvelope(successfulPrepared), /prepared creator retry/u);
  assert.throws(() => assertKeelCreatorSubmissionAllowed(successfulPrepared), /another wallet approval/u);

  const emptyReceiptIndexes = {
    ...envelope,
    status: "submitted",
    signing: "performed",
    submission: "submitted",
    walletBatchId: "wallet-batch-empty",
    walletBatchIds: ["wallet-batch-empty"],
    transactionHashes: [receiptHash],
    receipts: [{ transactionHash: receiptHash, status: "pending", operationIndexes: [] }],
  };
  assert.throws(() => parseKeelCreatorOperationEnvelope(emptyReceiptIndexes), /at least one reviewed operation/u);

  const failedWithoutBatch = {
    ...envelope,
    status: "failed",
    signing: "performed",
    submission: "submitted",
    lastError: "read-back failed",
  };
  assert.throws(() => parseKeelCreatorOperationEnvelope(failedWithoutBatch), /requires its active durable wallet batch/u);
});
