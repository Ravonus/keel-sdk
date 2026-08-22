import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { canonicalJson, createIntegrity, utf8ToBytes } from "../packages/protocol/dist/index.js";
import {
  CHUNK_STORE_MAX_BATCH_SLUGS,
  createKeelFactoryConfigDigest,
  createViemEthereumAdapterCodecs,
  normalizeKeelFactoryCollectionConfig,
  prepareEthereumKeelHoldOperations,
} from "../packages/ethereum-adapter/dist/index.js";

const target = { family: "ethereum", chainId: 1, address: "0x1111111111111111111111111111111111111111" };
const hex = (bytes) => `0x${Buffer.from(bytes).toString("hex")}`;
const fakeKeccak = (bytes) => `0x${createHash("sha256").update(bytes).digest("hex")}`;
const fakeAbi = (types, values) => {
  const encoded = new Uint8Array(types.length * 32);
  encoded.set(utf8ToBytes(canonicalJson({ types, values })).slice(0, encoded.byteLength));
  return hex(encoded);
};
const selectors = {
  "castSlugs(bytes[])": "0x0d1ff9e2",
  "weldObject(bytes32[],bytes32,uint64,uint8,string)": "0xb17463a8",
  "weldComposite(bytes32[],bytes32,uint64,string)": "0x5f97a164",
};
const codecs = {
  keccak256: fakeKeccak,
  encodeAbiParameters: fakeAbi,
  encodeFunctionData: (signature, args) => `${selectors[signature]}${hex(utf8ToBytes(canonicalJson({ signature, args }))).slice(2)}`,
  validateFunctionData: (signature, data) => data.startsWith(selectors[signature]) && data.length > 10,
};

const collectionConfig = {
  name: "Keel Demo",
  symbol: "KEEL",
  admin: "0x1111111111111111111111111111111111111111",
  royaltyReceiver: "0x2222222222222222222222222222222222222222",
  royaltyBps: "250",
  maxSupply: "1000",
  mintManager: "0x3333333333333333333333333333333333333333",
  keelIndex: "0x4444444444444444444444444444444444444444",
};

test("KeelFactory config helper matches the exact dieConfigDigest tuple", () => {
  const mixedCaseAdmin = `${collectionConfig.admin.slice(0, 2)}${collectionConfig.admin.slice(2).toUpperCase()}`;
  assert.deepEqual(normalizeKeelFactoryCollectionConfig({ ...collectionConfig, admin: mixedCaseAdmin }), collectionConfig);
  assert.equal(createKeelFactoryConfigDigest(collectionConfig), "0x818fc05dadddd562c44596d54c5a4a3f934f2058101087ed8f0bb95fa42c3744");
  assert.notEqual(createKeelFactoryConfigDigest({ ...collectionConfig, name: "Keel Mutated" }), createKeelFactoryConfigDigest(collectionConfig));
  assert.throws(() => createKeelFactoryConfigDigest({ ...collectionConfig, maxSupply: "01" }), /canonical decimal/u);
  assert.throws(() => createKeelFactoryConfigDigest({ ...collectionConfig, royaltyBps: "1".repeat(30) }), /decimal width/u);
  assert.throws(() => createKeelFactoryConfigDigest({ ...collectionConfig, maxSupply: "1".repeat(79) }), /decimal width/u);
  assert.throws(() => createKeelFactoryConfigDigest({ ...collectionConfig, name: "\uD800" }), /unpaired UTF-16/u);
});

async function flatPlan(content = "hello", chunkSize = content.length, compression = "none") {
  const source = utf8ToBytes(content);
  const chunk = source.slice(0, chunkSize);
  const chunkIntegrity = await createIntegrity(chunk);
  const sourceIntegrity = await createIntegrity(source);
  return {
    plan: {
      schema: "oca-upload-plan@2",
      indexEncoding: "oca-object-index@1",
      objectName: "hello",
      mediaType: "text/plain",
      originalByteLength: source.byteLength,
      storedByteLength: chunk.byteLength,
      compression,
      integrity: sourceIntegrity,
      maxChildren: 128,
      chunks: [{ index: 0, offset: 0, byteLength: chunk.byteLength, integrity: chunkIntegrity, file: "chunks/00000.bin" }],
    },
    chunks: { "chunks/00000.bin": chunk },
  };
}

test("Ethereum adapter verifies bytes and emits deterministic unsigned KeelHold calldata", async () => {
  const input = await flatPlan();
  const first = await prepareEthereumKeelHoldOperations({ ...input, target, codecs });
  const second = await prepareEthereumKeelHoldOperations({ ...input, target, codecs });
  assert.deepEqual(first, second);
  assert.equal(first.status, "ready-for-review");
  assert.equal(first.chainReady, false);
  assert.equal(first.signing, "not-performed");
  assert.equal(first.operations.length, 2);
  assert.equal(first.operations[0].kind, "castSlugs");
  assert.equal(first.operations[1].kind, "weldObject");
  assert.equal(first.operations[0].operationId, "op-ca6fca0ad918-00000");
  assert.match(first.operations[0].data, /^0x0d1ff9e2/u);
  assert.match(first.operations[1].data, /^0xb17463a8/u);
  assert.equal(first.operations[1].objectId.length, 66);
});

test("Ethereum adapter batches at three chunks and binds the canonical source plan digest", async () => {
  const source = utf8ToBytes("abcd");
  const chunks = {};
  const planChunks = [];
  for (let index = 0; index < source.length; index += 1) {
    const value = source.slice(index, index + 1);
    const file = `chunks/${String(index).padStart(5, "0")}.bin`;
    chunks[file] = value;
    planChunks.push({ index, offset: index, byteLength: 1, integrity: await createIntegrity(value), file });
  }
  const plan = {
    schema: "oca-upload-plan@2", indexEncoding: "oca-object-index@1", objectName: "abcd", mediaType: "text/plain",
    originalByteLength: 4, storedByteLength: 4, compression: "none", integrity: await createIntegrity(source), maxChildren: 128, chunks: planChunks,
  };
  const result = await prepareEthereumKeelHoldOperations({ plan, chunks, target, codecs });
  assert.equal(result.status, "ready-for-review");
  assert.equal(result.operations.filter((item) => item.kind === "castSlugs").length, 2);
  assert.equal(result.operations[0].args[0].length, CHUNK_STORE_MAX_BATCH_SLUGS);
  assert.equal(result.source.contentIntegrity.digest, plan.integrity.digest);
});

test("Ethereum adapter fails closed for missing codecs, compressed bytes, bad bytes, and Tezos", async () => {
  const input = await flatPlan();
  const missing = await prepareEthereumKeelHoldOperations({ ...input, target });
  assert.equal(missing.status, "deferred");
  assert.equal(missing.code, "missing-keccak256");
  const missingAbi = await prepareEthereumKeelHoldOperations({ ...input, target, codecs: { keccak256: fakeKeccak, encodeFunctionData: codecs.encodeFunctionData } });
  assert.equal(missingAbi.status, "deferred");
  assert.equal(missingAbi.code, "missing-abi-encoder");
  const compressed = await flatPlan("hello", 5, "gzip");
  const missingDecoder = await prepareEthereumKeelHoldOperations({ ...compressed, target, codecs });
  assert.equal(missingDecoder.status, "deferred");
  assert.equal(missingDecoder.code, "missing-decompressor");
  const tampered = { ...input, chunks: { ...input.chunks, "chunks/00000.bin": utf8ToBytes("tamper") } };
  const mismatch = await prepareEthereumKeelHoldOperations({ ...tampered, target, codecs });
  assert.equal(mismatch.status, "deferred");
  assert.equal(mismatch.code, "source-mismatch");
  const unavailable = await prepareEthereumKeelHoldOperations({ ...input, chunks: {}, target, codecs });
  assert.equal(unavailable.status, "deferred");
  assert.equal(unavailable.code, "source-unavailable");
  const shortCalldata = await prepareEthereumKeelHoldOperations({
    ...input,
    target,
    codecs: { ...codecs, encodeFunctionData: () => "0x1234" },
  });
  assert.equal(shortCalldata.status, "deferred");
  assert.equal(shortCalldata.code, "calldata-invalid");
  const selectorOnly = await prepareEthereumKeelHoldOperations({
    ...input,
    target,
    codecs: { ...codecs, encodeFunctionData: (signature) => selectors[signature], validateFunctionData: () => false },
  });
  assert.equal(selectorOnly.status, "deferred");
  assert.equal(selectorOnly.code, "calldata-invalid");
  const wrongSelector = await prepareEthereumKeelHoldOperations({
    ...input,
    target,
    codecs: { ...codecs, encodeFunctionData: () => "0xdeadbeef" },
  });
  assert.equal(wrongSelector.status, "deferred");
  assert.equal(wrongSelector.code, "calldata-invalid");
  const tezos = await prepareEthereumKeelHoldOperations({ ...input, target: { family: "tezos", address: "KT1AaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaA" }, codecs });
  assert.equal(tezos.status, "deferred");
  assert.equal(tezos.code, "tezos-adapter-required");
});

test("Ethereum adapter rejects unsafe limits and does not claim signing", async () => {
  const input = await flatPlan();
  const invalid = { ...input.plan, chunks: [{ ...input.plan.chunks[0], offset: 1 }] };
  const result = await prepareEthereumKeelHoldOperations({ ...input, plan: invalid, target, codecs });
  assert.equal(result.status, "deferred");
  assert.match(result.issues[0], /ordered|contiguous/u);
  assert.equal(Object.hasOwn(result, "signature"), false);
});

test("Ethereum adapter derives nested composite IDs with accumulated stored lengths", async () => {
  const values = ["a", "b", "c"].map((value) => utf8ToBytes(value));
  const chunks = {};
  const objects = [];
  for (let index = 0; index < values.length; index += 1) {
    const file = `objects/leaf-${String(index).padStart(5, "0")}/chunks/00000.bin`;
    chunks[file] = values[index];
    objects.push({
      id: `leaf-${String(index).padStart(5, "0")}`,
      kind: "leaf",
      level: 0,
      byteOffset: index,
      byteLength: 1,
      storedByteLength: 1,
      mediaType: "text/plain",
      compression: "none",
      integrity: await createIntegrity(values[index]),
      chunks: [{ index: 0, offset: 0, byteLength: 1, integrity: await createIntegrity(values[index]), file }],
    });
  }
  const ab = utf8ToBytes("ab");
  const abc = utf8ToBytes("abc");
  // Deliberately provide composites in reverse dependency order. The adapter
  // must emit child IDs before parent IDs rather than trusting input order.
  objects.push({ id: "node-002-00000", kind: "composite", level: 2, byteOffset: 0, byteLength: 3, mediaType: "text/plain", integrity: await createIntegrity(abc), parts: ["node-001-00000", "leaf-00002"] });
  objects.push({ id: "node-001-00000", kind: "composite", level: 1, byteOffset: 0, byteLength: 2, mediaType: "text/plain", integrity: await createIntegrity(ab), parts: ["leaf-00000", "leaf-00001"] });
  const plan = {
    schema: "oca-recursive-upload-plan@2", indexEncoding: "oca-object-index@1", objectName: "nested", mediaType: "text/plain",
    byteLength: 3, integrity: await createIntegrity(abc), root: "node-002-00000", treeDepth: 2, leafDecodedBytes: 4096,
    maxChunkBytes: 23000, maxPartsPerComposite: 2, maxChildren: 128, objects,
  };
  const result = await prepareEthereumKeelHoldOperations({ plan, chunks, target, codecs });
  assert.equal(result.status, "ready-for-review");
  const compositeCalls = result.operations.filter((item) => item.kind === "weldComposite");
  assert.equal(compositeCalls.length, 2);
  assert.equal(compositeCalls[0].args[2], 2);
  assert.equal(compositeCalls[1].args[2], 3);
  assert.equal(compositeCalls[0].objectId, "0x0e52b071d1cc6f50aab5d5c2660640663e943266425d1b649737a9c1f6786483");
  assert.equal(compositeCalls[1].objectId, "0xcc1d795a46f5ba24d46afcf55a0400df6f6342fa4e8c14830851af2121c99479");
});

test("Viem codec wiring matches the KeelHold golden calldata and IDs", async () => {
  const bytes = Uint8Array.from([0x00, 0x01, 0x02, 0xff]);
  const committed = await createIntegrity(bytes);
  const plan = {
    schema: "oca-upload-plan@2",
    indexEncoding: "oca-object-index@1",
    objectName: "golden",
    mediaType: "text/plain",
    originalByteLength: 4,
    storedByteLength: 4,
    compression: "none",
    integrity: committed,
    maxChildren: 128,
    chunks: [{ index: 0, offset: 0, byteLength: 4, integrity: committed, file: "chunks/00000.bin" }],
  };
  const result = await prepareEthereumKeelHoldOperations({
    plan,
    chunks: { "chunks/00000.bin": bytes },
    target,
    codecs: createViemEthereumAdapterCodecs(),
  });
  assert.equal(result.status, "ready-for-review");
  assert.equal(result.operations[0].data, "0x0d1ff9e20000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000004000102ff00000000000000000000000000000000000000000000000000000000");
  assert.equal(result.operations[0].args[0][0], "0x000102ff");
  assert.equal(result.operations[1].data, "0xb17463a800000000000000000000000000000000000000000000000000000000000000a03d1f57c984978ef98a18378c8166c1cb8ede02c03eeb6aee7e2f121dfeee3e560000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000000000001f746f73a429e97e187d63bdf24be339478da1a3bdde9565e15d5ad9462ddee82000000000000000000000000000000000000000000000000000000000000000a746578742f706c61696e00000000000000000000000000000000000000000000");
  assert.equal(result.operations[1].objectId, "0x880a5449897fe99d5d69db1a07d6614212f3553cb38d869530293ad0b38df789");
});

test("Ethereum adapter enforces contract media and recursive root invariants", async () => {
  const input = await flatPlan("x");
  const oversizedMedia = await prepareEthereumKeelHoldOperations({
    ...input,
    plan: { ...input.plan, mediaType: "é".repeat(65) },
    target,
    codecs,
  });
  assert.equal(oversizedMedia.status, "deferred");
  assert.match(oversizedMedia.issues[0], /UTF-8 byte limit/u);

  const bytes = utf8ToBytes("x");
  const committed = await createIntegrity(bytes);
  const recursive = {
    schema: "oca-recursive-upload-plan@2",
    indexEncoding: "oca-object-index@1",
    objectName: "root",
    mediaType: "text/plain",
    byteLength: 1,
    integrity: committed,
    root: "leaf",
    treeDepth: 0,
    leafDecodedBytes: 4096,
    maxChunkBytes: 23000,
    maxPartsPerComposite: 2,
    maxChildren: 128,
    objects: [{
      id: "leaf", kind: "leaf", level: 0, byteOffset: 1, byteLength: 1, storedByteLength: 1,
      mediaType: "text/plain", compression: "none", integrity: committed,
      chunks: [{ index: 0, offset: 0, byteLength: 1, integrity: committed, file: "leaf.bin" }],
    }],
  };
  const badRoot = await prepareEthereumKeelHoldOperations({ plan: recursive, chunks: { "leaf.bin": bytes }, target, codecs });
  assert.equal(badRoot.status, "deferred");
  assert.match(badRoot.issues[0], /root does not match|offset/u);
  const badLeafLength = await prepareEthereumKeelHoldOperations({
    plan: { ...recursive, objects: [{ ...recursive.objects[0], byteOffset: 0, byteLength: 999 }] },
    chunks: { "leaf.bin": bytes },
    target,
    codecs,
  });
  assert.equal(badLeafLength.status, "deferred");
  assert.match(badLeafLength.issues[0], /integrity\.byteLength|decoded bytes|byteLength/u);
});
