import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { root } from "./run.mjs";
import {
  compileCanonicalSolidityArtifacts,
  SOLIDITY_COMPILER_SETTINGS,
} from "./solidity-compiler.mjs";

const contractNames = Object.freeze([
  "KeelHold",
  "KEEL721",
  "KeelEquipmentInventory",
  "KeelEquipmentInventoryReader",
  "KeelEquipmentReservationEngine",
  "KeelManager",
  "KeelManagerProxy",
  "KeelArtifactRegistry",
  "VaultAchievementRegistry",
  "VaultArcadeRegistry",
  "VaultCharacter721",
  "VaultCharacterMetadataRenderer",
  "VaultCharacterStarterPack",
  "VaultGameCard",
  "VaultItem1155",
  "VaultMapAuction",
  "VaultRunLeaderboard",
  "VaultRunLootExtraction",
  "VaultRunSignatureAuthority",
]);

const artifactsRoot = path.join(root, "packages", "contracts", "artifacts");
const checkOnly = process.argv.includes("--check");
const compiled = await compileCanonicalSolidityArtifacts(root, {
  contractNames,
});
for (const diagnostic of compiled.diagnostics) {
  const line = diagnostic.formattedMessage ?? diagnostic.message;
  (diagnostic.severity === "error" ? process.stderr : process.stdout).write(
    `${line}\n`,
  );
}

const summary = {
  compiler: compiled.compilerVersion,
  evmVersion: SOLIDITY_COMPILER_SETTINGS.evmVersion,
  optimizerRuns: SOLIDITY_COMPILER_SETTINGS.optimizerRuns,
  viaIR: SOLIDITY_COMPILER_SETTINGS.viaIR,
  bytecodeHash: SOLIDITY_COMPILER_SETTINGS.bytecodeHash,
  appendCBOR: SOLIDITY_COMPILER_SETTINGS.appendCBOR,
  contracts: compiled.summary,
};
const parityFields = [
  "sourceName",
  "contractName",
  "compiler",
  "creationBytes",
  "runtimeBytes",
  "abi",
  "bytecode",
  "deployedBytecode",
  "methodIdentifiers",
  "metadata",
];

if (checkOnly) {
  for (const [contractName, artifact] of compiled.artifacts) {
    const stored = JSON.parse(
      await readFile(path.join(artifactsRoot, `${contractName}.json`), "utf8"),
    );
    for (const field of parityFields) {
      if (JSON.stringify(stored[field]) !== JSON.stringify(artifact[field])) {
        throw new Error(
          `${contractName} artifact ${field} is stale. Run pnpm contracts:compile:vault-runner before acceptance.`,
        );
      }
    }
  }
  const storedSummary = JSON.parse(
    await readFile(
      path.join(artifactsRoot, "vault-runner-solc-summary.json"),
      "utf8",
    ),
  );
  if (JSON.stringify(storedSummary) !== JSON.stringify(summary)) {
    throw new Error(
      "Vault Runner compiler summary is stale. Run pnpm contracts:compile:vault-runner before acceptance.",
    );
  }
  process.stdout.write(
    `Verified ${compiled.summary.length} canonical Vault Runner artifacts against current source.\n`,
  );
} else {
  await mkdir(artifactsRoot, { recursive: true });
  for (const [contractName, artifact] of compiled.artifacts) {
    await writeFile(
      path.join(artifactsRoot, `${contractName}.json`),
      `${JSON.stringify(artifact, null, 2)}\n`,
    );
  }
  await writeFile(
    path.join(artifactsRoot, "vault-runner-solc-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  process.stdout.write(
    `Compiled ${compiled.summary.length} Vault Runner contracts with ${compiled.compilerVersion}.\n`,
  );
}
for (const item of compiled.summary.filter((entry) => entry.runtimeBytes > 0)) {
  process.stdout.write(
    `${item.contractName.padEnd(32)} ${String(item.runtimeBytes).padStart(6)} runtime bytes\n`,
  );
}
