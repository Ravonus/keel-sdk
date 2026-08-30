import assert from "node:assert/strict";
import test from "node:test";

import {
  ONE_MINT_SUPPORTED_STAGE_KINDS,
  OneMintStageKind,
  ZERO_ADDRESS,
  ZERO_BYTES32,
  buildOneMintDrop,
  buildOneMintItemDrop,
  normalizeOneMintPerTokenMintData,
  oneMintActiveStageIndex,
  oneMintStageKindName,
} from "../packages/sdk/dist/index.js";

const target = "0x1111111111111111111111111111111111111111";
const payout = "0x2222222222222222222222222222222222222222";
const signer = "0x3333333333333333333333333333333333333333";
const entitlement = "0x4444444444444444444444444444444444444444";
const digest = (byte) => `0x${byte.repeat(64)}`;

test("[OneMint/buildOneMintDrop] preserves one shared allocation and immutable ordered stages", () => {
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

test("[OneMint/buildOneMintDrop] rejects invalid bounds, stage gaps, unsupported modes, and disconnected proof fields", () => {
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
  assert.throws(() => buildOneMintDrop({ ...base, supply: 0, stages: [] }), /supply must be greater than zero/u);
  assert.throws(() => buildOneMintDrop({
    ...base,
    maxPerTransaction: 4,
    stages: [{ kind: OneMintStageKind.Public, startTime: 10, endTime: 20, metadataDigest: digest("b") }],
  }), /maxPerTransaction/u);
  assert.throws(() => buildOneMintDrop({
    ...base,
    maxPerWallet: 11,
    stages: [{ kind: OneMintStageKind.Public, startTime: 10, endTime: 20, metadataDigest: digest("b") }],
  }), /maxPerWallet/u);
  assert.throws(() => buildOneMintDrop({
    ...base,
    metadataDigest: ZERO_BYTES32,
    stages: [{ kind: OneMintStageKind.Public, startTime: 10, endTime: 20, metadataDigest: digest("b") }],
  }), /metadataDigest cannot be zero/u);
  assert.throws(() => buildOneMintDrop({
    ...base,
    stages: Array.from({ length: 17 }, (_, index) => ({
      kind: OneMintStageKind.Public,
      startTime: index,
      endTime: index + 1,
      metadataDigest: digest("b"),
    })),
  }), /between 1 and 16/u);
  assert.throws(() => buildOneMintDrop({
    ...base,
    stages: [{
      kind: OneMintStageKind.Public,
      startTime: 10,
      endTime: 20,
      unitPrice: 1n << 96n,
      metadataDigest: digest("b"),
    }],
  }), /unitPrice exceeds its uint bound/u);
});

test("[OneMint/buildOneMintItemDrop] fixes the ERC-1155 item into the reviewed drop", () => {
  const drop = buildOneMintItemDrop({
    target,
    payout,
    targetTokenId: 42,
    supply: 10,
    maxPerTransaction: 2,
    maxPerWallet: 3,
    metadataDigest: digest("a"),
    stages: [{ kind: OneMintStageKind.Public, startTime: 10, endTime: 20, metadataDigest: digest("b") }],
  });
  assert.equal(drop.targetTokenId, 42n);
  assert.equal(Object.isFrozen(drop), true);
  assert.throws(() => buildOneMintItemDrop({
    ...drop,
    targetTokenId: 1n << 256n,
  }), /targetTokenId exceeds its uint bound/u);
});

test("[OneMint/oneMintStageKindName] names every supported onchain stage and refuses legacy unsupported modes", () => {
  const expected = ["Off", "Allowlist", "Public", "Token payment", "Claim", "Premint", "End", "Merkle"];
  assert.deepEqual(ONE_MINT_SUPPORTED_STAGE_KINDS.map(oneMintStageKindName), expected);
  assert.throws(() => oneMintStageKindName(OneMintStageKind.AuctionUnsupported), /unsupported enum/u);
});

test("[OneMint/oneMintActiveStageIndex] uses half-open stage windows and uint64 timestamps", () => {
  const stages = [
    { startTime: 10n, endTime: 20n },
    { startTime: 20n, endTime: 30n },
  ];
  assert.equal(oneMintActiveStageIndex(stages, 9), undefined);
  assert.equal(oneMintActiveStageIndex(stages, 10), 0);
  assert.equal(oneMintActiveStageIndex(stages, 20), 1);
  assert.equal(oneMintActiveStageIndex(stages, 30), undefined);
  assert.throws(() => oneMintActiveStageIndex(stages, -1), /non-negative/u);
  assert.throws(() => oneMintActiveStageIndex(stages, 1n << 64n), /uint bound/u);
});

test("[OneMint/normalizeOneMintPerTokenMintData] enforces the pre-receiver hook framing rules", () => {
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
  assert.throws(
    () => normalizeOneMintPerTokenMintData({ quantity: 1, tokenMintData: ["0x12", "0x34"] }),
    /exactly one mint-data slice/u,
  );
  assert.throws(() => normalizeOneMintPerTokenMintData({ quantity: 0 }), /greater than zero/u);
  assert.throws(() => normalizeOneMintPerTokenMintData({ quantity: 1n << 32n }), /uint bound/u);
  assert.throws(
    () => normalizeOneMintPerTokenMintData({ quantity: 1, tokenMintData: ["0x1"] }),
    /even-length hexadecimal/u,
  );
});
