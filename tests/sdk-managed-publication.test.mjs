import assert from "node:assert/strict";
import test from "node:test";

import {
  actualEthereumTransactionFeeWei,
  buildKeelCarrierDispatchPlan,
  buildKeelPublicationOperationBatches,
  buildKeelPublicationJobManifest,
  encodeKeelPublicationOperationBatch,
  compareKeelGas,
  estimateEthereumCalldataIntrinsicGas,
  estimateKeelCalldataGas,
  estimateKeelNativePublicationGas,
  executorEscrowWei,
  fitsSingleKeelCalldataCarrier,
  findKeelCarrierReplayBlockers,
  isKeelPublicationCheckpoint,
  KEEL_PUBLICATION_JOB_MAX_OPERATION_BATCH,
  KEEL_PUBLICATION_JOB_WIRE_DOMAIN,
  mergeKeelPublicationCheckpoints,
  mergeKeelPublicationRecovery,
  normalizeFailedIndexes,
  reconcileKeelSubmittedTransaction,
  selectResumableKeelJobId,
  selectKeelManagedPublicationJob,
  uploadKeelStudioArtifact,
} from "../packages/sdk/dist/index.js";
import { ABIS as crossChainMintAbis } from "../packages/sdk/dist/abis/keel-cross-chain-mint.generated.js";
import { selectDoomInput } from "../scripts/verify-doom-managed-publication.mjs";

const address = (byte) => `0x${byte.repeat(40)}`;
const digest = (byte) => `0x${byte.repeat(64)}`;

const owner = address("1");
const executor = address("2");

test("Doom managed verification requires an explicit local container or Doom-specific source RPC", () => {
  assert.deepEqual(selectDoomInput({ KEEL_DOOM_STORED_INPUT_PATH: "/tmp/doom.bin.br" }), {
    kind: "stored-file",
    path: "/tmp/doom.bin.br",
  });
  assert.deepEqual(selectDoomInput({ KEEL_DOOM_SOURCE_RPC_URL: "https://doom-source.example" }), {
    kind: "source-rpc",
    url: "https://doom-source.example",
  });
  assert.throws(
    () => selectDoomInput({ KEEL_SEPOLIA_READ_RPC_URL: "https://ambient.example" }),
    /KEEL_DOOM_STORED_INPUT_PATH.*KEEL_DOOM_SOURCE_RPC_URL/u,
  );
});

function candidate(jobId, nextChunk, nextOperation, overrides = {}) {
  return {
    jobId: BigInt(jobId),
    owner,
    executor,
    planDigest: digest(String(jobId)),
    chunkCount: 61,
    operationCount: 2,
    nextChunk,
    nextOperation,
    deadline: 2_000n,
    open: true,
    ...overrides,
  };
}

function expected(...jobs) {
  return jobs.map((job) => ({ jobId: job.jobId, planDigest: job.planDigest }));
}

test("managed recovery selects the most advanced matching job, not the newest job id", () => {
  const job3 = candidate(3, 61, 1);
  const job4 = candidate(4, 0, 0);
  const result = selectKeelManagedPublicationJob({
    candidates: [job3, job4],
    owner,
    executor,
    chunkCount: 61,
    operationCount: 2,
    expectedPlanDigests: expected(job3, job4),
    evidenceJobIds: [3n],
    chainTimestamp: 1_000n,
  });

  assert.equal(result.status, "selected");
  assert.equal(result.job.jobId, 3n);
  assert.equal(result.completedChunks, 61);
  assert.equal(result.completedOperations, 1);
});

test("equally advanced duplicate jobs stop as ambiguous without unique durable evidence", () => {
  const job1 = candidate(1, 61, 1);
  const job2 = candidate(2, 61, 1);
  const result = selectKeelManagedPublicationJob({
    candidates: [job1, job2],
    owner,
    executor,
    chunkCount: 61,
    operationCount: 2,
    expectedPlanDigests: expected(job1, job2),
    evidenceJobIds: [],
    chainTimestamp: 1_000n,
  });

  assert.equal(result.status, "ambiguous");
  assert.deepEqual(result.jobIds, [1n, 2n]);
});

test("a closed fully completed job is recovered and never replaced", () => {
  const complete = candidate(7, 61, 2, { open: false });
  const result = selectKeelManagedPublicationJob({
    candidates: [complete],
    owner,
    executor,
    chunkCount: 61,
    operationCount: 2,
    expectedPlanDigests: expected(complete),
    evidenceJobIds: [7n],
    chainTimestamp: 3_000n,
  });

  assert.equal(result.status, "complete");
  assert.equal(result.job.jobId, 7n);
});

test("an expired incomplete match blocks a replacement approval", () => {
  const expired = candidate(8, 61, 1, { deadline: 999n });
  const result = selectKeelManagedPublicationJob({
    candidates: [expired],
    owner,
    executor,
    chunkCount: 61,
    operationCount: 2,
    expectedPlanDigests: expected(expired),
    evidenceJobIds: [8n],
    chainTimestamp: 1_000n,
  });

  assert.equal(result.status, "expired");
  assert.equal(result.job.jobId, 8n);
  assert.equal(result.completedOperations, 1);
});

test("a fresh duplicate cannot make recovery repeat chunks from a more advanced expired job", () => {
  const expiredProgress = candidate(3, 61, 1, { deadline: 999n });
  const freshDuplicate = candidate(4, 0, 0, { deadline: 2_000n });
  const result = selectKeelManagedPublicationJob({
    candidates: [expiredProgress, freshDuplicate],
    owner,
    executor,
    chunkCount: 61,
    operationCount: 2,
    expectedPlanDigests: expected(expiredProgress, freshDuplicate),
    evidenceJobIds: [4n],
    chainTimestamp: 1_000n,
  });

  assert.equal(result.status, "expired");
  assert.equal(result.job.jobId, 3n);
  assert.equal(result.completedChunks, 61);
});

test("equal progress chooses the only still-active job over expired duplicates", () => {
  const expired1 = candidate(1, 61, 1, { deadline: 999n });
  const expired2 = candidate(2, 61, 1, { deadline: 999n });
  const active = candidate(3, 61, 1, { deadline: 2_000n });
  const result = selectKeelManagedPublicationJob({
    candidates: [expired1, expired2, active],
    owner,
    executor,
    chunkCount: 61,
    operationCount: 2,
    expectedPlanDigests: expected(expired1, expired2, active),
    evidenceJobIds: [],
    chainTimestamp: 1_000n,
  });

  assert.equal(result.status, "selected");
  assert.equal(result.job.jobId, 3n);
});

test("recovery merges monotonically and preserves receipts plus explicit failed indexes", () => {
  const merged = mergeKeelPublicationRecovery(
    {
      jobId: "12",
      completedChunks: 10,
      completedOperations: 0,
      failedChunkIndexes: [4, 2],
      failedOperationIndexes: [],
      transactionHashes: [digest("a")],
    },
    {
      jobId: "9",
      completedChunks: 8,
      completedOperations: 1,
      failedChunkIndexes: [2, 5],
      failedOperationIndexes: [1],
      transactionHashes: [digest("b")],
    },
  );

  assert.equal(merged.jobId, "12");
  assert.equal(merged.completedChunks, 10);
  assert.equal(merged.completedOperations, 1);
  assert.deepEqual(merged.failedChunkIndexes, [2, 4, 5]);
  assert.deepEqual(merged.failedOperationIndexes, [1]);
  assert.deepEqual(merged.transactionHashes, [digest("a"), digest("b")]);
  assert.deepEqual(normalizeFailedIndexes([3, 3, -1, 2, 8], 5), [2, 3]);
});

test("managed checkpoints validate and merge only one immutable job plan", () => {
  const current = {
    storageMode: "native",
    jobPlanDigest: digest("c"),
    totalChunks: 61,
    completedChunks: 10,
    totalOperations: 2,
    completedOperations: 0,
    failedChunkIndexes: [10],
    failedOperationIndexes: [],
    actualTransactionFeeWei: "12",
  };
  const incoming = {
    ...current,
    completedChunks: 9,
    completedOperations: 1,
    failedChunkIndexes: [11],
    failedOperationIndexes: [1],
    actualTransactionFeeWei: "9",
  };
  assert.equal(isKeelPublicationCheckpoint(current), true);
  assert.deepEqual(mergeKeelPublicationCheckpoints(current, incoming), {
    ...incoming,
    completedChunks: 10,
    failedChunkIndexes: [10, 11],
    actualTransactionFeeWei: "12",
  });
  assert.throws(
    () => mergeKeelPublicationCheckpoints(current, { ...incoming, jobPlanDigest: digest("d") }),
    /different immutable job plans/u,
  );
});

test("a replacement plan cannot replay an equivalent immutable object operation", () => {
  const immutableOperationDigest = digest("a");
  const blockers = findKeelCarrierReplayBlockers({
    selected: { ...candidate(4, 0, 0), immutableOperationDigest },
    candidates: [
      { ...candidate(3, 61, 1), immutableOperationDigest },
      { ...candidate(2, 20, 0), immutableOperationDigest: digest("b") },
    ],
  });

  assert.deepEqual(blockers.map(({ jobId }) => jobId), [3n]);
});

test("native KEEL gas and executor escrow stay separate from calldata and reference prices", () => {
  const storedBytes = new Uint8Array(61 * 23_000).fill(1);
  const native = estimateKeelNativePublicationGas({
    storedByteLength: storedBytes.byteLength,
    storedBytes,
    contentObjectCount: 1,
    logicalOperationCount: 1,
  });
  assert.equal(native.chunkCount, 61);
  assert.equal(native.carrierTransactionCount, 21);
  assert.equal(native.calldataIntrinsicGas, 22_919_408);
  assert.equal(native.nativeCarrierWriteGas, 289_249_200);
  assert.equal(native.calldataIntrinsicGas + native.nativeCarrierWriteGas, 312_168_608);
  assert.equal(native.objectCreationGas, 150_000);
  assert.equal(native.logicalRegistryOperationGas, 150_000);
  assert.equal(native.executorControlGas, 0);
  assert.equal(native.totalExecutorGas, 312_468_608);

  const managed = estimateKeelNativePublicationGas({
    storedByteLength: 23_000,
    contentObjectCount: 1,
    logicalOperationCount: 0,
    includeExecutorControlGas: true,
  });
  assert.equal(managed.executorControlGas, 200_000);
  assert.equal(managed.totalExecutorGas, 5_557_008);

  const recursive = estimateKeelNativePublicationGas({
    storedByteLength: 46_000,
    storedBytes: new Uint8Array(46_000).fill(1),
    chunkByteLengths: [23_000, 11_500, 11_500],
    contentObjectCount: 2,
    logicalOperationCount: 1,
  });
  assert.equal(recursive.chunkCount, 3);
  assert.equal(recursive.carrierTransactionCount, 1);
  assert.equal(recursive.calldataIntrinsicGas + recursive.nativeCarrierWriteGas, 10_288_176);
  assert.throws(
    () => estimateKeelNativePublicationGas({
      storedByteLength: 46_000,
      chunkByteLengths: [23_000, 22_999],
      contentObjectCount: 2,
    }),
    /do not match the stored byte length/u,
  );

  const modularViewer = estimateKeelNativePublicationGas({
    storedByteLength: 1_679,
    storedBytes: new Uint8Array(1_679).fill(1),
    chunkByteLengths: [138, 1_541],
    contentObjectCount: 2,
    logicalOperationCount: 0,
    includeExecutorControlGas: true,
  });
  assert.equal(modularViewer.chunkCount, 2);
  assert.equal(modularViewer.carrierTransactionCount, 1);
  assert.equal(modularViewer.calldataIntrinsicGas, 49_116);
  assert.equal(modularViewer.nativeCarrierWriteGas, 477_916);
  assert.equal(modularViewer.totalExecutorGas, 1_027_032);

  const calldata = estimateEthereumCalldataIntrinsicGas({
    bytes: Uint8Array.from([0, 1, 255]),
    transactionCount: 2,
    envelopeByteLengthPerTransaction: 4,
    envelopeZeroByteCountPerTransaction: 1,
  });
  assert.equal(calldata.transactionBaseGas, 42_000);
  assert.equal(calldata.calldataByteGas, 140);
  assert.equal(calldata.calldataIntrinsicGas, 42_140);

  const selectedSepoliaGasPrice = 1_049_205_228n;
  assert.equal(
    executorEscrowWei(native.totalExecutorGas, selectedSepoliaGasPrice),
    BigInt(native.totalExecutorGas) * selectedSepoliaGasPrice,
  );
  assert.equal(actualEthereumTransactionFeeWei(123_456n, 1_000_000_000n), 123_456_000_000_000n);
});

test("managed manifest commits one approval to ordered carriers and operations", () => {
  assert.equal(KEEL_PUBLICATION_JOB_WIRE_DOMAIN, "stratus-publication-job@3");
  const manifest = buildKeelPublicationJobManifest({
    owner,
    executor,
    deadline: 2_000n,
    carrierBatches: [["0x0102", "0x03"], ["0x0405"]],
    operations: [{ target: address("3"), data: "0xabcdef", value: 0n }],
  });
  assert.equal(manifest.chunkDigests.length, 3);
  assert.equal(manifest.operationDigests.length, 1);
  assert.deepEqual(manifest.allowedTargets, [address("3")]);
  assert.match(manifest.planDigest, /^0x[0-9a-f]{64}$/u);
  assert.equal(
    buildKeelPublicationJobManifest({
      owner,
      executor,
      deadline: 2_000n,
      carrierBatches: [["0x0102", "0x03"], ["0x0405"]],
      operations: [{ target: address("3"), data: "0xabcdef", value: 0n }],
    }).planDigest,
    manifest.planDigest,
  );
});

test("carrier waves start at the confirmed cursor and remain bounded", () => {
  const batches = [["0x01", "0x02", "0x03"], ["0x04", "0x05", "0x06"], ["0x07"]];
  assert.deepEqual(buildKeelCarrierDispatchPlan({
    batches,
    nextChunk: 2,
    startingNonce: 9,
    maximumTransactions: 2,
  }), [
    { batchIndex: 0, firstChunk: 2, lastChunkExclusive: 3, payloads: ["0x03"], nonce: 9 },
    { batchIndex: 1, firstChunk: 3, lastChunkExclusive: 6, payloads: ["0x04", "0x05", "0x06"], nonce: 10 },
  ]);
  assert.throws(
    () => buildKeelCarrierDispatchPlan({ batches, nextChunk: 8, startingNonce: 0 }),
    /cursor exceeds/u,
  );
});

test("packed operation waves remain contiguous, bounded at four, and encode without a chain write", () => {
  const operations = Array.from({ length: 9 }, (_, index) => ({
    target: address("3"),
    data: `0x${index.toString(16).padStart(2, "0")}`,
  }));
  assert.equal(KEEL_PUBLICATION_JOB_MAX_OPERATION_BATCH, 4);
  const wave = buildKeelPublicationOperationBatches({
    operations,
    nextOperation: 0,
    startingNonce: 12,
    maximumTransactions: 2,
  });
  assert.deepEqual(wave.map(({ firstOperation, lastOperationExclusive, nonce, method, route, operations: batch }) => ({
    firstOperation,
    lastOperationExclusive,
    nonce,
    method,
    route,
    count: batch.length,
  })), [
    { firstOperation: 0, lastOperationExclusive: 4, nonce: 12, method: "executeOperations", route: "packed-v2", count: 4 },
    { firstOperation: 4, lastOperationExclusive: 8, nonce: 13, method: "executeOperations", route: "packed-v2", count: 4 },
  ]);
  assert.equal(wave[0].targets.length, 4);
  assert.deepEqual(wave[0].values, [0n, 0n, 0n, 0n]);
  assert.equal(Object.isFrozen(wave), true);
  assert.equal(Object.isFrozen(wave[0]), true);
  const packedCalldata = encodeKeelPublicationOperationBatch({ jobId: 7n, batch: wave[0] });
  assert.match(packedCalldata, /^0x[0-9a-f]+$/u);
  assert.equal(packedCalldata.slice(0, 10), "0xc3df48b6");

  const resumed = buildKeelPublicationOperationBatches({
    operations,
    nextOperation: 8,
    startingNonce: 20,
  });
  assert.deepEqual(resumed.map(({ firstOperation, lastOperationExclusive }) => ({ firstOperation, lastOperationExclusive })), [
    { firstOperation: 8, lastOperationExclusive: 9 },
  ]);
  assert.deepEqual(resumed[0].operationData, ["0x08"]);
  assert.throws(
    () => buildKeelPublicationOperationBatches({ operations, nextOperation: 0, startingNonce: 0, maximumOperationsPerTransaction: 5 }),
    /cannot exceed 4 operations/u,
  );
  assert.throws(
    () => buildKeelPublicationOperationBatches({ operations, nextOperation: 10, startingNonce: 0 }),
    /cursor exceeds/u,
  );
});

test("explicit v1 operation fallback emits one contiguous executeOperation call per transaction", () => {
  const operations = [
    { target: address("4"), value: 2n, data: "0x01" },
    { target: address("5"), data: "0x02" },
    { target: address("6"), data: "0x03" },
  ];
  const fallback = buildKeelPublicationOperationBatches({
    operations,
    nextOperation: 1,
    startingNonce: 4,
    route: "single-v1",
    maximumTransactions: 2,
  });
  assert.deepEqual(fallback.map(({ firstOperation, lastOperationExclusive, method, route }) => ({
    firstOperation,
    lastOperationExclusive,
    method,
    route,
    count: fallback.find((batch) => batch.firstOperation === firstOperation).operations.length,
  })), [
    { firstOperation: 1, lastOperationExclusive: 2, method: "executeOperation", route: "single-v1", count: 1 },
    { firstOperation: 2, lastOperationExclusive: 3, method: "executeOperation", route: "single-v1", count: 1 },
  ]);
  assert.equal(fallback[0].values[0], 0n);
  assert.equal(encodeKeelPublicationOperationBatch({ jobId: 9n, batch: fallback[0] }).slice(0, 10), "0x26a18b61");
});

test("generated publication-job ABI exposes packed operations alongside the v1 entrypoint", () => {
  const names = crossChainMintAbis.KeelPublicationJob
    .filter((item) => item.type === "function")
    .map((item) => item.name);
  assert.equal(names.includes("executeOperation"), true);
  assert.equal(names.includes("executeOperations"), true);
  assert.equal(names.includes("MAX_OPERATION_BATCH"), true);
});

test("saved receipts recover a job id without authorizing a duplicate", () => {
  assert.equal(selectResumableKeelJobId({ savedJobId: "4", confirmedJobIds: [3n] }), 3n);
  assert.equal(selectResumableKeelJobId({ savedJobId: "4", confirmedJobIds: [] }), 4n);
  assert.throws(
    () => selectResumableKeelJobId({ confirmedJobIds: [3n, 4n] }),
    /ambiguous.*No new wallet approval/iu,
  );
});

test("submission timeouts reconcile receipts before any retry", () => {
  const transactionHash = digest("e");
  assert.deepEqual(reconcileKeelSubmittedTransaction({ transactionHash }), {
    status: "pending",
    transactionHash,
  });
  assert.deepEqual(reconcileKeelSubmittedTransaction({
    transactionHash,
    receipt: {
      transactionHash,
      status: "success",
      blockNumber: 10n,
      gasUsed: 100n,
      effectiveGasPrice: 3n,
    },
  }), {
    status: "confirmed",
    transactionHash,
    blockNumber: 10n,
    actualTransactionFeeWei: 300n,
  });
});

test("calldata estimates remain distinct from native carrier writes", () => {
  const bytes = Uint8Array.from([0, 1, 2, 0]);
  const estimate = estimateKeelCalldataGas({
    bytes,
    carrierCount: 1,
    envelopeByteLength: 2,
    envelopeZeroByteCount: 1,
  });
  assert.equal(estimate.totalIntrinsicGas, 21_060);
  assert.equal(fitsSingleKeelCalldataCarrier({ bytes, gasLimit: 21_060, envelopeByteLength: 2, envelopeZeroByteCount: 1 }), true);
  assert.deepEqual(compareKeelGas(100, 75), {
    baselineGas: 100,
    candidateGas: 75,
    savedGas: 25,
    savedPercent: 25,
  });
});

test("SDK artifact upload uses the server token without any wallet action", async () => {
  const formData = new FormData();
  formData.set("creatorAddress", owner);
  formData.set("name", "Doom upload test");
  let captured;
  const uploaded = await uploadKeelStudioArtifact({
    endpoint: "https://keel.invalid/api/artifacts",
    formData,
    writeToken: "test-write-token",
    fetchImplementation: async (endpoint, init) => {
      captured = { endpoint: String(endpoint), init };
      return new Response(JSON.stringify({ id: "artifact-1" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.deepEqual(uploaded, { id: "artifact-1" });
  assert.equal(captured.endpoint, "https://keel.invalid/api/artifacts");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.body, formData);
  assert.equal(captured.init.headers["x-keel-studio-write-token"], "test-write-token");
});

test("browser artifact upload uses session cookies and reports bounded progress", async () => {
  const original = globalThis.XMLHttpRequest;
  const events = [];
  let request;
  class FakeXmlHttpRequest {
    response = { id: "browser-artifact" };
    status = 201;
    upload = { addEventListener: (name, listener) => events.push([`upload:${name}`, listener]) };
    addEventListener(name, listener) { events.push([name, listener]); }
    open(method, endpoint) { this.method = method; this.endpoint = endpoint; }
    send(formData) {
      this.formData = formData;
      events.find(([name]) => name === "upload:progress")[1]({ lengthComputable: true, loaded: 3, total: 4 });
      events.find(([name]) => name === "load")[1]();
    }
  }
  globalThis.XMLHttpRequest = class extends FakeXmlHttpRequest {
    constructor() { super(); request = this; }
  };
  try {
    const formData = new FormData();
    const progress = [];
    const uploaded = await uploadKeelStudioArtifact({
      endpoint: "/api/artifacts",
      formData,
      onProgress: (value) => progress.push(value),
    });
    assert.deepEqual(uploaded, { id: "browser-artifact" });
    assert.equal(request.method, "POST");
    assert.equal(request.endpoint, "/api/artifacts");
    assert.equal(request.formData, formData);
    assert.deepEqual(progress, [75]);
  } finally {
    if (original === undefined) delete globalThis.XMLHttpRequest;
    else globalThis.XMLHttpRequest = original;
  }
});
