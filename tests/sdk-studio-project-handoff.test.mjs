import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MODULE = pathToFileURL(path.join(ROOT, "packages", "sdk", "dist", "studio-upload.js")).href;

test("agent staging preserves exact component declarations and never invokes a wallet", async () => {
  const { stageKeelStudioProject } = await import(MODULE);
  let request;
  const result = await stageKeelStudioProject({
    studioUrl: "https://studio.example/base",
    agentToken: "k".repeat(48),
    title: "Seed Current",
    description: "A deterministic p5.js work.",
    storageStrategy: "onchain",
    releaseIntent: {
      schema: "keel-release-intent@1",
      chainId: 11155111,
      mode: "release",
      collection: { mode: "choose-in-studio" },
      release: { type: "one-of-one", supply: "1", saleMechanism: "fixed-price", priceEth: "0.1", accessMode: "public", startsAt: null, endsAt: null },
      presentation: { preferredMode: "inline" },
      status: "editable-draft",
      wallet: { approvalRequiredNow: false, transactionSubmitted: false },
    },
    publicationIntent: {
      schema: "keel-studio-publication-intent@1",
      viewer: { mode: "keel-sandbox", required: true, verifyManifest: true, verifyChunks: true },
      draftStorage: { provider: "keel-socket-local", persistence: "temporary-unpinned", annualQuotaBytes: 500_000_000 },
      ipfs: { mode: "not-pinned" },
    },
    files: [
      { path: "index.html", bytes: new TextEncoder().encode("<canvas></canvas>"), mediaType: "text/html", role: "entrypoint", format: "asset" },
      { path: "modules/p5.min.js", bytes: new Uint8Array([1, 2]), mediaType: "text/javascript", role: "renderer", format: "umd" },
      { path: "modules/seeded-random.mjs", bytes: new Uint8Array([3]), mediaType: "text/javascript", role: "module", format: "es-module" },
    ],
    reusableModule: {
      resourcePaths: ["modules/p5.min.js"],
      assetType: "runtime",
      license: "LGPL-2.1-only",
      accessMode: "open",
      tags: ["p5.js", "runtime"],
    },
    flashRuntime: {
      swfPath: "GhostCircuit.swf",
      loaderPath: "modules/ruffle-loader.js",
      seededRandomPath: "modules/seeded-random.js",
      editionPath: "modules/flash-edition.js",
      ruffleMainPath: "runtime/ruffle.js",
      ruffleModernCorePath: "runtime/core-modern.js",
      ruffleLegacyCorePath: "runtime/core-legacy.js",
      ruffleModernWasmPath: "runtime/modern.wasm",
      ruffleLegacyWasmPath: "runtime/legacy.wasm",
      collectionSize: 111,
      previewRootSeed: `0x${"9".repeat(64)}`,
    },
    fetchImplementation: async (url, init) => {
      request = { url: String(url), init };
      return new Response(JSON.stringify({
        schema: "keel-studio-project-handoff@1",
        id: "draft-1",
        handoffUrl: "https://studio.example/studio/projects/new?handoff=secret",
        expiresAt: "2026-09-01T00:00:00.000Z",
        fileCount: 3,
        totalBytes: 20,
        wallet: { signing: "not-performed", submission: "not-performed" },
      }), { status: 201, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(request.url, "https://studio.example/api/agent/staging");
  assert.equal(request.init.headers.authorization, `Bearer ${"k".repeat(48)}`);
  assert.equal(request.init.body instanceof FormData, true);
  const metadata = JSON.parse(request.init.body.get("metadata"));
  assert.equal(metadata.storageStrategy, "onchain");
  assert.deepEqual(metadata.components.map(({ path: item, role, format, updateMode }) => ({ path: item, role, format, updateMode })), [
    { path: "index.html", role: "entrypoint", format: "asset", updateMode: "locked" },
    { path: "modules/p5.min.js", role: "renderer", format: "umd", updateMode: "locked" },
    { path: "modules/seeded-random.mjs", role: "module", format: "es-module", updateMode: "locked" },
  ]);
  assert.deepEqual(metadata.reusableModule.resourcePaths, ["modules/p5.min.js"]);
  assert.equal(metadata.flashRuntime.collectionSize, 111);
  assert.equal(metadata.flashRuntime.ruffleModernWasmPath, "runtime/modern.wasm");
  assert.equal(metadata.releaseIntent.release.type, "one-of-one");
  assert.equal(metadata.releaseIntent.release.priceEth, "0.1");
  assert.deepEqual(metadata.releaseIntent.presentation, { preferredMode: "inline" });
  assert.equal(metadata.publicationIntent.draftStorage.persistence, "temporary-unpinned");
  assert.equal(metadata.publicationIntent.ipfs.mode, "not-pinned");
  assert.deepEqual(result.wallet, { signing: "not-performed", submission: "not-performed" });
});

test("agent staging defaults projects to the reusable KEEL verification shell", async () => {
  const { stageKeelStudioProject } = await import(MODULE);
  let metadata;
  await stageKeelStudioProject({
    studioUrl: "https://studio.example",
    agentToken: "k".repeat(48),
    title: "Shell default",
    storageStrategy: "onchain",
    files: [{ path: "sketch.js", bytes: new TextEncoder().encode("draw()"), mediaType: "text/javascript", role: "script", format: "es-module" }],
    fetchImplementation: async (_url, init) => {
      metadata = JSON.parse(init.body.get("metadata"));
      return new Response(JSON.stringify({
        schema: "keel-studio-project-handoff@1",
        id: "draft-shell",
        handoffUrl: "https://studio.example/studio/projects/new?handoff=shell",
        expiresAt: "2030-01-01T00:00:00.000Z",
        fileCount: 1,
        totalBytes: 6,
        wallet: { signing: "not-performed", submission: "not-performed" },
      }), { status: 201, headers: { "content-type": "application/json" } });
    },
  });
  assert.deepEqual(metadata.publicationIntent.viewer, {
    mode: "keel-sandbox",
    required: true,
    verifyManifest: true,
    verifyChunks: true,
  });
});

test("agent staging requires an explicit viewerless storage-only choice", async () => {
  const { stageKeelStudioProject } = await import(MODULE);
  const { defaultKeelStudioPublicationIntent } = await import("../packages/sdk/dist/studio-publication.js");
  let metadata;
  const input = {
    studioUrl: "https://studio.example",
    agentToken: "k".repeat(48),
    title: "Storage only",
    storageStrategy: "onchain",
    viewer: "none",
    files: [{ path: "artifact.bin", bytes: new Uint8Array([1]), mediaType: "application/octet-stream", role: "other", format: "asset" }],
    fetchImplementation: async (_url, init) => {
      metadata = JSON.parse(init.body.get("metadata"));
      return new Response(JSON.stringify({
        schema: "keel-studio-project-handoff@1",
        id: "draft-storage",
        handoffUrl: "https://studio.example/studio/projects/new?handoff=storage",
        expiresAt: "2030-01-01T00:00:00.000Z",
        fileCount: 1,
        totalBytes: 1,
        wallet: { signing: "not-performed", submission: "not-performed" },
      }), { status: 201, headers: { "content-type": "application/json" } });
    },
  };
  await stageKeelStudioProject(input);
  assert.equal("publicationIntent" in metadata, false);
  await assert.rejects(
    stageKeelStudioProject({ ...input, publicationIntent: defaultKeelStudioPublicationIntent() }),
    /storage-only project cannot also require/u,
  );
});

test("agent staging fails closed on ambiguous paths, weak tokens, and invalid responses", async () => {
  const { stageKeelStudioProject } = await import(MODULE);
  const base = {
    studioUrl: "https://studio.example",
    agentToken: "k".repeat(48),
    title: "Valid title",
    storageStrategy: "onchain",
    files: [{ path: "index.html", bytes: new Uint8Array([1]), mediaType: "text/html", role: "entrypoint", format: "asset" }],
    fetchImplementation: async () => new Response("{}", { status: 201, headers: { "content-type": "application/json" } }),
  };
  await assert.rejects(stageKeelStudioProject({ ...base, agentToken: "weak" }), /at least 32/u);
  await assert.rejects(stageKeelStudioProject({ ...base, files: [...base.files, { ...base.files[0] }] }), /unique/u);
  await assert.rejects(stageKeelStudioProject({ ...base, files: [{ ...base.files[0], path: "../escape" }] }), /Invalid staged project path/u);
  await assert.rejects(stageKeelStudioProject(base), /invalid handoff result/u);
});

test("the p5 handoff example requires exact same-chain carrier bindings and never embeds module bytes", async () => {
  const { createProject } = await import(pathToFileURL(path.join(ROOT, "examples", "agent-p5-project", "project.mjs")).href);
  const [p5Bytes, seedBytes, html, sketch] = await Promise.all([
    readFile(path.join(ROOT, "examples", "demos", "vendor", "p5.min.js")),
    readFile(path.join(ROOT, "examples", "library", "seeded-random.js")),
    readFile(path.join(ROOT, "examples", "demos", "p5-flowfield", "index.html"), "utf8"),
    readFile(path.join(ROOT, "examples", "demos", "p5-flowfield", "sketch.js"), "utf8"),
  ]);
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    const bytes = request.params[0].to.toLowerCase() === `0x${"1".repeat(40)}` ? p5Bytes : seedBytes;
    const hex = Buffer.from(bytes).toString("hex");
    const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
    const result = `0x${(32n).toString(16).padStart(64, "0")}${BigInt(bytes.length).toString(16).padStart(64, "0")}${padded}`;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200, headers: { "content-type": "application/json" } });
  };
  let project;
  try {
    project = await createProject({
      chain: "eip155:11155111",
      p5: { store: `0x${"1".repeat(40)}`, objectId: `0x${"2".repeat(64)}` },
      seededRandom: { store: `0x${"3".repeat(40)}`, objectId: `0x${"4".repeat(64)}` },
    }, "https://ethereum-sepolia-rpc.publicnode.com");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(project.manifest.modules, ["p5.js", "keel.seeded-random"]);
  assert.deepEqual(project.manifest.moduleBindings.map(({ digest, chain }) => ({ digest, chain })), [
    { digest: `sha256:${hash(p5Bytes)}`, chain: "eip155:11155111" },
    { digest: `sha256:${hash(seedBytes)}`, chain: "eip155:11155111" },
  ]);
  assert.deepEqual(project.manifest.verification, { shell: true });
  assert.match(html, /type="module" src="\/content\/sketch\.js"/u);
  assert.match(sketch, /from "\/content\/seeded-random\.js"/u);
  assert.doesNotMatch(html + sketch, /https?:\/\//u);
});

test("compressed p5 modules verify through the Studio object gateway before staging", async () => {
  const { createProjectFromStudio } = await import(pathToFileURL(path.join(ROOT, "examples", "agent-p5-project", "project.mjs")).href);
  const [p5Bytes, seedBytes] = await Promise.all([
    readFile(path.join(ROOT, "examples", "demos", "vendor", "p5.min.js")),
    readFile(path.join(ROOT, "examples", "library", "seeded-random.js")),
  ]);
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    requests.push(parsed.href);
    const bytes = parsed.pathname.includes(`/0x${"2".repeat(64)}`) ? p5Bytes : seedBytes;
    return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.byteLength), "content-type": "text/javascript" } });
  };
  let project;
  try {
    project = await createProjectFromStudio({
      chain: "eip155:11155111",
      p5: { store: `0x${"1".repeat(40)}`, objectId: `0x${"2".repeat(64)}` },
      seededRandom: { store: `0x${"3".repeat(40)}`, objectId: `0x${"4".repeat(64)}` },
    }, "https://studio.example");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(project.manifest.moduleBindings.length, 2);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((url) => url.startsWith("https://studio.example/api/onchain/11155111/")));
});

test("Studio module verification fails closed on wrong bytes, lengths, and unsafe origins", async () => {
  const module = await import(pathToFileURL(path.join(ROOT, "examples", "agent-p5-project", "project.mjs")).href);
  await assert.rejects(module.createProjectFromStudio({
    chain: "eip155:11155111",
    p5: { store: `0x${"1".repeat(40)}`, objectId: `0x${"2".repeat(64)}` },
    seededRandom: { store: `0x${"3".repeat(40)}`, objectId: `0x${"4".repeat(64)}` },
  }, "http://studio.example"), /HTTPS/u);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array([1]), { status: 200, headers: { "content-length": "1" } });
  try {
    await assert.rejects(module.createProjectFromStudio({
      chain: "eip155:11155111",
      p5: { store: `0x${"1".repeat(40)}`, objectId: `0x${"2".repeat(64)}` },
      seededRandom: { store: `0x${"3".repeat(40)}`, objectId: `0x${"4".repeat(64)}` },
    }, "https://studio.example"), /wrong byte length/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
