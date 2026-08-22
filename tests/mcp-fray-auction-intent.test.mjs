import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { verifyFrayAuctionIntent } from "../packages/sdk/dist/index.js";
import { prepareFrayAuctionIntake, stageFrayProject } from "../packages/mcp/dist/fray-agent.js";

test("MCP intake carries exact family-specific policy instead of preset-ID economics", async () => {
  const ethereum = await prepareFrayAuctionIntake({
    title: "Exact ETH",
    useDefaultDescription: true,
    auctionPreset: 1,
    family: "ethereum",
    network: "sepolia",
  });
  assert.equal(ethereum.status, "ready-for-approval");
  assert.equal(ethereum.auction.policy.protocol, "fray-auction-policy@1");
  assert.equal(ethereum.auction.terms.reserveAtomic, "10000000000000000");
  assert.equal(ethereum.auction.terms.bidIncrementAtomic, "5000000000000000");
  assert.equal(ethereum.approvalRequest.api.body.auctionPolicy.terms.maximumEditionSize, 0);
  assert.equal(ethereum.approvalRequest.api.body.auctionPreset, undefined);

  const tezos = await prepareFrayAuctionIntake({
    title: "Exact tez",
    useDefaultDescription: true,
    auctionPreset: 3,
    family: "tezos",
    network: "shadownet",
  });
  assert.equal(tezos.auction.nativeCurrency.unit, "mutez");
  assert.equal(tezos.auction.terms.reserveAtomic, "2500000");
  assert.equal(tezos.auction.terms.maximumEditionSize, 25);
  assert.match(tezos.auction.display.reserve, /2\.5/u);

  const base = await prepareFrayAuctionIntake({
    title: "Exact Base ETH",
    useDefaultDescription: true,
    auctionPreset: 2,
    family: "ethereum",
    network: "base-sepolia",
  });
  assert.equal(base.status, "ready-for-approval");
  assert.equal(base.chain.chainId, 84_532);
});

test("MCP intake requires an explicit family and network before approval", async () => {
  const incomplete = [
    { family: "ethereum" },
    { family: "tezos" },
    { network: "sepolia" },
    { network: "shadownet" },
    { family: "tezos", network: "base-sepolia" },
    { family: "ethereum", network: "shadownet" },
  ];
  for (const selection of incomplete) {
    const result = await prepareFrayAuctionIntake({
      title: "Explicit chain",
      useDefaultDescription: true,
      auctionPreset: 1,
      ...selection,
    });
    assert.equal(result.status, "needs-input", JSON.stringify(selection));
    assert.equal(result.approvalRequest, undefined, JSON.stringify(selection));
    assert.equal(result.questions.some((question) => question.field === "chain"), true, JSON.stringify(selection));
  }
});

test("MCP staging binds source, chain, and full economics in one verified envelope", async () => {
  let posted;
  const server = createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/api/agent/staging") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      posted = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ staging: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", capability: "c".repeat(48), requestId: posted.requestId } }));
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/api/agent/handoffs/")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "modeled" }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const previousUrl = process.env.FRAY_STUDIO_URL;
  const previousToken = process.env.FRAY_STUDIO_AGENT_TOKEN;
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    process.env.FRAY_STUDIO_URL = `http://127.0.0.1:${address.port}`;
    process.env.FRAY_STUDIO_AGENT_TOKEN = "t".repeat(48);
    const sourceBytes = new TextEncoder().encode("exact art bytes");
    const result = await stageFrayProject({
      sourcePath: "art.html",
      sourceFileName: "art.html",
      sourceMediaType: "text/html",
      sourceBytes,
      title: "Exact staged art",
      description: "The exact staged art description.",
      family: "ethereum",
      network: "sepolia",
      auctionPreset: 2,
      metadataMode: "Onchain",
      releaseOutcome: "patrons",
      previewExecution: "html-sandbox",
      viewerModules: ["render:html-sandbox"],
      previewCapture: { still: { mode: "settle" }, video: { enabled: false, mode: "settle", durationMs: 3_000, fps: 12 } },
    });
    assert.equal(result.status, "ready-for-wallet-review");
    assert.equal(result.staging.capability, undefined);
    const handoff = JSON.parse(Buffer.from(new URL(result.handoffUrl).searchParams.get("frayHandoff"), "base64url").toString("utf8"));
    assert.equal(handoff.staging.capability, "c".repeat(48));
    assert.equal(result.feeEstimate.preflight.status, "refresh-on-open");
    assert.equal((await verifyFrayAuctionIntent(result.auctionIntent)).valid, true);
    assert.deepEqual(posted.auctionIntent, result.auctionIntent);
    assert.equal(posted.auctionIntent.intent.source.byteLength, sourceBytes.byteLength);
    assert.equal(posted.auctionIntent.intent.chain.chainId, 11_155_111);
    assert.equal(posted.auctionIntent.intent.terms.maximumEditionSize, 10);
    assert.match(posted.auctionIntent.integrity.digest, /^0x[0-9a-f]{64}$/u);

    await assert.rejects(() => stageFrayProject({
      sourcePath: "art.html",
      sourceFileName: "art.html",
      sourceMediaType: "text/html",
      sourceBytes,
      title: "Mismatch",
      description: "This release outcome does not match the selected policy.",
      family: "ethereum",
      network: "sepolia",
      auctionPreset: 2,
      metadataMode: "Onchain",
      releaseOutcome: "bidder",
      previewExecution: "html-sandbox",
      viewerModules: [],
      previewCapture: { still: { mode: "settle" }, video: { enabled: false, mode: "settle", durationMs: 3_000, fps: 12 } },
    }), /releaseOutcome must match/u);
  } finally {
    if (previousUrl === undefined) delete process.env.FRAY_STUDIO_URL;
    else process.env.FRAY_STUDIO_URL = previousUrl;
    if (previousToken === undefined) delete process.env.FRAY_STUDIO_AGENT_TOKEN;
    else process.env.FRAY_STUDIO_AGENT_TOKEN = previousToken;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("MCP staging uses verified resumable chunks when the Studio offers them", async () => {
  const uploadedParts = [];
  let completed;
  const uploadId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const uploadToken = "upload-session-token";
  const server = createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/api/agent/staging/uploads") {
      response.setHeader("content-type", "application/json");
      response.statusCode = 201;
      response.end(JSON.stringify({ upload: { id: uploadId, token: uploadToken, partBytes: 8 } }));
      return;
    }
    if (request.method === "PUT" && request.url?.startsWith(`/api/agent/staging/uploads/${uploadId}/parts/`)) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      uploadedParts.push({ bytes: Buffer.concat(chunks), digest: request.headers["x-fray-chunk-sha256"] });
      response.statusCode = 204;
      response.end();
      return;
    }
    if (request.method === "POST" && request.url === `/api/agent/staging/uploads/${uploadId}/complete`) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      completed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.setHeader("content-type", "application/json");
      response.statusCode = 201;
      response.end(JSON.stringify({ staging: { id: uploadId, capability: "d".repeat(48), requestId: completed.stage.requestId } }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const previousUrl = process.env.FRAY_STUDIO_URL;
  const previousToken = process.env.FRAY_STUDIO_AGENT_TOKEN;
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    process.env.FRAY_STUDIO_URL = `http://127.0.0.1:${address.port}`;
    process.env.FRAY_STUDIO_AGENT_TOKEN = "t".repeat(48);
    const sourceBytes = new TextEncoder().encode("resumable art bytes");
    const result = await stageFrayProject({
      sourcePath: "art.png",
      sourceFileName: "art.png",
      sourceMediaType: "image/png",
      sourceBytes,
      title: "Resumable staged art",
      description: "The exact resumable staged art description.",
      family: "tezos",
      network: "shadownet",
      auctionPreset: 1,
      metadataMode: "IPFS",
      releaseOutcome: "bidder",
      previewExecution: "none",
      viewerModules: [],
    });
    assert.equal(result.status, "ready-for-wallet-review");
    assert.equal(uploadedParts.length, 3);
    assert.deepEqual(Buffer.concat(uploadedParts.map((part) => part.bytes)), Buffer.from(sourceBytes));
    assert.deepEqual(completed.chunks.map((chunk) => chunk.sha256), uploadedParts.map((part) => part.digest));
    assert.equal(completed.uploadToken, uploadToken);
    assert.equal(completed.stage.sourceBytesBase64, undefined);
  } finally {
    if (previousUrl === undefined) delete process.env.FRAY_STUDIO_URL;
    else process.env.FRAY_STUDIO_URL = previousUrl;
    if (previousToken === undefined) delete process.env.FRAY_STUDIO_AGENT_TOKEN;
    else process.env.FRAY_STUDIO_AGENT_TOKEN = previousToken;
    await new Promise((resolve) => server.close(resolve));
  }
});
