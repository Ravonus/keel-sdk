import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  bytesToHex,
  decodeOrdinalsPortableCommitmentV1,
  decodePortableAnchorV1,
  decodePortableGraphV1,
  decodePortableManifestV1,
  ethereumPortableSourceNetworkV1,
  encodeOrdinalsPortableCommitmentV1,
  encodePortableAnchorV1,
  encodePortableGraphV1,
  encodePortableManifestV1,
  hexToBytes,
  ordinalsTargetDigestV1,
  PORTABLE_CHUNK_BYTES,
  PORTABLE_MAX_DECODED_BYTES,
  portableAnchorRootV1,
  portableChunkRootV1,
  portableContentCommitmentsV1,
  portableGraphRootV1,
  portableRootV1,
  portableSourceNetworkFromBytesV1,
  utf8ToBytes,
  verifyPortableContentV1,
  verifyPortableGraphTreeV1,
} from "../packages/protocol/dist/index.js";

const vector = JSON.parse(await readFile(new URL("./fixtures/portable-root-v1.json", import.meta.url), "utf8"));
const recursionVector = JSON.parse(await readFile(new URL("./fixtures/portable-recursion-v1.json", import.meta.url), "utf8"));
const manifest = {
  ...vector.manifest,
  decodedByteLength: BigInt(vector.manifest.decodedByteLength),
  revision: BigInt(vector.manifest.revision),
};
const anchor = { ...vector.anchor, sourceRevision: BigInt(vector.anchor.sourceRevision) };
const strp = { ...vector.strp, revision: BigInt(vector.strp.revision) };

test("portable manifest v1 matches the cross-language golden vector", async () => {
  const bytes = encodePortableManifestV1(manifest);
  assert.equal(bytesToHex(bytes), vector.manifestBytesHex);
  assert.equal(await portableRootV1(bytes), vector.portableRoot);
  assert.deepEqual(decodePortableManifestV1(bytes), manifest);
});

test("portable manifest decoder fails closed on non-canonical and unsupported bytes", () => {
  const bytes = hexToBytes(vector.manifestBytesHex);
  assert.throws(() => decodePortableManifestV1(bytes.slice(0, -1)), /Truncated/);
  assert.throws(() => decodePortableManifestV1(Uint8Array.from([...bytes, 0])), /Trailing/);
  const wrongDomain = bytes.slice();
  wrongDomain[0] ^= 1;
  assert.throws(() => decodePortableManifestV1(wrongDomain), /domain/);
  const wrongKind = bytes.slice();
  wrongKind[23] = 255;
  assert.throws(() => decodePortableManifestV1(wrongKind), /resource kind/);
  const wrongCompression = bytes.slice();
  wrongCompression[24] = 255;
  assert.throws(() => decodePortableManifestV1(wrongCompression), /compression/);
  const wrongBoolean = bytes.slice();
  wrongBoolean[wrongBoolean.length - 1] = 2;
  assert.throws(() => decodePortableManifestV1(wrongBoolean), /canonical 0 or 1/);
  assert.throws(() => encodePortableManifestV1({ ...manifest, mediaType: "image/svg+xml" }), /media type/);
  assert.throws(() => encodePortableManifestV1({ ...manifest, revision: 1n << 64n }), /64-bit/);
});

test("portable anchor v1 binds source family, network, registry, object, revision, and event", async () => {
  const bytes = encodePortableAnchorV1(anchor);
  assert.equal(bytesToHex(bytes), vector.anchorBytesHex);
  assert.deepEqual(decodePortableAnchorV1(bytes), anchor);
  assert.equal(await portableAnchorRootV1(anchor), vector.anchorRoot);
  assert.notEqual(await portableAnchorRootV1({ ...anchor, sourceNetwork: 1 }), vector.anchorRoot);
  assert.notEqual(await portableAnchorRootV1({ ...anchor, sourceFamily: 2 }), vector.anchorRoot);
  assert.notEqual(await portableAnchorRootV1({ ...anchor, sourceRevision: 8n }), vector.anchorRoot);
  assert.throws(() => decodePortableAnchorV1(Uint8Array.from([...bytes, 0])), /Trailing/);
});

test("portable source networks use canonical Ethereum or four-byte chain identifiers", () => {
  assert.equal(ethereumPortableSourceNetworkV1(11_155_111), vector.anchor.sourceNetwork);
  assert.equal(ethereumPortableSourceNetworkV1(11_155_111n), vector.anchor.sourceNetwork);
  assert.equal(portableSourceNetworkFromBytesV1(Uint8Array.of(0x00, 0xaa, 0x36, 0xa7)), 11_155_111);
  assert.throws(() => ethereumPortableSourceNetworkV1(1n << 32n), /must fit/);
  assert.throws(() => portableSourceNetworkFromBytesV1(Uint8Array.of(1, 2, 3)), /exactly four/);
});

test("STRP v1 is a fixed 66-byte transaction-output commitment", () => {
  const bytes = encodeOrdinalsPortableCommitmentV1(strp);
  assert.equal(bytes.length, 66);
  assert.equal(bytesToHex(bytes), vector.strpBytesHex);
  assert.deepEqual(decodeOrdinalsPortableCommitmentV1(bytes), strp);
  const wrongVersion = bytes.slice();
  wrongVersion[4] = 2;
  assert.throws(() => decodeOrdinalsPortableCommitmentV1(wrongVersion), /version/);
  const wrongFlags = bytes.slice();
  wrongFlags[5] = 1;
  assert.throws(() => decodeOrdinalsPortableCommitmentV1(wrongFlags), /flags/);
  assert.throws(() => decodeOrdinalsPortableCommitmentV1(Uint8Array.from([...bytes, 0])), /Trailing/);
});

test("Ordinals target digest is derived from the complete chain anchor", async () => {
  assert.equal(await ordinalsTargetDigestV1(vector.anchorRoot), strp.targetDigest);
  assert.notEqual(
    await ordinalsTargetDigestV1(`0x${"00".repeat(32)}`),
    strp.targetDigest,
  );
});

test("portable roots commit every manifest field", async () => {
  const root = await portableRootV1(manifest);
  const mutations = [
    { ...manifest, decodedByteLength: manifest.decodedByteLength + 1n },
    { ...manifest, revision: manifest.revision + 1n },
    { ...manifest, frozen: true },
    { ...manifest, editPolicy: 2 },
    { ...manifest, controllerId: `0x${"99".repeat(32)}` },
  ];
  for (const mutation of mutations) assert.notEqual(await portableRootV1(mutation), root);
});

test("portable chunk tree is fixed-boundary, ordered, recursive, and carrier-neutral", async () => {
  const bytes = Uint8Array.from(
    { length: recursionVector.chunk.decodedByteLength },
    (_, index) => (index * 31 + Math.floor(index / PORTABLE_CHUNK_BYTES) * 17 + 7) & 255,
  );
  const commitments = await portableContentCommitmentsV1(bytes);
  assert.equal(commitments.decodedByteLength, BigInt(bytes.length));
  assert.equal(commitments.chunkRoot, await portableChunkRootV1(bytes));
  assert.equal(PORTABLE_CHUNK_BYTES, recursionVector.chunk.chunkBytes);
  assert.equal(commitments.chunkRoot, recursionVector.chunk.chunkRoot);
  assert.equal(commitments.decodedSha256, recursionVector.chunk.decodedSha256);
  assert.equal(await portableChunkRootV1(new Uint8Array()), recursionVector.chunk.emptyRoot);

  const mutated = bytes.slice();
  mutated[PORTABLE_CHUNK_BYTES] ^= 1;
  assert.notEqual(await portableChunkRootV1(mutated), commitments.chunkRoot);
  const reordered = new Uint8Array(bytes.length);
  reordered.set(bytes.subarray(PORTABLE_CHUNK_BYTES, PORTABLE_CHUNK_BYTES * 2), 0);
  reordered.set(bytes.subarray(0, PORTABLE_CHUNK_BYTES), PORTABLE_CHUNK_BYTES);
  reordered.set(bytes.subarray(PORTABLE_CHUNK_BYTES * 2), PORTABLE_CHUNK_BYTES * 2);
  assert.notEqual(await portableChunkRootV1(reordered), commitments.chunkRoot);
});

test("portable content commitments reject oversized input before hashing", async () => {
  class ReportedOversizedBytes extends Uint8Array {
    get byteLength() { return PORTABLE_MAX_DECODED_BYTES + 1; }
  }
  await assert.rejects(
    () => portableContentCommitmentsV1(new ReportedOversizedBytes(1)),
    new RegExp(`decodedBytes exceeds ${PORTABLE_MAX_DECODED_BYTES} bytes`),
  );
});

test("portable graph canonically maps paths to recursive child roots", async () => {
  const graph = recursionVector.graph;
  const encoded = encodePortableGraphV1(graph);
  assert.equal(bytesToHex(encoded), recursionVector.graph.encodedHex);
  const decoded = decodePortableGraphV1(encoded);
  assert.deepEqual(decoded.entries.map((entry) => entry.path), ["game.js", "index.html", "sprites/orb.webp"]);
  assert.equal(await portableGraphRootV1(encoded), recursionVector.graph.root);
  assert.equal(await portableGraphRootV1(graph), await portableGraphRootV1(encoded));
  assert.notEqual(
    await portableGraphRootV1({
      ...graph,
      entries: graph.entries.map((entry) => entry.path === "game.js" ? { ...entry, portableRoot: `0x${"44".repeat(32)}` } : entry),
    }),
    await portableGraphRootV1(graph),
  );
  assert.throws(() => encodePortableGraphV1({ ...graph, entries: [...graph.entries, graph.entries[0]] }), /Duplicate/);
  assert.throws(() => encodePortableGraphV1({ ...graph, entrypoint: "../index.html" }), /canonical relative ASCII path/);
  assert.throws(
    () => encodePortableGraphV1({ ...graph, entries: graph.entries.map((entry) => entry.path === "index.html" ? { ...entry, executable: false } : entry) }),
    /executable Entrypoint/,
  );
});

test("portable resolver verifies manifests, decoded triples, children, and global limits end to end", async () => {
  const objects = new Map(recursionVector.objects.map((entry) => [entry.portableRoot, {
    manifestBytes: hexToBytes(entry.manifestBytesHex),
    decodedBytes: hexToBytes(entry.decodedHex),
  }]));
  for (const [root, entry] of objects) {
    assert.equal(await portableRootV1(entry.manifestBytes), root);
    await verifyPortableContentV1(decodePortableManifestV1(entry.manifestBytes), entry.decodedBytes);
  }
  const loader = {
    async loadManifest(root) { return objects.get(root)?.manifestBytes ?? new Uint8Array(); },
    async loadDecoded(root) { return objects.get(root)?.decodedBytes ?? new Uint8Array(); },
  };
  const receipt = await verifyPortableGraphTreeV1(recursionVector.rootPortableRoot, loader);
  const totalDecodedBytes = recursionVector.objects.reduce(
    (total, entry) => total + BigInt(hexToBytes(entry.decodedHex).length),
    0n,
  );
  assert.deepEqual(
    { objectCount: receipt.objectCount, graphCount: receipt.graphCount, totalDecodedBytes: receipt.totalDecodedBytes },
    { objectCount: 4, graphCount: 1, totalDecodedBytes },
  );
  assert.deepEqual(new Set(receipt.verifiedRoots), new Set(recursionVector.objects.map((entry) => entry.portableRoot)));

  const atlasRoot = recursionVector.objects.find((entry) => entry.name === "atlas").portableRoot;
  const corruptedLoader = {
    ...loader,
    async loadDecoded(root) {
      const bytes = await loader.loadDecoded(root);
      if (root !== atlasRoot) return bytes;
      const corrupted = bytes.slice(); corrupted[0] ^= 1; return corrupted;
    },
  };
  await assert.rejects(() => verifyPortableGraphTreeV1(recursionVector.rootPortableRoot, corruptedLoader), /SHA-256/);
  const missingChildLoader = {
    ...loader,
    async loadManifest(root) {
      if (root === atlasRoot) return new Uint8Array();
      return loader.loadManifest(root);
    },
  };
  await assert.rejects(
    () => verifyPortableGraphTreeV1(recursionVector.rootPortableRoot, missingChildLoader),
    /Truncated|domain|portable manifest/u,
  );
  const substitutedRoot = recursionVector.objects.find((entry) => entry.name !== "atlas").portableRoot;
  const substitutedChildLoader = {
    ...loader,
    async loadManifest(root) {
      if (root === atlasRoot) return loader.loadManifest(substitutedRoot);
      return loader.loadManifest(root);
    },
  };
  await assert.rejects(
    () => verifyPortableGraphTreeV1(recursionVector.rootPortableRoot, substitutedChildLoader),
    /do not match the requested root/u,
  );
  await assert.rejects(() => verifyPortableGraphTreeV1(recursionVector.rootPortableRoot, loader, { maxObjects: 2 }), /exceeds 2 objects/);
  await assert.rejects(() => verifyPortableGraphTreeV1(recursionVector.rootPortableRoot, loader, { maxTotalDecodedBytes: 32 }), /total decoded bytes/);
});

test("portable resolver enforces depth on every DAG path including cached children", async () => {
  const zero = `0x${"00".repeat(32)}`;
  async function object(resourceKind, mediaType, decodedBytes, lineageByte) {
    const commitments = await portableContentCommitmentsV1(decodedBytes);
    const manifestBytes = encodePortableManifestV1({
      resourceKind,
      compression: 0,
      mediaType,
      ...commitments,
      metadataSha256: zero,
      lineageId: `0x${lineageByte.repeat(32)}`,
      revision: 1n,
      parentPortableRoot: zero,
      editPolicy: 0,
      controllerId: zero,
      frozen: true,
    });
    return { manifestBytes, decodedBytes, root: await portableRootV1(manifestBytes) };
  }

  const shared = await object(0, "text/html", utf8ToBytes("shared child"), "55");
  const branchBytes = encodePortableGraphV1({
    entrypoint: "shared.html",
    entries: [{ path: "shared.html", portableRoot: shared.root, role: 0, executable: true }],
  });
  const branch = await object(9, "application/octet-stream", branchBytes, "66");
  const rootBytes = encodePortableGraphV1({
    entrypoint: "a-shared.html",
    entries: [
      { path: "a-shared.html", portableRoot: shared.root, role: 0, executable: true },
      { path: "z-branch.bin", portableRoot: branch.root, role: 5, executable: false },
    ],
  });
  const root = await object(9, "application/octet-stream", rootBytes, "77");
  const objects = new Map([shared, branch, root].map((entry) => [entry.root, entry]));
  const loader = {
    async loadManifest(portableRoot) { return objects.get(portableRoot)?.manifestBytes ?? new Uint8Array(); },
    async loadDecoded(portableRoot) { return objects.get(portableRoot)?.decodedBytes ?? new Uint8Array(); },
  };
  await assert.rejects(() => verifyPortableGraphTreeV1(root.root, loader, { maxDepth: 1 }), /recursion exceeds 1/);
  await verifyPortableGraphTreeV1(root.root, loader, { maxDepth: 2 });
});

test("Vault deploy top roots recurse into map children and weapon grandchildren and reject omission or substitution", async () => {
  const zero = `0x${"00".repeat(32)}`;
  let lineage = 1;
  async function object(resourceKind, mediaType, decodedBytes) {
    const commitments = await portableContentCommitmentsV1(decodedBytes);
    const manifestBytes = encodePortableManifestV1({
      resourceKind,
      compression: 0,
      mediaType,
      ...commitments,
      metadataSha256: zero,
      lineageId: `0x${(lineage++).toString(16).padStart(2, "0").repeat(32)}`,
      revision: 1n,
      parentPortableRoot: zero,
      editPolicy: 0,
      controllerId: zero,
      frozen: true,
    });
    return { manifestBytes, decodedBytes, root: await portableRootV1(manifestBytes) };
  }
  async function graph(entrypoint, entries) {
    return object(9, "application/octet-stream", encodePortableGraphV1({ entrypoint, entries }));
  }

  const viewer = await object(0, "text/html", utf8ToBytes("<main>Vault Orb</main>"));
  const atlas = await object(3, "image/webp", Uint8Array.of(0x52, 0x49, 0x46, 0x46));
  const codex = await object(4, "application/octet-stream", Uint8Array.of(0x53, 0x43, 0x58, 0x31));
  const weapons = await graph("vault-weapons-v1.codex.bin", [
    { path: "vault-weapons-v1.atlas.webp", portableRoot: atlas.root, role: 5, executable: false },
    { path: "vault-weapons-v1.codex.bin", portableRoot: codex.root, role: 0, executable: true },
  ]);
  const character = await graph("viewer.html", [
    { path: "viewer.html", portableRoot: viewer.root, role: 0, executable: true },
    { path: "weapons.graph", portableRoot: weapons.root, role: 5, executable: false },
  ]);
  const mapRuntime = await object(0, "text/html", utf8ToBytes("<main>Vault Map</main>"));
  const mapScript = await object(1, "text/javascript", utf8ToBytes("export const map = 1;"));
  const map = await graph("index.html", [
    { path: "game.js", portableRoot: mapScript.root, role: 1, executable: true },
    { path: "index.html", portableRoot: mapRuntime.root, role: 0, executable: true },
  ]);
  const objects = new Map([viewer, atlas, codex, weapons, character, mapRuntime, mapScript, map].map((entry) => [entry.root, entry]));
  const loader = {
    async loadManifest(root) { return objects.get(root)?.manifestBytes ?? new Uint8Array(); },
    async loadDecoded(root) { return objects.get(root)?.decodedBytes ?? new Uint8Array(); },
  };

  const characterReceipt = await verifyPortableGraphTreeV1(character.root, loader);
  assert.equal(characterReceipt.graphCount, 2);
  assert.equal(characterReceipt.objectCount, 5);
  const mapReceipt = await verifyPortableGraphTreeV1(map.root, loader);
  assert.equal(mapReceipt.graphCount, 1);
  assert.equal(mapReceipt.objectCount, 3);

  await assert.rejects(
    () => verifyPortableGraphTreeV1(character.root, {
      ...loader,
      async loadManifest(root) { return root === atlas.root ? new Uint8Array() : loader.loadManifest(root); },
    }),
    /Truncated|domain|portable manifest/u,
  );
  await assert.rejects(
    () => verifyPortableGraphTreeV1(character.root, {
      ...loader,
      async loadManifest(root) { return root === atlas.root ? codex.manifestBytes : loader.loadManifest(root); },
    }),
    /do not match the requested root/u,
  );
  await assert.rejects(
    () => verifyPortableGraphTreeV1(map.root, {
      ...loader,
      async loadDecoded(root) { return root === mapRuntime.root ? new Uint8Array() : loader.loadDecoded(root); },
    }),
    /byte length|SHA-256/u,
  );
});
