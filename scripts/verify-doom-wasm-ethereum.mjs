#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { createPublicClient, hexToBytes, http, zeroAddress } from "viem";
import { sha256Hex } from "@keel/protocol";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index];
  if (!value?.startsWith("--")) throw new Error(`Unexpected argument: ${value ?? ""}`);
  const equals = value.indexOf("=");
  if (equals >= 0) {
    args.set(value.slice(2, equals), value.slice(equals + 1));
    continue;
  }
  const next = process.argv[index + 1];
  if (next === undefined || next.startsWith("--")) throw new Error(`Missing value for ${value}`);
  args.set(value.slice(2), next);
  index += 1;
}

const outputDirectory = path.resolve(args.get("output") ?? process.env.DOOM_ONCHAIN_OUTPUT_DIRECTORY ?? "");
if (!outputDirectory || outputDirectory === path.resolve("")) {
  throw new Error("Provide --output for the prepared Doom publication.");
}

const rpcUrl = args.get("rpc") ?? process.env.DOOM_ETH_RPC_URL ?? process.env.KEEL_RPC_URL ?? "http://127.0.0.1:8545";
const keelHold = args.get("chunk-store") ?? process.env.DOOM_ETH_CHUNK_STORE ?? "";
const portableAnchorRegistry = args.get("portable-anchor-registry") ?? process.env.DOOM_ETH_PORTABLE_ANCHOR_REGISTRY ?? "";
const publication = JSON.parse(await readFile(path.join(outputDirectory, "publication.json"), "utf8"));
const rootObjectId = args.get("root-object-id") ?? process.env.DOOM_ETH_ROOT_OBJECT_ID ?? "";
const portableRoot = args.get("portable-root") ?? process.env.DOOM_ETH_PORTABLE_ROOT ?? publication.portable.root;
const expectedAnchorRoot = args.get("anchor-root") ?? process.env.DOOM_ETH_ANCHOR_ROOT ?? "";
const readGas = args.get("read-gas") ?? process.env.DOOM_ETH_READ_GAS ?? "500000000";

function address(value, label) {
  if (!/^0x[0-9a-fA-F]{40}$/u.test(value) || value.toLowerCase() === zeroAddress) {
    throw new Error(`Provide a nonzero ${label} address.`);
  }
  return value;
}

function bytes32(value, label) {
  if (!/^0x[0-9a-fA-F]{64}$/u.test(value) || /^0x0+$/u.test(value)) {
    throw new Error(`Provide a nonzero ${label} bytes32 value.`);
  }
  return value;
}

const keelHoldAddress = address(keelHold, "KeelHold");
const portableAnchorAddress = address(portableAnchorRegistry, "portable anchor registry");
const root = bytes32(rootObjectId, "root object ID");
const rootPortable = bytes32(portableRoot, "portable root");
const readGasWei = BigInt(readGas);
if (readGasWei <= 0n) throw new Error("--read-gas must be positive.");

const [keelHoldArtifact, portableAnchorArtifact] = await Promise.all([
  readFile(path.join(repoRoot, "packages/contracts/artifacts/KeelHold.json"), "utf8"),
  readFile(path.join(repoRoot, "packages/contracts/artifacts/KeelPortableAnchorRegistry.json"), "utf8"),
]);
const client = createPublicClient({ transport: http(rpcUrl, { timeout: 120_000, retryCount: 1 }) });
const chainId = await client.getChainId();
const started = Date.now();
const readHex = await client.readContract({
  address: keelHoldAddress,
  abi: JSON.parse(keelHoldArtifact).abi,
  functionName: "haulObject",
  args: [root],
  gas: readGasWei,
});
const readBytes = hexToBytes(readHex);
const readSha256 = await sha256Hex(readBytes);
const expectedSha256 = publication.wasm.sha256.toLowerCase();
if (readBytes.byteLength !== Number(publication.wasm.byteLength) || readSha256.toLowerCase() !== expectedSha256) {
  throw new Error(`Ethereum one-shot read mismatch: ${readBytes.byteLength} bytes, ${readSha256}.`);
}

const anchorRoot = await client.readContract({
  address: portableAnchorAddress,
  abi: JSON.parse(portableAnchorArtifact).abi,
  functionName: "portableAnchor",
  args: [rootPortable],
});
if (anchorRoot === `0x${"0".repeat(64)}`) throw new Error("Portable root has no native anchor yet.");
if (expectedAnchorRoot && anchorRoot.toLowerCase() !== expectedAnchorRoot.toLowerCase()) {
  throw new Error(`Portable anchor mismatch: ${anchorRoot} != ${expectedAnchorRoot}.`);
}

const proof = {
  schema: "keel-doom-wasm-ethereum-read-proof@1",
  chainId,
  rpc: rpcUrl,
  contracts: { keelHold: keelHoldAddress, portableAnchorRegistry: portableAnchorAddress },
  rootObjectId: root,
  portableRoot: rootPortable,
  anchorRoot,
  anchorVerification: "deferred approval; native anchor lookup only",
  oneShotRead: {
    method: "KeelHold.haulObject(bytes32)",
    callCount: 1,
    gas: readGas,
    byteLength: readBytes.byteLength,
    sha256: readSha256,
    elapsedMilliseconds: Date.now() - started,
  },
};
await writeFile(path.join(outputDirectory, "ethereum-read-proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ status: "PASS", chainId, rootObjectId: root, portableRoot: rootPortable, anchorRoot, oneShotReadBytes: readBytes.byteLength, oneShotReadSha256: readSha256 })}\n`);
