import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  FRAY_AUCTION_INTENT_PROTOCOL,
  FRAY_AUCTION_POLICY_PROFILES,
  createFrayAuctionIntent,
  formatFrayAtomicAmount,
  materializeFrayAuctionIntent,
  parseFrayAuctionIntent,
  resolveFrayAuctionPolicy,
  verifyFrayAuctionIntent,
} from "../packages/sdk/dist/index.js";

const fixture = JSON.parse(await readFile(new URL("./fixtures/fray-auction-intent-v1.json", import.meta.url), "utf8"));

test("Fray policy profiles preserve Studio economics for both chain families", () => {
  assert.equal(FRAY_AUCTION_POLICY_PROFILES.length, 8);
  const evmQuick = resolveFrayAuctionPolicy("ethereum", 1);
  const evmStandard = resolveFrayAuctionPolicy("ethereum", 2);
  const evmCollector = resolveFrayAuctionPolicy("ethereum", 3);
  const evmShowcase = resolveFrayAuctionPolicy("ethereum", 4);
  const tezosQuick = resolveFrayAuctionPolicy("tezos", 1);
  assert.equal(formatFrayAtomicAmount(evmQuick.terms.reserveAtomic, 18), "0.01");
  assert.equal(formatFrayAtomicAmount(evmQuick.terms.bidIncrementAtomic, 18), "0.005");
  assert.equal(evmStandard.terms.maximumEditionSize, 10);
  assert.equal(evmCollector.terms.maximumEditionSize, 25);
  assert.equal(evmShowcase.presetKey, "showcase");
  assert.equal(evmShowcase.terms.durationSeconds, 1_800);
  assert.equal(evmShowcase.terms.releaseOutcome, "patrons");
  assert.equal(evmShowcase.terms.extensionSeconds, 0);
  assert.equal(evmShowcase.terms.maximumExtensionSeconds, 0);
  assert.equal(formatFrayAtomicAmount(tezosQuick.terms.reserveAtomic, 6), "0.1");
  assert.equal(formatFrayAtomicAmount(tezosQuick.terms.bidIncrementAtomic, 6), "0.02");
});

test("all six golden vectors materialize and hash byte-for-byte", async () => {
  assert.equal(fixture.schema, "fray-auction-intent-vectors@1");
  for (const vector of fixture.vectors) {
    const { source, chain, policy } = vector.intent;
    const materialized = materializeFrayAuctionIntent({
      source,
      family: chain.family,
      network: chain.network,
      ...(chain.family === "ethereum" ? { chainId: chain.chainId } : {}),
      presetId: policy.presetId,
    });
    assert.deepEqual(materialized, vector.intent, vector.name);
    const envelope = await createFrayAuctionIntent(materialized);
    assert.deepEqual(envelope, { intent: vector.intent, integrity: vector.integrity }, vector.name);
    assert.equal((await verifyFrayAuctionIntent(envelope)).valid, true, vector.name);
    assert.deepEqual(parseFrayAuctionIntent(vector.intent), vector.intent, vector.name);
  }
});

test("every behavior-changing field is bound and policy drift fails closed", async () => {
  const vector = fixture.vectors.find((candidate) => candidate.name === "ethereum-standard");
  const envelope = await createFrayAuctionIntent(vector.intent);
  const mutations = [
    ["source digest", { ...envelope.intent, source: { ...envelope.intent.source, digest: `0x${"1".repeat(64)}` } }],
    ["source byte length", { ...envelope.intent, source: { ...envelope.intent.source, byteLength: envelope.intent.source.byteLength + 1 } }],
    ["chain family", { ...envelope.intent, chain: { ...envelope.intent.chain, family: "tezos" } }],
    ["chain network", { ...envelope.intent, chain: { ...envelope.intent.chain, network: "base-sepolia" } }],
    ["chain ID", { ...envelope.intent, chain: { ...envelope.intent.chain, chainId: 84_532 } }],
    ["currency symbol", { ...envelope.intent, chain: { ...envelope.intent.chain, nativeCurrency: { ...envelope.intent.chain.nativeCurrency, symbol: "TEZ" } } }],
    ["currency unit", { ...envelope.intent, chain: { ...envelope.intent.chain, nativeCurrency: { ...envelope.intent.chain.nativeCurrency, unit: "mutez" } } }],
    ["currency decimals", { ...envelope.intent, chain: { ...envelope.intent.chain, nativeCurrency: { ...envelope.intent.chain.nativeCurrency, decimals: 6 } } }],
    ["policy protocol", { ...envelope.intent, policy: { ...envelope.intent.policy, protocol: "fray-auction-policy@2" } }],
    ["policy preset ID", { ...envelope.intent, policy: { ...envelope.intent.policy, presetId: 3 } }],
    ["policy preset key", { ...envelope.intent, policy: { ...envelope.intent.policy, presetKey: "collector" } }],
    ["release outcome", { ...envelope.intent, terms: { ...envelope.intent.terms, releaseOutcome: "bidder" } }],
    ["start delay", { ...envelope.intent, terms: { ...envelope.intent.terms, startDelaySeconds: 301 } }],
    ["duration", { ...envelope.intent, terms: { ...envelope.intent.terms, durationSeconds: 86_401 } }],
    ["reserve", { ...envelope.intent, terms: { ...envelope.intent.terms, reserveAtomic: "100000000000000001" } }],
    ["bid increment", { ...envelope.intent, terms: { ...envelope.intent.terms, bidIncrementAtomic: "20000000000000001" } }],
    ["royalty", { ...envelope.intent, terms: { ...envelope.intent.terms, royaltyBps: 501 } }],
    ["minimum patron cap", { ...envelope.intent, terms: { ...envelope.intent.terms, minimumPatronCapAtomic: "10000000000000001" } }],
    ["maximum edition size", { ...envelope.intent, terms: { ...envelope.intent.terms, maximumEditionSize: 11 } }],
    ["maximum patron price", { ...envelope.intent, terms: { ...envelope.intent.terms, maximumPatronPriceAtomic: "1" } }],
    ["patron pricing mode", { ...envelope.intent, terms: { ...envelope.intent.terms, patronPricingMode: "demand" } }],
    ["extension", { ...envelope.intent, terms: { ...envelope.intent.terms, extensionSeconds: 901 } }],
    ["maximum extension", { ...envelope.intent, terms: { ...envelope.intent.terms, maximumExtensionSeconds: 3_601 } }],
  ];
  for (const [label, intent] of mutations) {
    const verification = await verifyFrayAuctionIntent({ ...envelope, intent });
    assert.equal(verification.valid, false, label);
  }
  assert.throws(() => parseFrayAuctionIntent({ ...vector.intent, policy: { ...vector.intent.policy, presetKey: "collector" } }), /disagree/u);
  assert.throws(() => parseFrayAuctionIntent({ ...vector.intent, terms: { ...vector.intent.terms, reserveAtomic: "010" } }), /canonical/u);
  assert.throws(() => parseFrayAuctionIntent({ ...vector.intent, unexpected: true }), /not supported/u);
});

test("family, currency, source, and lifecycle invariants reject ambiguous intents", () => {
  const ethereum = fixture.vectors[0].intent;
  const tezos = fixture.vectors[3].intent;
  assert.equal(ethereum.protocol, FRAY_AUCTION_INTENT_PROTOCOL);
  assert.throws(() => materializeFrayAuctionIntent({ source: ethereum.source, family: "ethereum", network: "sepolia", presetId: 1 }), /chainId/u);
  assert.throws(() => materializeFrayAuctionIntent({ source: tezos.source, family: "tezos", network: "shadownet", chainId: 1, presetId: 1 }), /must not include chainId/u);
  assert.throws(() => materializeFrayAuctionIntent({ source: ethereum.source, family: "ethereum", network: "sepolia", chainId: 11_155_111, presetId: 1, unexpected: true }), /not supported/u);
  assert.throws(() => parseFrayAuctionIntent({ ...ethereum, source: { ...ethereum.source, digest: `0x${"A".repeat(64)}` } }), /lower-case SHA-256/u);
  assert.throws(() => parseFrayAuctionIntent({ ...tezos, chain: { ...tezos.chain, nativeCurrency: { symbol: "XTZ", unit: "mutez", decimals: 6 } } }), /must use/u);
  assert.throws(() => parseFrayAuctionIntent({ ...ethereum, terms: { ...ethereum.terms, maximumEditionSize: 1 } }), /Bidder-only|policy profile/u);
});
