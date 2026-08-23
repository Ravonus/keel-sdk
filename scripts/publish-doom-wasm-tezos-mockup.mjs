#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { packDataBytes } from "../node_modules/.pnpm/@taquito+michel-codec@25.0.0/node_modules/@taquito/michel-codec/dist/taquito-michel-codec.es6.js";
import { keccak256 } from "viem";

const repoRoot = path.resolve(import.meta.dirname, "..");
const tezosRoot = path.join(repoRoot, "packages/tezos");
const defaultOutput = path.join(tezosRoot, "build/doom-wasm-onchain");
const image = process.env.DOOM_TEZOS_OCTEZ_IMAGE ?? "tezos/tezos@sha256:c7adc1605e0ac167743e5ccc107c88719d201994b8166dd794ea10fd0488bea2";

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

const outputDirectory = path.resolve(args.get("output") ?? process.env.DOOM_ONCHAIN_OUTPUT_DIRECTORY ?? defaultOutput);
const keepContainer = args.get("keep") === "true" || process.env.DOOM_KEEP_TEZOS_MOCKUP === "1";
const publication = JSON.parse(readFileSync(path.join(outputDirectory, "publication.json"), "utf8"));
const checkpointPlan = JSON.parse(readFileSync(path.join(outputDirectory, "tezos/keel-checkpoint-upload.json"), "utf8"));
if (!Array.isArray(checkpointPlan.chunks) || checkpointPlan.chunks.length === 0) throw new Error("Tezos checkpoint chunks are missing.");
if (publication.wasm?.sha256 !== checkpointPlan.identityTemplate?.expected_stored_sha256) {
  throw new Error("Publication and checkpoint digest commitments disagree.");
}

const artifactDirectory = path.join(tezosRoot, "build/immutable-checkpoint/Keel_resumable_immutable_checkpoint");
const artifactNames = {
  chunkCode: "step_003_cont_0_contract.tz",
  chunkStorage: "step_003_cont_0_storage.tz",
  checkpointCode: "step_004_cont_1_contract.tz",
  checkpointStorage: "step_004_cont_1_storage.tz",
};
for (const name of Object.values(artifactNames)) {
  if (!existsSync(path.join(artifactDirectory, name))) {
    throw new Error(`Missing native Keel artifact ${name}; run pnpm --filter @keel/vault-tezos keel:checkpoint:test first.`);
  }
}

function bytesHex(value) {
  return `0x${Buffer.from(value).toString("hex")}`;
}

function fixedBytes(value) {
  return Buffer.from(value.replace(/^0x/u, ""), "hex");
}

function sha256Hex(value) {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
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

const workDirectory = mkdtempSync(path.join(tezosRoot, "build/doom-wasm-tezos-mockup."));
const container = `keel-doom-keel-${process.pid}`;
let containerStarted = false;

function docker(arguments_, options = {}) {
  return execFileSync("docker", arguments_, {
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
}

function client(arguments_, options = {}) {
  return docker([
    "exec",
    container,
    "octez-client",
    "--base-dir",
    "/tmp/doom-keel-mockup",
    "--mode",
    "mockup",
    ...arguments_,
  ], options);
}

function addressFrom(output) {
  const matches = output.match(/KT1[1-9A-HJ-NP-Za-km-z]{33}/gu) ?? [];
  const address = matches.at(-1);
  if (!address) throw new Error(`No originated KT1 address in:\n${output}`);
  return address;
}

function sendTransfer(target, entrypoint, argument) {
  const output = client([
    "transfer",
    "0",
    "from",
    "bootstrap1",
    "to",
    target,
    "--entrypoint",
    entrypoint,
    "--arg",
    argument,
    "--burn-cap",
    "100",
  ], { maxBuffer: 8 * 1024 * 1024 });
  const operationHash = output.match(/o[1-9A-HJ-NP-Za-km-z]{50}/u)?.[0];
  if (!operationHash) throw new Error(`No operation hash for ${entrypoint}:\n${output}`);
  return operationHash;
}

function originate(name, codeFile, storageFile) {
  const output = client([
    "originate",
    "contract",
    name,
    "transferring",
    "0",
    "from",
    "bootstrap1",
    "running",
    `/artifacts/${path.basename(codeFile)}`,
    "--init",
    readFileSync(storageFile, "utf8").trim(),
    "--burn-cap",
    "100",
  ], { maxBuffer: 8 * 1024 * 1024 });
  return {
    address: addressFrom(output),
    operationHash: output.match(/o[1-9A-HJ-NP-Za-km-z]{50}/u)?.[0] ?? null,
  };
}

try {
  for (const [key, file] of Object.entries(artifactNames)) {
    copyFileSync(path.join(artifactDirectory, file), path.join(workDirectory, file));
  }
  docker([
    "run",
    "-d",
    "--name",
    container,
    "--entrypoint",
    "/bin/sh",
    "-v",
    `${workDirectory}:/artifacts`,
    image,
    "-c",
    "while :; do sleep 3600; done",
  ]);
  containerStarted = true;
  client(["create", "mockup"]);
  const chainId = client(["rpc", "get", "/chains/main/chain_id"]).trim().replaceAll('"', "");
  const bootstrapOutput = client(["show", "address", "bootstrap1"]);
  const administrator = bootstrapOutput.match(/tz[1-3][1-9A-HJ-NP-Za-km-z]{33}/u)?.[0];
  if (!administrator) throw new Error(`Could not resolve bootstrap1:\n${bootstrapOutput}`);
  writeFileSync(
    path.join(workDirectory, artifactNames.chunkStorage),
    `(Pair "${administrator}" {})\n`,
  );
  const keelHold = originate("doom-keel-chunks", artifactNames.chunkCode, path.join(workDirectory, artifactNames.chunkStorage));
  const checkpointRegistry = originate("doom-keel-checkpoint", artifactNames.checkpointCode, path.join(workDirectory, artifactNames.checkpointStorage));

  const chunks = checkpointPlan.chunks;
  const zero = `0x${"0".repeat(64)}`;
  let rollingIndexRoot = zero;
  for (const chunk of chunks) {
    const content = fixedBytes(chunk.bytes);
    const pointer = keccak256(bytesHex(content));
    if (pointer.toLowerCase() !== chunk.pointer.toLowerCase()) throw new Error(`Chunk ${chunk.index} pointer mismatch.`);
    const packedStep = packDataBytes(
      rollingStepData(rollingIndexRoot, chunk.index, pointer, content.byteLength),
      rollingStepType(),
    );
    rollingIndexRoot = keccak256(bytesHex(Buffer.from(packedStep.bytes, "hex")));
  }
  if (rollingIndexRoot.toLowerCase() !== checkpointPlan.identityTemplate.expected_index_root.toLowerCase()) {
    throw new Error("Rolling Keel checkpoint root does not match the prepared plan.");
  }

  const identity = {
    chunk_store: keelHold.address,
    expected_index_root: rollingIndexRoot,
    expected_chunk_count: chunks.length,
    expected_stored_sha256: publication.wasm.sha256,
    expected_stored_byte_length: publication.wasm.byteLength,
    decoded_sha256: publication.wasm.sha256,
    decoded_byte_length: publication.wasm.byteLength,
    media_type: "0x6170706c69636174696f6e2f6f637465742d73747265616d",
    compression: "0x6e6f6e65",
  };
  const packedIdentity = packDataBytes(identityData(identity), identityType());
  const objectId = sha256Hex(Buffer.from(packedIdentity.bytes, "hex"));
  const beginArgument = expressionPair([
    objectId,
    expressionPair([
      JSON.stringify(identity.chunk_store),
      identity.expected_index_root,
      String(identity.expected_chunk_count),
      identity.expected_stored_sha256,
      String(identity.expected_stored_byte_length),
      identity.decoded_sha256,
      String(identity.decoded_byte_length),
      identity.media_type,
      identity.compression,
    ]),
  ]);

  const uploadOperations = [];
  for (const chunk of chunks) {
    const operationHash = sendTransfer(keelHold.address, "write_chunk", chunk.bytes);
    uploadOperations.push({ entrypoint: "write_chunk", index: chunk.index, operationHash });
    if ((chunk.index + 1) % 20 === 0 || chunk.index + 1 === chunks.length) {
      process.stdout.write(`uploaded ${chunk.index + 1}/${chunks.length} native Keel chunks\n`);
    }
  }
  const beginOperation = sendTransfer(checkpointRegistry.address, "begin_checkpoint", beginArgument);
  const appendOperations = [];
  for (const chunk of chunks) {
    const operationHash = sendTransfer(
      checkpointRegistry.address,
      "append_checkpoint_chunk",
      expressionPair([objectId, String(chunk.index), chunk.pointer]),
    );
    appendOperations.push({ index: chunk.index, operationHash });
    if ((chunk.index + 1) % 20 === 0 || chunk.index + 1 === chunks.length) {
      process.stdout.write(`appended ${chunk.index + 1}/${chunks.length} checkpoint pointers\n`);
    }
  }
  const sealOperation = sendTransfer(checkpointRegistry.address, "seal_checkpoint", objectId);
  const viewOutput = client([
    "run",
    "view",
    "read_immutable_object",
    "on",
    "contract",
    checkpointRegistry.address,
    "with",
    "input",
    objectId,
    "--unlimited-gas",
  ], { maxBuffer: 32 * 1024 * 1024 });
  const viewMatch = viewOutput.match(/0x([0-9a-f]+)\s*$/iu);
  if (!viewMatch) throw new Error(`Could not parse the one-shot Tezos view result:\n${viewOutput.slice(-4000)}`);
  const returned = Buffer.from(viewMatch[1], "hex");
  if (returned.byteLength !== publication.wasm.byteLength) throw new Error("Tezos one-shot read length mismatch.");
  const returnedSha256 = sha256Hex(returned);
  if (returnedSha256.toLowerCase() !== publication.wasm.sha256.toLowerCase()) throw new Error("Tezos one-shot read SHA-256 mismatch.");

  const proof = {
    schema: "keel-doom-wasm-tezos-read-proof@1",
    chain: "tezos",
    chainId,
    transport: "Octez v25 mockup",
    contracts: {
      keelHold: keelHold.address,
      checkpointRegistry: checkpointRegistry.address,
    },
    checkpoint: {
      objectId,
      identity,
      packedIdentity: bytesHex(Buffer.from(packedIdentity.bytes, "hex")),
      beginOperation,
      appendCount: appendOperations.length,
      sealOperation,
    },
    writes: {
      chunkCount: uploadOperations.length,
      operationCount: uploadOperations.length,
    },
    oneShotRead: {
      view: "KeelImmutableCheckpointRegistry.read_immutable_object(bytes)",
      callCount: 1,
      gas: "unlimited (local Octez mockup)",
      byteLength: returned.byteLength,
      sha256: returnedSha256,
    },
  };
  writeFileSync(path.join(outputDirectory, "tezos-read-proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    chainId,
    keelHold: keelHold.address,
    checkpointRegistry: checkpointRegistry.address,
    objectId,
    bytes: returned.byteLength,
    sha256: returnedSha256,
    oneShotReadCallCount: 1,
  })}\n`);
} finally {
  if (containerStarted && !keepContainer) {
    try {
      docker(["rm", "-f", container], { stdio: "ignore" });
    } catch {
      // Preserve the original test failure if cleanup itself cannot run.
    }
  }
  if (!keepContainer) rmSync(workDirectory, { recursive: true, force: true });
}
