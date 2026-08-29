#!/usr/bin/env node

/**
 * Replays the native KEEL Doom publication entirely on a loopback Anvil.
 *
 * This is deliberately a benchmark, not a publisher.  It deploys fresh local
 * KeelHold/KeelPublicationJob contracts, sends one local owner authorization,
 * then sends the bounded executor carrier/object/finalization calls.  No
 * public RPC, wallet, deployed contract, or live executor is touched.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { brotliDecompressSync } from "node:zlib";

import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hexToBytes,
  http,
  keccak256,
  stringToHex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { buildKeelPublicationJobManifest } from "../packages/sdk/dist/managed-publication.js";

const EXPECTED_CHAIN_ID = 31_337;
const TRANSACTION_GAS_CAP = 16_777_216n;
const CHUNK_BYTES = 23_000;
const CHUNKS_PER_TRANSACTION = 3;
const COMPRESSION_BROTLI = 3;
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
const DEFAULT_ESCROW = 1_000_000_000_000_000n;
// These are the existing native Doom replay's wire values.  The fixture's
// independently verified SHA-256 values remain the benchmark authority; the
// legacy KeelHold digest field is a bytes32 commitment and historically used
// Keccak for this object operation.
const OBJECT_DIGEST_ALGORITHM = process.env.KEEL_NATIVE_OBJECT_DIGEST ?? "keccak256";
const OBJECT_MEDIA_TYPE = process.env.KEEL_NATIVE_MEDIA_TYPE ?? "application/x-fray-doom";
if (!["keccak256", "sha256"].includes(OBJECT_DIGEST_ALGORITHM)) {
  throw new Error("KEEL_NATIVE_OBJECT_DIGEST must be keccak256 or sha256.");
}

const EXPECTED = Object.freeze({
  decodedByteLength: 4_662_352,
  decodedDigest: "e0af21417cb1a10649a5ba200c96e3758218c567900463376c1cca0774cb713b",
  storedByteLength: 1_392_172,
  storedDigest: "4be5020e1ae73329f429e2a50721ffef4c8dd077da400ebe45e92aa4fbde3f73",
});

function usage() {
  throw new Error(
    "Usage: benchmark-keel-native-anvil.mjs <decoded.bin> <stored.bin.br> <hold-artifact.json> <job-artifact.json> [http://127.0.0.1:8545]",
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function bigintJson(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function safeLocalRpc(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) {
    throw new Error("Native KEEL benchmark refuses every non-loopback RPC URL.");
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Native KEEL benchmark RPC URL must be a bare loopback HTTP origin.");
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
  return {
    calldataBytes: bytes.length,
    zeroBytes,
    nonZeroBytes,
    transactionBaseGas,
    normalIntrinsicGas,
    eip7623FloorGas,
  };
}

function chunkPayloads(stored) {
  const chunks = [];
  for (let offset = 0; offset < stored.byteLength; offset += CHUNK_BYTES) {
    const bytes = stored.subarray(offset, Math.min(offset + CHUNK_BYTES, stored.byteLength));
    chunks.push({ bytes, digest: keccak256(bytes) });
  }
  const batches = [];
  for (let first = 0; first < chunks.length; first += CHUNKS_PER_TRANSACTION) {
    batches.push(chunks.slice(first, first + CHUNKS_PER_TRANSACTION));
  }
  assert.equal(chunks.length, 61);
  assert.equal(batches.length, 21);
  assert.ok(batches.every((batch) => batch.length >= 1 && batch.length <= CHUNKS_PER_TRANSACTION));
  return { chunks, batches };
}

async function loadArtifact(path) {
  const artifact = JSON.parse(await readFile(path, "utf8"));
  const bytecode = artifact.bytecode?.object ?? artifact.bytecode;
  if (!Array.isArray(artifact.abi) || typeof bytecode !== "string" || !bytecode.startsWith("0x")) {
    throw new TypeError(`Invalid Forge artifact: ${path}`);
  }
  return { abi: artifact.abi, bytecode };
}

const [decodedPath, storedPath, holdArtifactPath, jobArtifactPath, rpcInput = "http://127.0.0.1:8545"] = process.argv.slice(2);
if (!decodedPath || !storedPath || !holdArtifactPath || !jobArtifactPath) usage();
const rpcUrl = safeLocalRpc(rpcInput);
const [decoded, stored, holdArtifact, jobArtifact] = await Promise.all([
  readFile(decodedPath),
  readFile(storedPath),
  loadArtifact(holdArtifactPath),
  loadArtifact(jobArtifactPath),
]);
const objectDigest = OBJECT_DIGEST_ALGORITHM === "keccak256"
  ? keccak256(`0x${Buffer.from(decoded).toString("hex")}`)
  : `0x${EXPECTED.decodedDigest}`;
assert.equal(decoded.byteLength, EXPECTED.decodedByteLength);
assert.equal(sha256(decoded), EXPECTED.decodedDigest);
assert.equal(stored.byteLength, EXPECTED.storedByteLength);
assert.equal(sha256(stored), EXPECTED.storedDigest);
assert.equal(Buffer.compare(brotliDecompressSync(stored), decoded), 0);

const publicClient = createPublicClient({ transport: http(rpcUrl, { timeout: 30_000, retryCount: 0 }) });
const chainId = await publicClient.getChainId();
if (chainId !== EXPECTED_CHAIN_ID) {
  throw new Error(`Native KEEL benchmark requires local chain ${EXPECTED_CHAIN_ID}; received ${chainId}.`);
}
const owner = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 0 });
const executor = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 1 });
const ownerWallet = createWalletClient({ account: owner, transport: http(rpcUrl, { timeout: 30_000, retryCount: 0 }) });
const executorWallet = createWalletClient({ account: executor, transport: http(rpcUrl, { timeout: 30_000, retryCount: 0 }) });

async function wait(hash) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
  assert.equal(receipt.status, "success");
  assert.ok(receipt.gasUsed <= TRANSACTION_GAS_CAP, `transaction exceeded EIP-7825 cap: ${receipt.gasUsed}`);
  return receipt;
}

async function deploy(wallet, artifact, args = []) {
  const hash = await wallet.deployContract({ account: wallet.account, abi: artifact.abi, bytecode: artifact.bytecode, args });
  const receipt = await wait(hash);
  assert.ok(receipt.contractAddress);
  return { address: getAddress(receipt.contractAddress), hash, receipt };
}

const hold = await deploy(ownerWallet, holdArtifact);
const job = await deploy(ownerWallet, jobArtifact, [hold.address]);
const { chunks, batches } = chunkPayloads(stored);
const slugDigests = chunks.map((chunk) => chunk.digest);
const operationData = encodeFunctionData({
  abi: holdArtifact.abi,
  functionName: "weldObject",
  args: [
    slugDigests,
    objectDigest,
    BigInt(decoded.byteLength),
    COMPRESSION_BROTLI,
    OBJECT_MEDIA_TYPE,
  ],
});
const operationDigestCanonical = keccak256(encodeAbiParameters(
  [{ type: "address" }, { type: "uint256" }, { type: "bytes" }],
  [hold.address, 0n, operationData],
));
const latest = await publicClient.getBlock({ blockTag: "latest" });
const deadline = latest.timestamp + 86_400n;
const manifest = buildKeelPublicationJobManifest({
  owner: owner.address,
  executor: executor.address,
  deadline,
  carrierBatches: batches.map((batch) => batch.map((chunk) => `0x${Buffer.from(chunk.bytes).toString("hex")}`)),
  operations: [{ target: hold.address, value: 0n, data: operationData }],
});
assert.equal(manifest.operationDigests[0], operationDigestCanonical, "operation digest encoder sanity check");

const transactions = [];
async function submit(wallet, role, data, value = 0n) {
  const intrinsic = calldataGas(data);
  const hash = await wallet.sendTransaction({ account: wallet.account, to: job.address, data, value, gas: TRANSACTION_GAS_CAP });
  const receipt = await wait(hash);
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

const openData = encodeFunctionData({
  abi: jobArtifact.abi,
  functionName: "openJob",
  args: [manifest.planDigest, executor.address, deadline, [...manifest.chunkDigests], [...manifest.operationDigests], [...manifest.allowedTargets]],
});
const openResult = await submit(ownerWallet, "openJob-owner-approval", openData, DEFAULT_ESCROW);
const jobId = await publicClient.readContract({ address: job.address, abi: jobArtifact.abi, functionName: "nextJobId" });
assert.equal(jobId, 1n);

const fundData = encodeFunctionData({
  abi: jobArtifact.abi,
  functionName: "fundExecutor",
  args: [0n, DEFAULT_ESCROW],
});
await submit(executorWallet, "fundExecutor-escrow-control", fundData);

for (const [batchIndex, batch] of batches.entries()) {
  const payloads = batch.map((chunk) => `0x${Buffer.from(chunk.bytes).toString("hex")}`);
  const data = encodeFunctionData({
    abi: jobArtifact.abi,
    functionName: "executeCarrier",
    args: [0n, payloads],
  });
  await submit(executorWallet, `executeCarrier-${batchIndex}`, data);
}

const operationCallData = encodeFunctionData({
  abi: jobArtifact.abi,
  functionName: "executeOperation",
  args: [0n, hold.address, 0n, operationData],
});
const operationResult = await submit(executorWallet, "executeOperation-weldObject", operationCallData);
const objectWeldedEvent = holdArtifact.abi.find((entry) => entry.type === "event" && entry.name === "ObjectWelded");
assert.ok(objectWeldedEvent);
const objectIds = operationResult.receipt.logs.flatMap((log) => {
  if (log.address.toLowerCase() !== hold.address.toLowerCase()) return [];
  try {
    return [decodeEventLog({ abi: [objectWeldedEvent], data: log.data, topics: log.topics, strict: false }).args.objectId];
  } catch {
    return [];
  }
});
assert.equal(objectIds.length, 1);
const objectId = objectIds[0];

const completeData = encodeFunctionData({
  abi: jobArtifact.abi,
  functionName: "completeJob",
  args: [0n],
});
await submit(executorWallet, "completeJob-finalization", completeData);

const record = await publicClient.readContract({ address: hold.address, abi: holdArtifact.abi, functionName: "getObject", args: [objectId] });
assert.equal(record.byteLength, BigInt(decoded.byteLength));
assert.equal(record.storedByteLength, BigInt(stored.byteLength));
assert.equal(record.slugCount, 61);
assert.equal(record.compression, COMPRESSION_BROTLI);
assert.equal(record.digest.toLowerCase(), objectDigest.toLowerCase());
const pointers = await publicClient.readContract({
  address: hold.address,
  abi: holdArtifact.abi,
  functionName: "getObjectSlugPointers",
  args: [objectId, 0n, 128n],
});
assert.equal(pointers.length, chunks.length);
const reconstructedParts = [];
for (const pointer of pointers) {
  const code = await publicClient.getCode({ address: pointer });
  assert.ok(code?.startsWith("0x00"), "native carrier must begin with inert STOP byte");
  reconstructedParts.push(Buffer.from(hexToBytes(`0x${code.slice(4)}`)));
}
const reconstructedStored = Buffer.concat(reconstructedParts);
assert.equal(reconstructedStored.byteLength, stored.byteLength);
assert.equal(sha256(reconstructedStored), EXPECTED.storedDigest);
const reconstructedDecoded = brotliDecompressSync(reconstructedStored);
assert.equal(reconstructedDecoded.byteLength, decoded.byteLength);
assert.equal(sha256(reconstructedDecoded), EXPECTED.decodedDigest);
assert.deepEqual(reconstructedDecoded, decoded);

const carrierTransactions = transactions.filter(({ role }) => role.startsWith("executeCarrier-"));
assert.equal(carrierTransactions.length, 21);
assert.ok(carrierTransactions.every(({ calldataBytes }) => calldataBytes > 0));
const publicationGas = transactions.reduce((total, transaction) => total + transaction.gasUsed, 0n);
const carrierGas = carrierTransactions.reduce((total, transaction) => total + transaction.gasUsed, 0n);
const managedControlAndObjectGas = publicationGas - carrierGas;
const publicationFeeWei = transactions.reduce((total, transaction) => total + transaction.actualFeeWei, 0n);
const totalFloorGas = transactions.reduce((total, transaction) => total + BigInt(transaction.eip7623FloorGas), 0n);
const minimumHeadroom = transactions.reduce(
  (minimum, transaction) => transaction.gasHeadroom < minimum ? transaction.gasHeadroom : minimum,
  TRANSACTION_GAS_CAP,
);
const result = {
  schema: "keel-native-anvil-benchmark@1",
  simulationOnly: true,
  rpcUrl,
  chainId,
  fixture: {
    ...EXPECTED,
    header: decoded.subarray(0, 8).toString("ascii"),
    reconstructionVerified: true,
  },
  objectCommitment: { digest: objectDigest, digestAlgorithm: OBJECT_DIGEST_ALGORITHM, mediaType: OBJECT_MEDIA_TYPE, compression: "brotli" },
  planDigest: manifest.planDigest,
  operationDigest: manifest.operationDigests[0],
  chunkBytes: CHUNK_BYTES,
  chunksPerExecutorTransaction: CHUNKS_PER_TRANSACTION,
  chunkCount: chunks.length,
  carrierTransactionCount: carrierTransactions.length,
  publicationTransactionCount: transactions.length,
  ownerApprovalTransactionCount: 1,
  carrierExecutorTransactionCount: carrierTransactions.length,
  executorTransactionCount: transactions.filter(({ role }) => !role.startsWith("openJob-")).length,
  managedControlAndObjectTransactionCount: transactions.length - carrierTransactions.length,
  carrierGas,
  managedControlAndObjectGas,
  publicationGas,
  publicationFeeWei,
  totalEip7623FloorGas: totalFloorGas,
  minimumTransactionGasHeadroom: minimumHeadroom,
  objectId,
  holdAddress: hold.address,
  jobAddress: job.address,
  deploymentExcluded: {
    hold: { transactionHash: hold.hash, gasUsed: hold.receipt.gasUsed },
    job: { transactionHash: job.hash, gasUsed: job.receipt.gasUsed },
    totalGasUsed: hold.receipt.gasUsed + job.receipt.gasUsed,
  },
  escrowWei: DEFAULT_ESCROW,
  transactions,
};
process.stdout.write(`${JSON.stringify(result, bigintJson, 2)}\n`);
