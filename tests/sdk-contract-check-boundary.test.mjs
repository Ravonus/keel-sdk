import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

test("SDK contract policy gates cover reusable modules, not creator examples", async () => {
  for (const script of ["solidity-static-check.mjs", "solidity-gas-check.mjs"]) {
    const source = await readFile(path.join(ROOT, "scripts", script), "utf8");
    assert.match(source, /path\.join\(contractsRoot, "src", "modules"\)/u);
    assert.doesNotMatch(source, /path\.join\(contractsRoot, "src"\)\)/u);
  }
});
