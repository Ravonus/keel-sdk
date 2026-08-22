import { readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { root } from "./run.mjs";

export const EIP170_MAX_RUNTIME_BYTES = 24_576;
export const SOLIDITY_COMPILER_SETTINGS = Object.freeze({
  evmVersion: "cancun",
  optimizerRuns: 200,
  viaIR: true,
  bytecodeHash: "none",
  appendCBOR: false,
});

async function filesBelow(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const value = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await filesBelow(value)));
    else if (entry.isFile() && entry.name.endsWith(".sol")) output.push(value);
  }
  return output;
}

async function pinnedSolc() {
  let solc;
  try {
    ({ default: solc } = await import("solc"));
  } catch (error) {
    throw new Error(
      `solc 0.8.36 is not installed. Run pnpm install before compiling. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const compilerVersion = solc.version();
  if (!compilerVersion.startsWith("0.8.36+")) {
    throw new Error(
      `Expected solc 0.8.36, received ${compilerVersion}. Refusing a non-pinned build.`,
    );
  }
  return { solc, compilerVersion };
}

export async function compileCanonicalSolidityArtifacts(
  repositoryRoot = root,
  options = {},
) {
  const selectedContractNames =
    options.contractNames === undefined
      ? undefined
      : new Set(options.contractNames);
  const selectedSourceNames =
    options.sourceNames === undefined
      ? undefined
      : new Set(options.sourceNames);
  const contractsRoot = path.join(repositoryRoot, "packages", "contracts");
  const sourceRoot = path.join(contractsRoot, "src");
  const sources = {};
  for (const file of await filesBelow(sourceRoot)) {
    const key = path.relative(contractsRoot, file).split(path.sep).join("/");
    if (selectedSourceNames !== undefined && !selectedSourceNames.has(key)) continue;
    sources[key] = { content: await readFile(file, "utf8") };
  }

  const importCallback = (importPath) => {
    const candidates = [
      path.join(contractsRoot, importPath),
      path.join(repositoryRoot, "node_modules", importPath),
    ];
    for (const candidate of candidates) {
      try {
        return { contents: readFileSync(candidate, "utf8") };
      } catch {}
    }
    return { error: `Import not found: ${importPath}` };
  };

  const { solc, compilerVersion } = await pinnedSolc();
  const input = {
    language: "Solidity",
    sources,
    settings: {
      optimizer: {
        enabled: true,
        runs: SOLIDITY_COMPILER_SETTINGS.optimizerRuns,
      },
      viaIR: SOLIDITY_COMPILER_SETTINGS.viaIR,
      evmVersion: SOLIDITY_COMPILER_SETTINGS.evmVersion,
      metadata: {
        bytecodeHash: SOLIDITY_COMPILER_SETTINGS.bytecodeHash,
        appendCBOR: SOLIDITY_COMPILER_SETTINGS.appendCBOR,
      },
      outputSelection: {
        "*": {
          "*": [
            "abi",
            "metadata",
            "evm.bytecode.object",
            "evm.deployedBytecode.object",
            "evm.deployedBytecode.immutableReferences",
            "evm.methodIdentifiers",
          ],
        },
      },
    },
  };
  const output = JSON.parse(
    solc.compile(JSON.stringify(input), { import: importCallback }),
  );
  const diagnostics = output.errors ?? [];
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    const errors = diagnostics
      .filter((diagnostic) => diagnostic.severity === "error")
      .map((diagnostic) => diagnostic.formattedMessage ?? diagnostic.message)
      .join("\n");
    throw new Error(`Solidity compilation failed.\n${errors}`);
  }

  const artifacts = new Map();
  const summary = [];
  for (const [sourceName, contracts] of Object.entries(
    output.contracts ?? {},
  )) {
    if (!sourceName.startsWith("src/")) continue;
    for (const [contractName, artifact] of Object.entries(contracts)) {
      if (
        selectedContractNames !== undefined &&
        !selectedContractNames.has(contractName)
      )
        continue;
      const bytecode = artifact.evm?.bytecode?.object ?? "";
      const deployedBytecode = artifact.evm?.deployedBytecode?.object ?? "";
      const creationBytes = bytecode.length / 2;
      const runtimeBytes = deployedBytecode.length / 2;
      if (runtimeBytes > EIP170_MAX_RUNTIME_BYTES) {
        throw new Error(
          `${contractName} runtime is ${runtimeBytes} bytes; EIP-170 limit is ${EIP170_MAX_RUNTIME_BYTES}.`,
        );
      }
      const item = {
        sourceName,
        contractName,
        compiler: compilerVersion,
        creationBytes,
        runtimeBytes,
        abi: artifact.abi,
        bytecode: `0x${bytecode}`,
        deployedBytecode: `0x${deployedBytecode}`,
        immutableReferences:
          artifact.evm?.deployedBytecode?.immutableReferences ?? {},
        methodIdentifiers: artifact.evm?.methodIdentifiers ?? {},
        metadata: artifact.metadata,
      };
      artifacts.set(contractName, item);
      summary.push({ sourceName, contractName, creationBytes, runtimeBytes });
    }
  }
  if (selectedContractNames !== undefined) {
    const missing = [...selectedContractNames].filter(
      (contractName) => !artifacts.has(contractName),
    );
    if (missing.length > 0)
      throw new Error(
        `Canonical Solidity targets were not found: ${missing.join(", ")}.`,
      );
  }
  summary.sort(
    (left, right) =>
      right.runtimeBytes - left.runtimeBytes ||
      left.contractName.localeCompare(right.contractName),
  );
  return { compilerVersion, diagnostics, artifacts, summary };
}
