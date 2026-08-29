import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { contractsRoot, root } from "./run.mjs";
// The policy itself lives with the module tooling so the repo-wide gate and the
// per-module gate (`keel verify`) enforce exactly the same rules.
import { checkSource, staticPolicyCode } from "../tools/keel/static-policy.mjs";

async function walk(directory) {
  const values = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) values.push(...(await walk(absolute)));
    else if (entry.isFile() && entry.name.endsWith(".sol")) values.push(absolute);
  }
  return values;
}

if (process.argv.includes("--self-test")) {
  const allowed = staticPolicyCode(
    "if (blockhash(n) /* static-policy-allow: evidence-block-equality */ != expected) revert();",
  );
  const entropy = staticPolicyCode("bytes32 seed = keccak256(abi.encode(blockhash(block.number - 1))); ");
  if (/blockhash\s*\(/u.test(allowed) || !/blockhash\s*\(/u.test(entropy)) {
    throw new Error("blockhash evidence-only policy self-test failed");
  }
}

let failures = 0;
for (const file of await walk(path.join(contractsRoot, "src"))) {
  const source = await readFile(file, "utf8");
  for (const finding of checkSource(source)) {
    console.error(`${path.relative(root, file)}: ${finding}`);
    failures += 1;
  }
}

if (failures > 0) process.exit(1);
console.log("Solidity static policy checks passed.");
