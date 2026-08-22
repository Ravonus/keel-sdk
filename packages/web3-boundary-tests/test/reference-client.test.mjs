// Compatibility tests against the reference `web3protocol` JS client — the
// canonical implementation of ERC-6860/6944/7617/7618 URL handling — rather
// than our own reading of the specs.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { Client } from "web3protocol";

import { startBoundaryFixture } from "./helpers/boundary-fixture.mjs";

const encoder = new TextEncoder();
let fixture;
let client;
let doc;
let objectId;

async function drain(stream) {
  const parts = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts);
}

beforeAll(async () => {
  fixture = await startBoundaryFixture();
  client = new Client([{ id: fixture.chainId, rpcUrls: [fixture.rpcUrl] }]);
  doc = "<!doctype html><html><body>" + "keel ".repeat(6000) + "</body></html>"; // ~48 KB -> 3 chunks
  ({ objectId } = await fixture.publishLeaf(encoder.encode(doc)));
}, 120_000);

afterAll(() => fixture?.stop());

describe("ERC-6860 auto mode (indexed primitive, no adapter)", () => {
  it("resolves the store in auto mode and returns [data, hasNext] as JSON", async () => {
    const result = await client.fetchUrl(
      `web3://${fixture.store}:${fixture.chainId}/readChunk/${objectId}/1?returns=(bytes,bool)`,
    );
    expect(result.parsedUrl.mode).toBe("auto");
    const [dataHex, hasNext] = JSON.parse((await drain(result.output)).toString());
    expect(hasNext).toBe(true);
    expect(Buffer.from(dataHex.slice(2), "hex").toString()).toBe(doc.slice(23_000, 46_000));
  });

  it("random-accesses the final chunk without prior traversal", async () => {
    const result = await client.fetchUrl(
      `web3://${fixture.store}:${fixture.chainId}/readChunk/${objectId}/2?returns=(bytes,bool)`,
    );
    const [, hasNext] = JSON.parse((await drain(result.output)).toString());
    expect(hasNext).toBe(false);
  });

  it("serves flatSlugCount through a plain auto-mode URL", async () => {
    const result = await client.fetchUrl(
      `web3://${fixture.store}:${fixture.chainId}/flatSlugCount/${objectId}?returns=(uint256)`,
    );
    const [count] = JSON.parse((await drain(result.output)).toString());
    expect(BigInt(count)).toBe(3n);
  });
});

describe("ERC-6944/7617 resource-request mode", () => {
  it("resolves the adapter in resourceRequest mode", async () => {
    const result = await client.fetchUrl(`web3://${fixture.adapter}:${fixture.chainId}/object/${objectId}`);
    expect(result.parsedUrl.mode).toBe("resourceRequest");
    expect(result.httpCode).toBe(200);
  });

  it("reassembles the exact document by following web3-next-chunk", async () => {
    const result = await client.fetchUrl(`web3://${fixture.adapter}:${fixture.chainId}/object/${objectId}`);
    expect(result.httpHeaders["Content-Type"]).toBe("text/html");
    expect((await drain(result.output)).toString()).toBe(doc);
  });

  it("maps a missing object to HTTP 404", async () => {
    const result = await client.fetchUrl(`web3://${fixture.adapter}:${fixture.chainId}/object/0x${"11".repeat(32)}`);
    expect(result.httpCode).toBe(404);
  });

  it("maps an out-of-range chunk index to HTTP 404", async () => {
    const result = await client.fetchUrl(`web3://${fixture.adapter}:${fixture.chainId}/object/${objectId}/3`);
    expect(result.httpCode).toBe(404);
  });

  it("maps a malformed chunk index to HTTP 400", async () => {
    const result = await client.fetchUrl(`web3://${fixture.adapter}:${fixture.chainId}/object/${objectId}/xyz`);
    expect(result.httpCode).toBe(400);
  });
});

describe("ERC-7618 content encoding", () => {
  it("decompresses a gzip object transparently and strips the header", async () => {
    const original = "<html><body>" + "gzip-payload ".repeat(4000) + "</body></html>";
    const stored = gzipSync(Buffer.from(original));
    const { objectId: gzId } = await fixture.publishLeaf(new Uint8Array(stored), {
      compression: 1,
      decodedLength: original.length,
    });
    const result = await client.fetchUrl(`web3://${fixture.adapter}:${fixture.chainId}/object/${gzId}`);
    expect(result.httpCode).toBe(200);
    expect(result.httpHeaders["Content-Encoding"]).toBeUndefined();
    expect((await drain(result.output)).toString()).toBe(original);
  }, 60_000);

  it("decompresses a brotli object transparently", async () => {
    const original = "<html><body>" + "brotli-payload ".repeat(4000) + "</body></html>";
    const stored = brotliCompressSync(Buffer.from(original));
    const { objectId: brId } = await fixture.publishLeaf(new Uint8Array(stored), {
      compression: 3,
      decodedLength: original.length,
    });
    const result = await client.fetchUrl(`web3://${fixture.adapter}:${fixture.chainId}/object/${brId}`);
    expect(result.httpCode).toBe(200);
    expect((await drain(result.output)).toString()).toBe(original);
  }, 60_000);
});
