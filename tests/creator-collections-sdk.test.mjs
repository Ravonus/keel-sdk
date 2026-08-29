import assert from "node:assert/strict";
import test from "node:test";

import {
  OneMintStageKind,
  buildKeelCreatorCollectionCall,
  buildKeelCreator721Config,
  buildKeelCreator1155Config,
  buildOneMintItemDrop,
  configuredKeelCreatorDeployment,
  keelSharedCollectionIdOf,
  keelSharedItemIndexOf,
  keelSharedTokenId,
  moduleAbi,
  moduleAbiContracts,
  oneMintControllerAbi,
  prepareKeelCreatorCollectionReview,
  resolveKeelCreatorDeploymentRecords,
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

test("creator collection calls cover one-of-one, editions, shared collections, and BYO without signing", () => {
  const factoryAddress = "0x3333333333333333333333333333333333333333";
  const cases = [
    buildKeelCreatorCollectionCall({
      chainId: 11155111,
      creator,
      factoryAddress,
      operation: {
        kind: "dedicated-erc721",
        config: { name: "One of One", symbol: "ONE", maxSupply: 1, metadataDigest: digest("1") },
      },
    }),
    buildKeelCreatorCollectionCall({
      chainId: 11155111,
      creator,
      factoryAddress,
      operation: {
        kind: "dedicated-erc1155",
        config: { name: "Open Editions", symbol: "OPEN", metadataDigest: digest("2") },
      },
    }),
    buildKeelCreatorCollectionCall({
      chainId: 11155111,
      creator,
      factoryAddress,
      operation: { kind: "shared-erc1155", name: "Ten Thousand", metadataDigest: digest("3") },
    }),
    buildKeelCreatorCollectionCall({
      chainId: 11155111,
      creator,
      factoryAddress,
      operation: { kind: "external", tokenContract: target, name: "Brought From Home", metadataDigest: digest("4") },
    }),
  ];
  assert.deepEqual(cases.map((entry) => entry.functionName), ["createERC721", "createERC1155", "createSharedERC1155", "registerExternalCollection"]);
  assert.deepEqual(cases.map((entry) => entry.signing), ["not-performed", "not-performed", "not-performed", "not-performed"]);
  assert.deepEqual(cases.map((entry) => entry.submission), ["not-performed", "not-performed", "not-performed", "not-performed"]);
  assert.equal(cases[0].arguments[0].maxSupply, "1");
  assert.equal(JSON.stringify(cases).includes("1n"), false);
});

test("creator preparation fails closed when a chain has no recorded factory and renderer pair", () => {
  const configured = configuredKeelCreatorDeployment(11155111, "creator-v1");
  assert.equal(configured.status, "missing");
  const review = prepareKeelCreatorCollectionReview({
    chainId: 11155111,
    instance: "creator-v1",
    creator,
    operation: {
      kind: "dedicated-erc721",
      config: { name: "One of One", symbol: "ONE", maxSupply: 1, metadataDigest: digest("5") },
    },
  });
  assert.equal(review.status, "blocked");
  assert.equal(review.walletApproval, "not-requested");
  assert.equal(review.signing, "not-performed");
  assert.equal(review.submission, "not-performed");
});

test("creator deployment resolution requires one exact factory and renderer instance", () => {
  const records = [
    { module: "keel-die", chainId: 31337, instance: "creator-a", contract: "KeelCreatorFactory", address: "0x3333333333333333333333333333333333333333" },
    { module: "keel-die", chainId: 31337, instance: "creator-a", contract: "KeelArtifactTokenRenderer", address: "0x4444444444444444444444444444444444444444" },
    { module: "keel-die", chainId: 31337, instance: "creator-b", contract: "KeelCreatorFactory", address: "0x5555555555555555555555555555555555555555" },
    { module: "keel-die", chainId: 31337, instance: "creator-b", contract: "KeelArtifactTokenRenderer", address: "0x6666666666666666666666666666666666666666" },
  ];
  assert.equal(resolveKeelCreatorDeploymentRecords(records, 31337).status, "ambiguous");
  const selected = resolveKeelCreatorDeploymentRecords(records, 31337, "creator-b");
  assert.equal(selected.status, "configured");
  assert.equal(selected.deployment.instance, "creator-b");
  assert.equal(selected.deployment.factoryAddress, records[2].address);
  assert.equal(selected.deployment.rendererAddress, records[3].address);
  assert.equal(resolveKeelCreatorDeploymentRecords(records.slice(0, 1), 31337, "creator-a").status, "missing");

  const conflicting = [
    records[0],
    records[1],
    { ...records[0], address: "0x7777777777777777777777777777777777777777" },
  ];
  assert.equal(resolveKeelCreatorDeploymentRecords(conflicting, 31337).status, "ambiguous");
  assert.equal(resolveKeelCreatorDeploymentRecords(conflicting, 31337, "creator-a").status, "ambiguous");
  assert.equal(resolveKeelCreatorDeploymentRecords([...conflicting, records[0]], 31337, "creator-a").status, "ambiguous");
  assert.equal(resolveKeelCreatorDeploymentRecords([records[0], records[1], records[0]], 31337, "creator-a").status, "configured");
});

test("published module ABIs expose creator collections and exact item drops", async () => {
  assert.deepEqual(
    moduleAbiContracts("keel-die").filter((name) => name.startsWith("KeelCreator") || name === "KeelArtifactTokenRenderer" || name === "KeelShared1155"),
    ["KeelArtifactTokenRenderer", "KeelCreator1155", "KeelCreator721", "KeelCreatorFactory", "KeelShared1155"],
  );
  const factoryAbi = await moduleAbi("keel-die", "KeelCreatorFactory");
  const rendererAbi = await moduleAbi("keel-die", "KeelArtifactTokenRenderer");
  const controllerAbi = await moduleAbi("keel-mint-access", "OneMintController");
  assert.ok(factoryAbi.some((entry) => entry.type === "function" && entry.name === "createERC721"));
  assert.ok(factoryAbi.some((entry) => entry.type === "function" && entry.name === "createSharedERC1155"));
  assert.ok(rendererAbi.some((entry) => entry.type === "function" && entry.name === "bindTokenPresentation"));
  assert.ok(rendererAbi.some((entry) => entry.type === "function" && entry.name === "tokenURI"));
  assert.ok(controllerAbi.some((entry) => entry.type === "function" && entry.name === "createItemDrop"));
  assert.ok(oneMintControllerAbi.some((entry) => entry.includes("createItemDrop")));
});
