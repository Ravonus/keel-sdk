import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { contractsRoot, root } from "./run.mjs";
import { SOLIDITY_COMPILER_SETTINGS } from "./solidity-compiler.mjs";

async function filesBelow(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const value = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await filesBelow(value)));
    else if (entry.isFile() && entry.name.endsWith(".sol")) output.push(value);
  }
  return output;
}

function policyCode(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\/\/.*$/gmu, "");
}

function functionHeaders(code) {
  return [
    ...code.matchAll(
      /\b(?:function\s+[A-Za-z_$][\w$]*|constructor|receive|fallback)\s*\([^;{}]*\)[^{;]*\{/gu,
    ),
  ].map((match) => match[0]);
}

// The SDK gate owns reusable KEEL modules. Standalone creator examples keep
// their gas and behavior tests in their owning project instead of becoming
// hidden SDK prerequisites.
const sourceRoot = path.join(contractsRoot, "src", "modules");
const foundryPath = path.join(contractsRoot, "foundry.toml");
const foundryConfig = await readFile(foundryPath, "utf8");

const expectedFoundrySettings = [
  ["optimizer", /^optimizer\s*=\s*true$/mu],
  [
    `optimizer_runs = ${SOLIDITY_COMPILER_SETTINGS.optimizerRuns}`,
    new RegExp(
      `^optimizer_runs\\s*=\\s*${SOLIDITY_COMPILER_SETTINGS.optimizerRuns}$`,
      "mu",
    ),
  ],
  [
    `evm_version = "${SOLIDITY_COMPILER_SETTINGS.evmVersion}"`,
    new RegExp(
      `^evm_version\\s*=\\s*"${SOLIDITY_COMPILER_SETTINGS.evmVersion}"$`,
      "mu",
    ),
  ],
  ["via_ir", /^via_ir\s*=\s*true$/mu],
  [
    `bytecode_hash = "${SOLIDITY_COMPILER_SETTINGS.bytecodeHash}"`,
    new RegExp(
      `^bytecode_hash\\s*=\\s*"${SOLIDITY_COMPILER_SETTINGS.bytecodeHash}"$`,
      "mu",
    ),
  ],
  [
    `cbor_metadata = ${String(SOLIDITY_COMPILER_SETTINGS.appendCBOR)}`,
    new RegExp(
      `^cbor_metadata\\s*=\\s*${String(SOLIDITY_COMPILER_SETTINGS.appendCBOR)}$`,
      "mu",
    ),
  ],
];

const failures = [];
for (const [label, pattern] of expectedFoundrySettings) {
  if (!pattern.test(foundryConfig)) {
    failures.push(`${path.relative(root, foundryPath)}: expected ${label}`);
  }
}

let entrypoints = 0;
let stateChangingEntrypoints = 0;
let payableEntrypoints = 0;
let transientProtectedEntrypoints = 0;

for (const file of await filesBelow(sourceRoot)) {
  const relative = path.relative(root, file);
  const source = await readFile(file, "utf8");
  const code = policyCode(source);

  const forbidden = [
    [
      "storage-backed ReentrancyGuard; Cancun contracts must use ReentrancyGuardTransient",
      /@openzeppelin\/contracts\/utils\/ReentrancyGuard\.sol/gu,
    ],
    ["string-bearing require", /\brequire\s*\([^;]*,\s*["']/gu],
    ["string-bearing revert", /\brevert\s*\(\s*["']/gu],
    ["2300-gas transfer", /\.transfer\s*\(/gu],
    ["2300-gas send", /\.send\s*\(/gu],
  ];
  for (const [label, pattern] of forbidden) {
    if (pattern.test(code)) failures.push(`${relative}: forbidden ${label}`);
  }

  for (const header of functionHeaders(code)) {
    if (!/\b(?:external|public)\b/u.test(header)) continue;
    entrypoints += 1;
    if (!/\b(?:view|pure)\b/u.test(header)) stateChangingEntrypoints += 1;
    if (/\bpayable\b/u.test(header)) payableEntrypoints += 1;
    if (/\bnonReentrant\b/u.test(header)) transientProtectedEntrypoints += 1;
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}

console.log(
  `Solidity gas policy passed across ${entrypoints} public/external entrypoints (${stateChangingEntrypoints} state-changing, ${payableEntrypoints} payable, ${transientProtectedEntrypoints} transient-guarded).`,
);
