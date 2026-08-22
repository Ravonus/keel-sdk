import assert from "node:assert/strict";
import test from "node:test";

import {
  KEEL_PRESENTATION_POLICY_PROTOCOL,
  assessKeelPresentationRevision,
  decideKeelDeliveryUpdate,
} from "../packages/protocol/dist/index.js";

const digest = (byte) => `0x${byte.repeat(64)}`;
const creator = Object.freeze({ address: "tz1-creator", creator: true, tokenOwner: false, oracle: false });
const owner = Object.freeze({ address: "tz1-owner", creator: false, tokenOwner: true, oracle: false });
const oracle = Object.freeze({ address: "tz1-oracle", creator: false, tokenOwner: false, oracle: true });
const outsider = Object.freeze({ address: "tz1-outsider", creator: false, tokenOwner: false, oracle: false });

const policy = (overrides = {}) => Object.freeze({
  protocol: KEEL_PRESENTATION_POLICY_PROTOCOL,
  policyId: "style.main",
  key: "style.css",
  scope: "collection",
  authority: "creator",
  updateKind: "resource-revision",
  valueType: "binary",
  executable: false,
  sourceVisibility: "readable",
  allowedMediaTypes: ["text/css"],
  constraints: { maxBytes: 64_000 },
  ...overrides,
});

const revision = (overrides = {}) => Object.freeze({
  policyId: "style.main",
  revision: 1,
  parentRevision: 0,
  publisher: creator.address,
  valueDigest: digest("1"),
  byteLength: 128,
  mediaType: "text/css",
  ...overrides,
});

const observation = (candidate, overrides = {}) => Object.freeze({
  digest: candidate.valueDigest,
  byteLength: candidate.byteLength,
  mediaType: candidate.mediaType,
  ...overrides,
});

test("creator CSS update stays verified and creates one shared package revision", () => {
  const first = revision();
  assert.deepEqual(
    assessKeelPresentationRevision(policy(), undefined, first, creator, observation(first)),
    {
      verified: true,
      code: "verified-authorized-revision",
      message: "The changed value is authorized, revisioned, and byte-for-byte verified.",
    },
  );
  const second = revision({ revision: 2, parentRevision: 1, valueDigest: digest("2"), byteLength: 144 });
  assert.equal(assessKeelPresentationRevision(policy(), first, second, creator, observation(second)).verified, true);
  assert.deepEqual(decideKeelDeliveryUpdate(policy(), "marketplace-packed", true), {
    action: "new-shared-package-root",
    packageUploadCount: 1,
    reason: "One changed shared resource creates one new collection package root; unchanged DAG blocks are reused.",
  });
});

test("locked executable can be published once but no authority can revise it", () => {
  const locked = policy({
    policyId: "code.main",
    key: "art.js",
    authority: "immutable",
    updateKind: "viewer-revision",
    valueType: "binary",
    executable: true,
    allowedMediaTypes: ["text/javascript"],
  });
  const first = revision({ policyId: "code.main", mediaType: "text/javascript" });
  assert.equal(assessKeelPresentationRevision(locked, undefined, first, creator, observation(first)).verified, true);
  const attack = revision({
    policyId: "code.main",
    revision: 2,
    parentRevision: 1,
    mediaType: "text/javascript",
    valueDigest: digest("f"),
  });
  const result = assessKeelPresentationRevision(locked, first, attack, creator, observation(attack));
  assert.equal(result.verified, false);
  assert.equal(result.code, "authority-denied");
});

test("token owner typed palette update reuses package bytes and outsiders fail", () => {
  const palette = policy({
    policyId: "state.palette",
    key: "palette",
    scope: "token",
    authority: "token-owner",
    updateKind: "typed-state",
    valueType: "rgb24",
    allowedMediaTypes: ["text/plain"],
    constraints: { maxBytes: 7 },
  });
  const candidate = revision({
    policyId: "state.palette",
    publisher: owner.address,
    valueDigest: digest("a"),
    byteLength: 7,
    mediaType: "text/plain",
    canonicalValue: "#72ffd6",
  });
  assert.equal(assessKeelPresentationRevision(palette, undefined, candidate, owner, observation(candidate)).verified, true);
  assert.equal(assessKeelPresentationRevision(palette, undefined, candidate, outsider, observation(candidate)).code, "authority-denied");
  assert.equal(
    assessKeelPresentationRevision(
      palette,
      undefined,
      { ...candidate, canonicalValue: "#72FFD6" },
      owner,
      observation(candidate),
    ).code,
    "value-invalid",
  );
  assert.equal(decideKeelDeliveryUpdate(palette, "marketplace-packed", true).action, "same-package-new-query-state");
  assert.equal(decideKeelDeliveryUpdate(palette, "marketplace-packed", true).packageUploadCount, 0);
  assert.equal(decideKeelDeliveryUpdate(palette, "marketplace-packed", false).action, "token-config-root");
});

test("API snapshot requires enabled format, advancing manifest sequence, and exact observed bytes", () => {
  const api = policy({
    policyId: "api.weather",
    key: "weather.json",
    authority: "oracle",
    updateKind: "api-snapshot",
    valueType: "canonical-json",
    allowedMediaTypes: ["application/json"],
    constraints: { maxBytes: 4_096 },
  });
  const first = revision({
    policyId: "api.weather",
    publisher: oracle.address,
    valueDigest: digest("b"),
    byteLength: 24,
    mediaType: "application/json",
    canonicalValue: "{\"temperature\":21}",
    sourceSequence: 9,
    sourceManifestDigest: digest("c"),
  });
  assert.equal(assessKeelPresentationRevision(api, undefined, first, oracle, observation(first)).verified, true);
  assert.equal(
    assessKeelPresentationRevision(api, undefined, { ...first, mediaType: "text/plain" }, oracle, observation(first)).code,
    "media-type-denied",
  );
  assert.equal(
    assessKeelPresentationRevision(api, undefined, first, oracle, observation(first, { digest: digest("0") })).code,
    "observation-mismatch",
  );
  const stale = { ...first, revision: 2, parentRevision: 1, valueDigest: digest("d") };
  assert.equal(assessKeelPresentationRevision(api, first, stale, oracle, observation(stale)).code, "api-sequence-stale");
});

test("hybrid and recursive delivery move verified revisions without repacking IPFS", () => {
  assert.equal(decideKeelDeliveryUpdate(policy(), "hybrid-proxy", true).action, "stable-proxy-new-verified-revision");
  assert.equal(decideKeelDeliveryUpdate(policy(), "hybrid-proxy", true).packageUploadCount, 0);
  assert.equal(decideKeelDeliveryUpdate(policy(), "onchain-recursive", true).action, "new-onchain-revision");
  assert.equal(decideKeelDeliveryUpdate(policy(), "onchain-recursive", true).packageUploadCount, 0);
});
