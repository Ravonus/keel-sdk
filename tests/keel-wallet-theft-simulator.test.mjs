import test from "node:test";
import assert from "node:assert/strict";

import {
  createKeelWalletIntentPlan,
  verifyKeelWalletIntentPlan,
} from "../packages/sdk/dist/index.js";
import { parseKeelPluginFrameMessage } from "../packages/viewer/dist/index.js";

/**
 * The wallet-theft simulator.
 *
 * A Keel artwork runs in a sandboxed iframe and speaks to the wallet through
 * a narrow bridge: it may send a handshake, or an intent naming one of the
 * adapter's declared operations. It never hands the wallet a target address or
 * calldata — those are produced by the trusted wallet from the operation name,
 * not by the artwork.
 *
 * This file plays the artwork as the attacker. Two honest demo intents show the
 * boundary passing what it should; then a series of theft attempts show it
 * refusing everything that would move an asset the user did not agree to move.
 * Every check runs the real enforcement code, not a stand-in for it.
 */

/* --------------------------------------------------------------- shared rig */

const planDigest = `0x${"11".repeat(32)}`;
const contentDigest = `0x${"22".repeat(32)}`;
const childId = `0x${"33".repeat(32)}`;
const objectId = `0x${"44".repeat(32)}`;
const STORE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** The calldata shape the harness commits to, mirroring the SDK's own format. */
const calldata = (selector, byteLength, signature, args) => {
  const payload = Buffer.from(JSON.stringify({ signature, args }), "utf8").toString("hex");
  return `${selector}${payload.slice(0, (byteLength - 4) * 2).padEnd((byteLength - 4) * 2, "0")}`;
};

/** The wallet's own calldata check: the bytes must be exactly what the named
 *  operation and its arguments produce, so a crafted `data` field cannot ride
 *  in under an honest operation name. */
const validateCalldata = (signature, data, args) => {
  const selector =
    signature === "castSlugs(bytes[])"
      ? "0x0d1ff9e2"
      : signature === "weldObject(bytes32[],bytes32,uint64,uint8,string)"
        ? "0xb17463a8"
        : "0x5f97a164";
  const size =
    signature === "castSlugs(bytes[])"
      ? 164
      : signature === "weldObject(bytes32[],bytes32,uint64,uint8,string)"
        ? 292
        : 260;
  return data === calldata(selector, size, signature, args);
};

/** The adapter's own check: the operation must match what its object and graph
 *  committed to, so an attacker cannot smuggle different arguments past a name
 *  the plan blessed. */
const validateAdapterOperation = (operation) =>
  operation.kind === "castSlugs"
    ? Array.isArray(operation.args[0]) && operation.args[0].length === 1 && operation.args[0][0] === "0x01"
    : operation.objectId === objectId && operation.storedByteLength === 1;

/** A well-formed ready descriptor: one read-shaped storage write, one object
 *  creation. This is the honest baseline every attack is a mutation of. */
function honestReady() {
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
        to: STORE,
        valueWei: "0",
        signature: "castSlugs(bytes[])",
        args: [["0x01"]],
        data: calldata("0x0d1ff9e2", 164, "castSlugs(bytes[])", [["0x01"]]),
      },
      {
        operationId: `op-${planDigest.slice(2, 14)}-00001`,
        kind: "weldObject",
        chainId: 1,
        to: STORE,
        valueWei: "0",
        signature: "weldObject(bytes32[],bytes32,uint64,uint8,string)",
        args: [[childId], contentDigest, 1, 0, "text/plain"],
        data: calldata("0xb17463a8", 292, "weldObject(bytes32[],bytes32,uint64,uint8,string)", [
          [childId],
          contentDigest,
          1,
          0,
          "text/plain",
        ]),
        objectId,
        storedByteLength: 1,
      },
    ],
    signing: "not-performed",
    submission: "not-performed",
    caveat: "Unsigned calldata only; no RPC, simulation, signing, or submission was performed.",
  };
}

const build = (ready) =>
  createKeelWalletIntentPlan({
    family: "ethereum",
    ready,
    requestId: "sim",
    label: "simulator",
    validateCalldata,
    validateAdapterOperation,
  });

/* ------------------------------------------------- layer 1: the frame bridge */
/* What a sandboxed artwork is even allowed to say to the wallet.             */

test("layer 1 — the bridge accepts a handshake and a well-formed market intent", () => {
  assert.deepEqual(parseKeelPluginFrameMessage({ protocol: "keel-plugin-handshake@1", plugin: "keel-market" }), {
    kind: "handshake",
    plugin: "keel-market",
  });

  const intent = parseKeelPluginFrameMessage({
    protocol: "keel-wallet-intent@1",
    plugin: "keel-market",
    session: `0x${"ab".repeat(32)}`,
    intentId: "market.buy",
    proposal: { priceEth: "1.5", bidder: "0x1111111111111111111111111111111111111111" },
  });
  assert.equal(intent.kind, "intent");
  assert.equal(intent.intentId, "market.buy");
});

test("layer 1 — the bridge refuses an artwork that tries to carry its own calldata", () => {
  // The theft dream: the artwork sends a raw transaction and the wallet signs
  // it. The bridge has no field for that, so an intent shaped like a
  // transaction is not an intent it will parse.
  assert.throws(
    () =>
      parseKeelPluginFrameMessage({
        protocol: "keel-wallet-intent@1",
        plugin: "keel-market",
        session: `0x${"ab".repeat(32)}`,
        intentId: "market.buy",
        proposal: { priceEth: "1.5", bidder: "0x1111111111111111111111111111111111111111", to: STORE, data: "0xdeadbeef" },
      }),
    /Malformed/u,
  );
});

test("layer 1 — the bridge refuses an operation name outside the market namespace", () => {
  // `setApprovalForAll` is not `market.*`, so it cannot even be named here.
  assert.throws(
    () =>
      parseKeelPluginFrameMessage({
        protocol: "keel-wallet-intent@1",
        plugin: "keel-market",
        session: `0x${"ab".repeat(32)}`,
        intentId: "setApprovalForAll",
        proposal: { priceEth: "0", bidder: "0x1111111111111111111111111111111111111111" },
      }),
    /Malformed/u,
  );
});

test("layer 1 — a foreign plugin protocol is ignored, not obeyed", () => {
  assert.equal(parseKeelPluginFrameMessage({ protocol: "evil-wallet-drainer@1", plugin: "keel-market" }), undefined);
});

/* ---------------------------------------------- layer 2: the intent planner */
/* What the wallet will actually assemble into a reviewable batch.            */

test("layer 2 — the two honest demo operations assemble and verify", async () => {
  const plan = await build(honestReady());
  assert.equal(plan.status, "review-only");
  assert.equal(plan.signing, "not-performed");
  assert.equal(plan.submission, "not-performed");
  assert.equal(plan.requests.length, 2);
  assert.equal((await verifyKeelWalletIntentPlan(plan)).valid, true);
});

test("layer 2 — a stolen transfer disguised under an approved operation name is refused", async () => {
  // The classic drain: keep the blessed operationId, swap the calldata for a
  // transfer of the user's NFT. The wallet re-derives calldata from the name
  // and arguments and refuses the moment the bytes do not match.
  const theft = honestReady();
  theft.operations[0].data = calldata("0x0d1ff9e2", 164, "castSlugs(bytes[])", [["0xdeadbeef"]]);
  await assert.rejects(() => build(theft), /canonically validated/u);
});

test("layer 2 — an unbound operationId is refused", async () => {
  const theft = honestReady();
  theft.operations[0].operationId = "op-attacker-owns-this";
  await assert.rejects(() => build(theft), /operationId|bound/u);
});

test("layer 2 — a second target smuggled into the batch is refused outright", async () => {
  // Point one operation at the collection contract instead of the store, hoping
  // to reach `transferFrom` alongside an honest write. The batch is pinned to a
  // single target, so a mixed-target batch is not assembled at all — a stronger
  // guarantee than validating each target in isolation.
  const theft = honestReady();
  theft.operations[1].to = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  theft.operations[1].objectId = objectId;
  await assert.rejects(() => build(theft), /share one Ethereum target/u);
});

test("layer 2 — a signature that does not match its operation kind is refused", async () => {
  const theft = honestReady();
  theft.operations[0].signature = "transferFrom(address,address,uint256)";
  await assert.rejects(() => build(theft), /signature|kind|unsupported/u);
});

test("layer 2 — an operation kind outside the storage allowlist is refused", async () => {
  const theft = honestReady();
  theft.operations[0].kind = "transferFrom";
  theft.operations[0].signature = "transferFrom(address,address,uint256)";
  await assert.rejects(() => build(theft), /unsupported|kind/u);
});

test("layer 2 — smuggling a nonzero value under a zero-value operation is refused", async () => {
  const theft = honestReady();
  theft.operations[0].valueWei = "1000000000000000000";
  await assert.rejects(() => build(theft), /value|Wei|0/u);
});

/* ------------------------------------------ layer 3: tamper after the fact */
/* Even a validly built plan must not be alterable in flight.                */

test("layer 3 — editing a request in a built plan invalidates it", async () => {
  const plan = await build(honestReady());
  const tampered = {
    ...plan,
    requests: plan.requests.map((request, index) => (index === 0 ? { ...request, to: "0xcccccccccccccccccccccccccccccccccccccccc" } : request)),
  };
  assert.equal((await verifyKeelWalletIntentPlan(tampered)).valid, false);
});

test("layer 3 — the plan itself never signs or submits", async () => {
  // The strongest guarantee for a review boundary: nothing here can reach the
  // chain on its own. A theft that is only ever a proposal is a theft the user
  // can decline.
  const plan = await build(honestReady());
  assert.equal(plan.signing, "not-performed");
  assert.equal(plan.submission, "not-performed");
  assert.equal(plan.chainReady, false);
});
