import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { analyzeCost } from "../packages/builder/dist/index.js";

test("cost analysis evaluates deterministic compression candidates and modeled plans", async () => {
  const source = new TextEncoder().encode("keel module payload\n".repeat(400));
  const first = await analyzeCost(source, {
    compression: "auto",
    maxChunkBytes: 128,
    leafDecodedBytes: 512,
    maxPartsPerComposite: 4,
    mediaType: "text/javascript",
  });
  const second = await analyzeCost(source, {
    compression: "auto",
    maxChunkBytes: 128,
    leafDecodedBytes: 512,
    maxPartsPerComposite: 4,
    mediaType: "text/javascript",
  });
  assert.deepEqual(first, second);
  assert.equal(first.schema, "keel-cost-analysis@1");
  assert.deepEqual(first.candidates.map((candidate) => candidate.compression), ["none", "brotli", "gzip", "deflate"]);
  assert.equal(first.model.caveat, "modeled-estimate-not-gas-quote");
  for (const candidate of first.candidates) {
    assert.equal(candidate.flat.chunkCount, Math.ceil(candidate.flat.storedByteLength / 128));
    assert.equal(candidate.flat.chunkUploadTransactions, Math.ceil(candidate.flat.chunkCount / 3));
    assert.equal(candidate.flat.transactionCount, candidate.flat.chunkUploadTransactions + 1);
    assert.equal(candidate.recursive.leafChunkCount, candidate.recursive.chunkCount);
    assert.equal(candidate.recursive.transactionCount,
      candidate.recursive.chunkUploadTransactions + candidate.recursive.objectTransactions + candidate.recursive.compositeTransactions);
  }
  assert.equal(first.recommendation.compression, first.selectedCompression);
  assert.equal(first.recommendation.strategy, "flat");
});

test("cost analysis reports exact flat limits and recursive tree counts", async () => {
  const source = new Uint8Array((23_000 * 128) + 1);
  for (let index = 0; index < source.length; index += 1) source[index] = index % 251;
  const result = await analyzeCost(source, {
    compression: "none",
    leafDecodedBytes: 512 * 1024,
    maxPartsPerComposite: 64,
  });
  const candidate = result.candidates[0];
  assert.ok(candidate);
  assert.equal(candidate.compression, "none");
  assert.equal(candidate.flat.chunkCount, 129);
  assert.equal(candidate.flat.feasible, false);
  assert.equal(candidate.recursive.leafCount, 6);
  assert.equal(candidate.recursive.leafChunkCount, 130);
  assert.equal(candidate.recursive.maxLeafChunkCount, 23);
  assert.deepEqual(candidate.recursive.compositeNodeCounts, [1]);
  assert.equal(candidate.recursive.compositeCount, 1);
  assert.equal(candidate.recursive.treeDepth, 1);
  assert.equal(candidate.recursive.feasible, true);
  assert.equal(candidate.recursive.transactionCount, 51);
  assert.equal(result.recommendation.strategy, "recursive");
});

test("cost analysis fails closed when a recursive tree exceeds the direct reader depth", async () => {
  const result = await analyzeCost(new Uint8Array(513), {
    compression: "none",
    maxChunkBytes: 1,
    leafDecodedBytes: 1,
    maxPartsPerComposite: 2,
  });
  const candidate = result.candidates[0];
  assert.ok(candidate);
  assert.equal(candidate.recursive.treeDepth, 10);
  assert.equal(candidate.recursive.maxTreeDepth, 8);
  assert.equal(candidate.recursive.feasible, false);
  assert.equal(result.recommendation.strategy, "infeasible");
});

test("cost analysis rejects unsafe boundaries and the CLI exposes the caveat", async () => {
  await assert.rejects(() => analyzeCost(new Uint8Array()), /non-empty/u);
  await assert.rejects(() => analyzeCost(new Uint8Array([1]), { maxChunkBytes: 23_001 }), /23000/u);
  await assert.rejects(() => analyzeCost(new Uint8Array([1]), { maxPartsPerComposite: 1 }), /2 through 128/u);
  await assert.rejects(() => analyzeCost(new Uint8Array([1]), { leafDecodedBytes: 23_000 * 128 + 1 }), /cannot exceed/u);
  await assert.rejects(() => analyzeCost(new Uint8Array([1]), { mediaType: "a".repeat(129) }), /1 through 128 bytes/u);
  await assert.rejects(() => analyzeCost(new Uint8Array([1]), { mediaType: "é".repeat(65) }), /1 through 128 bytes/u);
  await assert.rejects(() => analyzeCost(new Uint8Array([1]), { mediaType: 123 }), /1 through 128 bytes/u);
  await assert.rejects(() => analyzeCost(new Uint8Array([1]), true), /options must be an object/u);
  await assert.rejects(() => analyzeCost(new Uint8Array([1]), ["none"]), /options must be an object/u);
  const depthBound = await analyzeCost(new Uint8Array(513), {
    compression: "none",
    maxChunkBytes: 1,
    leafDecodedBytes: 1,
    maxPartsPerComposite: 2,
  });
  const depthCandidate = depthBound.candidates[0];
  assert.ok(depthCandidate);
  assert.equal(depthCandidate.recursive.treeDepth, 10);
  assert.equal(depthCandidate.recursive.feasible, false);
  assert.equal(depthBound.model.maxTreeDepth, 8);
  assert.equal(depthBound.recommendation.strategy, "infeasible");

  const directory = await mkdtemp(path.join(os.tmpdir(), "oca-cost-cli-"));
  try {
    const input = path.join(directory, "module.js");
    await writeFile(input, "export const answer = 42;\n");
    const cli = path.resolve("packages/builder/dist/cli.js");
    const json = JSON.parse(execFileSync(process.execPath, [
      cli, "cost", input, "--compression", "none", "--chunk-bytes", "8", "--leaf-bytes", "512", "--json",
    ], { encoding: "utf8" }));
    assert.equal(json.schema, "keel-cost-analysis@1");
    assert.equal(json.model.caveat, "modeled-estimate-not-gas-quote");
    const summary = execFileSync(process.execPath, [cli, "cost", input, "--compression", "none"], { encoding: "utf8" });
    assert.match(summary, /modeled estimate, not a gas quote/u);
    const linked = path.join(directory, "linked.js");
    await symlink(input, linked);
    assert.throws(
      () => execFileSync(process.execPath, [cli, "cost", linked], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
      (error) => String(error?.stderr ?? "").includes("regular non-symlink"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
