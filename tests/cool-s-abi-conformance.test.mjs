import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import nodeTest from "node:test";
import { parseAbiItem } from "viem";

import {
  ABI_CONTRACTS,
  coolSCanvas721Abi,
  coolSCanvasMintControllerAbi,
  coolSLine721Abi,
  coolS721Abi,
  coolSMetadataRendererAbi,
  coolSReleaseResolverAbi,
  coolSTargetTableAbi,
  coolSVisualRegistryAbi,
  keel721Abi,
  oneMintControllerAbi,
} from "../packages/sdk/dist/index.js";
import { ABIS as canvasAbis } from "../packages/sdk/dist/abis/keel-canvas.generated.js";
import { ABIS as coolSAbis } from "../packages/sdk/dist/abis/cool-s.generated.js";
import { ABIS as lineAbis } from "../packages/sdk/dist/abis/line.generated.js";
import { siblingRepositories } from "./sibling-repository.mjs";

const siblings = siblingRepositories("cool-s", "keel-contracts");
const COOL_S_CONTRACTS = new URL("../../cool-s/contracts/", import.meta.url);
const KEEL_CONTRACTS = new URL("../../keel-contracts/", import.meta.url);

function compilerAbi(root, spec) {
  try {
    return JSON.parse(execFileSync(
      "forge",
      ["inspect", spec, "abi", "--json"],
      { cwd: root, encoding: "utf8" },
    ));
  } catch (error) {
    throw new Error("Could not inspect " + spec + " with Forge: " + (error instanceof Error ? error.message : String(error)));
  }
}

function canonicalType(parameter) {
  return parameter.type.startsWith("tuple")
    ? "(" + (parameter.components ?? []).map(canonicalType).join(",") + ")" + parameter.type.slice("tuple".length)
    : parameter.type;
}

function key(item) {
  return item.type + ":" + item.name + "(" + (item.inputs ?? []).map(canonicalType).join(",") + ")";
}

function normalizeParameter(parameter, preserveName) {
  return {
    name: preserveName ? (parameter.name ?? "") : "",
    type: parameter.type,
    indexed: parameter.indexed ?? false,
    components: (parameter.components ?? []).map((component) => normalizeParameter(component, true)),
  };
}

function normalizeItem(item) {
  const isEvent = item.type === "event";
  return {
    type: item.type,
    name: item.name,
    stateMutability: item.stateMutability ?? "",
    anonymous: item.anonymous ?? false,
    // Solidity overrides may omit a parameter label without changing its wire
    // ABI. Return labels, tuple fields, and all event labels remain exact:
    // callers rely on those to expose artifactRevision instead of the retired
    // objectRevision vocabulary.
    inputs: (item.inputs ?? []).map((parameter) => normalizeParameter(parameter, isEvent)),
    outputs: (item.outputs ?? []).map((parameter) => normalizeParameter(parameter, true)),
  };
}

function normalizedInterface(items) {
  const entries = items
    .filter((item) => item.type === "function" || item.type === "event")
    .map((item) => [key(item), normalizeItem(item)]);
  assert.equal(new Set(entries.map(([signature]) => signature)).size, entries.length, "ABI contains a duplicate callable signature");
  return entries.sort(([left], [right]) => left.localeCompare(right));
}

function assertFacadeMatchesCompiler(name, facade, root, spec) {
  const source = compilerAbi(root, spec);
  const parsed = facade.map((item) => parseAbiItem(item));
  assert.deepEqual(
    normalizedInterface(parsed),
    normalizedInterface(source),
    name + " drifted from " + spec,
  );
}

const FACADES = [
  ["keel721Abi", keel721Abi, KEEL_CONTRACTS, "src/modules/keel-die/KEEL721.sol:KEEL721"],
  ["coolSLine721Abi", coolSLine721Abi, COOL_S_CONTRACTS, "src/line/LINE721.sol:LINE721"],
  ["coolSCanvas721Abi", coolSCanvas721Abi, COOL_S_CONTRACTS, "src/keel-canvas/CoolSCanvas721.sol:CoolSCanvas721"],
  ["coolSCanvasMintControllerAbi", coolSCanvasMintControllerAbi, COOL_S_CONTRACTS, "src/keel-canvas/CoolSCanvasMintController.sol:CoolSCanvasMintController"],
  ["coolS721Abi", coolS721Abi, COOL_S_CONTRACTS, "src/cool-s/CoolS721.sol:CoolS721"],
  ["coolSVisualRegistryAbi", coolSVisualRegistryAbi, COOL_S_CONTRACTS, "src/cool-s/CoolSVisualRegistryV1.sol:CoolSVisualRegistryV1"],
  ["coolSTargetTableAbi", coolSTargetTableAbi, COOL_S_CONTRACTS, "src/cool-s/CoolSTargetTableV1.sol:CoolSTargetTableV1"],
  ["coolSReleaseResolverAbi", coolSReleaseResolverAbi, COOL_S_CONTRACTS, "src/cool-s/CoolSReleaseResolverV1.sol:CoolSReleaseResolverV1"],
  ["coolSMetadataRendererAbi", coolSMetadataRendererAbi, COOL_S_CONTRACTS, "src/cool-s/CoolSMetadataRendererV1.sol:CoolSMetadataRendererV1"],
];

nodeTest("Cool S and LINE human-readable SDK facades exactly follow their compiler ABIs", {
  skip: siblings.skip,
  timeout: 60_000,
}, () => {
  for (const [name, facade, root, spec] of FACADES) {
    assertFacadeMatchesCompiler(name, facade, root, spec);
  }
});

nodeTest("generated Cool S, LINE, and canvas ABI exports remain exact compiler snapshots", {
  skip: siblings.skip,
  timeout: 60_000,
}, () => {
  const generated = [
    ["cool-s", coolSAbis, [
      ["CoolS721", "src/cool-s/CoolS721.sol:CoolS721"],
      ["CoolSMetadataRendererV1", "src/cool-s/CoolSMetadataRendererV1.sol:CoolSMetadataRendererV1"],
      ["CoolSNoveltyLedgerV1", "src/cool-s/CoolSNoveltyLedgerV1.sol:CoolSNoveltyLedgerV1"],
      ["CoolSReleaseResolverV1", "src/cool-s/CoolSReleaseResolverV1.sol:CoolSReleaseResolverV1"],
      ["CoolSTargetTableV1", "src/cool-s/CoolSTargetTableV1.sol:CoolSTargetTableV1"],
      ["CoolSVisualRegistryV1", "src/cool-s/CoolSVisualRegistryV1.sol:CoolSVisualRegistryV1"],
      ["CoolSLocalVRFCoordinator", "src/cool-s/CoolSLocalVRFCoordinator.sol:CoolSLocalVRFCoordinator"],
    ]],
    ["line", lineAbis, [
      ["LINE721", "src/line/LINE721.sol:LINE721"],
      ["LINEThumbnail", "src/line/LINEThumbnail.sol:LINEThumbnail"],
      ["LINEThumbnailRenderer", "src/line/LINEThumbnailRenderer.sol:LINEThumbnailRenderer"],
    ]],
    ["keel-canvas", canvasAbis, [
      ["CoolSCanvas721", "src/keel-canvas/CoolSCanvas721.sol:CoolSCanvas721"],
      ["CoolSCanvasRenderer", "src/keel-canvas/CoolSCanvasRenderer.sol:CoolSCanvasRenderer"],
      ["CoolSCanvasSplitter", "src/keel-canvas/CoolSCanvasSplitter.sol:CoolSCanvasSplitter"],
      ["CoolSCanvasMintController", "src/keel-canvas/CoolSCanvasMintController.sol:CoolSCanvasMintController"],
      ["CoolSComposer", "src/keel-canvas/CoolSComposer.sol:CoolSComposer"],
    ]],
  ];

  for (const [unit, exported, contracts] of generated) {
    assert.deepEqual([...ABI_CONTRACTS[unit]].sort(), Object.keys(exported).sort(), unit + " ABI index drifted from its exports");
    for (const [name, spec] of contracts) {
      assert.deepEqual(exported[name], compilerAbi(COOL_S_CONTRACTS, spec), unit + "/" + name + " drifted from " + spec);
    }
  }
});

nodeTest("LINE and Cool S use fourteen strokes and current artifact vocabulary, while OneMint exposes its delegate read", {
  skip: siblings.skip,
  timeout: 30_000,
}, () => {
  const lineItems = coolSLine721Abi.map((item) => parseAbiItem(item));
  const weights = lineItems.find((item) => item.type === "function" && item.name === "setLineRarityWeights");
  assert.equal(weights?.inputs?.[0]?.type, "uint16[14]");
  assert.ok(lineItems.some((item) => item.type === "event" && item.name === "LineMinted"));
  assert.ok(!lineItems.some((item) => item.type === "event" && item.name.startsWith("CoolSLine")));
  const record = lineItems.find((item) => item.type === "function" && item.name === "lineRecord");
  assert.equal(record?.outputs?.[2]?.name, "artifactRevision");

  const expectedDelegateRead = compilerAbi(
    KEEL_CONTRACTS,
    "src/modules/keel-mint-access/OneMintController.sol:OneMintController",
  ).find((item) => item.type === "function" && item.name === "delegates");
  const actualDelegateRead = oneMintControllerAbi
    .map((item) => parseAbiItem(item))
    .find((item) => item.type === "function" && item.name === "delegates");
  assert.deepEqual(normalizeItem(actualDelegateRead), normalizeItem(expectedDelegateRead));
});
