import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { decodeFunctionData, parseAbi } from "viem";

import {
  buildKeelHistoryVerificationBundle,
  buildKeelHistoryInscriptionBatches,
  buildKeelPublicationPlan,
  computeKeelHistoryPublicationCommitmentDigest,
  computeKeelHistoryBatchDigest,
  encodeKeelHistoryPublicationOpen,
  encodeKeelHistoryInscriptionBatch,
  estimateEthereumCalldataIntrinsicGasWithEip7623,
  KEEL_EIP_7825_TRANSACTION_GAS_CAP,
  KEEL_HISTORY_INSCRIPTION_STORAGE_MODE,
  KEEL_HISTORY_INSCRIPTION_V1,
  KEEL_NATIVE_CARRIER_V1,
  keelHistoryPublicationJobAbi,
  keelPublicationJobAbi,
  parseKeelWakeUri,
  reconstructKeelHistoryStoredBytes,
  replayKeelHistoryExecutorRotations,
  selectKeelPublicationStorageMode,
  verifyKeelHistoryVerificationBundle,
  buildKeelWakeUri,
} from "../packages/sdk/dist/index.js";

const address = (byte) => `0x${byte.repeat(40)}`;
const sha256 = (bytes) => `0x${createHash("sha256").update(bytes).digest("hex")}`;
const owner = address("1");
const executor = address("2");
const target = address("3");

test("storage selection is strict and defaults only when omitted", () => {
  assert.equal(selectKeelPublicationStorageMode(), KEEL_NATIVE_CARRIER_V1);
  assert.equal(selectKeelPublicationStorageMode(KEEL_HISTORY_INSCRIPTION_V1), KEEL_HISTORY_INSCRIPTION_V1);
  assert.throws(() => selectKeelPublicationStorageMode("native"), /Unsupported KEEL publication storage mode/u);
  assert.throws(() => selectKeelPublicationStorageMode("calldata"), /Unsupported KEEL publication storage mode/u);
});

test("publication ABIs expose terminal and history control evidence", () => {
  assert.ok(keelPublicationJobAbi.includes("event JobCancelled(uint256 indexed jobId,address indexed owner,uint256 refund)"));
  for (const signature of [
    "function openPublication(uint256 expectedPublicationId,bytes32 storageMode,address executor,uint64 deadline",
    "function publishBatch(uint256 publicationId,bytes32 storageMode,bytes32 planDigest",
    "function finalizePublication(uint256 publicationId,bytes32 storageMode,bytes32 planDigest)",
    "function getPublication(uint256 publicationId) view returns",
    "function chunkDigest(uint256 publicationId,uint256 index) view returns (bytes32)",
    "function batchChunkCount(uint256 publicationId,uint256 index) view returns (uint256)",
    "event HistoryPublicationCancelled(",
    "event HistoryPublicationExecutorRotated(",
  ]) assert.ok(keelHistoryPublicationJobAbi.some((entry) => entry.startsWith(signature)), signature);
});

test("history planner commits SHA-256 chunks, exact batch ordering, and explicit mode", async () => {
  const storedBytes = new Uint8Array(23_000 * 3 + 17);
  storedBytes.fill(7);
  const plan = await buildKeelPublicationPlan({
    storageMode: KEEL_HISTORY_INSCRIPTION_V1,
    owner,
    executor,
    deadline: 2_000n,
    decodedDigest: sha256(storedBytes),
    storedDigest: sha256(storedBytes),
    decodedByteLength: storedBytes.byteLength,
    storedBytes,
    compression: "none",
    mediaType: "application/octet-stream",
    operations: [{ target, data: "0x", value: 0n }],
    history: { chainId: 31337, coordinator: address("c"), publicationIdForQuote: 42n },
  });

  assert.equal(plan.storageMode, KEEL_HISTORY_INSCRIPTION_V1);
  assert.equal(plan.commitment.storageMode, KEEL_HISTORY_INSCRIPTION_V1);
  assert.equal(plan.historyBatches.length, 2);
  assert.deepEqual(plan.historyBatches.map((batch) => batch.orderedChunkCount), [3, 1]);
  assert.deepEqual(plan.commitment.batchChunkCounts, [3, 1]);
  assert.equal(plan.commitment.chunkDigests.length, 4);
  assert.equal(
    plan.commitment.commitmentDigest,
    computeKeelHistoryPublicationCommitmentDigest({
      owner,
      executor,
      chainId: 31337,
      coordinator: address("c"),
      publicationId: 42n,
      planDigest: plan.planDigest,
      decodedDigest: plan.decodedDigest,
      storedDigest: plan.storedDigest,
      decodedByteLength: plan.commitment.decodedByteLength,
      storedByteLength: plan.commitment.storedByteLength,
      compression: plan.commitment.compressionCode,
      mediaTypeHash: plan.commitment.mediaTypeHash,
      chunkDigests: plan.commitment.chunkDigests,
      batchChunkCounts: plan.commitment.batchChunkCounts,
    }),
  );
  assert.ok(plan.gas.totalExecutorGas > plan.gas.chargedCalldataIntrinsicGas);
  assert.ok(plan.gas.batches.every((batch) => batch.totalBatchGas < KEEL_EIP_7825_TRANSACTION_GAS_CAP));
  assert.equal(plan.historyOpenTransactionInput, encodeKeelHistoryPublicationOpen({
    expectedPublicationId: 42n,
    executor,
    deadline: 2_000n,
    planDigest: plan.planDigest,
    decodedDigest: plan.decodedDigest,
    storedDigest: plan.storedDigest,
    decodedByteLength: storedBytes.byteLength,
    storedByteLength: storedBytes.byteLength,
    compression: 0,
    mediaTypeHash: plan.commitment.mediaTypeHash,
    chunkDigests: plan.commitment.chunkDigests,
    batchChunkCounts: plan.commitment.batchChunkCounts,
  }));
  const decodedOpen = decodeFunctionData({
    abi: parseAbi([
      "function openPublication(uint256 expectedPublicationId,bytes32 storageMode,address executor,uint64 deadline,bytes32 planDigest,bytes32 decodedDigest,bytes32 storedDigest,uint64 decodedByteLength,uint64 storedByteLength,uint8 compression,bytes32 mediaTypeHash,bytes32[] chunkDigests,uint8[] batchChunkCounts) payable returns (uint256 publicationId)",
    ]),
    data: plan.historyOpenTransactionInput,
  });
  assert.equal(decodedOpen.args[0], 42n, "open calldata must bind the quoted nextPublicationId");
  assert.notEqual(
    plan.historyOpenTransactionInput,
    encodeKeelHistoryPublicationOpen({
      expectedPublicationId: 43n,
      executor,
      deadline: 2_000n,
      planDigest: plan.planDigest,
      decodedDigest: plan.decodedDigest,
      storedDigest: plan.storedDigest,
      decodedByteLength: storedBytes.byteLength,
      storedByteLength: storedBytes.byteLength,
      compression: 0,
      mediaTypeHash: plan.commitment.mediaTypeHash,
      chunkDigests: plan.commitment.chunkDigests,
      batchChunkCounts: plan.commitment.batchChunkCounts,
    }),
    "a competing open must require replanning/reconciliation rather than retargeting batch calldata",
  );

  const first = plan.historyBatches[0];
  const decoded = decodeFunctionData({
    abi: [{
      type: "function",
      name: "publishBatch",
      stateMutability: "nonpayable",
      inputs: [
        { name: "publicationId", type: "uint256" },
        { name: "storageMode", type: "bytes32" },
        { name: "planDigest", type: "bytes32" },
        { name: "batchIndex", type: "uint256" },
        { name: "firstChunkIndex", type: "uint256" },
        { name: "storedByteOffset", type: "uint256" },
        { name: "payloads", type: "bytes[]" },
      ],
      outputs: [],
    }],
    data: first.transactionInput,
  });
  assert.equal(decoded.functionName, "publishBatch");
  assert.equal(decoded.args[0], 42n);
  assert.equal(decoded.args[1], KEEL_HISTORY_INSCRIPTION_STORAGE_MODE);
  assert.equal(decoded.args[2], plan.planDigest);
  assert.deepEqual(decoded.args[6], first.payloads);
  assert.equal(first.transactionInput, encodeKeelHistoryInscriptionBatch({ publicationId: 42n, planDigest: plan.planDigest, batch: first }));
});

test("history verification reconstructs from chain evidence without plan preimages", async () => {
  const storedBytes = Uint8Array.from({ length: 91 }, (_, index) => index);
  const plan = await buildKeelPublicationPlan({
    storageMode: KEEL_HISTORY_INSCRIPTION_V1,
    owner,
    executor,
    deadline: 2_000n,
    decodedDigest: sha256(storedBytes),
    storedDigest: sha256(storedBytes),
    decodedByteLength: storedBytes.byteLength,
    storedBytes,
    compression: "none",
    mediaType: "application/octet-stream",
    history: { chainId: 31337, coordinator: address("c"), publicationIdForQuote: 0n },
  });
  const full = buildKeelHistoryVerificationBundle(plan);
  const chainOnly = {
    storageMode: full.storageMode,
    chainId: full.chainId,
    coordinator: full.coordinator,
    publicationId: full.publicationId,
    owner: full.owner,
    executor: full.executor,
    planDigest: full.planDigest,
    commitmentDigest: full.commitmentDigest,
    storedDigest: full.storedDigest,
    decodedDigest: full.decodedDigest,
    storedByteLength: full.storedByteLength,
    decodedByteLength: full.decodedByteLength,
    compression: full.compression,
    mediaTypeHash: full.mediaTypeHash,
    chunkDigests: full.chunkDigests,
    batchChunkCounts: full.batchChunkCounts,
    batches: full.batches.map(({ batchDigest, ...batch }) => batch),
  };
  assert.deepEqual(reconstructKeelHistoryStoredBytes(chainOnly), storedBytes);
  const verified = await verifyKeelHistoryVerificationBundle({ bundle: chainOnly, decodedBytes: storedBytes });
  assert.equal(verified.storedVerified, true);
  assert.equal(verified.decodedVerified, true);
  assert.equal(computeKeelHistoryBatchDigest(full.batches[0]), full.batches[0].batchDigest);

  const corrupted = {
    ...chainOnly,
    batches: chainOnly.batches.map((batch, index) => index === 0
      ? { ...batch, payloads: [`0x${"ff".repeat(91)}`] }
      : batch),
  };
  await assert.rejects(() => verifyKeelHistoryVerificationBundle({ bundle: corrupted }), /corrupt SHA-256 chunk/u);
  const wrongLength = {
    ...chainOnly,
    batches: chainOnly.batches.map((batch, index) => index === 0
      ? { ...batch, storedByteLength: batch.storedByteLength + 1 }
      : batch),
  };
  await assert.rejects(() => verifyKeelHistoryVerificationBundle({ bundle: wrongLength }), /byte lengths/u);
});

test("history planning fails closed without chain identity or with a stale stored digest", async () => {
  const storedBytes = Uint8Array.from([1, 2, 3]);
  const base = {
    storageMode: KEEL_HISTORY_INSCRIPTION_V1,
    owner,
    executor,
    deadline: 2_000n,
    decodedDigest: sha256(storedBytes),
    storedDigest: sha256(storedBytes),
    decodedByteLength: storedBytes.byteLength,
    storedBytes,
    compression: "none",
    mediaType: "application/octet-stream",
  };
  await assert.rejects(() => buildKeelPublicationPlan(base), /chainId, coordinator, and a read-only nextPublicationId/u);
  await assert.rejects(() => buildKeelPublicationPlan({
    ...base,
    storedDigest: sha256(Uint8Array.from([9, 9, 9])),
    history: { chainId: 31337, coordinator: address("c"), publicationIdForQuote: 0n },
  }), /stored digest does not match/u);
  assert.throws(() => computeKeelHistoryPublicationCommitmentDigest({
    chainId: 0,
    coordinator: address("c"),
    publicationId: 0n,
    owner,
    executor,
    planDigest: sha256(storedBytes),
    decodedDigest: sha256(storedBytes),
    storedDigest: sha256(storedBytes),
    decodedByteLength: storedBytes.byteLength,
    storedByteLength: storedBytes.byteLength,
    compression: 0,
    mediaTypeHash: sha256(storedBytes),
    chunkDigests: [sha256(storedBytes)],
    batchChunkCounts: [1],
  }), /chain ID must be positive/u);
});

test("history executor rotations replay against immutable initial authority", () => {
  const rotated = replayKeelHistoryExecutorRotations({
    publicationId: 7n,
    owner,
    initialExecutor: executor,
    rotations: [{
      publicationId: 7n,
      owner,
      previousExecutor: executor,
      newExecutor: target,
      nextBatch: 1,
      nextChunk: 3,
      nextStoredOffset: 69_000,
    }],
  });
  assert.equal(rotated, target);
  assert.throws(() => replayKeelHistoryExecutorRotations({
    publicationId: 7n,
    owner,
    initialExecutor: executor,
    rotations: [{
      publicationId: 7n,
      owner,
      previousExecutor: address("4"),
      newExecutor: target,
      nextBatch: 1,
      nextChunk: 3,
      nextStoredOffset: 69_000,
    }],
  }), /conflicting/u);
});

test("history batches enforce the contract three-chunk and 4096-chunk bounds", () => {
  const digest = `0x${"1".repeat(64)}`;
  const bytes = new Uint8Array(4);
  assert.throws(() => buildKeelHistoryInscriptionBatches({
    storedBytes: bytes,
    chunkByteLength: 1,
    chunksPerBatch: 4,
    chunkDigests: [digest, digest, digest, digest],
  }), /more than three chunks/u);
  assert.throws(() => buildKeelHistoryInscriptionBatches({
    storedBytes: new Uint8Array(4_097),
    chunkByteLength: 1,
    chunkDigests: Array.from({ length: 4_097 }, () => digest),
  }), /4096 chunks/u);
});

test("EIP-7623 quote places execution inside the standard branch", () => {
  const payload = Uint8Array.from([1, 2, 3]);
  const floorDominant = estimateEthereumCalldataIntrinsicGasWithEip7623({ bytes: payload, executionGas: 0 });
  assert.equal(floorDominant.calldataFloorApplied, true);
  assert.equal(floorDominant.chargedTotalGas, floorDominant.floorTotalGas);
  const executionDominant = estimateEthereumCalldataIntrinsicGasWithEip7623({ bytes: payload, executionGas: 10_000 });
  assert.equal(executionDominant.calldataFloorApplied, false);
  assert.equal(executionDominant.chargedTotalGas, executionDominant.standardTotalGas + 10_000);
});

test("KEEL Wake URI is canonical and keeps ord:// separate", () => {
  const coordinator = address("a");
  const uri = buildKeelWakeUri({ chainId: 1, coordinator, publicationId: 42n });
  assert.equal(uri, `keel://wake/eip155/1/${coordinator}/42`);
  assert.deepEqual(parseKeelWakeUri(uri), { kind: "object", chainId: 1, coordinator, publicationId: 42n });
  const chunkUri = buildKeelWakeUri({ kind: "chunk", chainId: 1, coordinator, publicationId: 42n, chunkIndex: 3n });
  assert.equal(chunkUri, `keel://wake/eip155/1/${coordinator}/42/chunk/3`);
  assert.deepEqual(parseKeelWakeUri(chunkUri), { kind: "chunk", chainId: 1, coordinator, publicationId: 42n, chunkIndex: 3n });
  for (const invalid of [
    `keel://wake/eip155/01/${coordinator}/42`,
    `keel://wake/eip155/1/${coordinator.toUpperCase()}/42`,
    `keel://wake/eip155/1/${coordinator}/042`,
    `keel://wake/eip155/0/${coordinator}/42`,
    `keel://wake/eip155/1/${coordinator}/42?archive=1`,
    `keel://wake/eip155/1/${coordinator}/42/chunk/01`,
    `keel://wake/eip155/1/${coordinator}/42/chunk/-1`,
    `keel://wake/eip155/1/${coordinator}/42/chunk/3/`,
    `keel://wake/other/1/${coordinator}/42`,
  ]) assert.throws(() => parseKeelWakeUri(invalid), /Invalid KEEL Wake URI|canonical/u);
});
