import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import { KEEL_THREE_R180 } from "../packages/sdk/dist/index.js";

export const THREE_R180_SEPOLIA_OBJECT_WELDED_TOPIC = "0xa9b747b717f45aa5e0058b2f0ab1a924631f6adcdc0070c0a2a8fc3ac2f4e633";
export const THREE_R180_SEPOLIA_DEFAULT_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
export const THREE_R180_SEPOLIA_WINDOW_BLOCKS = 2_048;
export const THREE_R180_SEPOLIA_MAX_HEAD_ADVANCE = 16;

const CHAIN_ID = 11_155_111;
const CHAIN_ID_HEX = "0xaa36a7";
const ADDRESS = /^0x[0-9a-f]{40}$/iu;
const BYTES32 = /^0x[0-9a-f]{64}$/iu;
const HASH = /^0x[0-9a-f]{64}$/iu;
const HOLD_ABI = parseAbi([
  "function getObject(bytes32 objectId) view returns ((bytes32 digest,bytes32 indexDigest,address descriptorPointer,uint64 byteLength,uint64 storedByteLength,uint32 chunkCount,uint8 compression,bool composite,bool exists,string mediaType))",
]);

function asCanonicalAddress(value) {
  if (typeof value !== "string" || !ADDRESS.test(value)) throw new TypeError("Sepolia KEEL Hold must be a 20-byte address.");
  return value.toLowerCase();
}

function asCanonicalBytes32(value, label) {
  if (typeof value !== "string" || !BYTES32.test(value)) throw new TypeError(`${label} must be a bytes32 value.`);
  return value.toLowerCase();
}

function asBlock(value, label) {
  if (typeof value !== "object" || value === null || typeof value.number !== "string" || typeof value.hash !== "string") {
    throw new Error(`Sepolia RPC returned an unavailable ${label} block.`);
  }
  const number = Number(BigInt(value.number));
  if (!Number.isSafeInteger(number) || number < 0 || !HASH.test(value.hash)) {
    throw new Error(`Sepolia RPC returned an invalid ${label} block.`);
  }
  return Object.freeze({ number, hash: value.hash.toLowerCase() });
}

function endpointIdentity(endpoint) {
  const url = new URL(endpoint);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.username !== "" || url.password !== "" || (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))) {
    throw new TypeError("Sepolia evidence requires an HTTPS RPC endpoint or explicit loopback HTTP endpoint without credentials.");
  }
  return `${url.origin}${url.pathname}`;
}

function moduleRecords() {
  return [KEEL_THREE_R180.main, KEEL_THREE_R180.core].map((module) => Object.freeze({
    id: module.id,
    digest: `0x${module.digest.slice("sha256:".length)}`,
    decodedByteLength: module.byteLength,
    mediaType: KEEL_THREE_R180.mediaType,
  }));
}

function tupleValue(tuple, name, index) {
  return Array.isArray(tuple) ? tuple[index] : tuple[name];
}

async function scanRpc(endpoint, request) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: request.id, method: request.method, params: request.params }),
  });
  if (!response.ok) throw new Error(`Sepolia RPC ${request.method} is unavailable.`);
  const payload = await response.json();
  if (typeof payload !== "object" || payload === null || payload.error !== undefined || !("result" in payload)) {
    throw new Error(`Sepolia RPC ${request.method} returned an unavailable result.`);
  }
  return payload.result;
}

/**
 * Produces fresh, bounded, read-only object evidence. It refuses uncertain
 * endpoints, changing heads, duplicate object candidates, or mismatched
 * `getObject` records rather than treating a module as reusable.
 */
export async function scanThreeR180Sepolia(input) {
  const endpoint = input?.endpoint ?? THREE_R180_SEPOLIA_DEFAULT_RPC;
  const endpointId = endpointIdentity(endpoint);
  const hold = asCanonicalAddress(input?.hold);
  const windowBlocks = input?.windowBlocks ?? THREE_R180_SEPOLIA_WINDOW_BLOCKS;
  const maxHeadAdvance = input?.maxHeadAdvance ?? THREE_R180_SEPOLIA_MAX_HEAD_ADVANCE;
  if (!Number.isSafeInteger(windowBlocks) || windowBlocks < 1 || windowBlocks > THREE_R180_SEPOLIA_WINDOW_BLOCKS) {
    throw new RangeError(`Sepolia evidence window must be between 1 and ${THREE_R180_SEPOLIA_WINDOW_BLOCKS} blocks.`);
  }
  if (!Number.isSafeInteger(maxHeadAdvance) || maxHeadAdvance < 0 || maxHeadAdvance > THREE_R180_SEPOLIA_MAX_HEAD_ADVANCE) {
    throw new RangeError(`Sepolia evidence max head advance must be between 0 and ${THREE_R180_SEPOLIA_MAX_HEAD_ADVANCE}.`);
  }
  let id = 1;
  const rpc = (method, params) => scanRpc(endpoint, { id: id++, method, params });
  const chainId = await rpc("eth_chainId", []);
  if (typeof chainId !== "string" || chainId.toLowerCase() !== CHAIN_ID_HEX) {
    throw new Error("RPC endpoint is not Ethereum Sepolia.");
  }
  const headNumber = Number(BigInt(await rpc("eth_blockNumber", [])));
  if (!Number.isSafeInteger(headNumber) || headNumber < windowBlocks - 1) {
    throw new Error("Sepolia RPC returned an invalid or too-old head block.");
  }
  const fromNumber = headNumber - windowBlocks + 1;
  const [from, to] = await Promise.all([
    rpc("eth_getBlockByNumber", [`0x${fromNumber.toString(16)}`, false]).then((value) => asBlock(value, "range start")),
    rpc("eth_getBlockByNumber", [`0x${headNumber.toString(16)}`, false]).then((value) => asBlock(value, "range end")),
  ]);
  if (from.number !== fromNumber || to.number !== headNumber) throw new Error("Sepolia RPC returned inconsistent range blocks.");
  const modules = [];
  for (const module of moduleRecords()) {
    const topics = Object.freeze([THREE_R180_SEPOLIA_OBJECT_WELDED_TOPIC, null, module.digest]);
    const logs = await rpc("eth_getLogs", [{
      address: hold,
      fromBlock: `0x${fromNumber.toString(16)}`,
      toBlock: `0x${headNumber.toString(16)}`,
      topics,
    }]);
    if (!Array.isArray(logs)) throw new Error(`Sepolia RPC returned an unavailable ObjectWelded result for ${module.id}.`);
    const objectIds = [...new Set(logs.map((log) => {
      if (typeof log !== "object" || log === null || String(log.address).toLowerCase() !== hold || !Array.isArray(log.topics) ||
          log.topics[0]?.toLowerCase() !== THREE_R180_SEPOLIA_OBJECT_WELDED_TOPIC || log.topics[2]?.toLowerCase() !== module.digest) {
        throw new Error(`Sepolia RPC returned an invalid ObjectWelded record for ${module.id}.`);
      }
      return asCanonicalBytes32(log.topics[1], `${module.id} objectId`);
    }))];
    if (objectIds.length > 1) throw new Error(`Sepolia current-store evidence is ambiguous for ${module.id}.`);
    const objectQueries = [];
    if (objectIds.length === 1) {
      const objectId = objectIds[0];
      const data = encodeFunctionData({ abi: HOLD_ABI, functionName: "getObject", args: [objectId] });
      const raw = await rpc("eth_call", [{ to: hold, data }, { blockHash: to.hash, requireCanonical: true }]);
      if (typeof raw !== "string" || raw === "0x") throw new Error(`Sepolia getObject is unavailable for ${module.id}.`);
      let result;
      try {
        result = decodeFunctionResult({ abi: HOLD_ABI, functionName: "getObject", data: raw });
      } catch {
        throw new Error(`Sepolia getObject returned undecodable data for ${module.id}.`);
      }
      const object = {
        objectId,
        digest: String(tupleValue(result, "digest", 0)).toLowerCase(),
        byteLength: String(tupleValue(result, "byteLength", 3)),
        storedByteLength: String(tupleValue(result, "storedByteLength", 4)),
        chunkCount: String(tupleValue(result, "chunkCount", 5)),
        compression: String(tupleValue(result, "compression", 6)),
        exists: tupleValue(result, "exists", 8) === true,
        mediaType: tupleValue(result, "mediaType", 9),
      };
      if (object.digest !== module.digest || object.byteLength !== String(module.decodedByteLength) || object.exists !== true || object.mediaType !== module.mediaType) {
        throw new Error(`Sepolia getObject does not verify the expected ${module.id} module.`);
      }
      objectQueries.push(Object.freeze(object));
    }
    modules.push(Object.freeze({
      id: module.id,
      digest: module.digest,
      queryTopics: topics,
      logCount: logs.length,
      objectIds: Object.freeze(objectIds),
      objectQueries: Object.freeze(objectQueries),
      currentStoreMatch: objectQueries.length === 1,
    }));
  }
  const headAtEndNumber = Number(BigInt(await rpc("eth_blockNumber", [])));
  const headAtEnd = await rpc("eth_getBlockByNumber", [`0x${headAtEndNumber.toString(16)}`, false]).then((value) => asBlock(value, "final head"));
  if (!Number.isSafeInteger(headAtEndNumber) || headAtEnd.number !== headAtEndNumber || headAtEndNumber < headNumber || headAtEndNumber - headNumber > maxHeadAdvance ||
      (headAtEndNumber === headNumber && headAtEnd.hash !== to.hash)) {
    throw new Error("Sepolia evidence is stale because the chain head advanced during the scan.");
  }
  const matched = modules.filter((module) => module.currentStoreMatch).length;
  return Object.freeze({
    schema: "keel-three-r180-sepolia-evidence@1",
    endpoint: endpointId,
    chainId: CHAIN_ID,
    hold,
    range: Object.freeze({ from, to, head: to, headAtEnd }),
    eventTopic: THREE_R180_SEPOLIA_OBJECT_WELDED_TOPIC,
    modules: Object.freeze(modules),
    outcome: matched === 0 ? "absent" : matched === modules.length ? "complete" : "partial",
  });
}

const isDirectRun = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const args = process.argv.slice(2);
  const [endpoint, hold] = args.length === 1
    ? [THREE_R180_SEPOLIA_DEFAULT_RPC, args[0]]
    : [args[0] ?? THREE_R180_SEPOLIA_DEFAULT_RPC, args[1]];
  if (hold === undefined) throw new Error("Usage: node scripts/three-r180-sepolia-evidence.mjs [endpoint] <keel-hold-address>");
  console.log(JSON.stringify(await scanThreeR180Sepolia({ endpoint, hold }), null, 2));
}
