import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { chooseSmallestCompression } from "../packages/builder/dist/index.js";
import {
  KEEL_NATIVE_CHUNK_BYTES,
  KEEL_NATIVE_CHUNKS_PER_TRANSACTION,
  KEEL_THREE_R180,
  assertKeelThreeR180OfficialBytes,
  estimateKeelNativePublicationGas,
} from "../packages/sdk/dist/index.js";
import { scanThreeR180Sepolia } from "./three-r180-sepolia-evidence.mjs";

const root = resolve(import.meta.dirname, "..");
const fixture = resolve(root, "examples/fixtures/three-r180-rotating-cube");
const output = resolve(fixture, "three-r180.sepolia.native-publication.quote.json");
const currentSepoliaStore = "0x0a4f31d5ab08029e4c68f6f3227d9fa3a2d66267";

function chunkLengths(length) {
  const result = [];
  for (let offset = 0; offset < length; offset += KEEL_NATIVE_CHUNK_BYTES) {
    result.push(Math.min(KEEL_NATIVE_CHUNK_BYTES, length - offset));
  }
  return result;
}

async function officialBytes() {
  const [demoMain, core] = await Promise.all([
    readFile(resolve(root, "examples/demos/vendor/three.min.js"), "utf8"),
    readFile(resolve(root, "examples/demos/vendor/three.core.min.js")),
  ]);
  // The demo copy is an isolated browser fixture. Reversing its two content
  // aliases recreates the exact upstream ESM file asserted by the SDK.
  return {
    main: new TextEncoder().encode(demoMain.replaceAll('from"/content/three.core.min.js"', 'from"./three.core.min.js"')),
    core: new Uint8Array(core),
  };
}

const source = await officialBytes();
await assertKeelThreeR180OfficialBytes(source);
const evidence = await scanThreeR180Sepolia({
  endpoint: process.argv[2],
  hold: currentSepoliaStore,
});
const [main, core] = await Promise.all([chooseSmallestCompression(source.main), chooseSmallestCompression(source.core)]);
const modules = [
  { metadata: KEEL_THREE_R180.main, source: source.main, stored: main },
  { metadata: KEEL_THREE_R180.core, source: source.core, stored: core },
].map(({ metadata, source: plaintext, stored }) => ({
  id: metadata.id,
  identity: metadata.identity,
  sourceUrl: metadata.sourceUrl,
  digest: metadata.digest,
  decodedByteLength: plaintext.byteLength,
  compression: stored.compression,
  storedByteLength: stored.bytes.byteLength,
  chunkByteLengths: chunkLengths(stored.bytes.byteLength),
  storedBytes: stored.bytes,
}));
const evidenceByModuleId = new Map(evidence.modules.map((module) => [module.id, module]));
for (const module of modules) {
  const record = evidenceByModuleId.get(module.id);
  if (record === undefined) throw new Error(`Sepolia evidence did not include ${module.id}.`);
  module.currentStoreMatch = record.currentStoreMatch;
}
const publicationModules = modules.filter((module) => !module.currentStoreMatch);
const allStoredBytes = new Uint8Array(publicationModules.reduce((total, item) => total + item.storedBytes.byteLength, 0));
let storedOffset = 0;
for (const item of publicationModules) {
  allStoredBytes.set(item.storedBytes, storedOffset);
  storedOffset += item.storedBytes.byteLength;
}
const allChunkByteLengths = publicationModules.flatMap((item) => item.chunkByteLengths);
const gas = publicationModules.length === 0
  ? undefined
  : estimateKeelNativePublicationGas({
    storedByteLength: allStoredBytes.byteLength,
    storedBytes: allStoredBytes,
    chunkByteLengths: allChunkByteLengths,
    contentObjectCount: publicationModules.length,
    logicalOperationCount: publicationModules.length,
    includeExecutorControlGas: true,
  });
const carrierBatches = [];
for (let index = 0; index < allChunkByteLengths.length; index += KEEL_NATIVE_CHUNKS_PER_TRANSACTION) {
  const batch = allChunkByteLengths.slice(index, index + KEEL_NATIVE_CHUNKS_PER_TRANSACTION);
  carrierBatches.push({
    index: carrierBatches.length,
    chunkIndexes: batch.map((_, offset) => index + offset),
    chunkByteLengths: batch,
    storedByteLength: batch.reduce((total, length) => total + length, 0),
  });
}

const quote = {
  schema: "keel-three-r180-shared-module-quote@1",
  status: evidence.outcome === "complete" ? "ALREADY_AVAILABLE" : "READY_FOR_REVIEW",
  route: "native-carrier-v1",
  chain: { family: "ethereum", chainId: 11155111, store: currentSepoliaStore },
  source: {
    package: "three@0.180.0",
    license: "MIT",
    maintainedBy: "three.js-authors",
    modules: modules.map(({ storedBytes, ...module }) => module),
  },
  deduplication: evidence,
  packing: {
    maxChunkBytes: KEEL_NATIVE_CHUNK_BYTES,
    maxCarriersPerExecutorTransaction: KEEL_NATIVE_CHUNKS_PER_TRANSACTION,
    totalChunks: allChunkByteLengths.length,
    carrierBatches,
  },
  operations: modules.map((module) => ({
    kind: "weld-object",
    moduleId: module.id,
    status: module.currentStoreMatch ? "reused-current-store" : "not-encoded-until-explicit-approval",
  })),
  gas: {
    calldataIntrinsicGas: gas?.calldataIntrinsicGas ?? 0,
    nativeCarrierWriteGas: gas?.nativeCarrierWriteGas ?? 0,
    objectCreationGas: gas?.objectCreationGas ?? 0,
    logicalRegistryOperationGas: gas?.logicalRegistryOperationGas ?? 0,
    executorControlGas: gas?.executorControlGas ?? 0,
    totalExecutorGas: gas?.totalExecutorGas ?? 0,
    executorEscrowWei: null,
    actualTransactionFeeWei: null,
    mainnetReferencePriceWei: null,
    selectedTestnetGasPriceWei: null,
    note: "No escrow or fee amount is quoted until an explicit owner, executor, deadline, and selected gas price are supplied.",
  },
  recovery: {
    job: "not-opened",
    futureJobMatch: ["owner", "executor", "planDigest", "chunkCount", "operationCount", "cursor"],
    confirmedChunksNeverRepeated: true,
    failedChunkIndexesPersisted: true,
    receiptReconciledBeforeRetry: true,
  },
  wallet: { approval: "not-requested", signing: "not-performed", submitted: false },
};

await writeFile(output, `${JSON.stringify(quote, null, 2)}\n`);
console.log(JSON.stringify({ output, status: quote.status, deduplication: evidence.outcome, chunks: quote.packing.totalChunks, carrierTransactions: carrierBatches.length, totalExecutorGas: quote.gas.totalExecutorGas }));
