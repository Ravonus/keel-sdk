#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { packDataBytes } from "../node_modules/.pnpm/@taquito+michel-codec@25.0.0/node_modules/@taquito/michel-codec/dist/taquito-michel-codec.es6.js";
import { keccak256 } from "viem";

import { createRecursiveUploadPlan } from "@keel/builder";
import {
  canonicalJson,
  encodePortableManifestV1,
  portableContentCommitmentsV1,
  portableRootV1,
  PortableCompression,
  PortableEditPolicy,
  PortableResourceKind,
  sha256Hex,
  utf8ToBytes,
} from "@keel/protocol";
import { buildKeelTezosRecursiveObject } from "@keel/studio-core";

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

const wasmPath = path.resolve(args.get("wasm") ?? process.env.DOOM_WASM_PATH ?? "");
const outputDirectory = path.resolve(
  args.get("output") ?? process.env.DOOM_ONCHAIN_OUTPUT_DIRECTORY ?? path.join(repoRoot, "packages/tezos/build/doom-wasm-onchain"),
);
const wadSha256 = (args.get("wad-sha256") ?? process.env.DOOM_WAD_SHA256 ?? "").toLowerCase();
const sourceCommit = args.get("source-commit") ?? process.env.DOOM_WASM_SOURCE_COMMIT ?? "31cc1af9656a8184830090c4e9f268383f5d7e15";
const wadSource = args.get("wad-source") ?? process.env.DOOM_WAD_SOURCE ?? "https://www.libsdl.org/projects/doom/data/doom1.wad.gz";
const ethLeafDecodedBytes = Number(args.get("eth-leaf-bytes") ?? process.env.DOOM_ETH_LEAF_BYTES ?? 2_400_000);
const ethMaxParts = Number(args.get("eth-max-parts") ?? process.env.DOOM_ETH_MAX_PARTS ?? 64);
const tezosLeafBytes = Number(args.get("tezos-leaf-bytes") ?? process.env.DOOM_TEZOS_LEAF_BYTES ?? 12_000);
const tezosKeelHoldAddress = args.get("tezos-chunk-store") ?? process.env.DOOM_TEZOS_CHUNK_STORE ?? "";
const tezosCheckpointRegistryAddress = args.get("tezos-checkpoint-registry") ?? process.env.DOOM_TEZOS_CHECKPOINT_REGISTRY ?? "";
const tezosContentRegistryAddress = args.get("tezos-content-registry") ?? process.env.DOOM_TEZOS_CONTENT_REGISTRY ?? "";
const tezosChainId = args.get("tezos-chain-id") ?? process.env.DOOM_TEZOS_CHAIN_ID ?? "";
const tezosNetworkBytes = args.get("tezos-network-bytes") ?? process.env.DOOM_TEZOS_NETWORK_BYTES ?? "";

if (!wasmPath || wasmPath === path.resolve("")) {
  throw new Error("Provide --wasm /path/to/doom.wasm or DOOM_WASM_PATH.");
}
if (!/^[0-9a-f]{64}$/u.test(wadSha256)) {
  throw new Error("Provide --wad-sha256 with the exact 32-byte WAD digest; game data is never guessed or committed.");
}
if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error("--source-commit must be a 40-character Git commit.");
if (!Number.isSafeInteger(tezosLeafBytes) || tezosLeafBytes <= 0 || tezosLeafBytes > 12_000) {
  throw new Error("--tezos-leaf-bytes must be an integer from 1 through 12000.");
}

function bytesHex(value) {
  return `0x${Buffer.from(value).toString("hex")}`;
}

function raw(value) {
  return bytesHex(Buffer.from(value, "utf8"));
}

function uintHex(value, byteLength) {
  let cursor = BigInt(value);
  const output = Buffer.alloc(byteLength);
  for (let index = byteLength - 1; index >= 0; index -= 1) {
    output[index] = Number(cursor & 0xffn);
    cursor >>= 8n;
  }
  if (cursor !== 0n) throw new RangeError(`value does not fit in ${byteLength} bytes`);
  return bytesHex(output);
}

function keccakHex(value) {
  return keccak256(bytesHex(value));
}

function expressionPair(values) {
  if (values.length < 2) throw new Error("pair requires at least two values");
  const wrap = (value) => value.startsWith("Pair ") ? `(${value})` : value;
  let result = `Pair ${wrap(values[values.length - 2])} ${wrap(values[values.length - 1])}`;
  for (let index = values.length - 3; index >= 0; index -= 1) {
    result = `Pair ${wrap(values[index])} (${result})`;
  }
  return result;
}

function dataPair(values) {
  if (values.length < 2) throw new Error("pair requires at least two values");
  let result = { prim: "Pair", args: [values[values.length - 2], values[values.length - 1]] };
  for (let index = values.length - 3; index >= 0; index -= 1) {
    result = { prim: "Pair", args: [values[index], result] };
  }
  return result;
}

function typePair(left, right) {
  return { prim: "pair", args: [left, right] };
}

function dataBytes(value) {
  return { bytes: value.replace(/^0x/u, "") };
}

function dataNat(value) {
  return { int: String(value) };
}

function identityData(identity) {
  return dataPair([
    { string: identity.chunk_store },
    dataBytes(identity.expected_index_root),
    dataNat(identity.expected_chunk_count),
    dataBytes(identity.expected_stored_sha256),
    dataNat(identity.expected_stored_byte_length),
    dataBytes(identity.decoded_sha256),
    dataNat(identity.decoded_byte_length),
    dataBytes(identity.media_type),
    dataBytes(identity.compression),
  ]);
}

function identityType() {
  return typePair(
    { prim: "address" },
    typePair(
      { prim: "bytes" },
      typePair(
        { prim: "nat" },
        typePair(
          { prim: "bytes" },
          typePair(
            { prim: "nat" },
            typePair(
              { prim: "bytes" },
              typePair({ prim: "nat" }, typePair({ prim: "bytes" }, { prim: "bytes" })),
            ),
          ),
        ),
      ),
    ),
  );
}

function rollingStepData(previous, index, slugPointer, byteLength) {
  return dataPair([
    dataBytes(previous),
    dataNat(index),
    dataBytes(slugPointer),
    dataNat(byteLength),
  ]);
}

function rollingStepType() {
  return typePair(
    { prim: "bytes" },
    typePair({ prim: "nat" }, typePair({ prim: "bytes" }, { prim: "nat" })),
  );
}

function identityExpression(identity) {
  return expressionPair([
    JSON.stringify(identity.chunk_store),
    identity.expected_index_root,
    String(identity.expected_chunk_count),
    identity.expected_stored_sha256,
    String(identity.expected_stored_byte_length),
    identity.decoded_sha256,
    String(identity.decoded_byte_length),
    identity.media_type,
    identity.compression,
  ]);
}

function validKT1(value) {
  return /^KT1[1-9A-HJ-NP-Za-km-z]{33}$/u.test(value);
}

function base58Decode(value) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number = 0n;
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error(`Invalid base58 character in ${value}`);
    number = number * 58n + BigInt(digit);
  }
  const output = [];
  while (number > 0n) {
    output.unshift(Number(number & 0xffn));
    number >>= 8n;
  }
  const leadingZeroes = value.match(/^1*/u)?.[0].length ?? 0;
  return Buffer.concat([Buffer.alloc(leadingZeroes), Buffer.from(output)]);
}

function kt1Payload(value) {
  const decoded = base58Decode(value);
  if (decoded.length !== 27 || decoded[0] !== 2 || decoded[1] !== 90 || decoded[2] !== 121) {
    throw new Error(`Invalid KT1 address: ${value}`);
  }
  return decoded.subarray(3, 23);
}

function fixedHex(value, byteLength, label) {
  if (!new RegExp(`^0x[0-9a-f]{${byteLength * 2}}$`, "u").test(value)) {
    throw new Error(`${label} must be 0x-prefixed ${byteLength}-byte hex.`);
  }
  return Buffer.from(value.slice(2), "hex");
}

const wasmBytes = new Uint8Array(await readFile(wasmPath));
if (wasmBytes.byteLength === 0) throw new Error("Doom WASM is empty.");
const module = new WebAssembly.Module(wasmBytes);
const imports = WebAssembly.Module.imports(module).map((item) => `${item.module}.${item.name}`).sort();
const exports = WebAssembly.Module.exports(module).map((item) => item.name).sort();
const requiredExports = ["initGame", "tickGame", "reportKeyDown", "reportKeyUp", "memory"];
for (const name of requiredExports) {
  if (!exports.includes(name)) throw new Error(`Doom WASM is missing required export ${name}.`);
}
const requiredImports = [
  "console.onErrorMessage",
  "console.onInfoMessage",
  "gameSaving.readSaveGame",
  "gameSaving.sizeOfSaveGame",
  "gameSaving.writeSaveGame",
  "loading.onGameInit",
  "loading.readWads",
  "loading.wadSizes",
  "runtimeControl.timeInMilliseconds",
  "ui.drawFrame",
];
for (const name of requiredImports) {
  if (!imports.includes(name)) throw new Error(`Doom WASM is missing required import ${name}.`);
}

const metadata = {
  schema: "keel-doom-wasm-source@1",
  engine: {
    repository: "https://github.com/jacobenget/doom.wasm",
    commit: sourceCommit,
    license: "GPL-2.0",
    interface: { imports, requiredExports },
  },
  gameData: {
    source: wadSource,
    sha256: `0x${wadSha256}`,
    keptOutsideRepository: true,
  },
};
const metadataBytes = utf8ToBytes(canonicalJson(metadata));
const metadataSha256 = await sha256Hex(metadataBytes);
const commitments = await portableContentCommitmentsV1(wasmBytes);
const zero = `0x${"0".repeat(64)}`;
const lineageId = await sha256Hex(utf8ToBytes(`keel.doom-wasm.lineage.v1:${sourceCommit}`));
const manifest = {
  resourceKind: PortableResourceKind.Viewer,
  compression: PortableCompression.None,
  mediaType: "application/octet-stream",
  decodedByteLength: commitments.decodedByteLength,
  decodedSha256: commitments.decodedSha256,
  metadataSha256,
  chunkRoot: commitments.chunkRoot,
  lineageId,
  revision: 1n,
  parentPortableRoot: zero,
  editPolicy: PortableEditPolicy.Immutable,
  controllerId: zero,
  frozen: true,
};
const manifestBytes = encodePortableManifestV1(manifest);
const portableRoot = await portableRootV1(manifestBytes);

const ethereumDirectory = path.join(outputDirectory, "ethereum");
const tezosDirectory = path.join(outputDirectory, "tezos");
const ethereumPlan = await createRecursiveUploadPlan(wasmBytes, {
  objectName: "doom.wasm",
  mediaType: "application/octet-stream",
  outputDirectory: ethereumDirectory,
  compression: "none",
  maxChunkBytes: 23_000,
  leafDecodedBytes: ethLeafDecodedBytes,
  maxPartsPerComposite: ethMaxParts,
});
const tezosRecursive = await buildKeelTezosRecursiveObject(wasmBytes, "application/octet-stream");

const tezosChunks = [];
let rollingIndexRoot = zero;
for (let offset = 0, index = 0; offset < wasmBytes.byteLength; offset += tezosLeafBytes, index += 1) {
  const content = wasmBytes.slice(offset, Math.min(offset + tezosLeafBytes, wasmBytes.byteLength));
  const pointer = keccakHex(content);
  const packedStep = packDataBytes(
    rollingStepData(rollingIndexRoot, index, pointer, content.byteLength),
    rollingStepType(),
  );
  rollingIndexRoot = keccakHex(Buffer.from(packedStep.bytes, "hex"));
  tezosChunks.push({
    index,
    pointer,
    byteLength: content.byteLength,
    bytes: bytesHex(content),
  });
}

const tezosIdentity = tezosKeelHoldAddress && validKT1(tezosKeelHoldAddress)
  ? {
      chunk_store: tezosKeelHoldAddress,
      expected_index_root: rollingIndexRoot,
      expected_chunk_count: tezosChunks.length,
      expected_stored_sha256: commitments.decodedSha256,
      expected_stored_byte_length: wasmBytes.byteLength,
      decoded_sha256: commitments.decodedSha256,
      decoded_byte_length: wasmBytes.byteLength,
      media_type: raw("application/octet-stream"),
      compression: raw("none"),
    }
  : null;

let checkpointPlan;
let checkpointObjectId = null;
if (tezosKeelHoldAddress && !validKT1(tezosKeelHoldAddress)) {
  throw new Error("--tezos-chunk-store must be a valid KT1 address.");
}
if (tezosIdentity) {
  const packedIdentity = packDataBytes(identityData(tezosIdentity), identityType());
  checkpointObjectId = await sha256Hex(Buffer.from(packedIdentity.bytes, "hex"));
  const beginArgument = expressionPair([checkpointObjectId, identityExpression(tezosIdentity)]);
  checkpointPlan = {
    schema: "keel-doom-wasm-tezos-checkpoint-upload@1",
    status: "ready",
    carrier: "KeelKeelHold",
    checkpointRegistry: "KeelImmutableCheckpointRegistry",
    keelHold: tezosKeelHoldAddress,
    objectId: checkpointObjectId,
    identity: tezosIdentity,
    packedIdentity: `0x${packedIdentity.bytes}`,
    chunks: tezosChunks,
    operations: [
      ...tezosChunks.map((chunk) => ({
        entrypoint: "write_chunk",
        argument: chunk.bytes,
        pointer: chunk.pointer,
        index: chunk.index,
      })),
      { entrypoint: "begin_checkpoint", argument: beginArgument, objectId: checkpointObjectId },
      ...tezosChunks.map((chunk) => ({
        entrypoint: "append_checkpoint_chunk",
        argument: expressionPair([checkpointObjectId, String(chunk.index), chunk.pointer]),
        objectId: checkpointObjectId,
        index: chunk.index,
        pointer: chunk.pointer,
      })),
      { entrypoint: "seal_checkpoint", argument: checkpointObjectId, objectId: checkpointObjectId },
    ],
    read: {
      view: "read_immutable_object",
      argument: checkpointObjectId,
      expectedSha256: commitments.decodedSha256,
      expectedByteLength: wasmBytes.byteLength,
      callCountForBytes: 1,
    },
  };
} else {
  checkpointPlan = {
    schema: "keel-doom-wasm-tezos-checkpoint-upload@1",
    status: "address-required",
    carrier: "KeelKeelHold",
    checkpointRegistry: "KeelImmutableCheckpointRegistry",
    keelHold: null,
    objectId: null,
    identityTemplate: {
      expected_index_root: rollingIndexRoot,
      expected_chunk_count: tezosChunks.length,
      expected_stored_sha256: commitments.decodedSha256,
      expected_stored_byte_length: wasmBytes.byteLength,
      decoded_sha256: commitments.decodedSha256,
      decoded_byte_length: wasmBytes.byteLength,
      media_type: raw("application/octet-stream"),
      compression: raw("none"),
    },
    chunks: tezosChunks,
    operations: tezosChunks.map((chunk) => ({
      entrypoint: "write_chunk",
      argument: chunk.bytes,
      pointer: chunk.pointer,
      index: chunk.index,
    })),
    requires: ["KeelKeelHold KT1 address before packing identity and checkpoint operations"],
  };
}

let tezosContentPublication = {
  schema: "keel-doom-wasm-tezos-content-publication@1",
  status: "approval-gated",
  registry: "ContentObjectRegistry",
  requires: ["Keel checkpoint and ContentObjectRegistry KT1 addresses", "Tezos binary network id"],
  publish: null,
  anchor: null,
};
if (
  checkpointObjectId
  && validKT1(tezosCheckpointRegistryAddress)
  && validKT1(tezosContentRegistryAddress)
  && tezosChainId
  && /^0x[0-9a-f]{8}$/u.test(tezosNetworkBytes)
) {
  const locator = `tezos://${tezosChainId}/${tezosCheckpointRegistryAddress}/${checkpointObjectId.slice(2)}`;
  const publishArgument = expressionPair([
    raw("none"),
    uintHex(wasmBytes.byteLength, 8),
    commitments.decodedSha256,
    bytesHex(manifestBytes),
    "True",
    raw(locator),
    raw("application/octet-stream"),
    portableRoot,
    "0x00",
    uintHex(1, 8),
  ]);
  const packedAddress = Buffer.concat([
    Buffer.from("050a0000001601", "hex"),
    kt1Payload(tezosContentRegistryAddress),
    Buffer.from([0]),
  ]);
  const sourceRegistry = await sha256Hex(packedAddress);
  const sourceEventDigest = await sha256Hex(Buffer.concat([
    Buffer.from("keel.tezos-source-event.v1", "utf8"),
    fixedHex(portableRoot, 32, "portable root"),
    manifestBytes,
    Buffer.from(locator, "utf8"),
    Buffer.from(uintHex(1, 8).slice(2), "hex"),
  ]));
  const anchorBytes = Buffer.concat([
    Buffer.from("keel.anchor.v1", "utf8"),
    fixedHex(portableRoot, 32, "portable root"),
    Buffer.from([2]),
    fixedHex(tezosNetworkBytes, 4, "Tezos network bytes"),
    fixedHex(sourceRegistry, 32, "source registry"),
    fixedHex(portableRoot, 32, "source object key"),
    Buffer.from(uintHex(1, 8).slice(2), "hex"),
    fixedHex(sourceEventDigest, 32, "source event digest"),
  ]);
  const anchorRoot = await sha256Hex(anchorBytes);
  tezosContentPublication = {
    schema: "keel-doom-wasm-tezos-content-publication@1",
    status: "ready-for-approval",
    registry: tezosContentRegistryAddress,
    checkpointRegistry: tezosCheckpointRegistryAddress,
    publish: {
      entrypoint: "publish",
      argument: publishArgument,
      portableRoot,
      descriptorBytes: bytesHex(manifestBytes),
      locator,
    },
    anchor: {
      entrypoint: "publish_anchor",
      argument: expressionPair([bytesHex(anchorBytes), anchorRoot]),
      anchorBytes: bytesHex(anchorBytes),
      anchorRoot,
      verification: "deferred approval; no external anchor verifier is invoked",
    },
  };
}

await mkdir(path.join(tezosDirectory, "recursive-nodes"), { recursive: true });
for (const node of tezosRecursive.nodes) {
  await writeFile(path.join(tezosDirectory, "recursive-nodes", `${node.id.slice(2)}.bin`), node.encoded);
}
await mkdir(outputDirectory, { recursive: true });
await writeFile(path.join(outputDirectory, "doom-portable-manifest.bin"), manifestBytes);
await writeFile(path.join(outputDirectory, "doom-portable-manifest.json"), `${JSON.stringify({ ...manifest, portableRoot }, (_, value) => typeof value === "bigint" ? value.toString() : value, 2)}\n`);
await writeFile(path.join(outputDirectory, "doom-source-metadata.json"), `${JSON.stringify({ ...metadata, wasmSha256: commitments.decodedSha256, wasmByteLength: wasmBytes.byteLength, metadataSha256 }, null, 2)}\n`);
await writeFile(path.join(tezosDirectory, "keel-checkpoint-upload.json"), `${JSON.stringify(checkpointPlan, null, 2)}\n`);
await writeFile(path.join(tezosDirectory, "keel-content-publication.json"), `${JSON.stringify(tezosContentPublication, null, 2)}\n`);
await writeFile(path.join(tezosDirectory, "recursive-object.json"), `${JSON.stringify({
  schema: "keel-doom-wasm-tezos-recursive-object@1",
  objectId: tezosRecursive.id,
  manifestSha256: await sha256Hex(tezosRecursive.manifest),
  manifestByteLength: tezosRecursive.manifest.byteLength,
  rootNode: tezosRecursive.rootNode,
  decodedSha256: tezosRecursive.decodedSha256,
  decodedByteLength: tezosRecursive.decodedByteLength,
  nodeCount: tezosRecursive.nodes.length,
  nodeDirectory: "recursive-nodes",
  checkpointObjectId,
  readSurface: "KeelImmutableCheckpointRegistry.read_immutable_object(bytes)",
}, null, 2)}\n`);
await writeFile(path.join(outputDirectory, "publication.json"), `${JSON.stringify({
  schema: "keel-doom-wasm-cross-chain-publication@1",
  wasm: {
    file: path.basename(wasmPath),
    byteLength: wasmBytes.byteLength,
    sha256: commitments.decodedSha256,
    mediaType: "application/octet-stream",
  },
  portable: {
    root: portableRoot,
    manifestFile: "doom-portable-manifest.bin",
    manifestByteLength: manifestBytes.byteLength,
    manifestSha256: portableRoot,
    decodedSha256: commitments.decodedSha256,
    chunkRoot: commitments.chunkRoot,
    metadataSha256,
  },
  ethereum: {
    planFile: "ethereum/recursive-upload-plan.json",
    rootPlanId: ethereumPlan.root,
    objectCount: ethereumPlan.objects.length,
    readMethod: "KeelHold.haulObject(bytes32)",
    compressedRead: false,
  },
  tezos: {
    checkpointPlanFile: "tezos/keel-checkpoint-upload.json",
    contentPublicationFile: "tezos/keel-content-publication.json",
    recursiveObjectFile: "tezos/recursive-object.json",
    checkpointObjectId,
    chunkCount: tezosChunks.length,
    readMethod: "KeelImmutableCheckpointRegistry.read_immutable_object(bytes)",
    readCallCountForBytes: 1,
    anchorVerification: "deferred approval; native publication only",
  },
}, null, 2)}\n`);

process.stdout.write(`${JSON.stringify({
  status: "PASS",
  outputDirectory,
  wasmBytes: wasmBytes.byteLength,
  wasmSha256: commitments.decodedSha256,
  portableRoot,
  ethereumObjects: ethereumPlan.objects.length,
  ethereumRoot: ethereumPlan.root,
  tezosNodes: tezosRecursive.nodes.length,
  tezosChunks: tezosChunks.length,
  tezosCheckpointObjectId: checkpointObjectId,
  tezosContentPublication: tezosContentPublication.status,
})}\n`);
