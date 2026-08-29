import assert from "node:assert/strict";
import nodeTest from "node:test";
import { parseAbi } from "viem";

import {
  ABI_CONTRACTS,
  keelAssetTagRegistryAbi,
  moduleAbi,
  moduleAbiContracts,
} from "../packages/sdk/dist/index.js";
import { ABIS as graphAbis } from "../packages/sdk/dist/abis/keel-graph.generated.js";

const expectedFunctions = [
  "MAX_COMMUNITY_ACTIVE_TAGS",
  "MAX_LABEL_BYTES",
  "MAX_TAG_BATCH",
  "bitIndex",
  "canonicalTagWord",
  "canonicalWord",
  "communityCount",
  "communityTagCount",
  "communityTagWord",
  "communityWord",
  "defineCanonicalTag",
  "defineCanonicalTags",
  "has",
  "hasCommunityTag",
  "hasTag",
  "id",
  "label",
  "libraryRegistry",
  "nextTagId",
  "setCanonicalTags",
  "setCanonicalTagsByLabel",
  "setCommunityTags",
  "setCommunityTagsByLabel",
  "tagId",
  "tagIdFor",
  "tagLabel",
  "word",
  "wordIndex",
];

const expectedEvents = ["CanonicalTagUpdated", "CommunityTagUpdated", "TagDefined"];

function canonicalType(parameter) {
  return parameter.type.startsWith("tuple")
    ? `(${(parameter.components ?? []).map(canonicalType).join(",")})${parameter.type.slice("tuple".length)}`
    : parameter.type;
}

function signature(item) {
  return `${item.type}:${item.name}(${(item.inputs ?? []).map(canonicalType).join(",")})`;
}

nodeTest("asset-tag ABI is publicly exported and parseAbi exposes its functions and events", async () => {
  const parsed = parseAbi(keelAssetTagRegistryAbi);
  assert.deepEqual(
    parsed.filter((item) => item.type === "function").map((item) => item.name).sort(),
    [...expectedFunctions].sort(),
  );
  assert.deepEqual(
    parsed.filter((item) => item.type === "event").map((item) => item.name).sort(),
    [...expectedEvents].sort(),
  );

  assert.ok(ABI_CONTRACTS["keel-graph"].includes("KeelAssetTagRegistry"));
  assert.ok(moduleAbiContracts("keel-graph").includes("KeelAssetTagRegistry"));

  const generated = await moduleAbi("keel-graph", "KeelAssetTagRegistry");
  assert.deepEqual(generated, graphAbis.KeelAssetTagRegistry);

  const generatedSurface = generated.filter((item) => item.type === "function" || item.type === "event");
  const parsedSurface = parsed.filter((item) => item.type === "function" || item.type === "event");
  assert.deepEqual(
    parsedSurface.map(signature).sort(),
    generatedSurface.map(signature).sort(),
    "human-readable facade drifted from the checked generated ABI",
  );
});
