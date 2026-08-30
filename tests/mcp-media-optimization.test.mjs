import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMcpServer } from "../packages/mcp/dist/index.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHxcCAk+Uzr4AAAAASUVORK5CYII=",
  "base64",
);

async function call(server, id, name, args) {
  const response = await server.handle({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
  assert.equal(response?.error, undefined, response?.error?.message);
  return response?.result?.structuredContent;
}

test("MCP requires an exact reviewed optimization result before writing a new file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "keel-mcp-media-opt-"));
  try {
    await writeFile(path.join(directory, "source.png"), ONE_PIXEL_PNG);
    const server = await createMcpServer({ workspaceRoot: directory });
    await server.handle({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "media-test", version: "1" } },
    });
    const plan = await call(server, 1, "media-optimize", {
      input: "source.png",
      selectedStorageMode: "inline",
    });
    assert.equal(plan.mode, "dry-run");
    assert.equal(plan.status, "ready-for-explicit-apply");
    assert.equal(plan.storage.selectedMode, "inline");
    assert.equal(plan.storage.changed, false);

    const wrong = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "media-optimize-apply",
        arguments: {
          input: "source.png",
          output: "optimized.webp",
          expectedOutputDigest: `0x${"00".repeat(32)}`,
          expectedAfterBytes: plan.measurements.afterBytes,
          selectedStorageMode: "inline",
        },
      },
    });
    assert.equal(wrong?.result?.isError, true);
    assert.match(wrong?.result?.content?.[0]?.text ?? "", /does not match the reviewed dry-run/u);

    const applied = await call(server, 3, "media-optimize-apply", {
      input: "source.png",
      output: "optimized.webp",
      expectedOutputDigest: plan.output.integrity.digest,
      expectedAfterBytes: plan.measurements.afterBytes,
      selectedStorageMode: "inline",
    });
    assert.equal(applied.mode, "explicit-apply");
    assert.equal(applied.status, "completed");
    assert.equal(applied.output.integrity.digest, plan.output.integrity.digest);
    assert.equal(applied.measurements.afterBytes, plan.measurements.afterBytes);
    assert.equal(applied.sourceRetention.sourceRemoved, false);
    assert.equal(applied.storage.selectedMode, "inline");
    assert.equal(applied.storage.changed, false);
    assert.deepEqual(await readFile(path.join(directory, "source.png")), ONE_PIXEL_PNG);
    assert.equal((await readFile(path.join(directory, "optimized.webp"))).byteLength, plan.measurements.afterBytes);

    const traversal = await server.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "media-optimize-apply",
        arguments: {
          input: "source.png",
          output: "../escape.webp",
          expectedOutputDigest: plan.output.integrity.digest,
          expectedAfterBytes: plan.measurements.afterBytes,
          selectedStorageMode: "inline",
        },
      },
    });
    assert.equal(traversal?.result?.isError, true);
    assert.match(traversal?.result?.content?.[0]?.text ?? "", /must stay inside the MCP workspace/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
