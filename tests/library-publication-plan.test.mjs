import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildKeelLibraryPublicationPlan,
  verifyKeelLibraryPublicationPlanEnvelope,
  KEEL_LIBRARY_MAX_CAST_BATCH_SLUGS,
  KEEL_LIBRARY_MAX_LEAF_SLUGS,
} from "../packages/sdk/dist/index.js";

const ADDR = "0x1111111111111111111111111111111111111111";
const HOLD = "0x2222222222222222222222222222222222222222";
const OBJECT = "0x3333333333333333333333333333333333333333";
const LINK = "0x4444444444444444444444444444444444444444";
const GRAPH = "0x5555555555555555555555555555555555555555";
const LIBRARY = "0x6666666666666666666666666666666666666666";
const TAG = "0x7777777777777777777777777777777777777777";
const DIGEST = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CONTENT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const LOGICAL = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const REPORT_DIGEST = `0x${createHash("sha256").update("{}").digest("hex")}`;

function input(mode = "open", overrides = {}) {
  return {
    chain: { family: "ethereum", chainId: 31337 },
    controller: ADDR,
    contracts: { hold: HOLD, objectRegistry: OBJECT, linkRegistry: LINK, graphRegistry: GRAPH, libraryRegistry: LIBRARY, tagRegistry: TAG },
    salts: {
      graph: "0x0101010101010101010101010101010101010101010101010101010101010101",
      asset: "0x0202020202020202020202020202020202020202020202020202020202020202",
    },
    artifact: {
      id: "artifact-1",
      revision: 1,
      name: "Example module",
      description: "A review fixture",
      assetType: "module",
      license: "MIT",
      controller: ADDR,
      anchor: { chainId: 31337, registry: OBJECT, collection: ADDR, tokenId: "1" },
      resource: {
        path: "main.js",
        resourceId: "resource-1",
        digest: DIGEST,
        byteLength: 4,
        mediaType: "text/javascript",
        compression: "none",
        contentStore: HOLD,
        contentObjectId: CONTENT,
        logicalObjectId: LOGICAL,
        objectRegistry: OBJECT,
        objectRevision: 1,
        linkRegistry: LINK,
      },
      sourceVerification: {
        protocol: "keel-source-receipt@1",
        source: { algorithm: "sha256", digest: DIGEST, byteLength: 4 },
        output: { algorithm: "sha256", digest: DIGEST, byteLength: 4 },
        report: {},
        reportDigest: REPORT_DIGEST,
        disposition: "exact-source-output",
      },
    },
    policy: { mode, ...(mode === "paid" ? { payout: ADDR, priceWei: "10" } : {}), ...(mode === "address-allowlist" ? { allowlistRoot: DIGEST } : {}), ...(mode === "token-gate" ? { gateToken: ADDR, minimumTokenBalance: "1" } : {}) },
    tags: ["module", "javascript"],
    live: { logicalObjectExists: true, contractsCompatible: true, logicalObjectMatches: true },
    ...overrides,
  };
}

test("Library publication plan is deterministic and keeps operations unsigned", async () => {
  const first = await buildKeelLibraryPublicationPlan(input());
  const second = await buildKeelLibraryPublicationPlan(input());
  assert.deepEqual(first, second);
  assert.equal(first.plan.status, "review-only");
  assert.equal(first.plan.signing, "not-performed");
  assert.equal(first.plan.submitted, false);
  assert.equal(first.plan.recurringSubscription, false);
  assert.equal(first.plan.operations[0].kind, "logical-object");
  assert.equal(first.plan.operations.filter((operation) => operation.function === "castSlugs(bytes[])").length, 1);
  assert.equal(first.plan.operations.filter((operation) => operation.function === "weldObject(bytes32[],bytes32,uint64,uint8,string)").length, 1);
  assert.equal(first.plan.operations.find((operation) => operation.function === "weldObject(bytes32[],bytes32,uint64,uint8,string)").args.slugIds.length, 1);
  assert.equal(first.plan.assetKind, 0);
  assert.equal((await verifyKeelLibraryPublicationPlanEnvelope(first)).valid, true);
});

test("tampering with a canonical plan is rejected", async () => {
  const envelope = await buildKeelLibraryPublicationPlan(input());
  const tampered = { ...envelope, plan: { ...envelope.plan, controller: "0x9999999999999999999999999999999999999999" } };
  const verification = await verifyKeelLibraryPublicationPlanEnvelope(tampered);
  assert.equal(verification.valid, false);
  assert.match(verification.issues.join(" "), /integrity/i);
});

test("native modes are literal and subscription or special activation is rejected", async () => {
  for (const mode of ["closed", "open", "paid", "address-allowlist", "token-gate", "submission-only"]) {
    const plan = await buildKeelLibraryPublicationPlan(input(mode));
    assert.equal(plan.plan.policy.mode, mode);
  }
  await assert.rejects(() => buildKeelLibraryPublicationPlan(input("subscription")), /native access modes|unsupported/i);
  await assert.rejects(() => buildKeelLibraryPublicationPlan(input("special")), /native access modes|unsupported/i);
  await assert.rejects(() => buildKeelLibraryPublicationPlan(input("license")), /native access modes|unsupported/i);
});

test("allowlist and submission grants preserve uint64 strings and valid windows", async () => {
  const allowlist = await buildKeelLibraryPublicationPlan(input("address-allowlist", {
    policy: { mode: "address-allowlist", allowlistRoot: DIGEST, grantDurationSeconds: "18446744073709551615", availableFrom: "10", availableUntil: "20" },
  }));
  assert.equal(allowlist.plan.policy.grantDurationSeconds, "18446744073709551615");
  assert.equal(allowlist.plan.policy.availableFrom, "10");
  assert.equal(allowlist.plan.policy.availableUntil, "20");
  assert.equal(typeof JSON.parse(new TextDecoder().decode(Buffer.from(allowlist.plan.manifest.canonicalBytesHex.slice(2), "hex"))).access.grantDurationSeconds, "string");
  const submission = await buildKeelLibraryPublicationPlan(input("submission-only", {
    policy: { mode: "submission-only", grantDurationSeconds: "3600", availableFrom: "100", availableUntil: "200" },
  }));
  assert.equal(submission.plan.policy.grantDurationSeconds, "3600");
  assert.equal(submission.plan.policy.availableUntil, "200");
});

function inputWithReportLength(length) {
  const report = { payload: "x".repeat(length) };
  const reportDigest = `0x${createHash("sha256").update(JSON.stringify(report)).digest("hex")}`;
  const value = input("open");
  value.artifact.sourceVerification = { ...value.artifact.sourceVerification, report, reportDigest };
  return value;
}

async function inputWithLeafCount(target) {
  let low = 0;
  let high = target * 23_000;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = inputWithReportLength(middle);
    const plan = await buildKeelLibraryPublicationPlan(candidate);
    const count = Math.ceil(plan.plan.manifest.byteLength / 23_000);
    if (count === target) return candidate;
    if (count < target) low = middle + 1;
    else high = middle - 1;
  }
  throw new Error(`Could not create a ${target}-leaf fixture.`);
}

test("Hold storage repeats batches of at most three and rejects a 129-leaf flat object", async () => {
  assert.equal(KEEL_LIBRARY_MAX_CAST_BATCH_SLUGS, 3);
  assert.equal(KEEL_LIBRARY_MAX_LEAF_SLUGS, 128);
  for (const count of [3, 4, 128]) {
    const plan = await buildKeelLibraryPublicationPlan(await inputWithLeafCount(count));
    const casts = plan.plan.operations.filter((operation) => operation.function === "castSlugs(bytes[])");
    const welds = plan.plan.operations.filter((operation) => operation.function === "weldObject(bytes32[],bytes32,uint64,uint8,string)");
    assert.equal(casts.length, Math.ceil(count / 3));
    assert.ok(casts.every((operation) => operation.args.chunkCount >= 1 && operation.args.chunkCount <= 3));
    assert.equal(welds.length, 1);
    assert.equal(welds[0].args.slugIds.length, count);
  }
  await assert.rejects(() => buildKeelLibraryPublicationPlan(inputWithReportLength(129 * 23_000)), /at most 128|Composite objects are not available/i);
});

test("live stale and mismatched manifest object evidence block readiness", async () => {
  const stale = await buildKeelLibraryPublicationPlan(input("open", { live: { logicalObjectExists: true, contractsCompatible: true, logicalObjectMatches: true, staleReason: "changed" } }));
  assert.equal(stale.plan.readiness, "blocked");
  assert.ok(stale.plan.blockers.some((value) => value.startsWith("stale-live-read:")));
  const mismatch = await buildKeelLibraryPublicationPlan(input("open", { live: { logicalObjectExists: true, contractsCompatible: true, logicalObjectMatches: true, holdObjectExists: true, holdObjectMatches: false } }));
  assert.equal(mismatch.plan.readiness, "blocked");
  assert.ok(mismatch.plan.blockers.includes("manifest-object-exists-but-live-readback-does-not-match"));
});
