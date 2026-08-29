#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { brotliDecompressSync } from "node:zlib";

import {
  bytesToHex,
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  encodeFunctionData,
  http,
  keccak256,
  stringToHex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";

const EXPECTED_CHAIN_ID = 31_337;
const STORAGE_MODE = keccak256(stringToHex("history-inscription-v1"));
const TRANSACTION_GAS_CAP = 16_777_216n;
const CHUNK_BYTES = 23_000;
const CHUNKS_PER_BATCH = 3;
const EXPECTED = Object.freeze({
  decodedByteLength: 4_662_352,
  decodedDigest: "e0af21417cb1a10649a5ba200c96e3758218c567900463376c1cca0774cb713b",
  storedByteLength: 1_392_172,
  storedDigest: "4be5020e1ae73329f429e2a50721ffef4c8dd077da400ebe45e92aa4fbde3f73",
});

const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

function usage() {
  throw new Error("Usage: benchmark-keel-wake-anvil.mjs <decoded.bin> <stored.bin.br> <contract-artifact.json> [http://127.0.0.1:8545]");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeLocalRpc(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) {
    throw new Error("KEEL Wake benchmark refuses every non-loopback RPC URL.");
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("KEEL Wake benchmark RPC URL must be a bare loopback HTTP origin.");
  }
  return parsed.toString();
}

function calldataGas(data) {
  const bytes = Buffer.from(data.slice(2), "hex");
  let zeroBytes = 0;
  for (const byte of bytes) if (byte === 0) zeroBytes += 1;
  const nonZeroBytes = bytes.length - zeroBytes;
  const transactionBaseGas = 21_000;
  const normalIntrinsicGas = transactionBaseGas + zeroBytes * 4 + nonZeroBytes * 16;
  const eip7623FloorGas = transactionBaseGas + zeroBytes * 10 + nonZeroBytes * 40;
  return { calldataBytes: bytes.length, zeroBytes, nonZeroBytes, transactionBaseGas, normalIntrinsicGas, eip7623FloorGas };
}

function bigintJson(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

const [decodedPath, storedPath, artifactPath, rpcInput = "http://127.0.0.1:8545"] = process.argv.slice(2);
if (!decodedPath || !storedPath || !artifactPath) usage();
const rpcUrl = safeLocalRpc(rpcInput);
const [decoded, stored, artifact] = await Promise.all([
  readFile(decodedPath),
  readFile(storedPath),
  readFile(artifactPath, "utf8").then(JSON.parse),
]);
assert.equal(decoded.byteLength, EXPECTED.decodedByteLength);
assert.equal(sha256(decoded), EXPECTED.decodedDigest);
assert.equal(stored.byteLength, EXPECTED.storedByteLength);
assert.equal(sha256(stored), EXPECTED.storedDigest);

const abi = artifact.abi;
const bytecode = artifact.bytecode?.object ?? artifact.bytecode;
if (!Array.isArray(abi) || typeof bytecode !== "string" || !bytecode.startsWith("0x")) {
  throw new TypeError("Invalid KeelHistoryPublicationJob Forge artifact.");
}

const publicClient = createPublicClient({ transport: http(rpcUrl, { timeout: 30_000, retryCount: 0 }) });
const chainId = await publicClient.getChainId();
if (chainId !== EXPECTED_CHAIN_ID) {
  throw new Error(`KEEL Wake benchmark requires local chain ${EXPECTED_CHAIN_ID}; received ${chainId}.`);
}
const owner = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 0 });
const executor = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 1 });
const ownerWallet = createWalletClient({ account: owner, transport: http(rpcUrl, { timeout: 30_000, retryCount: 0 }) });
const executorWallet = createWalletClient({ account: executor, transport: http(rpcUrl, { timeout: 30_000, retryCount: 0 }) });

const deployHash = await ownerWallet.deployContract({ abi, bytecode, args: [] });
const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
assert.equal(deployReceipt.status, "success");
assert.ok(deployReceipt.contractAddress);
const coordinator = deployReceipt.contractAddress;

const chunks = [];
for (let offset = 0; offset < stored.byteLength; offset += CHUNK_BYTES) {
  const bytes = stored.subarray(offset, Math.min(offset + CHUNK_BYTES, stored.byteLength));
  chunks.push({ bytes, digest: `0x${sha256(bytes)}` });
}
const batches = [];
for (let firstChunkIndex = 0, storedByteOffset = 0; firstChunkIndex < chunks.length; firstChunkIndex += CHUNKS_PER_BATCH) {
  const selected = chunks.slice(firstChunkIndex, firstChunkIndex + CHUNKS_PER_BATCH);
  batches.push({
    batchIndex: batches.length,
    firstChunkIndex,
    storedByteOffset,
    chunks: selected,
  });
  storedByteOffset += selected.reduce((total, chunk) => total + chunk.bytes.byteLength, 0);
}
assert.equal(chunks.length, 61);
assert.equal(batches.length, 21);

const publicationId = await publicClient.readContract({ address: coordinator, abi, functionName: "nextPublicationId" });
const latest = await publicClient.getBlock({ blockTag: "latest" });
const deadline = latest.timestamp + 3_600n;
const planDigest = keccak256(stringToHex("keel-wake-doom-benchmark-v1"));
const decodedDigest = `0x${EXPECTED.decodedDigest}`;
const storedDigest = `0x${EXPECTED.storedDigest}`;
const mediaTypeHash = keccak256(stringToHex("application/vnd.fray.doom-container.v1"));
const openData = encodeFunctionData({
  abi,
  functionName: "openPublication",
  args: [
    publicationId,
    STORAGE_MODE,
    executor.address,
    deadline,
    planDigest,
    decodedDigest,
    storedDigest,
    BigInt(decoded.byteLength),
    BigInt(stored.byteLength),
    3,
    mediaTypeHash,
    chunks.map((chunk) => chunk.digest),
    batches.map((batch) => batch.chunks.length),
  ],
});

const transactions = [];
async function submit(wallet, account, role, data) {
  const intrinsic = calldataGas(data);
  const hash = await wallet.sendTransaction({ account, to: coordinator, data, gas: TRANSACTION_GAS_CAP });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `${role} reverted`);
  assert.ok(receipt.gasUsed <= TRANSACTION_GAS_CAP, `${role} exceeded the transaction gas cap`);
  const transaction = await publicClient.getTransaction({ hash });
  assert.equal(transaction.input.toLowerCase(), data.toLowerCase());
  transactions.push({
    role,
    hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice,
    actualFeeWei: receipt.gasUsed * receipt.effectiveGasPrice,
    gasHeadroom: TRANSACTION_GAS_CAP - receipt.gasUsed,
    ...intrinsic,
    calldataFloorDominated: receipt.gasUsed === BigInt(intrinsic.eip7623FloorGas),
  });
  return { receipt, transaction };
}

await submit(ownerWallet, owner, "open", openData);
for (const batch of batches) {
  const data = encodeFunctionData({
    abi,
    functionName: "publishBatch",
    args: [
      publicationId,
      STORAGE_MODE,
      planDigest,
      BigInt(batch.batchIndex),
      BigInt(batch.firstChunkIndex),
      BigInt(batch.storedByteOffset),
      batch.chunks.map((chunk) => bytesToHex(chunk.bytes)),
    ],
  });
  await submit(executorWallet, executor, `batch-${batch.batchIndex}`, data);
}
const finalizeData = encodeFunctionData({
  abi,
  functionName: "finalizePublication",
  args: [publicationId, STORAGE_MODE, planDigest],
});
await submit(executorWallet, executor, "finalize", finalizeData);

const publication = await publicClient.readContract({
  address: coordinator,
  abi,
  functionName: "getPublication",
  args: [publicationId],
});
assert.equal(publication.completed, true);
assert.equal(publication.cancelled, false);
assert.equal(publication.nextChunk, 61);
assert.equal(publication.nextBatch, 21);
assert.equal(publication.nextStoredOffset, BigInt(stored.byteLength));
assert.equal(publication.storedDigest.toLowerCase(), storedDigest);
assert.equal(publication.decodedDigest.toLowerCase(), decodedDigest);

const batchTransactions = transactions.filter((transaction) => transaction.role.startsWith("batch-"));
const reconstructedParts = [];
for (const evidence of batchTransactions) {
  const transaction = await publicClient.getTransaction({ hash: evidence.hash });
  const decodedCall = decodeFunctionData({ abi, data: transaction.input });
  assert.equal(decodedCall.functionName, "publishBatch");
  reconstructedParts.push(...decodedCall.args[6].map((payload) => Buffer.from(payload.slice(2), "hex")));
}
const reconstructed = Buffer.concat(reconstructedParts);
assert.equal(reconstructed.byteLength, stored.byteLength);
assert.equal(sha256(reconstructed), EXPECTED.storedDigest);
const reconstructedDecoded = brotliDecompressSync(reconstructed);
assert.equal(reconstructedDecoded.byteLength, decoded.byteLength);
assert.equal(sha256(reconstructedDecoded), EXPECTED.decodedDigest);
assert.deepEqual(reconstructedDecoded, decoded);

const totalGas = transactions.reduce((total, transaction) => total + transaction.gasUsed, 0n);
const totalFeeWei = transactions.reduce((total, transaction) => total + transaction.actualFeeWei, 0n);
const totalFloorGas = transactions.reduce((total, transaction) => total + BigInt(transaction.eip7623FloorGas), 0n);
const minimumHeadroom = transactions.reduce(
  (minimum, transaction) => transaction.gasHeadroom < minimum ? transaction.gasHeadroom : minimum,
  TRANSACTION_GAS_CAP,
);
const result = {
  schema: "keel-wake-anvil-benchmark@1",
  simulationOnly: true,
  rpcUrl,
  chainId,
  coordinator,
  publicationId,
  fixture: EXPECTED,
  chunkBytes: CHUNK_BYTES,
  chunkCount: chunks.length,
  chunksPerBatch: CHUNKS_PER_BATCH,
  batchCount: batches.length,
  publicationTransactionCount: transactions.length,
  executorTransactionCount: batchTransactions.length + 1,
  totalGas,
  totalFeeWei,
  totalEip7623FloorGas: totalFloorGas,
  minimumTransactionGasHeadroom: minimumHeadroom,
  reconstructedStoredDigest: sha256(reconstructed),
  reconstructedDecodedDigest: sha256(reconstructedDecoded),
  transactions,
  deploymentExcluded: {
    transactionHash: deployHash,
    gasUsed: deployReceipt.gasUsed,
  },
};
process.stdout.write(`${JSON.stringify(result, bigintJson, 2)}\n`);
