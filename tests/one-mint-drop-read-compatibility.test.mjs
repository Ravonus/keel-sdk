import assert from "node:assert/strict";
import test from "node:test";

import { decodeFunctionResult, encodeFunctionResult, parseAbi } from "viem";

import {
  keelCrossChainMintBridgeAbi,
  keelMintGateAbi,
  keelMintRouteRegistryAbi,
  oneMintControllerAbi,
  oneMintCoreDropReadAbi,
} from "../packages/sdk/dist/index.js";
import { ABIS as mintAccessAbis } from "../packages/sdk/dist/abis/keel-mint-access.generated.js";
import { ABIS as crossChainAbis } from "../packages/sdk/dist/abis/keel-cross-chain-mint.generated.js";

const creator = "0x764E3EE7A844d9165937c41fd08086e43b997149";
const target = "0x89353d6847EcAb3c5E2d2b89d0401ddc3b0250Ef";
const digest = "0xee594f9f8106382885d65d35bf84a189847412529099518057946f430f48bf89";
const coreAbi = parseAbi(oneMintCoreDropReadAbi);
const currentAbi = parseAbi(oneMintControllerAbi);

const coreDrop = {
  creator,
  target,
  payout: creator,
  supply: 1n,
  minted: 0n,
  defaultMaxPerTransaction: 1,
  defaultMaxPerWallet: 1,
  stageCount: 1,
  paused: false,
  closed: false,
  capacityReserved: true,
  exists: true,
  metadataDigest: digest,
};

const currentDrop = {
  ...coreDrop,
  targetTokenId: 22n,
  itemized: true,
  skipTargetHook: false,
  mintRouteId: 9n,
};

function functionEntry(abi, name) {
  const entry = abi.find((candidate) => candidate.type === "function" && candidate.name === name);
  assert.ok(entry, `missing function ${name}`);
  return entry;
}

function eventEntry(abi, name) {
  const entry = abi.find((candidate) => candidate.type === "event" && candidate.name === name);
  assert.ok(entry, `missing event ${name}`);
  return entry;
}

function componentShape(components) {
  return components.map(({ name, type }) => ({ name, type }));
}

test("stable OneMint drop ABI decodes the deployed 13-word Sepolia layout", () => {
  const data = encodeFunctionResult({
    abi: coreAbi,
    functionName: "getDrop",
    result: coreDrop,
  });

  assert.equal((data.length - 2) / 2, 416);
  assert.deepEqual(decodeFunctionResult({
    abi: coreAbi,
    functionName: "getDrop",
    data,
  }), coreDrop);
});

test("stable OneMint drop ABI ignores every append-only field on current controllers", () => {
  const data = encodeFunctionResult({
    abi: currentAbi,
    functionName: "getDrop",
    result: currentDrop,
  });

  assert.equal((data.length - 2) / 2, 544);
  assert.deepEqual(decodeFunctionResult({
    abi: coreAbi,
    functionName: "getDrop",
    data,
  }), coreDrop);
});

test("current OneMint ABI exposes the optional capacity fast-path read without changing getDrop", () => {
  assert.ok(oneMintControllerAbi.includes("function capacityReservationSkipped(bytes32 dropId) view returns (bool)"));
});

test("stable mint facades exactly match current generated route-aware tuple layouts", () => {
  const stableOneMint = parseAbi(oneMintControllerAbi);
  const stableCore = parseAbi(oneMintCoreDropReadAbi);
  const generatedDrop = functionEntry(mintAccessAbis.OneMintController, "getDrop").outputs[0].components;
  const stableDrop = functionEntry(stableOneMint, "getDrop").outputs[0].components;
  const stableCoreDrop = functionEntry(stableCore, "getDrop").outputs[0].components;
  assert.deepEqual(componentShape(stableDrop), componentShape(generatedDrop));
  assert.deepEqual(componentShape(stableCoreDrop), componentShape(generatedDrop.slice(0, 13)));

  const stableGate = parseAbi(keelMintGateAbi);
  const generatedCampaign = functionEntry(mintAccessAbis.KeelMintGate, "getCampaign").outputs[0].components;
  const stableCampaign = functionEntry(stableGate, "getCampaign").outputs[0].components;
  assert.deepEqual(componentShape(stableCampaign), componentShape(generatedCampaign));

  const stableCrossChain = parseAbi(keelCrossChainMintBridgeAbi);
  const generatedCrossChain = crossChainAbis.KeelCrossChainMintBridge;
  assert.deepEqual(
    componentShape(functionEntry(stableCrossChain, "mintRoute").outputs[0].components),
    componentShape(functionEntry(generatedCrossChain, "mintRoute").outputs[0].components),
  );
  assert.deepEqual(
    componentShape(functionEntry(stableCrossChain, "setMintRoute").inputs),
    componentShape(functionEntry(generatedCrossChain, "setMintRoute").inputs),
  );
  assert.deepEqual(
    componentShape(eventEntry(stableCrossChain, "MintRouteConfigured").inputs),
    componentShape(eventEntry(generatedCrossChain, "MintRouteConfigured").inputs),
  );
  assert.deepEqual(
    componentShape(functionEntry(stableCrossChain, "requestCrossMint").inputs),
    componentShape(functionEntry(generatedCrossChain, "requestCrossMint").inputs),
  );
  assert.deepEqual(
    componentShape(eventEntry(stableCrossChain, "CrossMintRequested").inputs),
    componentShape(eventEntry(generatedCrossChain, "CrossMintRequested").inputs),
  );

  const stableRegistry = parseAbi(keelMintRouteRegistryAbi);
  for (const name of ["resolveCurrentRoute", "resolveCurrentTargetRoute", "mintReserved", "mintUnreserved"]) {
    assert.deepEqual(
      componentShape(functionEntry(stableRegistry, name).inputs),
      componentShape(functionEntry(mintAccessAbis.KeelMintRouteRegistry, name).inputs),
    );
  }
});
