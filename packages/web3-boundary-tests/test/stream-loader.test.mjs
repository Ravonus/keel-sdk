// Tests for the dependency-free stream loader — the proof that any HTML
// viewer or page can consume Keel recursion via the standards surface
// with zero libraries: hand-rolled ABI codec, raw eth_call, ERC-7617
// traversal, platform decompression.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, parseAbi } from "viem";

import {
  encodeRequestCalldata,
  decodeRequestReturn,
  decodeReadChunkReturn,
  fetchChunk,
  fetchStream,
} from "../../../examples/demos/keel-web3-adapter/web3-stream-loader.mjs";
import { startBoundaryFixture } from "./helpers/boundary-fixture.mjs";

const encoder = new TextEncoder();
const requestAbi = parseAbi([
  "function request(string[] resource,(string key,string value)[] params) view returns (uint16 statusCode,string body,(string key,string value)[] headers)",
]);

describe("hand-rolled ABI codec (pure, no chain)", () => {
  it("encodes request calldata identically to a real ABI encoder", () => {
    for (const resource of [[], ["object"], ["object", "0x" + "ab".repeat(32), "57"]]) {
      const decoded = decodeFunctionData({ abi: requestAbi, data: encodeRequestCalldata(resource) });
      expect(decoded.functionName).toBe("request");
      expect(decoded.args[0]).toEqual(resource);
      expect(decoded.args[1]).toEqual([]);
    }
  });

  it("decodes request returns produced by a real ABI encoder, including binary bodies", () => {
    // `bytes` and `string` share the same ABI wire encoding; using bytes here
    // lets the fixture carry raw binary exactly as adapter chunk bodies do.
    const binaryBody = "0x000102fffe0a0d";
    const encoded = encodeAbiParameters(
      [
        { type: "uint16" },
        { type: "bytes" },
        { type: "tuple[]", components: [{ type: "string" }, { type: "string" }] },
      ],
      [206, binaryBody, [["Content-Type", "application/wasm"], ["web3-next-chunk", "/object/0xab/1"]]],
    );
    const decoded = decodeRequestReturn(encoded);
    expect(decoded.statusCode).toBe(206);
    expect([...decoded.body]).toEqual([0, 1, 2, 255, 254, 10, 13]);
    expect(decoded.headers["content-type"]).toBe("application/wasm");
    expect(decoded.headers["web3-next-chunk"]).toBe("/object/0xab/1");
  });

  it("decodes readChunk returns", () => {
    const abi = parseAbi(["function readChunk(bytes32,uint256) view returns (bytes data,bool hasNext)"]);
    const encoded = encodeFunctionResult({ abi, functionName: "readChunk", result: ["0xdeadbeef", true] });
    const decoded = decodeReadChunkReturn(encoded);
    expect(Buffer.from(decoded.data).toString("hex")).toBe("deadbeef");
    expect(decoded.hasNext).toBe(true);
  });
});

describe("loader against a live chain", () => {
  let fixture;
  let doc;
  let objectId;

  beforeAll(async () => {
    fixture = await startBoundaryFixture();
    doc = "<!doctype html><html><body>" + "loader ".repeat(8000) + "</body></html>"; // ~56 KB -> 3 chunks
    ({ objectId } = await fixture.publishLeaf(encoder.encode(doc)));
  }, 120_000);

  afterAll(() => fixture?.stop());

  it("random-accesses one chunk through the native indexed primitive", async () => {
    const { data, hasNext } = await fetchChunk({ rpcUrl: fixture.rpcUrl, store: fixture.store, objectId, index: 2 });
    expect(hasNext).toBe(false);
    expect(Buffer.from(data).toString()).toBe(doc.slice(46_000));
  });

  it("streams and reassembles the exact document via web3-next-chunk", async () => {
    const result = await fetchStream({ rpcUrl: fixture.rpcUrl, adapter: fixture.adapter, objectId });
    expect(result.statusCode).toBe(200);
    expect(result.contentType).toBe("text/html");
    expect(Buffer.from(result.body).toString()).toBe(doc);
  });

  it("applies Content-Encoding: gzip with platform decompression", async () => {
    const original = "<svg>" + "gz ".repeat(9000) + "</svg>";
    const stored = gzipSync(Buffer.from(original));
    const { objectId: gzId } = await fixture.publishLeaf(new Uint8Array(stored), {
      compression: 1,
      mediaType: "image/svg+xml",
      decodedLength: original.length,
    });
    const result = await fetchStream({ rpcUrl: fixture.rpcUrl, adapter: fixture.adapter, objectId: gzId });
    expect(result.contentType).toBe("image/svg+xml");
    expect(Buffer.from(result.body).toString()).toBe(original);
  });

  it("surfaces adapter status codes instead of masking them", async () => {
    const missing = await fetchStream({ rpcUrl: fixture.rpcUrl, adapter: fixture.adapter, objectId: "0x" + "22".repeat(32) });
    expect(missing.statusCode).toBe(404);
    const malformed = await fetchStream({ rpcUrl: fixture.rpcUrl, adapter: fixture.adapter, objectId: "0x1234" });
    expect(malformed.statusCode).toBe(400);
  });

  it("enforces the client-side traversal budget the ERCs leave to clients", async () => {
    await expect(
      fetchStream({ rpcUrl: fixture.rpcUrl, adapter: fixture.adapter, objectId, maxChunks: 2 }),
    ).rejects.toThrow(/traversal budget exceeded/);
  });
});
