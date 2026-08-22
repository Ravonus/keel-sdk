import assert from "node:assert/strict";
import test from "node:test";

import { buildKeelFrozenDataset } from "../packages/sdk/dist/index.js";
import {
  assertKeelFrozenDatasetWithinLimits,
  queryKeelFrozenDataset,
} from "../packages/viewer/dist/index.js";

async function weatherDataset() {
  return buildKeelFrozenDataset({
    datasetId: "weather-history-denver",
    revision: 1,
    visibility: "closed",
    pagination: "mixed",
    targetRows: 2,
    batches: [
      { page: 1, cursorOut: "c2", rows: [{ station: "DEN", temperature: 10 }, { station: "DEN", temperature: 12 }] },
      { page: 2, cursorIn: "c2", rows: [{ station: "COS", temperature: 30 }, { station: "PUB", temperature: 35 }] },
    ],
    locations: (hash) => [`https://data.example/chunks/${hash}.json`],
  });
}

test("assertKeelFrozenDatasetWithinLimits accepts a dataset under the defaults", async () => {
  const built = await weatherDataset();
  assert.doesNotThrow(() => assertKeelFrozenDatasetWithinLimits(built.manifest));
});

test("assertKeelFrozenDatasetWithinLimits rejects too many chunks", async () => {
  const built = await weatherDataset();
  assert.throws(() => assertKeelFrozenDatasetWithinLimits(built.manifest, { maxChunks: 1 }), /maxChunks/);
});

test("assertKeelFrozenDatasetWithinLimits rejects too many rows", async () => {
  const built = await weatherDataset();
  assert.throws(() => assertKeelFrozenDatasetWithinLimits(built.manifest, { maxRows: 1 }), /maxRows/);
});

test("assertKeelFrozenDatasetWithinLimits rejects an oversize chunk and oversize aggregate", async () => {
  const built = await weatherDataset();
  assert.throws(() => assertKeelFrozenDatasetWithinLimits(built.manifest, { maxChunkBytes: 1 }), /maxChunkBytes/);
  assert.throws(() => assertKeelFrozenDatasetWithinLimits(built.manifest, { maxTotalBytes: 1 }), /maxTotalBytes/);
});

test("queryKeelFrozenDataset enforces limits before fetching any chunk", async () => {
  const built = await weatherDataset();
  let loads = 0;
  const loadChunk = async (descriptor) => {
    loads += 1;
    return built.chunks[descriptor.ordinal].bytes;
  };
  await assert.rejects(
    () => queryKeelFrozenDataset(built.manifest, {}, { loadChunk, limits: { maxChunks: 1 } }),
    /maxChunks/,
  );
  assert.equal(loads, 0); // rejected up front, nothing fetched
});

test("queryKeelFrozenDataset binds the manifest to a committed digest when provided", async () => {
  const built = await weatherDataset();
  const loadChunk = async (descriptor) => built.chunks[descriptor.ordinal].bytes;

  // Correct committed digest: passes.
  const ok = await queryKeelFrozenDataset(built.manifest, {}, {
    loadChunk,
    expectedManifestIntegrity: built.manifestIntegrity,
  });
  assert.equal(ok.totalMatched, 4);

  // Wrong committed digest: rejected before any chunk is trusted.
  const wrong = { algorithm: "sha256", digest: `0x${"00".repeat(32)}`, byteLength: built.manifestIntegrity.byteLength };
  await assert.rejects(
    () => queryKeelFrozenDataset(built.manifest, {}, { loadChunk, expectedManifestIntegrity: wrong }),
    /failed integrity verification/,
  );
});

test("a manifest tampered after commitment fails the anchor check", async () => {
  const built = await weatherDataset();
  const loadChunk = async (descriptor) => built.chunks[descriptor.ordinal].bytes;
  // Tamper: swap the declared rowCount total. The committed digest no longer matches.
  const tampered = { ...built.manifest, rowCount: 3 };
  await assert.rejects(
    () => queryKeelFrozenDataset(tampered, {}, { loadChunk, expectedManifestIntegrity: built.manifestIntegrity }),
    /failed integrity verification|rowCount/,
  );
});
