// Streams a real, pre-existing HTML artifact — the 714 KB bundled vault
// gallery viewer — through the web3:// boundary and proves byte-exact
// reconstruction with the dependency-free loader. Nothing about the artifact
// was authored for these tests: this is "any HTML artifact, separately
// authored, served intact".
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { fetchChunk, fetchStream } from "../../../examples/demos/keel-web3-adapter/web3-stream-loader.mjs";
import { startBoundaryFixture, repositoryRoot, MAX_SLUG_BYTES } from "./helpers/boundary-fixture.mjs";

const artifactPath = path.join(
  repositoryRoot,
  "examples/demos/vault-arcade/generated-attribute-proxy/vault-character-gallery-viewer-bundled.html",
);

let fixture;
let artifact;
let objectId;
let chunkCount;

beforeAll(async () => {
  artifact = new Uint8Array(await readFile(artifactPath));
  fixture = await startBoundaryFixture();
  ({ objectId, chunkCount } = await fixture.publishLeaf(artifact));
}, 240_000);

afterAll(() => fixture?.stop());

describe("separately authored HTML artifact through the boundary", () => {
  it("spans many full-size carriers", () => {
    expect(artifact.length).toBeGreaterThan(700_000);
    expect(chunkCount).toBe(Math.ceil(artifact.length / MAX_SLUG_BYTES));
    expect(chunkCount).toBeGreaterThanOrEqual(30);
  });

  it("streams back byte-exact via ERC-7617 traversal with the no-dependency loader", async () => {
    const result = await fetchStream({ rpcUrl: fixture.rpcUrl, adapter: fixture.adapter, objectId });
    expect(result.statusCode).toBe(200);
    expect(result.contentType).toBe("text/html");
    expect(result.body.length).toBe(artifact.length);
    const streamedDigest = createHash("sha256").update(result.body).digest("hex");
    const sourceDigest = createHash("sha256").update(artifact).digest("hex");
    expect(streamedDigest).toBe(sourceDigest);
  }, 120_000);

  it("random-accesses a mid-artifact chunk without touching earlier chunks", async () => {
    const index = Math.floor(chunkCount / 2);
    const { data, hasNext } = await fetchChunk({ rpcUrl: fixture.rpcUrl, store: fixture.store, objectId, index });
    expect(hasNext).toBe(true);
    const expected = artifact.slice(index * MAX_SLUG_BYTES, (index + 1) * MAX_SLUG_BYTES);
    expect(Buffer.from(data).equals(Buffer.from(expected))).toBe(true);
  });

  it("streams the gzip-stored variant back to the identical document", async () => {
    const stored = gzipSync(Buffer.from(artifact));
    const { objectId: gzId, chunkCount: gzChunks } = await fixture.publishLeaf(new Uint8Array(stored), {
      compression: 1,
      decodedLength: artifact.length,
    });
    expect(gzChunks).toBeLessThan(chunkCount); // compression must actually shrink the stored form
    const result = await fetchStream({ rpcUrl: fixture.rpcUrl, adapter: fixture.adapter, objectId: gzId });
    expect(result.statusCode).toBe(200);
    expect(Buffer.from(result.body).equals(Buffer.from(artifact))).toBe(true);
  }, 120_000);
});
