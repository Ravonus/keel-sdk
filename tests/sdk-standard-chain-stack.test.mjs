import assert from "node:assert/strict";
import test from "node:test";

import {
  KEEL_STANDARD_CHAIN_STACK,
  KEEL_STANDARD_LIBRARY_ASSET_IDS,
  assertKeelStandardChainDeployment,
  buildKeelStandardChainDeploymentPlan,
} from "../packages/sdk/dist/index.js";

const OPERATOR = "0x1111111111111111111111111111111111111111";
const ADDRESSES = {
  keelGraphRegistry: "0x2222222222222222222222222222222222222222",
  keelLibraryRegistry: "0x3333333333333333333333333333333333333333",
  keelAssetTagRegistry: "0x4444444444444444444444444444444444444444",
  keelModuleReviewRegistry: "0x5555555555555555555555555555555555555555",
  keelPluginRegistry: "0x6666666666666666666666666666666666666666",
};

test("standard chain stack always includes the complete KEEL graph and library layer", () => {
  assert.deepEqual(
    KEEL_STANDARD_CHAIN_STACK.map(({ key, contractName, chainContractKind }) => ({ key, contractName, chainContractKind })),
    [
      { key: "keelGraphRegistry", contractName: "KeelGraphRegistry", chainContractKind: "keel-graph-registry" },
      { key: "keelLibraryRegistry", contractName: "KeelLibraryRegistry", chainContractKind: "keel-library-registry" },
      { key: "keelAssetTagRegistry", contractName: "KeelAssetTagRegistry", chainContractKind: "keel-asset-tag-registry" },
      { key: "keelModuleReviewRegistry", contractName: "KeelModuleReviewRegistry", chainContractKind: "keel-module-review-registry" },
      { key: "keelPluginRegistry", contractName: "KeelPluginRegistry", chainContractKind: "keel-plugin-registry" },
    ],
  );
});

test("standard Library bootstrap declares the shared p5 and deterministic seed modules once", () => {
  assert.deepEqual(KEEL_STANDARD_LIBRARY_ASSET_IDS, ["p5-1-11-3", "seeded-random"]);
});

test("standard chain deployment plan wires every constructor to the same graph layer", () => {
  const plan = buildKeelStandardChainDeploymentPlan({ operator: OPERATOR, addresses: ADDRESSES });
  assert.deepEqual(plan.map(({ key, args }) => [key, args]), [
    ["keelGraphRegistry", []],
    ["keelLibraryRegistry", [ADDRESSES.keelGraphRegistry]],
    ["keelAssetTagRegistry", [ADDRESSES.keelLibraryRegistry]],
    ["keelModuleReviewRegistry", [OPERATOR, OPERATOR, ADDRESSES.keelGraphRegistry]],
    ["keelPluginRegistry", [OPERATOR, OPERATOR, ADDRESSES.keelGraphRegistry]],
  ]);
});

test("standard chain deployment records fail closed when Library support is absent", () => {
  assert.throws(
    () => assertKeelStandardChainDeployment({ ...ADDRESSES, keelLibraryRegistry: undefined }),
    /keelLibraryRegistry/u,
  );
  assert.deepEqual(assertKeelStandardChainDeployment(ADDRESSES), ADDRESSES);
});
