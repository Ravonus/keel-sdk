import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMcpServer } from "../packages/mcp/dist/index.js";

const initializeParams = { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "draft-test", version: "1" } };
const token = `keel_agent_${"d".repeat(48)}`;
const draft = {
  artifactId: null,
  title: "Agent repair",
  description: "Editable through a scoped Studio grant.",
  story: "",
  releaseType: "one-of-one",
  accessMode: "public",
  supply: "1",
  priceEth: "0.1",
  maxPerTransaction: 1,
  maxPerWallet: 1,
  startsAt: null,
  endsAt: null,
  networkLabel: "Sepolia",
  payoutAddress: null,
  page: {},
};

async function call(server, id, args) {
  return server.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "keel-studio-draft", arguments: args } });
}

test("MCP edits Studio drafts with an environment-only grant and optimistic revision", async () => {
  const previousToken = process.env.KEEL_STUDIO_AGENT_TOKEN;
  const previousFetch = globalThis.fetch;
  const requests = [];
  process.env.KEEL_STUDIO_AGENT_TOKEN = token;
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (init.method === "PATCH") {
      const payload = JSON.parse(init.body);
      return Response.json({ ...payload.draft, id: "release-1", revision: 2, status: "draft", slug: "agent-repair" });
    }
    return Response.json({ projects: [], releases: [{ ...draft, id: "release-1", revision: 1, status: "draft", slug: "agent-repair" }] });
  };
  try {
    const server = await createMcpServer();
    await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: initializeParams });
    const listed = await call(server, 2, { studioUrl: "https://studio.example", operation: "list" });
    assert.equal(listed?.result.structuredContent.releases[0].title, "Agent repair");
    const updated = await call(server, 3, {
      studioUrl: "https://studio.example",
      operation: "update",
      releaseId: "release-1",
      expectedRevision: 1,
      draft: { ...draft, title: "Agent repair complete" },
    });
    assert.equal(updated?.result.structuredContent.title, "Agent repair complete");
    assert.equal(updated?.result.structuredContent.revision, 2);
    assert.equal(requests.length, 2);
    assert.ok(requests.every(({ init }) => new Headers(init.headers).get("authorization") === `Bearer ${token}`));
    assert.ok(requests.every(({ url }) => url.startsWith("https://studio.example/api/agent/drafts")));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.KEEL_STUDIO_AGENT_TOKEN;
    else process.env.KEEL_STUDIO_AGENT_TOKEN = previousToken;
  }
});

test("MCP never accepts a draft key in tool arguments and fails closed without the environment grant", async () => {
  const previousToken = process.env.KEEL_STUDIO_AGENT_TOKEN;
  delete process.env.KEEL_STUDIO_AGENT_TOKEN;
  try {
    const server = await createMcpServer();
    await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: initializeParams });
    const missing = await call(server, 2, { studioUrl: "https://studio.example", operation: "list" });
    assert.equal(missing?.result.isError, true);
    assert.match(missing?.result.content[0].text, /KEEL_STUDIO_AGENT_TOKEN/u);
    const exposed = await call(server, 3, { studioUrl: "https://studio.example", operation: "list", grantToken: token });
    assert.equal(exposed?.result.isError, true);
    assert.match(exposed?.result.content[0].text, /grantToken is not supported/u);
  } finally {
    if (previousToken === undefined) delete process.env.KEEL_STUDIO_AGENT_TOKEN;
    else process.env.KEEL_STUDIO_AGENT_TOKEN = previousToken;
  }
});

test("MCP stages an image-only KEEL shell project without uploading a local viewer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "keel-mcp-stage-"));
  const previousToken = process.env.KEEL_STUDIO_AGENT_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.KEEL_STUDIO_AGENT_TOKEN = token;
  await writeFile(path.join(root, "signal.webp"), Uint8Array.of(82, 73, 70, 70, 1, 2, 3, 4));
  let metadata;
  let uploadedFiles = [];
  globalThis.fetch = async (_url, init = {}) => {
    metadata = JSON.parse(init.body.get("metadata"));
    uploadedFiles = init.body.getAll("files");
    return Response.json({
      schema: "keel-studio-project-handoff@1",
      id: "stage-1",
      handoffUrl: "https://studio.example/studio/projects/new?handoff=secret",
      expiresAt: "2026-09-01T00:00:00.000Z",
      fileCount: 1,
      totalBytes: 8,
      wallet: { signing: "not-performed", submission: "not-performed" },
    });
  };
  try {
    const server = await createMcpServer({ workspaceRoot: root });
    await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: initializeParams });
    const result = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "keel-studio-stage-project",
        arguments: {
          studioUrl: "https://studio.example",
          title: "Signal Bloom",
          description: "Image-only project",
          storageStrategy: "onchain",
          files: [{ path: "signal.webp", mediaType: "image/webp", role: "image", format: "asset" }],
        },
      },
    });
    assert.equal(result?.result.structuredContent.fileCount, 1);
    assert.equal(result?.result.structuredContent.wallet.signing, "not-performed");
    assert.equal("viewer" in metadata, false);
    assert.deepEqual(metadata.components.map(({ path: filePath, role }) => [filePath, role]), [["signal.webp", "image"]]);
    assert.equal(metadata.publicationIntent.viewer.mode, "keel-sandbox");
    assert.equal(metadata.components.some(({ path: filePath }) => filePath === "viewer.js" || filePath === "index.html"), false);
    assert.equal(uploadedFiles.length, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.KEEL_STUDIO_AGENT_TOKEN;
    else process.env.KEEL_STUDIO_AGENT_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP rejects a locally declared KEEL shell before staging while allowing creator HTML", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "keel-mcp-shell-"));
  const previousToken = process.env.KEEL_STUDIO_AGENT_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.KEEL_STUDIO_AGENT_TOKEN = token;
  await writeFile(path.join(root, "viewer.js"), "console.log('creator');");
  let uploads = 0;
  globalThis.fetch = async () => {
    uploads += 1;
    throw new Error("rejected before upload");
  };
  try {
    const server = await createMcpServer({ workspaceRoot: root });
    await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: initializeParams });
    const result = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "keel-studio-stage-project",
        arguments: {
          studioUrl: "https://studio.example",
          title: "No local shell",
          storageStrategy: "onchain",
          files: [{ path: "viewer.js", label: "KEEL verification shell", mediaType: "text/javascript", role: "script", format: "classic-script" }],
        },
      },
    });
    assert.equal(result?.result.isError, true);
    assert.match(result?.result.content[0].text, /creator resources\/modules only/u);
    assert.equal(uploads, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.KEEL_STUDIO_AGENT_TOKEN;
    else process.env.KEEL_STUDIO_AGENT_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});
