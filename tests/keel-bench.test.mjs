import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  assembleHistoricalKeelViewer,
  buildHistoricalKeelCommitmentChain,
  composeHistoricalKeelViewer,
  createKeelAuthorityTimeline,
  ingestHistoricalKeelObject,
  measureHistoricalKeelDedupe,
} from "../packages/studio-core/dist/index.js";

const corpusDirectory = path.resolve("examples/keel");
const encoder = new TextEncoder();

function address(value) {
  return `0x${value.toString(16).padStart(40, "0")}`;
}

test("historical Keel bench exposes exact B85 stages, uint48 indexing, assembly, commitments, and dedupe", async () => {
  const startSource = new Uint8Array(await readFile(path.join(corpusDirectory, "b85", "start.b85")));
  const start = await ingestHistoricalKeelObject({
    id: 1,
    name: "start",
    mediaType: "application/javascript",
    sourceBytes: startSource,
    encoding: "base85",
    wrapper: "auto",
    compression: "brotli",
  });
  const raw = await ingestHistoricalKeelObject({
    id: 2,
    name: "raw-tail",
    mediaType: "application/javascript",
    sourceBytes: encoder.encode("globalThis.__KEEL_TAIL__=true;"),
    encoding: "raw",
    compression: "none",
  });

  assert.equal(start.model.wrapper, "legacy-b85-tag");
  assert.equal(start.model.stages.source.byteLength, 1_511);
  assert.equal(start.model.stages.base85Payload?.byteLength, 1_500);
  assert.equal(start.model.stages.stored.byteLength, 1_200);
  assert.equal(start.model.stages.resolved.byteLength, 4_857);
  assert.equal(start.model.base85?.canonicalReencode, true);
  assert.equal(start.model.chunks.length, 1);
  assert.equal(start.model.chunks[0]?.byteLength, 1_200);

  const composition = await composeHistoricalKeelViewer({
    name: "comet-reference",
    objects: [start, raw, start, raw, start, raw],
  });
  assert.deepEqual(composition.slots.map((slot) => slot.objectId), ["1", "2", "1", "2", "1", "2"]);
  assert.deepEqual(composition.packedUint48Words.map((word) => word.objectIds), [
    ["1", "2", "1", "2", "1"],
    ["2"],
  ]);
  assert.deepEqual(composition.packedUint48Words.map((word) => word.viewerWord), [2, 3]);
  assert.equal(composition.packing.legacyMetadataWordCount, 2);
  assert.equal(
    composition.packedUint48Words[0]?.value,
    (1n | (2n << 48n) | (1n << 96n) | (2n << 144n) | (1n << 192n)).toString(),
  );

  const assembly = await assembleHistoricalKeelViewer({
    composition,
    blockNumber: "19000000",
    timestamp: "1710000000",
  });
  assert.match(assembly.html, /19000000/u);
  assert.match(assembly.html, /1710000000/u);
  assert.ok(assembly.html.includes("globalThis.__KEEL_CHAIN__"));
  assert.deepEqual(assembly.viewerData, ["1710000000"]);
  assert.equal(assembly.verified, true);

  const commitmentChain = await buildHistoricalKeelCommitmentChain({
    composition,
    assembly,
  });
  assert.equal(commitmentChain.verified, true);
  assert.equal(commitmentChain.registry.status, "not-published");
  assert.equal(commitmentChain.objectStages.filter((entry) => entry.verified).length, 2);

  const dedupe = measureHistoricalKeelDedupe({
    tokenCompositions: [
      { tokenId: "1", composition },
      { tokenId: "2", composition },
    ],
  });
  assert.equal(dedupe.uniqueChunkBytes, start.model.stages.stored.byteLength + raw.model.stages.stored.byteLength);
  assert.equal(dedupe.naiveReferencedChunkBytes, dedupe.uniqueChunkBytes * 6);
  assert.ok(dedupe.bytesSaved > 0);

  const authority = createKeelAuthorityTimeline({
    earlyTestLedgerEoa: address(1),
    multisig: { address: address(2) },
  });
  assert.equal(authority.earlyTest.signer.kind, "hardware-wallet-eoa-declared");
  assert.equal(authority.earlyTest.signer.onchainCode, "not-checked");
  assert.equal(authority.earlyTest.signer.description, "Caller-declared Ledger hardware-wallet EOA");
  assert.equal(authority.handoff.target.kind, "onchain-multisig");
  assert.equal(authority.handoff.status, "planned");
});

test("historical Keel bench records a handoff only from a separately verified on-chain record", async () => {
  const verified = createKeelAuthorityTimeline({
    earlyTestLedgerEoa: address(1),
    multisig: { address: address(2) },
    verifiedOnchainHandoff: {
      schema: "keel-onchain-handoff-verification@1",
      verified: true,
      chainId: 31_337,
      transactionHash: `0x${"ab".repeat(32)}`,
      blockNumber: "42",
      multisig: address(2),
      authority: "DEFAULT_ADMIN_ROLE",
      verifier: "role-readback",
    },
  });
  assert.equal(verified.handoff.status, "verified-onchain");
  assert.equal(verified.handoff.verification?.transactionHash, `0x${"ab".repeat(32)}`);
  assert.equal(verified.handoff.target.address, address(2));

  assert.throws(() => createKeelAuthorityTimeline({
    earlyTestLedgerEoa: address(1),
    multisig: { address: address(2) },
    verifiedOnchainHandoff: {
      schema: "keel-onchain-handoff-verification@1",
      verified: true,
      chainId: 31_337,
      transactionHash: "0x1234",
      blockNumber: "42",
      multisig: address(2),
      authority: "DEFAULT_ADMIN_ROLE",
      verifier: "role-readback",
    },
  }), /transactionHash/u);
});

test("historical Keel bench accepts binary raw ingest without UTF-8 coercion and rejects unrepresentable IDs", async () => {
  const binary = await ingestHistoricalKeelObject({
    id: 3,
    name: "binary-fixture",
    mediaType: "image/png",
    sourceBytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff]),
    encoding: "raw",
    compression: "none",
  });
  assert.equal(binary.model.inspection.contentKind, "binary");
  assert.equal(binary.model.inspection.utf8Validated, false);

  await assert.rejects(
    () => ingestHistoricalKeelObject({
      id: 1n << 48n,
      name: "too-large",
      mediaType: "application/javascript",
      sourceBytes: encoder.encode("x"),
      encoding: "raw",
      compression: "none",
    }),
    /uint48/u,
  );
});

test("historical Keel bench ingests all 19 preserved corpus artifacts through its staged model", async () => {
  const corpus = JSON.parse(await readFile(path.join(corpusDirectory, "corpus.json"), "utf8"));
  const objects = await Promise.all(
    corpus.artifacts.map(async (artifact, index) => ingestHistoricalKeelObject({
      id: index + 1,
      name: artifact.name,
      mediaType: artifact.mediaType,
      sourceBytes: new Uint8Array(await readFile(path.join(corpusDirectory, artifact.sourceFile))),
      encoding: "base85",
      wrapper: artifact.wrapper,
      compression: artifact.compression,
    })),
  );

  assert.equal(objects.length, 19);
  assert.ok(objects.every((object) => object.model.base85?.canonicalReencode === true));
  assert.ok(objects.every((object) => object.model.base85?.byteRoundTripVerified === true));
  assert.ok(objects.every((object) => object.model.inspection.utf8Validated));
  assert.deepEqual(
    objects.map((object) => object.model.stages.source.byteLength).reduce((sum, value) => sum + value, 0),
    corpus.totals.sourceBytes,
  );
  assert.deepEqual(
    objects.map((object) => object.model.stages.stored.byteLength).reduce((sum, value) => sum + value, 0),
    corpus.totals.decodedBytes,
  );
  assert.deepEqual(
    objects.map((object) => object.model.stages.resolved.byteLength).reduce((sum, value) => sum + value, 0),
    corpus.totals.decompressedBytes,
  );
  const start = objects.find((object) => object.model.name === "start");
  assert.equal(start?.model.wrapper, "legacy-b85-tag");
  assert.equal(start?.model.stages.base85Payload?.byteLength, 1_500);
});
