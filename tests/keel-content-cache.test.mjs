import assert from "node:assert/strict";
import test from "node:test";
import {
  createMemoryKeelContentCache,
  decodeKeelDataUri,
  resolveKeelContent,
  sha256Hex,
} from "../packages/protocol/dist/index.js";

const identity = {
  namespace: "test-script",
  chainId: 11155111,
  source: "0x0000000000000000000000000000000000000001",
  objectKey: "runner-4",
  revision: "1",
  version: "0xabc",
};

test("Keel content cache returns and verifies the exact first load", async () => {
  const cache = createMemoryKeelContentCache();
  const bytes = new TextEncoder().encode("<script>window.ok=true</script>");
  let loads = 0;
  const input = {
    identity,
    cache,
    expectedIntegrity: { algorithm: "sha256", digest: await sha256Hex(bytes), byteLength: bytes.byteLength },
    allowedMediaTypes: ["text/html"],
    load: async () => {
      loads += 1;
      return { bytes, mediaType: "text/html" };
    },
  };

  const first = await resolveKeelContent(input);
  const second = await resolveKeelContent(input);
  assert.equal(first.cacheStatus, "miss");
  assert.equal(second.cacheStatus, "hit");
  assert.equal(loads, 1);
  assert.deepEqual(second.bytes, bytes);
  assert.match(second.etag, /^"keel-[0-9a-f]{64}"$/u);
});

test("Keel content cache rejects a corrupt cached payload and reloads", async () => {
  const memory = createMemoryKeelContentCache();
  const bytes = new TextEncoder().encode("verified bytes");
  let loads = 0;
  const first = await resolveKeelContent({
    identity,
    cache: memory,
    load: async () => ({ bytes, mediaType: "application/octet-stream" }),
  });
  const corruptingCache = {
    async get(key) {
      const record = await memory.get(key);
      return record === undefined ? undefined : { ...record, bytes: new Uint8Array([0, 1, 2]) };
    },
    async put(record) {
      await memory.put(record);
    },
  };
  const recovered = await resolveKeelContent({
    identity,
    cache: corruptingCache,
    load: async () => {
      loads += 1;
      return { bytes, mediaType: "application/octet-stream" };
    },
  });
  assert.equal(first.cacheStatus, "miss");
  assert.equal(recovered.cacheStatus, "miss");
  assert.equal(loads, 1);
  assert.deepEqual(recovered.bytes, bytes);
});

test("Keel data URI decoding preserves exact HTML bytes", () => {
  const source = "<html><body>onchain</body></html>";
  const decoded = decodeKeelDataUri(`data:text/html;base64,${Buffer.from(source).toString("base64")}`, "text/html");
  assert.equal(new TextDecoder().decode(decoded.bytes), source);
  assert.equal(decoded.mediaType, "text/html");
});
