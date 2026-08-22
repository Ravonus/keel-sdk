import test from "node:test";
import assert from "node:assert/strict";

import {
  createIntegrity,
  utf8ToBytes,
} from "../packages/protocol/dist/index.js";
import {
  createViemEthereumAdapterCodecs,
  preflightEthereumKeelHoldOperations,
  prepareEthereumKeelHoldOperations,
  verifyEthereumKeelHoldReceipts,
} from "../packages/ethereum-adapter/dist/index.js";

const target = {
  family: "ethereum",
  chainId: 1,
  address: "0x1111111111111111111111111111111111111111",
};

async function readyResult() {
  const bytes = utf8ToBytes("hello");
  const integrity = await createIntegrity(bytes);
  const result = await prepareEthereumKeelHoldOperations({
    target,
    codecs: createViemEthereumAdapterCodecs(),
    plan: {
      schema: "keel-upload-plan@2",
      indexEncoding: "keel-object-index@1",
      objectName: "hello",
      mediaType: "text/plain",
      originalByteLength: bytes.byteLength,
      storedByteLength: bytes.byteLength,
      compression: "none",
      integrity,
      maxChildren: 128,
      chunks: [{ index: 0, offset: 0, byteLength: bytes.byteLength, integrity, file: "chunks/00000.bin" }],
    },
    chunks: { "chunks/00000.bin": bytes },
  });
  assert.equal(result.status, "ready-for-review");
  return result;
}

const pointer = "0x2222222222222222222222222222222222222222";

test("Ethereum read-only preflight is deterministic and never claims chain readiness", async () => {
  const ready = await readyResult();
  const reads = [];
  const client = {
    getCode: async (request) => {
      reads.push({ method: "getCode", request });
      return "0x60006000";
    },
    readContract: async (request) => {
      reads.push({ method: request.functionName, request });
      return pointer;
    },
  };
  const first = await preflightEthereumKeelHoldOperations(ready, client);
  const second = await preflightEthereumKeelHoldOperations(ready, client);
  assert.deepEqual(first, second);
  assert.equal(first.status, "passed");
  assert.equal(first.chainReady, false);
  assert.equal(first.signing, "not-performed");
  assert.equal(first.submission, "not-performed");
  assert.equal(first.checks[0].status, "present");
  assert.equal(first.checks[1].kind, "chunk-pointer");
  assert.equal(first.checks[1].status, "present");
  assert.equal(first.requests.length, 1);
  assert.equal(first.requests[0].operationId, ready.operations[1].operationId);
  assert.equal(first.requests[0].id, ready.operations[1].args[0][0]);
  assert.equal(reads.length, 4);
});

test("Ethereum preflight fails closed for absent code and unavailable reads", async () => {
  const ready = await readyResult();
  const missingCode = await preflightEthereumKeelHoldOperations(ready, {
    getCode: async () => "0x",
    readContract: async () => pointer,
  });
  assert.equal(missingCode.status, "blocked");
  assert.equal(missingCode.code, "contract-missing");

  const unavailable = await preflightEthereumKeelHoldOperations(ready, {
    getCode: async () => { throw new Error("offline"); },
    readContract: async () => pointer,
  });
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.code, "read-unavailable");
  assert.match(unavailable.issues[0], /offline/u);

  const deferred = await preflightEthereumKeelHoldOperations(
    await prepareEthereumKeelHoldOperations({
      target,
      plan: (await readyResult()).source,
      chunks: {},
    }),
    { getCode: async () => "0x6000", readContract: async () => pointer },
  );
  assert.equal(deferred.status, "deferred");
  assert.equal(deferred.code, "adapter-result-deferred");
});

test("Ethereum receipts bind every unsigned operation without signing or submission", async () => {
  const ready = await readyResult();
  const receipts = ready.operations.map((operation, index) => ({
    operationId: operation.operationId,
    transactionHash: `0x${String(index + 1).padStart(64, "0")}`,
    chainId: operation.chainId,
    to: operation.to,
    status: "success",
    blockNumber: 100 + index,
  }));
  const verified = verifyEthereumKeelHoldReceipts(ready, receipts);
  assert.equal(verified.status, "verified");
  assert.equal(verified.chainReady, false);
  assert.equal(verified.receipts.length, ready.operations.length);
  assert.equal(verified.signing, "not-performed");
  assert.equal(verified.submission, "not-performed");

  const mismatch = verifyEthereumKeelHoldReceipts(ready, [{ ...receipts[0], operationId: "other" }, receipts[1]]);
  assert.equal(mismatch.status, "failed");
  assert.equal(mismatch.code, "receipt-mismatch");
  const reverted = verifyEthereumKeelHoldReceipts(ready, [{ ...receipts[0], status: "reverted" }, receipts[1]]);
  assert.equal(reverted.status, "failed");
  assert.equal(reverted.code, "receipt-reverted");
  const unknown = verifyEthereumKeelHoldReceipts(ready, receipts.map((item, index) => index === 0 ? { ...item, extra: true } : item));
  assert.equal(unknown.status, "failed");
  assert.equal(unknown.code, "receipt-invalid");
});

test("Ethereum preflight and receipt verification reject forged empty adapter results", async () => {
  const ready = await readyResult();
  const forged = { ...ready, operations: [] };
  const preflight = await preflightEthereumKeelHoldOperations(forged, {
    getCode: async () => "0x6000",
    readContract: async () => pointer,
  });
  assert.equal(preflight.status, "deferred");
  assert.equal(preflight.code, "invalid-adapter-result");
  const receipts = verifyEthereumKeelHoldReceipts(forged, []);
  assert.equal(receipts.status, "failed");
  assert.equal(receipts.code, "receipt-invalid");
});

test("Ethereum preflight and receipts reject forged adapter flags, provenance, and call arguments", async () => {
  const ready = await readyResult();
  const client = { getCode: async () => "0x6000", readContract: async () => pointer };
  const forgedFlags = { ...ready, family: "tezos", chainReady: true, signing: "performed", submission: "submitted", caveat: "trust me" };
  const flagsPreflight = await preflightEthereumKeelHoldOperations(forgedFlags, client);
  assert.equal(flagsPreflight.status, "deferred");
  const flagsReceipts = verifyEthereumKeelHoldReceipts(forgedFlags, []);
  assert.equal(flagsReceipts.status, "failed");

  const missingContent = { ...ready, source: { planIntegrity: ready.source.planIntegrity } };
  const provenance = await preflightEthereumKeelHoldOperations(missingContent, client);
  assert.equal(provenance.status, "deferred");
  assert.equal(verifyEthereumKeelHoldReceipts(missingContent, []).status, "failed");

  const changedContent = {
    ...ready,
    source: {
      ...ready.source,
      contentIntegrity: { ...ready.source.contentIntegrity, digest: `0x${"00".repeat(32)}` },
    },
  };
  assert.equal((await preflightEthereumKeelHoldOperations(changedContent, client)).status, "deferred");
  assert.equal(verifyEthereumKeelHoldReceipts(changedContent, []).status, "failed");

  const changedPlan = {
    ...ready,
    source: {
      ...ready.source,
      planIntegrity: { ...ready.source.planIntegrity, digest: `0x${"11".repeat(32)}` },
    },
  };
  assert.equal((await preflightEthereumKeelHoldOperations(changedPlan, client)).status, "deferred");
  assert.equal(verifyEthereumKeelHoldReceipts(changedPlan, []).status, "failed");

  const badArguments = {
    ...ready,
    operations: ready.operations.map((operation, index) => index === 1 ? { ...operation, args: [["not-a-bytes32"]] } : operation),
  };
  const argsPreflight = await preflightEthereumKeelHoldOperations(badArguments, client);
  assert.equal(argsPreflight.status, "deferred");
  assert.equal(verifyEthereumKeelHoldReceipts(badArguments, []).status, "failed");

  for (const malformed of [null, undefined, [], "not-an-adapter-result"]) {
    assert.equal((await preflightEthereumKeelHoldOperations(malformed, client)).code, "invalid-adapter-result");
    assert.equal(verifyEthereumKeelHoldReceipts(malformed, []).code, "receipt-invalid");
  }

  const reversed = { ...ready, operations: [...ready.operations].reverse() };
  assert.equal((await preflightEthereumKeelHoldOperations(reversed, client)).code, "invalid-adapter-result");
  assert.equal(verifyEthereumKeelHoldReceipts(reversed, []).code, "receipt-invalid");

  const truncated = { ...ready, operations: ready.operations.map((operation) => operation.kind === "weldObject" ? { ...operation, data: "0xb17463a8" } : operation) };
  assert.equal((await preflightEthereumKeelHoldOperations(truncated, client)).code, "invalid-adapter-result");
  assert.equal(verifyEthereumKeelHoldReceipts(truncated, []).code, "receipt-invalid");

  const forgedBody = { ...ready, operations: ready.operations.map((operation) => operation.kind === "weldObject" ? { ...operation, data: `0xb17463a8${"00".repeat(292)}` } : operation) };
  assert.equal((await preflightEthereumKeelHoldOperations(forgedBody, client)).code, "invalid-adapter-result");
  assert.equal(verifyEthereumKeelHoldReceipts(forgedBody, []).code, "receipt-invalid");

  const forgedObjectId = { ...ready, operations: ready.operations.map((operation) => operation.kind === "weldObject" ? { ...operation, objectId: `0xbb${"00".repeat(31)}` } : operation) };
  assert.equal((await preflightEthereumKeelHoldOperations(forgedObjectId, client)).code, "invalid-adapter-result");
  assert.equal(verifyEthereumKeelHoldReceipts(forgedObjectId, []).code, "receipt-invalid");

  const codecs = createViemEthereumAdapterCodecs();
  const forgedArgs = {
    ...ready,
    operations: ready.operations.map((operation) => {
      if (operation.kind !== "weldObject") return operation;
      const args = [[`0x${"aa".repeat(32)}`], ...operation.args.slice(1)];
      return { ...operation, args, data: codecs.encodeFunctionData(operation.signature, args) };
    }),
  };
  assert.equal((await preflightEthereumKeelHoldOperations(forgedArgs, client)).code, "invalid-adapter-result");
  assert.equal(verifyEthereumKeelHoldReceipts(forgedArgs, []).code, "receipt-invalid");
});
