import test from "node:test";
import assert from "node:assert/strict";
import {
  buildKeelModuleReviewRequest,
  KEEL_MODULE_FORMAT_INDEX,
  KEEL_MODULE_REVIEW_PROTOCOL,
  KEEL_MODULE_REVIEW_REGISTRY_ABI,
} from "../packages/sdk/dist/index.js";

const REGISTRY = "0x9abb1f929a05e0ddf558aa9f594ec7775e28f8b2";
const DIGEST = (byte) => `0x${byte.repeat(64)}`;

function spec(overrides = {}) {
  return {
    moduleId: DIGEST("1"),
    moduleVersion: 1,
    format: "es-module",
    graphId: DIGEST("2"),
    graphVersion: 1,
    manifestDigest: DIGEST("3"),
    resourceGraphDigest: DIGEST("4"),
    metadataDigest: DIGEST("5"),
    ...overrides,
  };
}

test("submit request is review-only, non-custodial, and encodes the spec tuple", async () => {
  const env = await buildKeelModuleReviewRequest({ chainId: 11155111, registry: REGISTRY, action: "submit", spec: spec() });
  assert.equal(env.protocol, KEEL_MODULE_REVIEW_PROTOCOL);
  assert.equal(env.status, "review-only");
  assert.equal(env.chainReady, false);
  assert.equal(env.signing, "not-performed");
  assert.equal(env.submission, "not-performed");
  assert.equal(env.call.function, "submitModule");
  // spec tuple order + format enum index
  assert.deepEqual(env.call.args, [
    DIGEST("1"), 1, KEEL_MODULE_FORMAT_INDEX["es-module"], DIGEST("2"), 1, DIGEST("3"), DIGEST("4"), DIGEST("5"),
  ]);
  assert.equal(env.integrity.algorithm, "sha256");
  assert.match(env.integrity.digest, /^0x[0-9a-f]{64}$/u);
});

test("sanction / deprecate / revoke build the right registry calls", async () => {
  const sanction = await buildKeelModuleReviewRequest({
    chainId: 11155111, registry: REGISTRY, action: "sanction", specDigest: DIGEST("a"), reviewDigest: DIGEST("b"), validUntil: 0,
  });
  assert.equal(sanction.call.function, "sanctionModule");
  assert.deepEqual(sanction.call.args, [DIGEST("a"), DIGEST("b"), 0]);

  const deprecate = await buildKeelModuleReviewRequest({
    chainId: 11155111, registry: REGISTRY, action: "deprecate", specDigest: DIGEST("a"), reasonDigest: DIGEST("c"), validUntil: 1_900_000_000,
  });
  assert.equal(deprecate.call.function, "deprecateModule");
  assert.deepEqual(deprecate.call.args, [DIGEST("a"), DIGEST("c"), DIGEST("0"), 1_900_000_000]);

  const revoke = await buildKeelModuleReviewRequest({
    chainId: 11155111, registry: REGISTRY, action: "revoke", specDigest: DIGEST("a"), reasonDigest: DIGEST("c"), replacementSpecDigest: DIGEST("d"),
  });
  assert.equal(revoke.call.function, "revokeModule");
  assert.deepEqual(revoke.call.args, [DIGEST("a"), DIGEST("c"), DIGEST("d")]);
});

test("validation rejects malformed input", async () => {
  await assert.rejects(() => buildKeelModuleReviewRequest({ chainId: 11155111, registry: "not-an-address", action: "submit", spec: spec() }), /registry/);
  await assert.rejects(() => buildKeelModuleReviewRequest({ chainId: 11155111, registry: REGISTRY, action: "submit" }), /requires a spec/);
  await assert.rejects(() => buildKeelModuleReviewRequest({ chainId: 11155111, registry: REGISTRY, action: "submit", spec: spec({ moduleId: "0xnothex" }) }), /moduleId/);
  await assert.rejects(() => buildKeelModuleReviewRequest({ chainId: 11155111, registry: REGISTRY, action: "sanction", specDigest: DIGEST("a") }), /reviewDigest/);
  await assert.rejects(() => buildKeelModuleReviewRequest({ chainId: 0, registry: REGISTRY, action: "submit", spec: spec() }), /chainId/);
});

test("the registry ABI is exported and covers the review lifecycle", () => {
  const fns = new Set(KEEL_MODULE_REVIEW_REGISTRY_ABI.filter((x) => x.type === "function").map((x) => x.name));
  for (const f of ["submitModule", "sanctionModule", "deprecateModule", "revokeModule", "moduleAuthorized", "review", "specDigest"]) {
    assert.ok(fns.has(f), `ABI must include ${f}`);
  }
});
