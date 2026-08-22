#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  bytesToHex,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  hexToBytes,
  http,
  keccak256,
  stringToHex,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sha256Hex } from "@keel/protocol";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index];
  if (!value?.startsWith("--")) throw new Error(`Unexpected argument: ${value ?? ""}`);
  if (value === "--local") {
    args.set("local", "1");
    continue;
  }
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
const localMode = args.has("local") || process.env.DOOM_ETH_LOCAL === "1";
const rpcUrl = args.get("rpc") ?? process.env.DOOM_ETH_RPC_URL ?? process.env.KEEL_RPC_URL ?? "http://127.0.0.1:8545";
const localPrivateKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const privateKey = (args.get("private-key") ?? process.env.DOOM_ETH_PRIVATE_KEY ?? process.env.LOCAL_DEPLOYER_PRIVATE_KEY ?? (localMode ? localPrivateKey : ""));
if (!outputDirectory || outputDirectory === path.resolve("")) throw new Error("Provide --output for a prepared Doom publication.");
if (!/^0x[0-9a-fA-F]{64}$/u.test(privateKey)) throw new Error("Provide DOOM_ETH_PRIVATE_KEY or --private-key; no key is inferred outside --local.");

const publication = JSON.parse(await readFile(path.join(outputDirectory, "publication.json"), "utf8"));
const plan = JSON.parse(await readFile(path.join(outputDirectory, publication.ethereum.planFile), "utf8"));
const manifestBytes = new Uint8Array(await readFile(path.join(outputDirectory, publication.portable.manifestFile)));
const wasmSha256 = publication.wasm.sha256;
const portableRoot = publication.portable.root;
const zeroBytes32 = `0x${"0".repeat(64)}`;
const account = privateKeyToAccount(privateKey);
const transport = http(rpcUrl, { timeout: 120_000, retryCount: 1 });
const publicClient = createPublicClient({ transport });
const walletClient = createWalletClient({ account, transport });
const chainId = await publicClient.getChainId();
if (!localMode && chainId === 31_337) throw new Error("Local Anvil chain requires --local; refusing an implicit local write.");

async function artifact(name) {
  const artifactPath = path.join(repoRoot, "packages/contracts/artifacts", `${name}.json`);
  return JSON.parse(await readFile(artifactPath, "utf8"));
}

const [keelHoldArtifact, artifactRegistryArtifact, portableAnchorArtifact] = await Promise.all([
  artifact("KeelHold"),
  artifact("KeelArtifactRegistry"),
  artifact("KeelPortableAnchorRegistry"),
]);
const keelHoldAbi = keelHoldArtifact.abi;
const artifactRegistryAbi = artifactRegistryArtifact.abi;
const portableAnchorAbi = portableAnchorArtifact.abi;

const receipts = [];
async function send(address, abi, functionName, callArgs, label) {
  const simulation = await publicClient.simulateContract({
    account,
    address,
    abi,
    functionName,
    args: callArgs,
  });
  const hash = await walletClient.writeContract(simulation.request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  receipts.push({ label, hash, blockNumber: receipt.blockNumber.toString() });
  return { result: simulation.result, hash, receipt };
}

async function deploy(name, constructorArgs = []) {
  const compiled = await artifact(name);
  const hash = await walletClient.deployContract({
    account,
    abi: compiled.abi,
    bytecode: compiled.bytecode,
    args: constructorArgs,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== "success" || receipt.contractAddress === null) throw new Error(`${name} deployment failed: ${hash}`);
  receipts.push({ label: `deploy:${name}`, hash, blockNumber: receipt.blockNumber.toString(), address: receipt.contractAddress });
  return receipt.contractAddress;
}

let keelHold = (args.get("chunk-store") ?? process.env.DOOM_ETH_CHUNK_STORE ?? "").toLowerCase();
let artifactRegistry = (args.get("object-registry") ?? process.env.DOOM_ETH_OBJECT_REGISTRY ?? "").toLowerCase();
let portableAnchorRegistry = (args.get("portable-anchor-registry") ?? process.env.DOOM_ETH_PORTABLE_ANCHOR_REGISTRY ?? "").toLowerCase();
if (!keelHold || !artifactRegistry || !portableAnchorRegistry) {
  if (!localMode) throw new Error("Provide existing Ethereum KeelHold, KeelArtifactRegistry, and KeelPortableAnchorRegistry addresses, or use --local.");
  keelHold = await deploy("KeelHold");
  const managerImplementation = await deploy("KeelManager");
  const managerArtifact = await artifact("KeelManager");
  const governors = [account.address, "0x0000000000000000000000000000000000001001", "0x0000000000000000000000000000000000001002"];
  const initializer = encodeFunctionData({
    abi: managerArtifact.abi,
    functionName: "initialize",
    args: [governors, [account.address], []],
  });
  const manager = await deploy("KeelManagerProxy", [managerImplementation, initializer]);
  artifactRegistry = await deploy("KeelArtifactRegistry", [keelHold, manager]);
  portableAnchorRegistry = await deploy("KeelPortableAnchorRegistry", [artifactRegistry]);
}

function asAddress(value, label) {
  if (!/^0x[0-9a-f]{40}$/u.test(value)) throw new Error(`${label} is not an Ethereum address.`);
  if (value === zeroAddress) throw new Error(`${label} cannot be the zero address.`);
  return value;
}
keelHold = asAddress(keelHold, "keelHold");
artifactRegistry = asAddress(artifactRegistry, "artifactRegistry");
portableAnchorRegistry = asAddress(portableAnchorRegistry, "portableAnchorRegistry");

const slugIds = new Map();
const objectIds = new Map();
const ethereumRootDirectory = path.join(outputDirectory, "ethereum");
for (const object of plan.objects) {
  if (object.kind === "leaf") {
    const ids = [];
    for (let offset = 0; offset < object.chunks.length; offset += 3) {
      const batch = object.chunks.slice(offset, offset + 3);
      const payloads = [];
      for (const chunk of batch) {
        const bytes = new Uint8Array(await readFile(path.join(ethereumRootDirectory, chunk.file)));
        const hex = bytesToHex(bytes);
        const slugId = keccak256(hex);
        if (chunk.integrity?.digest && chunk.integrity.digest !== await sha256Hex(bytes)) {
          throw new Error(`Ethereum plan chunk SHA-256 mismatch at ${chunk.file}.`);
        }
        payloads.push(hex);
        ids.push(slugId);
        slugIds.set(slugId, true);
      }
      await send(keelHold, keelHoldAbi, "castSlugs", [payloads], `${object.id}:castSlugs:${offset / 3}`);
    }
    const created = await send(
      keelHold,
      keelHoldAbi,
      "weldObject",
      [ids, object.integrity.digest, BigInt(object.byteLength), 0, object.mediaType],
      `${object.id}:weldObject`,
    );
    objectIds.set(object.id, created.result);
    continue;
  }
  const partIds = object.parts.map((part) => objectIds.get(part));
  if (partIds.some((part) => typeof part !== "string")) throw new Error(`Ethereum recursive plan order is invalid at ${object.id}.`);
  const created = await send(
    keelHold,
    keelHoldAbi,
    "weldComposite",
    [partIds, object.integrity.digest, BigInt(object.byteLength), object.mediaType],
    `${object.id}:weldComposite`,
  );
  objectIds.set(object.id, created.result);
}

const rootObjectId = objectIds.get(plan.root);
if (typeof rootObjectId !== "string") throw new Error("Ethereum recursive root was not created.");

const manifestSlugId = keccak256(bytesToHex(manifestBytes));
await send(keelHold, keelHoldAbi, "castSlug", [bytesToHex(manifestBytes)], "portable-manifest:castSlug");
const manifestContent = await send(
  keelHold,
  keelHoldAbi,
  "weldObject",
  [[manifestSlugId], portableRoot, BigInt(manifestBytes.byteLength), 0, "application/octet-stream"],
  "portable-manifest:weldObject",
);
const manifestContentObjectId = manifestContent.result;
const manifestLogical = await send(
  artifactRegistry,
  artifactRegistryAbi,
  "forgeArtifact",
  [
    keccak256(stringToHex("keel-doom-wasm-portable-manifest.v1")),
    { collection: zeroAddress, tokenId: 0n },
    0,
    manifestContentObjectId,
    0,
    portableRoot,
    publication.portable.metadataSha256,
    zeroBytes32,
  ],
  "portable-manifest:logical-object",
);
const decodedLogical = await send(
  artifactRegistry,
  artifactRegistryAbi,
  "forgeArtifact",
  [
    keccak256(stringToHex("keel-doom-wasm-decoded.v1")),
    { collection: zeroAddress, tokenId: 0n },
    0,
    rootObjectId,
    0,
    wasmSha256,
    publication.portable.metadataSha256,
    zeroBytes32,
  ],
  "doom-wasm:logical-object",
);
const anchor = await send(
  portableAnchorRegistry,
  portableAnchorAbi,
  "publishObjectAnchor",
  [manifestLogical.result, 1n, decodedLogical.result, 1n, portableRoot],
  "doom-wasm:portable-anchor",
);

const readHex = await publicClient.readContract({
  address: keelHold,
  abi: keelHoldAbi,
  functionName: "haulObject",
  args: [rootObjectId],
  gas: BigInt(args.get("read-gas") ?? process.env.DOOM_ETH_READ_GAS ?? (localMode ? "500000000" : "50000000")),
});
const readBytes = hexToBytes(readHex);
const readSha256 = await sha256Hex(readBytes);
if (readBytes.byteLength !== Number(publication.wasm.byteLength) || readSha256.toLowerCase() !== wasmSha256.toLowerCase()) {
  throw new Error(`Ethereum one-shot read mismatch: ${readBytes.byteLength} bytes, ${readSha256}.`);
}
const storedAnchorRoot = await publicClient.readContract({
  address: portableAnchorRegistry,
  abi: portableAnchorAbi,
  functionName: "portableAnchor",
  args: [portableRoot],
});
if (storedAnchorRoot.toLowerCase() !== anchor.result.toLowerCase()) throw new Error("Portable anchor readback mismatch.");

const receipt = {
  schema: "keel-doom-wasm-ethereum-publication@1",
  chainId,
  rpc: rpcUrl,
  publisher: account.address,
  contracts: { keelHold, artifactRegistry, portableAnchorRegistry },
  rootObjectId,
  manifestContentObjectId,
  manifestLogicalObjectId: manifestLogical.result,
  decodedLogicalObjectId: decodedLogical.result,
  portableRoot,
  anchorRoot: anchor.result,
  transactions: receipts,
  oneShotRead: {
    method: "KeelHold.haulObject(bytes32)",
    callCount: 1,
    gas: (args.get("read-gas") ?? process.env.DOOM_ETH_READ_GAS ?? (localMode ? "500000000" : "50000000")),
    byteLength: readBytes.byteLength,
    sha256: readSha256,
  },
};
await writeFile(path.join(outputDirectory, "ethereum-publication.json"), `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  status: "PASS",
  chainId,
  rootObjectId,
  portableRoot,
  anchorRoot: anchor.result,
  transactionCount: receipts.length,
  oneShotReadBytes: readBytes.byteLength,
  oneShotReadSha256: readSha256,
})}\n`);
