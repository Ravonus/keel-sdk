import assert from "node:assert/strict";
import test from "node:test";

import {
  OneMintStageKind,
  ZERO_ADDRESS,
  buildOneMintDrop,
  normalizeOneMintPerTokenMintData,
  oneMintActiveStageIndex,
} from "../packages/sdk/dist/index.js";

const target = "0x1111111111111111111111111111111111111111";
const payout = "0x2222222222222222222222222222222222222222";
const signer = "0x3333333333333333333333333333333333333333";
const entitlement = "0x4444444444444444444444444444444444444444";
const digest = (byte) => `0x${byte.repeat(64)}`;

test("OneMint builder preserves one shared allocation and immutable ordered stages", () => {
  const drop = buildOneMintDrop({
    target,
    payout,
    supply: 1_000,
    maxPerTransaction: 4,
    maxPerWallet: 8,
    metadataDigest: digest("a"),
    stages: [
      {
        kind: OneMintStageKind.Allowlist,
        startTime: 100,
        endTime: 200,
        unitPrice: 1n,
        signer,
        metadataDigest: digest("b"),
      },
      {
        kind: OneMintStageKind.Public,
        startTime: 200,
        endTime: 300,
        unitPrice: 2n,
        metadataDigest: digest("c"),
      },
      {
        kind: OneMintStageKind.Claim,
        startTime: 300,
        endTime: 400,
        signer,
        entitlementToken: entitlement,
        metadataDigest: digest("d"),
      },
    ],
  });

  assert.equal(drop.supply, 1_000n);
  assert.equal(drop.stages[0].paymentAsset, ZERO_ADDRESS);
  assert.equal(drop.stages[1].startTime, drop.stages[0].endTime);
  assert.equal(oneMintActiveStageIndex(drop.stages, 250), 1);
  assert.equal(Object.isFrozen(drop), true);
  assert.equal(Object.isFrozen(drop.stages), true);
});

test("OneMint builder rejects overlapping stages, unsupported modes, and disconnected proof fields", () => {
  const base = {
    target,
    payout,
    supply: 10,
    maxPerTransaction: 2,
    maxPerWallet: 3,
    metadataDigest: digest("a"),
  };
  assert.throws(() => buildOneMintDrop({
    ...base,
    stages: [
      { kind: OneMintStageKind.Public, startTime: 10, endTime: 20, metadataDigest: digest("b") },
      { kind: OneMintStageKind.Public, startTime: 19, endTime: 30, metadataDigest: digest("c") },
    ],
  }), /previous stage endTime/u);
  assert.throws(() => buildOneMintDrop({
    ...base,
    stages: [{ kind: OneMintStageKind.AuctionUnsupported, startTime: 10, endTime: 20, metadataDigest: digest("b") }],
  }), /unsupported enum/u);
  assert.throws(() => buildOneMintDrop({
    ...base,
    stages: [{ kind: OneMintStageKind.Allowlist, startTime: 10, endTime: 20, metadataDigest: digest("b") }],
  }), /signer must be set/u);
});

test("per-token mint data matches the pre-receiver hook framing rules", () => {
  assert.deepEqual(normalizeOneMintPerTokenMintData({ quantity: 1, tokenMintData: ["0x1234"] }), {
    mode: "single",
    quantity: 1n,
    slices: ["0x1234"],
  });
  assert.deepEqual(normalizeOneMintPerTokenMintData({ quantity: 3 }), {
    mode: "empty-batch",
    quantity: 3n,
    slices: [],
  });
  assert.deepEqual(normalizeOneMintPerTokenMintData({ quantity: 2, tokenMintData: ["0x", "0x"] }), {
    mode: "empty-batch",
    quantity: 2n,
    slices: [],
  });
  assert.throws(
    () => normalizeOneMintPerTokenMintData({ quantity: 2, tokenMintData: ["0x1234"] }),
    /one ordered slice per token/u,
  );
});
