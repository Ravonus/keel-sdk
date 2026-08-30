import assert from "node:assert/strict";
import test from "node:test";
import { keccak256, parseAbi, stringToBytes } from "viem";
import {
  KEEL721_CAMPAIGN_CREATOR_ROLE,
  KEEL721_PRESENTATION_ROLE,
  keel721Abi,
} from "../packages/sdk/dist/index.js";
import { ABIS as keelDieAbis } from "../packages/sdk/dist/abis/keel-die.generated.js";

const itemKey = (item) =>
  `${item.type}:${item.name}(${(item.inputs ?? []).map((input) => input.type).join(",")})`;

test("canonical KEEL721 human-readable ABI exactly tracks compiled functions and events", () => {
  const compiled = keelDieAbis.KEEL721
    .filter((item) => item.type === "function" || item.type === "event")
    .map(itemKey)
    .sort();
  const exported = parseAbi(keel721Abi).map(itemKey).sort();
  assert.deepEqual(exported, compiled);
});

test("KEEL721 role IDs stay available without public constant getters", () => {
  assert.equal(KEEL721_CAMPAIGN_CREATOR_ROLE, keccak256(stringToBytes("CAMPAIGN_CREATOR_ROLE")));
  assert.equal(KEEL721_PRESENTATION_ROLE, keccak256(stringToBytes("PRESENTATION_ROLE")));
  const compiledFunctions = new Set(
    keelDieAbis.KEEL721.filter((item) => item.type === "function").map((item) => item.name),
  );
  assert.equal(compiledFunctions.has("CAMPAIGN_CREATOR_ROLE"), false);
  assert.equal(compiledFunctions.has("PRESENTATION_ROLE"), false);
});
