import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { encodeFunctionResult, parseAbi } from "viem";

import { KEEL_THREE_R180 } from "../packages/sdk/dist/index.js";
import { scanThreeR180Sepolia } from "../scripts/three-r180-sepolia-evidence.mjs";

const HOLD = "0x0a4f31d5ab08029e4c68f6f3227d9fa3a2d66267";
const EVENT_TOPIC = "0xa9b747b717f45aa5e0058b2f0ab1a924631f6adcdc0070c0a2a8fc3ac2f4e633";
const mainDigest = `0x${KEEL_THREE_R180.main.digest.slice("sha256:".length)}`;
const coreDigest = `0x${KEEL_THREE_R180.core.digest.slice("sha256:".length)}`;
const HOLD_ABI = parseAbi([
  "function getObject(bytes32 objectId) view returns ((bytes32 digest,bytes32 indexDigest,address descriptorPointer,uint64 byteLength,uint64 storedByteLength,uint32 chunkCount,uint8 compression,bool composite,bool exists,string mediaType))",
]);

function block(number) {
  return { number: `0x${number.toString(16)}`, hash: `0x${number.toString(16).padStart(64, "0")}` };
}

function objectLog(objectId, digest) {
  return {
    address: HOLD,
    blockNumber: "0x2710",
    transactionHash: `0x${"a".repeat(64)}`,
    logIndex: "0x0",
    topics: [EVENT_TOPIC, objectId, digest, `0x${"b".repeat(64)}`],
    data: "0x",
  };
}

function objectResult(digest, byteLength) {
  return encodeFunctionResult({
    abi: HOLD_ABI,
    functionName: "getObject",
    result: {
      digest,
      indexDigest: `0x${"c".repeat(64)}`,
      descriptorPointer: `0x${"d".repeat(40)}`,
      byteLength: BigInt(byteLength),
      storedByteLength: 66_437n,
      chunkCount: 3,
      compression: 1,
      composite: false,
      exists: true,
      mediaType: "text/javascript",
    },
  });
}

async function fakeRpc(options = {}) {
  const requests = [];
  let blockCalls = 0;
  const server = createServer(async (request, response) => {
    const parts = [];
    for await (const part of request) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts).toString("utf8"));
    requests.push(body);
    const answer = (result) => response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    if (body.method === "eth_chainId") return answer("0xaa36a7");
    if (body.method === "eth_blockNumber") {
      blockCalls += 1;
      return answer(`0x${(blockCalls > 1 && options.advanceHead ? 100 + options.advanceHead : 100).toString(16)}`);
    }
    if (body.method === "eth_getBlockByNumber") return answer(block(Number.parseInt(body.params[0], 16)));
    if (body.method === "eth_getLogs") {
      const [filter] = body.params;
      assert.equal(filter.address, HOLD);
      assert.equal(filter.topics[0], EVENT_TOPIC);
      const digest = filter.topics[2];
      if (digest === mainDigest && options.mainObjectIds) return answer(options.mainObjectIds.map((id) => objectLog(id, mainDigest)));
      if (digest === coreDigest && options.coreObjectIds) return answer(options.coreObjectIds.map((id) => objectLog(id, coreDigest)));
      return answer([]);
    }
    if (body.method === "eth_call") return answer(options.objectCallResult ?? "0x");
    throw new Error(`unexpected JSON-RPC method ${body.method}`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    endpoint: `http://127.0.0.1:${address.port}/rpc?do-not-record-me`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test("bounded Sepolia evidence records endpoint identity, range hashes, exact ObjectWelded queries, and absent results", async () => {
  const rpc = await fakeRpc();
  try {
    const evidence = await scanThreeR180Sepolia({ endpoint: rpc.endpoint, hold: HOLD, windowBlocks: 32 });
    assert.equal(evidence.endpoint, rpc.endpoint.replace("?do-not-record-me", ""));
    assert.equal(evidence.chainId, 11155111);
    assert.equal(evidence.range.from.number, 69);
    assert.equal(evidence.range.to.number, 100);
    assert.equal(evidence.range.head.hash, block(100).hash);
    assert.equal(evidence.range.headAtEnd.hash, block(100).hash);
    assert.equal(evidence.outcome, "absent");
    assert.deepEqual(evidence.modules.map((module) => module.currentStoreMatch), [false, false]);
    assert.deepEqual(evidence.modules.map((module) => module.objectIds), [[], []]);
    assert.deepEqual(evidence.modules.map((module) => module.objectQueries), [[], []]);
    const logRequests = rpc.requests.filter((request) => request.method === "eth_getLogs");
    assert.deepEqual(logRequests.map((request) => request.params[0].topics[2]), [mainDigest, coreDigest]);
  } finally {
    await rpc.close();
  }
});

test("bounded Sepolia evidence fails closed when a digest is ambiguous or the head becomes stale", async () => {
  const ambiguous = await fakeRpc({ mainObjectIds: [`0x${"1".repeat(64)}`, `0x${"2".repeat(64)}`] });
  try {
    await assert.rejects(
      () => scanThreeR180Sepolia({ endpoint: ambiguous.endpoint, hold: HOLD, windowBlocks: 32 }),
      /ambiguous/u,
    );
  } finally {
    await ambiguous.close();
  }
  const stale = await fakeRpc({ advanceHead: 17 });
  try {
    await assert.rejects(
      () => scanThreeR180Sepolia({ endpoint: stale.endpoint, hold: HOLD, windowBlocks: 32, maxHeadAdvance: 16 }),
      /stale/u,
    );
  } finally {
    await stale.close();
  }
});

test("bounded Sepolia evidence marks a module reusable only after getObject verifies its exact immutable record", async () => {
  const objectId = `0x${"1".repeat(64)}`;
  const rpc = await fakeRpc({
    mainObjectIds: [objectId],
    objectCallResult: objectResult(mainDigest, KEEL_THREE_R180.main.byteLength),
  });
  try {
    const evidence = await scanThreeR180Sepolia({ endpoint: rpc.endpoint, hold: HOLD, windowBlocks: 32 });
    assert.equal(evidence.outcome, "partial");
    assert.equal(evidence.modules[0].currentStoreMatch, true);
    assert.deepEqual(evidence.modules[0].objectIds, [objectId]);
    assert.deepEqual(evidence.modules[0].objectQueries, [{
      objectId,
      digest: mainDigest,
      byteLength: String(KEEL_THREE_R180.main.byteLength),
      storedByteLength: "66437",
      chunkCount: "3",
      compression: "1",
      exists: true,
      mediaType: "text/javascript",
    }]);
    const calls = rpc.requests.filter((request) => request.method === "eth_call");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params[0].to, HOLD);
    assert.equal(calls[0].params[1].requireCanonical, true);
  } finally {
    await rpc.close();
  }
});
