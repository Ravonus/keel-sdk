import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { root } from "./run.mjs";
import { compileCanonicalSolidityArtifacts, SOLIDITY_COMPILER_SETTINGS } from "./solidity-compiler.mjs";

const artifactsRoot = path.join(root, "packages", "contracts", "artifacts");
const compiled = await compileCanonicalSolidityArtifacts(root);
for (const diagnostic of compiled.diagnostics) {
  const line = diagnostic.formattedMessage ?? diagnostic.message;
  (diagnostic.severity === "error" ? process.stderr : process.stdout).write(`${line}\n`);
}

await rm(artifactsRoot, { recursive: true, force: true });
await mkdir(artifactsRoot, { recursive: true });
for (const [contractName, artifact] of compiled.artifacts) {
  await writeFile(path.join(artifactsRoot, `${contractName}.json`), `${JSON.stringify(artifact, null, 2)}\n`);
}
await writeFile(
  path.join(artifactsRoot, "solc-summary.json"),
  `${JSON.stringify({
    compiler: compiled.compilerVersion,
    evmVersion: SOLIDITY_COMPILER_SETTINGS.evmVersion,
    optimizerRuns: SOLIDITY_COMPILER_SETTINGS.optimizerRuns,
    viaIR: SOLIDITY_COMPILER_SETTINGS.viaIR,
    bytecodeHash: SOLIDITY_COMPILER_SETTINGS.bytecodeHash,
    appendCBOR: SOLIDITY_COMPILER_SETTINGS.appendCBOR,
    contracts: compiled.summary,
  }, null, 2)}\n`,
);
process.stdout.write(`Compiled ${compiled.summary.length} Solidity contracts with ${compiled.compilerVersion}.\n`);
for (const item of compiled.summary.filter((entry) => entry.runtimeBytes > 0)) {
  process.stdout.write(`${item.contractName.padEnd(28)} ${String(item.runtimeBytes).padStart(6)} runtime bytes\n`);
}
