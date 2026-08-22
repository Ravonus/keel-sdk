import test from "node:test";
import assert from "node:assert/strict";

import { createIntegrity, utf8ToBytes } from "../packages/protocol/dist/index.js";
import {
  createKeelPublishReviewPlan,
  parseKeelPublishReviewPlan,
  verifyKeelPublishReviewPlan,
} from "../packages/sdk/dist/index.js";

async function commitment(bytes) {
  return createIntegrity(utf8ToBytes(bytes));
}

async function chainPlan() {
  const bytes = "hello";
  const integrity = await commitment(bytes);
  return {
    schema: "keel-chain-operation-plan@1",
    status: "review-only",
    materialized: true,
    descriptorMaterialized: true,
    chainReady: false,
    target: { family: "ethereum", network: 1, address: "0x1111111111111111111111111111111111111111" },
    sourcePlan: { path: "materialized/upload-plan.json", schema: "oca-upload-plan@2", objectName: "hello", mediaType: "text/plain", integrity },
    operations: [
      {
        kind: "castSlugs",
        function: "castSlugs(bytes[])",
        payloadEncoding: "raw-bytes-from-files",
        chunkFiles: ["chunks/00000.bin"],
        chunkByteLengths: [5],
        chunkIntegrities: [integrity],
        slugIds: "derived-keccak256-after-review",
      },
      {
        kind: "weldObject",
        function: "weldObject(bytes32[],bytes32,uint64,uint8,string)",
        slugIds: "from-preceding-castSlugs",
        digest: integrity,
        byteLength: 5,
        compression: "none",
        mediaType: "text/plain",
      },
    ],
    encoding: "deferred-contract-abi",
    walletApproval: "required",
    signing: "not-performed",
    submission: "not-performed",
    caveat: "Operation descriptors are verified against local chunk files; a wallet or chain adapter must encode, review, sign, and submit them.",
  };
}

test("publish review plans normalize deterministically and verify their canonical envelope", async () => {
  const envelope = await createKeelPublishReviewPlan(await chainPlan());
  assert.equal(envelope.plan.protocol, "keel-publish-plan@1");
  assert.equal(envelope.plan.chainReady, false);
  assert.equal(envelope.plan.target.chainId, 1);
  assert.equal(envelope.plan.operationCount, 2);
  assert.equal(envelope.plan.operations[0].descriptor.chunkCount, 1);
  assert.equal(envelope.plan.operations[0].descriptor.chunkFiles, undefined);
  assert.equal(envelope.plan.source.path, undefined);
  assert.equal((await verifyKeelPublishReviewPlan(envelope)).valid, true);
  assert.deepEqual(parseKeelPublishReviewPlan(envelope.plan), envelope.plan);
  const repeated = await createKeelPublishReviewPlan(await chainPlan());
  assert.deepEqual(repeated, envelope);
});

test("publish review plans reject Tezos generic descriptors and unsafe operation metadata", async () => {
  const source = await chainPlan();
  await assert.rejects(() => createKeelPublishReviewPlan({ ...source, target: { ...source.target, family: "tezos", network: "ghostnet", address: "KT1AaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaA" } }), /contract-specific adapter/u);
  await assert.rejects(() => createKeelPublishReviewPlan({ ...source, operations: [{ ...source.operations[0], chunkFiles: ["../escape.bin"] }, source.operations[1]] }), /safe relative path/u);
  await assert.rejects(() => createKeelPublishReviewPlan({ ...source, operations: [{ ...source.operations[0], unknown: true }, source.operations[1]] }), /not supported/u);
  await assert.rejects(() => createKeelPublishReviewPlan({ ...source, target: { ...source.target, chainId: 999 }, operations: source.operations }), /disagree/u);
  await assert.rejects(() => createKeelPublishReviewPlan({ ...source, caveat: null }), /caveat/u);
  await assert.rejects(() => createKeelPublishReviewPlan({ ...source, operations: [{ ...source.operations[0], chunkFiles: ["chunks//00000.bin"] }, source.operations[1]] }), /safe relative path/u);
  await assert.rejects(() => createKeelPublishReviewPlan({ ...source, operations: [{ ...source.operations[0], chunkCount: 2 }, source.operations[1]] }), /chunkCount/u);
  await assert.rejects(() => createKeelPublishReviewPlan({ ...source, operations: [source.operations[1]] }), /castSlugs/u);
  await assert.rejects(() => createKeelPublishReviewPlan({ ...source, operations: [source.operations[1], source.operations[0]] }), /castSlugs/u);
  await assert.rejects(() => createKeelPublishReviewPlan({ ...source, operations: [source.operations[0], { ...source.operations[1], objectId: "not-a-bytes32" }] }), /flat source/u);
  const fakeSource = { algorithm: "sha256", digest: `0x${"1".repeat(64)}`, byteLength: 1 };
  const fakeObject = { algorithm: "sha256", digest: `0x${"2".repeat(64)}`, byteLength: 2 };
  await assert.rejects(() => createKeelPublishReviewPlan({ ...source, sourcePlan: { ...source.sourcePlan, integrity: fakeSource }, operations: [source.operations[0], { ...source.operations[1], digest: fakeObject, byteLength: 2, mediaType: "image/png" }] }), /mediaType|integrity|byteLength/u);
  await assert.rejects(() => createKeelPublishReviewPlan({ ...source, operations: [{ ...source.operations[0], chunkByteLengths: [1], chunkIntegrities: [{ ...source.operations[0].chunkIntegrities[0], byteLength: 1 }] }, source.operations[1]] }), /stored chunk lengths/u);
});

test("publish review plans close the recursive logical graph before wrapping", async () => {
  const source = await chainPlan();
  const leaf = { ...source.operations[1], objectId: "leaf" };
  const composite = {
    kind: "weldComposite",
    function: "weldComposite(bytes32[],bytes32,uint64,string)",
    objectId: "root",
    partObjectIds: ["leaf"],
    digest: source.sourcePlan.integrity,
    byteLength: 5,
    mediaType: "text/plain",
  };
  const recursive = { ...source, sourcePlan: { ...source.sourcePlan, schema: "oca-recursive-upload-plan@2" }, operations: [source.operations[0], leaf, composite] };
  const wrapped = await createKeelPublishReviewPlan(recursive);
  assert.equal(wrapped.plan.source.schema, "oca-recursive-upload-plan@2");
  await assert.rejects(() => createKeelPublishReviewPlan({ ...recursive, operations: [source.operations[0], leaf, { ...composite, partObjectIds: ["ghost"] }] }), /unknown|forward/u);
  await assert.rejects(() => createKeelPublishReviewPlan({ ...recursive, operations: [source.operations[0], leaf, { ...composite, partObjectIds: ["root"] }] }), /unknown|forward|self/u);
  await assert.rejects(() => createKeelPublishReviewPlan({ ...recursive, operations: [source.operations[0], leaf, composite, { ...composite, objectId: "root-2" }] }), /unreachable|root/u);
});

test("publish review plan verification fails closed on envelope and nested tampering", async () => {
  const envelope = await createKeelPublishReviewPlan(await chainPlan());
  const targetTamper = { ...envelope, plan: { ...envelope.plan, target: { ...envelope.plan.target, chainId: 10 } } };
  assert.equal((await verifyKeelPublishReviewPlan(targetTamper)).valid, false);
  const integrityTamper = { ...envelope, integrity: { ...envelope.integrity, digest: `0x${"0".repeat(64)}` } };
  assert.equal((await verifyKeelPublishReviewPlan(integrityTamper)).valid, false);
  const unknown = { ...envelope, plan: { ...envelope.plan, unexpected: true } };
  assert.equal((await verifyKeelPublishReviewPlan(unknown)).valid, false);
});

test("publish review plans cap duplicated MCP-safe detail", async () => {
  const source = await chainPlan();
  const oversized = { ...source, operations: [...Array.from({ length: 3000 }, () => source.operations[0]), { ...source.operations[1], compression: "gzip" }] };
  await assert.rejects(() => createKeelPublishReviewPlan(oversized), /detail limit/u);
  const base = await createKeelPublishReviewPlan(source);
  const largeOperations = [...Array.from({ length: 3000 }, () => base.plan.operations[0]), { ...base.plan.operations[1], descriptor: { ...base.plan.operations[1].descriptor, compression: "gzip" } }];
  assert.throws(() => parseKeelPublishReviewPlan({ ...base.plan, operationCount: largeOperations.length, operations: largeOperations }), /detail limit/u);
});
