import assert from "node:assert/strict";
import test from "node:test";

import {
  KEEL_DRAFT_ANNUAL_QUOTA_BYTES,
  KEEL_IPFS_BASE_TIER_BYTES,
  defaultKeelStudioPublicationIntent,
  keelIpfsOffer,
} from "../packages/sdk/dist/index.js";

test("Studio publication intent never calls temporary Socket-server draft storage an IPFS pin", () => {
  const intent = defaultKeelStudioPublicationIntent();
  assert.deepEqual(intent.viewer, { mode: "keel-sandbox", required: true, verifyManifest: true, verifyChunks: true });
  assert.deepEqual(intent.draftStorage, { provider: "keel-socket-local", persistence: "temporary-unpinned", annualQuotaBytes: 500_000_000 });
  assert.deepEqual(intent.ipfs, { mode: "not-pinned" });
  assert.equal(KEEL_DRAFT_ANNUAL_QUOTA_BYTES, 500_000_000);
});

test("managed IPFS pricing and proceeds funding remain explicit", () => {
  assert.deepEqual(keelIpfsOffer(KEEL_IPFS_BASE_TIER_BYTES, { mode: "keel-paid" }), {
    requiresImmediatePayment: true,
    reserveFromDropProceeds: false,
    priceUsdCents: 2_000,
    termSeconds: 63_072_000,
    minimumTierBytes: 25_000_000,
    baseTierBytes: 500_000_000,
    overageBytes: 0,
  });
  const proceeds = keelIpfsOffer(1_000_000, { mode: "drop-proceeds", maximumUsdCents: 2_000 });
  assert.equal(proceeds.requiresImmediatePayment, false);
  assert.equal(proceeds.reserveFromDropProceeds, true);
  assert.equal(keelIpfsOffer(0, { mode: "not-pinned" }).priceUsdCents, 200);
  assert.equal(keelIpfsOffer(25_000_000, { mode: "not-pinned" }).priceUsdCents, 200);
  assert.equal(keelIpfsOffer(25_000_001, { mode: "not-pinned" }).priceUsdCents, 201);
  assert.equal(keelIpfsOffer(1_000_000_000, { mode: "not-pinned" }).priceUsdCents, 5_790);
});

test("creator provider stores only a credential reference", () => {
  assert.throws(() => defaultKeelStudioPublicationIntent({ mode: "creator-provider", providerId: "", credentialRef: "secret:ipfs" }), /provider ID/u);
  const intent = defaultKeelStudioPublicationIntent({ mode: "creator-provider", providerId: "pinata", credentialRef: "vault://creator/ipfs" });
  assert.equal(intent.ipfs.mode, "creator-provider");
});
