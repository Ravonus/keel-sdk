import assert from "node:assert/strict";
import test from "node:test";

import { parseKeelFrozenDatasetManifest } from "../packages/protocol/dist/index.js";
import { buildKeelFrozenDataset } from "../packages/sdk/dist/index.js";
import {
  createMemoryKeelFrozenDatasetCache,
  planKeelFrozenDatasetQuery,
  queryKeelFrozenDataset,
} from "../packages/viewer/dist/index.js";

async function weatherDataset(revision = 1) {
  return buildKeelFrozenDataset({
    datasetId: "weather-history-denver",
    revision,
    ...(revision > 1 ? { parentRevision: revision - 1 } : {}),
    visibility: "closed",
    pagination: "mixed",
    targetRows: 2,
    batches: [{
      page: 1,
      cursorOut: "secret-cursor-two",
      rows: [
        { station: "DEN", temperature: 10, condition: "light snow" },
        { station: "DEN", temperature: 12, condition: "clear" },
      ],
    }, {
      page: 2,
      cursorIn: "secret-cursor-two",
      cursorOut: "secret-cursor-three",
      rows: [
        { station: "COS", temperature: 30, condition: "dry" },
        { station: "PUB", temperature: 35, condition: "dry wind" },
      ],
    }],
    locations: (hash) => [`https://data.example/chunks/${hash}.json`],
  });
}

test("frozen dataset builder preserves full rows while pagination remains hashed provenance", async () => {
  const built = await weatherDataset();
  const parsed = parseKeelFrozenDatasetManifest(built.manifest);
  assert.equal(parsed.frozen, true);
  assert.equal(parsed.rowCount, 4);
  assert.equal(parsed.chunks.length, 2);
  assert.deepEqual(parsed.chunks.map((chunk) => [chunk.rowStart, chunk.rowCount]), [[0, 2], [2, 2]]);
  assert.ok(parsed.chunks.every((chunk) => chunk.contentHash === chunk.integrity.digest));
  assert.ok(parsed.fields.some((field) => field.path === "/temperature" && field.type === "number"));
  assert.doesNotMatch(new TextDecoder().decode(built.manifestBytes), /secret-cursor/u);
  assert.match(parsed.chunks[1].sourceSpans[0].cursorInDigest, /^0x[0-9a-f]{64}$/u);
});

test("viewer planner skips only chunks proven irrelevant, then verifies and caches selected chunks", async () => {
  const built = await weatherDataset();
  const query = {
    where: [{ path: "/temperature", op: "gte", value: 30 }],
    sort: [{ path: "/temperature", direction: "desc" }],
    select: ["/station", "/temperature"],
  };
  const plan = planKeelFrozenDatasetQuery(built.manifest, query);
  assert.deepEqual(plan.load.map((chunk) => chunk.ordinal), [1]);
  assert.deepEqual(plan.skip.map((chunk) => chunk.ordinal), [0]);

  const cache = createMemoryKeelFrozenDatasetCache();
  let loads = 0;
  const loadChunk = async (descriptor) => {
    loads += 1;
    return built.chunks[descriptor.ordinal].bytes;
  };
  const first = await queryKeelFrozenDataset(built.manifest, query, { cache, loadChunk });
  const second = await queryKeelFrozenDataset(built.manifest, query, { cache, loadChunk });
  assert.equal(loads, 1);
  assert.equal(first.totalMatched, 2);
  assert.deepEqual(first.rows, [
    { "/station": "PUB", "/temperature": 35 },
    { "/station": "COS", "/temperature": 30 },
  ]);
  assert.deepEqual(second.rows, first.rows);
  assert.equal(first.loadedChunkHashes.length, 1);
  assert.equal(first.skippedChunkHashes.length, 1);
});

test("search scans unknown shapes and a new revision cannot reuse stale revision bytes", async () => {
  const first = await weatherDataset(1);
  const second = await weatherDataset(2);
  const cache = createMemoryKeelFrozenDatasetCache();
  let loads = 0;
  await queryKeelFrozenDataset(first.manifest, { search: "snow" }, {
    cache,
    loadChunk: async (descriptor) => {
      loads += 1;
      return first.chunks[descriptor.ordinal].bytes;
    },
  });
  const result = await queryKeelFrozenDataset(second.manifest, { search: "wind" }, {
    cache,
    loadChunk: async (descriptor) => {
      loads += 1;
      return second.chunks[descriptor.ordinal].bytes;
    },
  });
  assert.equal(loads, 4);
  assert.equal(result.totalMatched, 1);
  assert.equal(result.rows[0].station, "PUB");
});

test("viewer rejects bytes that do not match the manifest hash", async () => {
  const built = await weatherDataset();
  await assert.rejects(
    queryKeelFrozenDataset(built.manifest, {}, {
      loadChunk: async () => new TextEncoder().encode('{"rows":[]}'),
    }),
    /failed SHA-256 verification/u,
  );
});

test("planner never prunes inequality rows when a field can be absent", async () => {
  const built = await buildKeelFrozenDataset({
    datasetId: "sparse",
    revision: 1,
    targetRows: 10,
    batches: [{ rows: [{ status: "open" }, { id: 2 }] }],
  });
  const query = { where: [{ path: "/status", op: "neq", value: "open" }] };
  assert.deepEqual(planKeelFrozenDatasetQuery(built.manifest, query).load.map((chunk) => chunk.ordinal), [0]);
  const result = await queryKeelFrozenDataset(built.manifest, query, {
    loadChunk: async (descriptor) => built.chunks[descriptor.ordinal].bytes,
  });
  assert.deepEqual(result.rows, [{ id: 2 }]);
});
