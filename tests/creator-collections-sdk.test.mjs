import assert from "node:assert/strict";
import test from "node:test";

import {
  OneMintStageKind,
  buildKeelCreator721Config,
  buildKeelCreator1155Config,
  buildOneMintItemDrop,
  keelSharedCollectionIdOf,
  keelSharedItemIndexOf,
  keelSharedTokenId,
  moduleAbi,
  moduleAbiContracts,
  oneMintControllerAbi,
} from "../packages/sdk/dist/index.js";

const creator = "0x1111111111111111111111111111111111111111";
const target = "0x2222222222222222222222222222222222222222";
const digest = (byte) => `0x${byte.repeat(64)}`;

test("creator collection configs are ABI-ready and reject ambiguous royalties", () => {
  assert.deepEqual(buildKeelCreator721Config({
    name: "One of Ones",
    symbol: "ONE",
    maxSupply: 100,
    royaltyReceiver: creator,
    royaltyBps: 500,
    metadataDigest: digest("a"),
  }), {
    name: "One of Ones",
    symbol: "ONE",
    royaltyReceiver: creator,
    royaltyBps: 500n,
    metadataDigest: digest("a"),
    maxSupply: 100n,
  });
  assert.equal(buildKeelCreator1155Config({
    name: "Editions",
    symbol: "EDIT",
    metadataDigest: digest("b"),
  }).royaltyBps, 0n);
  assert.throws(() => buildKeelCreator1155Config({
    name: "Editions",
    symbol: "EDIT",
    royaltyBps: 500,
    metadataDigest: digest("b"),
  }), /royaltyReceiver is required/u);
});

test("shared ERC-1155 token ids preserve disjoint logical collection ranges", () => {
  const first = keelSharedTokenId(7, 1);
  const second = keelSharedTokenId(8, 1);
  assert.notEqual(first, second);
  assert.equal(keelSharedCollectionIdOf(first), 7n);
  assert.equal(keelSharedItemIndexOf(first), 1n);
  assert.throws(() => keelSharedTokenId(0, 1), /must be positive/u);
});

test("item drop commits the ERC-1155 token id in the reviewed operation", () => {
  const drop = buildOneMintItemDrop({
    target,
    targetTokenId: keelSharedTokenId(7, 3),
    payout: creator,
    supply: 10,
    maxPerTransaction: 2,
    maxPerWallet: 4,
    metadataDigest: digest("c"),
    stages: [{
      kind: OneMintStageKind.Public,
      startTime: 100,
      endTime: 200,
      metadataDigest: digest("d"),
    }],
  });
  assert.equal(keelSharedCollectionIdOf(drop.targetTokenId), 7n);
  assert.equal(keelSharedItemIndexOf(drop.targetTokenId), 3n);
  assert.equal(Object.isFrozen(drop), true);
});

test("published module ABIs expose creator collections and exact item drops", async () => {
  assert.deepEqual(
    moduleAbiContracts("keel-die").filter((name) => name.startsWith("KeelCreator") || name === "KeelShared1155"),
    ["KeelCreator1155", "KeelCreator721", "KeelCreatorFactory", "KeelShared1155"],
  );
  const factoryAbi = await moduleAbi("keel-die", "KeelCreatorFactory");
  const controllerAbi = await moduleAbi("keel-mint-access", "OneMintController");
  assert.ok(factoryAbi.some((entry) => entry.type === "function" && entry.name === "createERC721"));
  assert.ok(factoryAbi.some((entry) => entry.type === "function" && entry.name === "createSharedERC1155"));
  assert.ok(controllerAbi.some((entry) => entry.type === "function" && entry.name === "createItemDrop"));
  assert.ok(oneMintControllerAbi.some((entry) => entry.includes("createItemDrop")));
});
