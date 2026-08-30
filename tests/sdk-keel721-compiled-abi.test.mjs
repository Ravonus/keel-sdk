import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import testBase from "node:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ABIS as keelDieAbis } from "../packages/sdk/dist/abis/keel-die.generated.js";
import { siblingTest } from "./sibling-repository.mjs";

const test = siblingTest(testBase, "keel-contracts");
const SDK_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONTRACTS_ROOT = resolve(SDK_ROOT, "../keel-contracts");
const RECORDED_ABI = resolve(CONTRACTS_ROOT, "modules/keel-die/abi/KEEL721.json");

test("KEEL721 compiled, recorded, and generated SDK ABIs are identical", () => {
  const compiled = JSON.parse(execFileSync(
    "forge",
    ["inspect", "src/modules/keel-die/KEEL721.sol:KEEL721", "abi", "--json"],
    { cwd: CONTRACTS_ROOT, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  ));
  const recorded = JSON.parse(readFileSync(RECORDED_ABI, "utf8"));
  assert.deepEqual(recorded, compiled, "checked-in KEEL721 ABI is stale relative to Solidity");
  assert.deepEqual(keelDieAbis.KEEL721, recorded, "generated SDK ABI is stale relative to contracts");
});
