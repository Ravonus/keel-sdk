import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { brotliDecompressSync } from "node:zlib";

import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  hexToBytes,
  http,
  keccak256,
  parseAbi,
  parseAbiItem,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { keelHoldAbi, keelPublicationJobAbi } from "../packages/sdk/dist/abi.js";
import { buildKeelCarrierDispatchPlan, buildKeelPublicationJobManifest } from "../packages/sdk/dist/managed-publication.js";

const JOB_ADDRESS = getAddress("0x29e5D1E7FEED7507a8F70A4D381C1cFE8fb70a24");
const JOB_ID = 3n;
const STORED_SHA256 = "4be5020e1ae73329f429e2a50721ffef4c8dd077da400ebe45e92aa4fbde3f73";
const DECODED_SHA256 = "e0af21417cb1a10649a5ba200c96e3758218c567900463376c1cca0774cb713b";
const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const EXECUTOR_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const holdAbi = parseAbi(keelHoldAbi);
const jobAbi = parseAbi(keelPublicationJobAbi);
const oldJobAbi = parseAbi(["function executeCarrier(uint256 jobId,bytes[] payloads)"]);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const cursor = (job) => Number(job.nextSlug ?? job[6]);

async function loadArtifact(filePath) {
  const value = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(typeof value.bytecode?.object, "string");
  return { abi: value.abi, bytecode: value.bytecode.object };
}

async function exactDoom(client) {
  const latest = await client.getBlockNumber();
  const event = parseAbiItem("event CarrierProgress(uint256 indexed jobId,uint256 indexed firstSlug,uint256 slugCount,uint256 nextSlug)");
  const logs = await client.getLogs({ address: JOB_ADDRESS, event, args: { jobId: JOB_ID }, fromBlock: latest - 50_000n, toBlock: latest });
  logs.sort((left, right) => Number(left.args.firstSlug - right.args.firstSlug));
  assert.equal(logs.length, 21);
  const batches = [];
  for (const log of logs) {
    const transaction = await client.getTransaction({ hash: log.transactionHash });
    const decoded = decodeFunctionData({ abi: oldJobAbi, data: transaction.input });
    assert.equal(decoded.functionName, "executeCarrier");
    assert.equal(decoded.args[0], JOB_ID);
    batches.push([...decoded.args[1]]);
  }
  const payloads = batches.flat();
  const stored = Buffer.concat(payloads.map((payload) => Buffer.from(hexToBytes(payload))));
  const decoded = brotliDecompressSync(stored);
  assert.equal(payloads.length, 61);
  assert.equal(stored.byteLength, 1_392_172);
  assert.equal(sha256(stored), STORED_SHA256);
  assert.equal(decoded.byteLength, 4_662_352);
  assert.equal(sha256(decoded), DECODED_SHA256);
  assert.equal(decoded.subarray(0, 8).toString("ascii"), "FRAYDOOM");
  return { batches, payloads, stored, decoded };
}

async function wait(client, hash) {
  return client.waitForTransactionReceipt({ hash, timeout: 30_000 });
}

async function deploy(wallet, client, account, contract, args = []) {
  const receipt = await wait(client, await wallet.deployContract({ account, abi: contract.abi, bytecode: contract.bytecode, args }));
  assert.equal(receipt.status, "success");
  assert.ok(receipt.contractAddress);
  return { address: receipt.contractAddress, receipt };
}

async function main() {
  const localRpc = process.env.KEEL_LOCAL_RPC_URL ?? "http://127.0.0.1:8545";
  const contractsRoot = process.env.KEEL_CONTRACTS_ROOT ?? path.resolve("../keel-contracts");
  const owner = privateKeyToAccount(process.env.KEEL_LOCAL_OWNER_KEY ?? OWNER_KEY);
  const executor = privateKeyToAccount(process.env.KEEL_LOCAL_EXECUTOR_KEY ?? EXECUTOR_KEY);
  const doom = await exactDoom(createPublicClient({ transport: http(process.env.KEEL_SEPOLIA_READ_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com") }));
  if (process.env.KEEL_DOOM_DECODED_OUTPUT_PATH) {
    await writeFile(process.env.KEEL_DOOM_DECODED_OUTPUT_PATH, doom.decoded);
  }
  if (process.env.KEEL_DOOM_STORED_OUTPUT_PATH) {
    await writeFile(process.env.KEEL_DOOM_STORED_OUTPUT_PATH, doom.stored);
  }
  let client = createPublicClient({ transport: http(localRpc) });
  let ownerWallet = createWalletClient({ account: owner, transport: http(localRpc) });
  let executorWallet = createWalletClient({ account: executor, transport: http(localRpc) });
  const holdArtifact = await loadArtifact(path.join(contractsRoot, "out/KeelHold.sol/KeelHold.json"));
  const jobArtifact = await loadArtifact(path.join(contractsRoot, "out/KeelPublicationJob.sol/KeelPublicationJob.json"));
  const hold = await deploy(ownerWallet, client, owner, holdArtifact);
  const job = await deploy(ownerWallet, client, owner, jobArtifact, [hold.address]);
  assert.equal(
    (await client.readContract({ address: job.address, abi: jobAbi, functionName: "keelHold" })).toLowerCase(),
    hold.address.toLowerCase(),
  );

  const slugIds = doom.payloads.map((payload) => keccak256(payload));
  const operation = encodeFunctionData({
    abi: holdAbi,
    functionName: "weldObject",
    args: [slugIds, keccak256(toHex(doom.decoded)), BigInt(doom.decoded.byteLength), 3, "application/x-fray-doom"],
  });
  const block = await client.getBlock();
  const deadline = block.timestamp + 86_400n;
  const manifest = buildKeelPublicationJobManifest({
    owner: owner.address,
    executor: executor.address,
    deadline,
    carrierBatches: doom.batches,
    operations: [{ target: hold.address, value: 0n, data: operation }],
  });
  const escrow = 1_000_000_000_000_000n;
  const receipts = [];
  receipts.push(await wait(client, await ownerWallet.writeContract({
    account: owner,
    address: job.address,
    abi: jobAbi,
    functionName: "openJob",
    args: [manifest.planDigest, executor.address, deadline, [...manifest.chunkDigests], [...manifest.operationDigests], [...manifest.allowedTargets]],
    value: escrow,
  })));
  assert.equal(await client.readContract({ address: job.address, abi: jobAbi, functionName: "nextJobId" }), 1n);
  receipts.push(await wait(client, await executorWallet.writeContract({ account: executor, address: job.address, abi: jobAbi, functionName: "fundExecutor", args: [0n, escrow] })));

  const wrong = [...doom.batches[0]];
  wrong[0] = toHex(Buffer.from("wrong-doom-chunk"));
  const wrongReceipt = await wait(client, await executorWallet.sendTransaction({
    account: executor,
    to: job.address,
    gas: 8_000_000n,
    data: encodeFunctionData({ abi: jobAbi, functionName: "executeCarrier", args: [0n, wrong] }),
  }));
  assert.equal(wrongReceipt.status, "reverted");
  assert.equal(cursor(await client.readContract({ address: job.address, abi: jobAbi, functionName: "getJob", args: [0n] })), 0);

  for (const batch of doom.batches.slice(0, 10)) {
    receipts.push(await wait(client, await executorWallet.writeContract({ account: executor, address: job.address, abi: jobAbi, functionName: "executeCarrier", args: [0n, [...batch]] })));
  }
  assert.equal(cursor(await client.readContract({ address: job.address, abi: jobAbi, functionName: "getJob", args: [0n] })), 30);

  // Crash/reload: recover exclusively from the chain cursor and prove that a
  // second openJob never appeared.
  client = createPublicClient({ transport: http(localRpc) });
  ownerWallet = createWalletClient({ account: owner, transport: http(localRpc) });
  executorWallet = createWalletClient({ account: executor, transport: http(localRpc) });
  let state = await client.readContract({ address: job.address, abi: jobAbi, functionName: "getJob", args: [0n] });
  assert.equal(cursor(state), 30);
  assert.equal(await client.readContract({ address: job.address, abi: jobAbi, functionName: "nextJobId" }), 1n);

  // Treat this submission as timed out, retain its hash, reconcile the receipt,
  // and continue from cursor 33 without retrying it.
  const timedOutHash = await executorWallet.writeContract({ account: executor, address: job.address, abi: jobAbi, functionName: "executeCarrier", args: [0n, [...doom.batches[10]]] });
  const timedOutReceipt = await wait(client, timedOutHash);
  assert.equal(timedOutReceipt.status, "success");
  receipts.push(timedOutReceipt);
  state = await client.readContract({ address: job.address, abi: jobAbi, functionName: "getJob", args: [0n] });
  assert.equal(cursor(state), 33);

  while (cursor(state) < doom.payloads.length) {
    const dispatches = buildKeelCarrierDispatchPlan({
      batches: doom.batches,
      nextChunk: cursor(state),
      startingNonce: await client.getTransactionCount({ address: executor.address, blockTag: "pending" }),
    });
    assert.ok(dispatches.length > 0 && dispatches.length <= 4);
    for (const dispatch of dispatches) {
      receipts.push(await wait(client, await executorWallet.writeContract({
        account: executor,
        address: job.address,
        abi: jobAbi,
        functionName: "executeCarrier",
        args: [0n, [...dispatch.payloads]],
        nonce: dispatch.nonce,
      })));
    }
    state = await client.readContract({ address: job.address, abi: jobAbi, functionName: "getJob", args: [0n] });
  }
  assert.equal(cursor(state), 61);

  const operationReceipt = await wait(client, await executorWallet.writeContract({ account: executor, address: job.address, abi: jobAbi, functionName: "executeOperation", args: [0n, hold.address, 0n, operation] }));
  receipts.push(operationReceipt);
  const objectIds = operationReceipt.logs.flatMap((log) => {
    if (log.address.toLowerCase() !== hold.address.toLowerCase()) return [];
    try {
      return [decodeEventLog({ abi: holdAbi, eventName: "ObjectWelded", data: log.data, topics: log.topics }).args.objectId];
    } catch {
      return [];
    }
  });
  assert.equal(objectIds.length, 1);
  const pointers = await client.readContract({
    address: hold.address,
    abi: holdAbi,
    functionName: "getObjectSlugPointers",
    args: [objectIds[0], 0n, 128n],
  });
  assert.equal(pointers.length, 61);
  const hauled = Buffer.concat(await Promise.all(pointers.map(async (pointer) => {
    const code = await client.getCode({ address: pointer });
    assert.ok(code?.startsWith("0x00"));
    return Buffer.from(hexToBytes(`0x${code.slice(4)}`));
  })));
  assert.equal(sha256(hauled), STORED_SHA256);
  assert.equal(sha256(brotliDecompressSync(hauled)), DECODED_SHA256);
  receipts.push(await wait(client, await executorWallet.writeContract({ account: executor, address: job.address, abi: jobAbi, functionName: "completeJob", args: [0n] })));
  await assert.rejects(client.readContract({ address: job.address, abi: jobAbi, functionName: "getJob", args: [0n] }));
  assert.equal(await client.readContract({ address: job.address, abi: jobAbi, functionName: "nextJobId" }), 1n);

  process.stdout.write(`${JSON.stringify({
    schema: "keel-doom-managed-publication-local-proof@1",
    exactDoom: { chunks: 61, storedBytes: doom.stored.byteLength, storedSha256: sha256(doom.stored), decodedBytes: doom.decoded.byteLength, decodedSha256: sha256(doom.decoded), header: "FRAYDOOM" },
    localReplay: { oneOwnerApprovalTransaction: true, duplicateJobsOpened: 0, failedChunkRejectedBeforeCursor: true, recoveredAfterChunk: 30, timeoutReceiptReconciledAtChunk: 33, completedChunks: 61, completedOperations: 1, objectReadBack: true, planDigest: manifest.planDigest, actualGasUsed: receipts.reduce((sum, value) => sum + value.gasUsed, 0n).toString() },
    externalTransactionsSent: 0,
  }, null, 2)}\n`);
}

await main();
