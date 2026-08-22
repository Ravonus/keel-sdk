import test from "node:test";
import assert from "node:assert/strict";

import {
  createKeelWalletIntentPlan,
  parseKeelWalletIntentPlan,
  verifyKeelWalletIntentPlan,
} from "../packages/sdk/dist/index.js";

const planDigest = `0x${"11".repeat(32)}`;
const contentDigest = `0x${"22".repeat(32)}`;
const childId = `0x${"33".repeat(32)}`;
const objectId = `0x${"44".repeat(32)}`;
const calldata = (selector, byteLength, signature, args) => {
  const payload = Buffer.from(JSON.stringify({ signature, args }), "utf8").toString("hex");
  return `${selector}${payload.slice(0, (byteLength - 4) * 2).padEnd((byteLength - 4) * 2, "0")}`;
};
const validateCalldata = (signature, data, args) => {
  const selector = signature === "castSlugs(bytes[])" ? "0x0d1ff9e2" : signature === "weldObject(bytes32[],bytes32,uint64,uint8,string)" ? "0xb17463a8" : "0x5f97a164";
  const size = signature === "castSlugs(bytes[])" ? 164 : signature === "weldObject(bytes32[],bytes32,uint64,uint8,string)" ? 292 : 260;
  return data === calldata(selector, size, signature, args);
};
const validateAdapterOperation = (operation) => operation.kind === "castSlugs"
  ? Array.isArray(operation.args[0]) && operation.args[0].length === 1 && operation.args[0][0] === "0x01"
  : operation.objectId === objectId && operation.storedByteLength === 1;

function ready() {
  return {
    status: "ready-for-review",
    family: "ethereum",
    chainReady: false,
    source: {
      planIntegrity: { algorithm: "sha256", digest: planDigest, byteLength: 128 },
      contentIntegrity: { algorithm: "sha256", digest: contentDigest, byteLength: 1 },
    },
    operations: [
      {
        operationId: `op-${planDigest.slice(2, 14)}-00000`,
        kind: "castSlugs",
        chainId: 1,
        to: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        valueWei: "0",
        signature: "castSlugs(bytes[])",
        args: [["0x01"]],
        data: calldata("0x0d1ff9e2", 164, "castSlugs(bytes[])", [["0x01"]]),
      },
      {
        operationId: `op-${planDigest.slice(2, 14)}-00001`,
        kind: "weldObject",
        chainId: 1,
        to: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        valueWei: "0",
        signature: "weldObject(bytes32[],bytes32,uint64,uint8,string)",
        args: [[childId], contentDigest, 1, 0, "text/plain"],
        data: calldata("0xb17463a8", 292, "weldObject(bytes32[],bytes32,uint64,uint8,string)", [[childId], contentDigest, 1, 0, "text/plain"]),
        objectId,
        storedByteLength: 1,
      },
    ],
    signing: "not-performed",
    submission: "not-performed",
    caveat: "Unsigned calldata only; no RPC, simulation, signing, or submission was performed.",
  };
}

test("wallet intent consumes only a ready adapter descriptor and remains review-only", async () => {
  const plan = await createKeelWalletIntentPlan({
    family: "ethereum",
    ready: ready(),
    requestId: "collection-001",
    label: "Create collection",
    transport: "ledger",
    qr: true,
    validateCalldata,
    validateAdapterOperation,
  });
  assert.equal(plan.status, "review-only");
  assert.equal(plan.chainReady, false);
  assert.equal(plan.signing, "not-performed");
  assert.equal(plan.submission, "not-performed");
  assert.equal(plan.qr.status, "unsupported");
  assert.equal(plan.qr.requested, true);
  assert.equal(plan.source.planIntegrity.digest, planDigest);
  assert.equal(plan.requests.length, 2);
  assert.equal((await verifyKeelWalletIntentPlan(plan)).valid, true);
  assert.deepEqual(parseKeelWalletIntentPlan(plan), plan);
});

test("wallet intent defers a valid descriptor when adapter validators are absent", async () => {
  const result = await createKeelWalletIntentPlan({
    family: "ethereum",
    ready: ready(),
    requestId: "no-validator",
    label: "No validator",
  });
  assert.equal(result.status, "deferred");
  assert.equal(result.code, "adapter-validation-required");
});

test("wallet intent rejects old unbound operations, forged flags, ordering, and content roots", async () => {
  await assert.rejects(
    () => createKeelWalletIntentPlan({ family: "ethereum", operations: ready().operations, requestId: "x", label: "x" }),
    /ready|not supported/u,
  );
  await assert.rejects(() => createKeelWalletIntentPlan({ family: "ethereum", ready: { ...ready(), chainReady: true }, requestId: "x", label: "x", validateCalldata, validateAdapterOperation }), /flags/u);
  const swapped = ready();
  swapped.operations.reverse();
  await assert.rejects(() => createKeelWalletIntentPlan({ family: "ethereum", ready: swapped, requestId: "x", label: "x", validateCalldata, validateAdapterOperation }), /operationId|castSlugs|contentIntegrity/u);
  const forged = ready();
  forged.operations[1].args[1] = `0x${"55".repeat(32)}`;
  await assert.rejects(() => createKeelWalletIntentPlan({ family: "ethereum", ready: forged, requestId: "x", label: "x", validateCalldata, validateAdapterOperation }), /canonically|contentIntegrity|operation/u);
  const forgedObject = ready();
  forgedObject.operations[1].objectId = `0x${"99".repeat(32)}`;
  await assert.rejects(() => createKeelWalletIntentPlan({ family: "ethereum", ready: forgedObject, requestId: "x", label: "x", validateCalldata, validateAdapterOperation }), /object and graph|operation/u);
  await assert.rejects(() => createKeelWalletIntentPlan({ family: "ethereum", ready: { ...ready(), operations: ready().operations.map((item) => ({ ...item, to: "0x0000000000000000000000000000000000000000" })) }, requestId: "x", label: "x", validateCalldata, validateAdapterOperation }), /to is invalid/u);
});

test("wallet intent integrity catches request and plan tampering", async () => {
  const plan = await createKeelWalletIntentPlan({ family: "ethereum", ready: ready(), requestId: "tamper", label: "Tamper", validateCalldata, validateAdapterOperation });
  const changedRequest = structuredClone(plan);
  changedRequest.requests[0].request.label = "changed";
  assert.equal((await verifyKeelWalletIntentPlan(changedRequest)).valid, false);
  const changedFlags = { ...plan, signing: "performed" };
  assert.equal((await verifyKeelWalletIntentPlan(changedFlags)).valid, false);
  assert.throws(() => parseKeelWalletIntentPlan({ ...plan, unexpected: true }), /not supported/u);
});

test("wallet intent fails closed for Tezos and incompatible transports", async () => {
  const tezos = await createKeelWalletIntentPlan({ family: "tezos", ready: {}, requestId: "tez", label: "Tezos", transport: "tezconnect" });
  assert.equal(tezos.status, "deferred");
  assert.equal(tezos.code, "tezos-adapter-required");
  const mismatch = await createKeelWalletIntentPlan({ family: "ethereum", ready: ready(), requestId: "eth", label: "Ethereum", transport: "tezconnect" });
  assert.equal(mismatch.status, "deferred");
  assert.equal(mismatch.code, "transport-mismatch");
});
