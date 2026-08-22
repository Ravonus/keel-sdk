import { run } from "./run.mjs";

run("node", ["scripts/test.mjs"]);
run("node", ["scripts/solidity-static-check.mjs"]);
run("node", ["scripts/solidity-gas-check.mjs"]);

run("node", ["scripts/studio-structure-check.mjs"]);
