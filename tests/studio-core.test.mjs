import test from "node:test";
import assert from "node:assert/strict";
import { assertValidManifest, createIntegrity } from "../packages/protocol/dist/index.js";
import {
  buildKeelTezosRecursiveObject,
  buildKeelDirectory,
  buildKeelModuleCatalog,
  buildKeelOnchfsCarrier,
  buildKeelStorageGraph,
  buildKeelWebpDerivative,
  buildStudioManifest,
  buildKeelObjktExport,
  compressionSummary,
  createArtifactWrapper,
  createGeneratedWrapper,
  detectReorg,
  entrypointModeForMediaType,
  eventIdentityKey,
  normalizeVirtualPath,
  planKeelDelivery,
  prepareStudioArtifact,
  createKeelModuleRelease,
  searchKeelModuleCatalog,
  selectKeelModuleCarrier,
  slugify,
  verifyPreparedStudioArtifact,
} from "../packages/studio-core/dist/index.js";

function storedZipFiles(bytes) {
  const files = new Map();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 4 <= bytes.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true);
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    assert.equal(method, 0, "OBJKT export uses deterministic STORE entries");
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength));
    files.set(name, bytes.slice(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  return files;
}

const bytes = new TextEncoder().encode("<p>hello</p>");

test("studio-core creates safe names and compression summaries", () => {
  assert.equal(slugify("  Living Study #1  "), "living-study-1");
  assert.equal(normalizeVirtualPath("/content/preview.webp"), "/content/preview.webp");
  assert.throws(() => normalizeVirtualPath("/content/../secret"));
  assert.deepEqual(compressionSummary(1_000, 250), {
    originalBytes: 1_000,
    storedBytes: 250,
    savedBytes: 750,
    ratio: 0.25,
    percentSaved: 75,
  });
  assert.equal(entrypointModeForMediaType("video/mp4"), "video");
});

test("canonical Inline graph is the entrypoint and never generates a replacement index.html", async () => {
  const graph = new TextEncoder().encode("QUJDREVGRw");
  const prepared = await prepareStudioArtifact({
    id: "canonical-inline-entry",
    name: "Canonical Inline",
    createdAt: "2026-08-28T00:00:00.000Z",
    assets: [{
      id: "keel-inline-token-uri-fragment",
      fileName: "keel-inline-token-uri.fragment",
      mediaType: "application/vnd.keel.token-uri-base64-fragment",
      role: "entrypoint",
      executable: true,
      entrypoint: true,
      bytes: graph,
    }],
  });
  assert.equal(prepared.manifest.entrypoint.resource, "keel-inline-token-uri-fragment");
  assert.equal(prepared.manifest.entrypoint.mode, "html");
  assert.equal(prepared.resources.some((resource) => resource.fileName === "index.html"), false);
});

test("studio-core wrapper uses virtual content paths only", () => {
  const html = createArtifactWrapper({
    title: "Study",
    mediaType: "image/webp",
    resourcePath: "/content/preview",
    originalPath: "/content/original",
  });
  assert.match(html, /src="\/content\/preview"/u);
  assert.match(html, /href="\/content\/original"/u);
  assert.doesNotMatch(html, /https?:\/\//u);
});

test("ordinary Keel modules select the creator media renderer without owning verification", () => {
  const cases = [
    ["image", "image/png", /<img src="keel:\/\/creator-resource"/u],
    ["video", "video/mp4", /<video src="keel:\/\/creator-resource" controls playsinline>/u],
    ["audio", "audio\/mpeg", /<audio src="keel:\/\/creator-resource" controls>/u],
    ["module", "text\/javascript", /<script type="module" src="keel:\/\/creator-resource"><\/script>/u],
  ];
  for (const [mode, mediaType, expected] of cases) {
    const child = createGeneratedWrapper({
      name: `${mode} creator asset`, resourceId: "creator-resource", mediaType, mode, downloads: false,
    });
    assert.match(child, expected);
    assert.doesNotMatch(child, /keel-proof-toggle|Keel verification shell|ON-CHAIN VERIFIED/u);
  }
});

test("SWF-only projects fail closed with a Ruffle requirement instead of a blocked nested frame", () => {
  const html = createGeneratedWrapper({
    name: "Ghost Circuit",
    resourceId: "ghost-circuit-swf",
    mediaType: "application/x-shockwave-flash",
    mode: "html",
    downloads: true,
  });
  assert.match(html, /Ruffle runtime required/u);
  assert.match(html, /data-keel-flash-runtime="missing"/u);
  assert.doesNotMatch(html, /<iframe\b/iu);
});

test("manifest-declared Flash runtime generates an in-sandbox Ruffle entrypoint", async () => {
  const javascript = new TextEncoder().encode("export const ready = true;");
  const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const prepared = await prepareStudioArtifact({
    id: "flash-runtime",
    name: "Ghost Circuit",
    createdAt: "2026-08-26T00:00:00.000Z",
    assets: [
      { fileName: "GhostCircuit.swf", mediaType: "application/x-shockwave-flash", role: "original", bytes: new Uint8Array([67, 87, 83]) },
      { fileName: "modules/ruffle-loader.js", mediaType: "text/javascript", role: "script", bytes: javascript },
      { fileName: "modules/seeded-random.js", mediaType: "text/javascript", role: "script", bytes: javascript },
      { fileName: "modules/flash-edition.js", mediaType: "text/javascript", role: "script", bytes: javascript },
      { fileName: "runtime/ruffle.js", mediaType: "text/javascript", role: "script", bytes: javascript },
      { fileName: "runtime/core-modern.js", mediaType: "text/javascript", role: "script", bytes: javascript },
      { fileName: "runtime/core-legacy.js", mediaType: "text/javascript", role: "script", bytes: javascript },
      { fileName: "runtime/modern.wasm", mediaType: "application/wasm", role: "script", bytes: wasm },
      { fileName: "runtime/legacy.wasm", mediaType: "application/wasm", role: "script", bytes: wasm },
    ],
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
      previewRootSeed: `0x${"11".repeat(32)}`,
    },
  });
  const entrypoint = prepared.resources.find((resource) => resource.resource.role === "entrypoint");
  const source = new TextDecoder().decode(entrypoint.decodedBytes);
  assert.match(source, /createRuffleLoader/u);
  assert.match(source, /data-keel-flash-runtime="ruffle"/u);
  assert.doesNotMatch(source, /<iframe\b/iu);
  assert.equal(prepared.manifest.extensions["keel:flash"].protocol, "keel-flash@1");
  assert.equal(prepared.manifest.extensions["keel:flash"].collectionSize, 111);
  assert.equal(prepared.manifest.runtime.capabilities.webAssembly, true);
  assert.equal((await verifyPreparedStudioArtifact(prepared)).valid, true);
});

test("studio-core emits a valid strict manifest", async () => {
  const integrity = await createIntegrity(bytes);
  const { manifest } = await buildStudioManifest({
    id: "demo-artifact",
    name: "Demo artifact",
    createdAt: "2026-08-07T00:00:00.000Z",
    entrypointResourceId: "entrypoint",
    entrypointMode: "html",
    fallbackImageResourceId: "preview",
    downloadResourceId: "original",
    attributions: [
      { account: "0x1111111111111111111111111111111111111111", tag: "artist" },
      { account: "0x2222222222222222222222222222222222222222", tag: "engineer" },
    ],
    resources: [
      {
        id: "entrypoint",
        role: "entrypoint",
        mediaType: "text/html",
        originalName: "viewer.html",
        integrity,
        executable: true,
        aliases: ["/content/entrypoint"],
        uri: "./content/entrypoint",
      },
      {
        id: "preview",
        role: "preview",
        mediaType: "image/png",
        originalName: "preview.png",
        integrity,
        aliases: ["/content/preview"],
        uri: "./content/preview",
      },
      {
        id: "original",
        role: "original",
        mediaType: "image/png",
        originalName: "original.png",
        integrity,
        aliases: ["/content/original"],
        uri: "./content/original",
      },
    ],
  });
  assert.equal(manifest.schema, "keel-manifest@2");
  assert.equal(manifest.runtime.content.blockUndeclared, true);
  assert.equal(manifest.runtime.content.externalSources, "host-verified");
  assert.deepEqual(manifest.attributions.map((entry) => entry.tag), ["artist", "engineer"]);
});

test("studio-core requires a verified image fallback for an HTML entrypoint", async () => {
  const integrity = await createIntegrity(bytes);
  await assert.rejects(
    () => buildStudioManifest({
      id: "html-without-preview",
      name: "HTML without preview",
      createdAt: "2026-08-27T00:00:00.000Z",
      entrypointResourceId: "entrypoint",
      entrypointMode: "html",
      resources: [{
        id: "entrypoint",
        role: "entrypoint",
        mediaType: "text/html",
        integrity,
        executable: true,
        uri: "./content/entrypoint",
      }],
    }),
    /requires a verified image fallback/iu,
  );
});

test("studio-core rejects an explicit non-image fallback", async () => {
  const integrity = await createIntegrity(bytes);
  await assert.rejects(
    () => buildStudioManifest({
      id: "html-as-preview",
      name: "HTML as preview",
      createdAt: "2026-08-27T00:00:00.000Z",
      entrypointResourceId: "entrypoint",
      entrypointMode: "html",
      fallbackImageResourceId: "entrypoint",
      resources: [{
        id: "entrypoint",
        role: "entrypoint",
        mediaType: "text/html",
        integrity,
        executable: true,
        uri: "./content/entrypoint",
      }],
    }),
    /not an image media type/iu,
  );
});

test("studio-core uses an image entrypoint as its own fallback", async () => {
  const integrity = await createIntegrity(bytes);
  const { manifest } = await buildStudioManifest({
    id: "image-only",
    name: "Image only",
    createdAt: "2026-08-27T00:00:00.000Z",
    entrypointResourceId: "image",
    entrypointMode: "image",
    resources: [{
      id: "image",
      role: "image",
      mediaType: "image/png",
      integrity,
      uri: "./content/image",
    }],
  });
  assert.equal(manifest.fallback.image, "image");
});

test("studio-core detects parent-hash reorgs", () => {
  const hashA = `0x${"11".repeat(32)}`;
  const hashB = `0x${"22".repeat(32)}`;
  const hashC = `0x${"33".repeat(32)}`;
  const previous = { chainId: 1, blockNumber: 100n, blockHash: hashA, parentHash: hashB };
  const canonical = { chainId: 1, blockNumber: 101n, blockHash: hashC, parentHash: hashA };
  const fork = { chainId: 1, blockNumber: 101n, blockHash: hashC, parentHash: hashB };
  assert.equal(detectReorg(previous, canonical).reorg, false);
  assert.equal(detectReorg(previous, fork).reorg, true);
  assert.equal(eventIdentityKey({ chainId: 1, blockNumber: 101n, transactionHash: hashC, logIndex: 4 }), `1:${hashC}:4`);
});


test("studio-core prepares and verifies exact decoded and compressed bytes", async () => {
  const original = new TextEncoder().encode("Keel ".repeat(4096));
  const prepared = await prepareStudioArtifact({
    id: "prepared-artifact",
    name: "Prepared artifact",
    createdAt: "2026-08-07T00:00:00.000Z",
    attributions: [{ account: "0x3333333333333333333333333333333333333333", tag: "contributor" }],
    assets: [
      {
        fileName: "original.txt",
        mediaType: "text/plain",
        role: "original",
        bytes: original,
      },
    ],
  });
  assert.equal(prepared.manifest.entrypoint.mode, "html");
  assert.equal(prepared.manifest.attributions[0].tag, "contributor");
  assert.deepEqual(prepared.manifest.runtime.determinism, { mode: "live" });
  assert.equal(prepared.stats.resourceCount, 2);
  const originalResource = prepared.resources.find((resource) => resource.fileName === "original.txt");
  assert.deepEqual(originalResource.resource.aliases, ["/content/original.txt"]);
  assert.ok(prepared.stats.storedByteLength < prepared.stats.decodedByteLength);
  assert.equal((await verifyPreparedStudioArtifact(prepared)).valid, true);

  const first = prepared.resources[0];
  assert.ok(first);
  const corruptBytes = first.storedBytes.slice();
  corruptBytes[0] = (corruptBytes[0] ?? 0) ^ 1;
  const corrupt = {
    ...prepared,
    resources: [{ ...first, storedBytes: corruptBytes }, ...prepared.resources.slice(1)],
  };
  const verification = await verifyPreparedStudioArtifact(corrupt);
  assert.equal(verification.valid, false);
  assert.equal(verification.resourcesValid, false);
});

test("studio-core keeps the HTML entrypoint contract-readable for inline presentation", async () => {
  const prepared = await prepareStudioArtifact({
    id: "inline-contract-readable",
    name: "Inline contract readable",
    createdAt: "2026-08-27T00:00:00.000Z",
    assets: [{
      fileName: "index.html",
      mediaType: "text/html",
      role: "entrypoint",
      executable: true,
      entrypoint: true,
      bytes: new TextEncoder().encode("<!doctype html><script>document.body.textContent='keel';</script>"),
    }],
  });
  const entrypoint = prepared.resources.find((resource) => resource.fileName === "index.html");
  assert.equal(entrypoint.compression, "none");
  assert.deepEqual(entrypoint.storedBytes, entrypoint.decodedBytes);
  assert.equal((await verifyPreparedStudioArtifact(prepared)).valid, true);
});

test("studio-core exposes both stable IDs and real file paths to verified viewers", async () => {
  const prepared = await prepareStudioArtifact({
    id: "module-aliases",
    name: "Module aliases",
    createdAt: "2026-08-26T00:00:00.000Z",
    assets: [{
      id: "module-keel-seeded-random",
      fileName: "seeded-random.js",
      mediaType: "text/javascript",
      role: "script",
      executable: true,
      bytes: new TextEncoder().encode("export const seeded = true;"),
    }],
  });
  const moduleResource = prepared.resources.find((resource) => resource.fileName === "seeded-random.js");
  assert.deepEqual(moduleResource.resource.aliases, [
    "/content/module-keel-seeded-random",
    "/content/seeded-random.js",
  ]);
  assert.equal((await verifyPreparedStudioArtifact(prepared)).valid, true);
});

test("studio-core can explicitly prepare a frozen immutable 1/1 artifact", async () => {
  const prepared = await prepareStudioArtifact({
    id: "immutable-three-one",
    name: "Immutable Three One",
    createdAt: "2026-08-24T00:00:00.000Z",
    immutable: true,
    assets: [{
      fileName: "index.html",
      mediaType: "text/html",
      role: "entrypoint",
      entrypoint: true,
      executable: true,
      bytes: new TextEncoder().encode("<canvas></canvas>"),
    }],
  });

  assert.equal(prepared.manifest.revision.number, 1);
  assert.deepEqual(prepared.manifest.revision.compatibility, { min: 1, max: 1 });
  assert.equal(prepared.manifest.revision.policy, "immutable");
  assert.equal(prepared.manifest.revision.frozen, true);
  assert.equal((await verifyPreparedStudioArtifact(prepared)).valid, true);
});

test("studio-core keeps the existing creator revision default when immutable is omitted", async () => {
  const prepared = await prepareStudioArtifact({
    id: "mutable-default",
    name: "Mutable default",
    createdAt: "2026-08-24T00:00:00.000Z",
    assets: [{ fileName: "index.html", mediaType: "text/html", role: "entrypoint", entrypoint: true, bytes: new TextEncoder().encode("<canvas></canvas>") }],
  });

  assert.equal(prepared.manifest.revision.policy, "creator");
  assert.equal(prepared.manifest.revision.frozen, undefined);
});

test("studio-core rejects immutable revisions other than the canonical 1/1 shape", async () => {
  await assert.rejects(
    () => prepareStudioArtifact({
      id: "immutable-revision-two",
      name: "Invalid immutable revision",
      revision: 2,
      immutable: true,
      assets: [{ fileName: "index.html", mediaType: "text/html", role: "entrypoint", entrypoint: true, bytes: new TextEncoder().encode("<canvas></canvas>") }],
    }),
    /immutable artifacts must use revision 1/iu,
  );
});

test("studio-core automatically packs a complete OBJKT ZIP from resolved Keel resources", async () => {
  const prepared = await prepareStudioArtifact({
    id: "objkt-packed",
    name: "Packed Keel scene",
    createdAt: "2026-08-11T00:00:00.000Z",
    assets: [
      { fileName: "scene/viewer.html", mediaType: "text/html", role: "entrypoint", entrypoint: true, executable: true, bytes: new TextEncoder().encode('<script src="./p5.min.js"></script><canvas></canvas>') },
      { fileName: "scene/p5.min.js", mediaType: "text/javascript", role: "library", executable: true, bytes: new TextEncoder().encode("globalThis.p5={version:'test'}") },
      { fileName: "scene/model.glb", mediaType: "model/gltf-binary", role: "model", bytes: Uint8Array.of(0x67, 0x6c, 0x54, 0x46) },
    ],
  });
  const [first, second] = await Promise.all([
    buildKeelObjktExport(prepared, "packed"),
    buildKeelObjktExport(prepared, "packed"),
  ]);
  assert.deepEqual(first.archive, second.archive, "OBJKT export must be byte-deterministic");
  assert.equal(first.sourceManifestDigest, prepared.manifestIntegrity.digest);
  const files = storedZipFiles(first.archive);
  assert.deepEqual([...files.keys()], [
    "index.html", "scene/viewer.html", "scene/p5.min.js", "scene/model.glb", "keel-export.json",
  ]);
  assert.match(new TextDecoder().decode(files.get("index.html")), /src="\.\/scene\/viewer\.html"/u);
  assert.deepEqual(files.get("scene/p5.min.js"), prepared.resources[1].decodedBytes);
  const receipt = JSON.parse(new TextDecoder().decode(files.get("keel-export.json")));
  assert.equal(receipt.sourceManifest.digest, prepared.manifestIntegrity.digest);
  assert.equal(receipt.mode, "packed");
});

test("studio-core hybrid ZIP accepts only a self-verifying Keel entrypoint", async () => {
  const raw = await prepareStudioArtifact({
    id: "objkt-hybrid-hostile",
    name: "Broken hybrid",
    createdAt: "2026-08-11T00:00:00.000Z",
    assets: [{ fileName: "index.html", mediaType: "text/html", role: "entrypoint", entrypoint: true, executable: true, bytes: new TextEncoder().encode("<canvas></canvas>") }],
  });
  await assert.rejects(buildKeelObjktExport(raw, "hybrid"), /self-verifying Keel standalone entrypoint/u);

  const verifier = await prepareStudioArtifact({
    id: "objkt-hybrid",
    name: "Verified hybrid",
    createdAt: "2026-08-11T00:00:00.000Z",
    assets: [{
      fileName: "index.html", mediaType: "text/html", role: "entrypoint", entrypoint: true, executable: true,
      bytes: new TextEncoder().encode('<script id="keel-verification-envelope">{"protocol":"keel-standalone-viewer@1"}</script>'),
    }],
  });
  const output = await buildKeelObjktExport(verifier, "hybrid");
  assert.deepEqual([...storedZipFiles(output.archive).keys()], ["index.html", "keel-export.json"]);
});

test("studio-core rejects uncommitted insecure remote transports", async () => {
  await assert.rejects(
    () => prepareStudioArtifact({
      id: "bad-remote",
      name: "Bad remote",
      assets: [{
        fileName: "asset.bin",
        mediaType: "application/octet-stream",
        bytes: new Uint8Array([1, 2, 3]),
        remoteUri: "http://example.com/asset.bin",
      }],
    }),
    /credential-free HTTPS/u,
  );
});

test("generated composite entrypoints omit the fictional local file source", async () => {
  const shellBytes = new TextEncoder().encode("<shell>");
  const creatorBytes = new TextEncoder().encode("creator");
  const rootBytes = new Uint8Array([...shellBytes, ...creatorBytes]);
  const [shellIntegrity, creatorIntegrity, rootIntegrity] = await Promise.all([
    createIntegrity(shellBytes),
    createIntegrity(creatorBytes),
    createIntegrity(rootBytes),
  ]);
  const prepared = await prepareStudioArtifact({
    id: "canonical-shell-composite",
    name: "Canonical shell composite",
    assets: [
      {
        id: "keel-shell",
        fileName: "keel-shell.fragment",
        mediaType: "application/json",
        role: "library",
        executable: false,
        bytes: shellBytes,
        sourceMode: "additional-only",
        additionalSources: [{
          kind: "onchain",
          chainId: 11_155_111,
          store: `0x${"11".repeat(20)}`,
          objectId: `0x${"22".repeat(32)}`,
          integrity: shellIntegrity,
        }],
      },
      {
        id: "creator-entry",
        fileName: "creator-entry.fragment",
        mediaType: "application/json",
        role: "script",
        executable: false,
        bytes: creatorBytes,
      },
      {
        id: "keel-viewer-root",
        fileName: "keel-viewer-root.html",
        mediaType: "text/html",
        role: "entrypoint",
        entrypoint: true,
        executable: true,
        bytes: rootBytes,
        sourceMode: "additional-only",
        additionalSources: [{
          kind: "composite",
          parts: ["keel-shell", "creator-entry"],
          integrity: rootIntegrity,
        }],
      },
    ],
  });
  assert.deepEqual(prepared.manifest.resources.find((resource) => resource.id === "keel-shell")?.sources.map((source) => source.kind), ["onchain"]);
  assert.deepEqual(prepared.manifest.resources.find((resource) => resource.id === "keel-viewer-root")?.sources.map((source) => source.kind), ["composite"]);
  assert.equal(prepared.manifest.resources.some((resource) => resource.sources.some((source) => source.kind === "uri" && source.uri.endsWith("keel-viewer-root.html"))), false);
});

test("pre-encoded tokenURI fragments remain exact uncompressed contract-readable bytes", async () => {
  const bytes = new TextEncoder().encode("QUJD".repeat(512));
  const prepared = await prepareStudioArtifact({
    id: "prepared-token-uri-fragment",
    name: "Prepared token URI fragment",
    createdAt: "2026-08-27T00:00:00.000Z",
    assets: [{
      id: "keel-inline-token-uri-fragment",
      fileName: "keel-inline-token-uri.fragment",
      mediaType: "application/vnd.keel.token-uri-base64-fragment",
      role: "data",
      executable: false,
      bytes,
    }],
  });
  const fragment = prepared.resources.find((resource) => resource.resource.id === "keel-inline-token-uri-fragment");
  assert.ok(fragment);
  assert.equal(fragment.compression, "none");
  assert.deepEqual(fragment.storedBytes, bytes);
  assert.equal(fragment.storedIntegrity.digest, fragment.decodedIntegrity.digest);
});

test("Keel stores an independently compressed module graph and materializes a directory without ZIP", async () => {
  const prepared = await prepareStudioArtifact({
    id: "keel-module-directory",
    name: "Keel module directory",
    createdAt: "2026-08-11T00:00:00.000Z",
    assets: [
      {
        fileName: "scene/viewer.html",
        mediaType: "text/html",
        role: "entrypoint",
        entrypoint: true,
        executable: true,
        bytes: new TextEncoder().encode('<script type="module" src="./engine.mjs"></script><canvas></canvas>'),
      },
      {
        fileName: "scene/engine.mjs",
        mediaType: "text/javascript",
        role: "library",
        executable: true,
        bytes: new TextEncoder().encode("export const render=()=>document.body.dataset.ready='yes';".repeat(128)),
      },
    ],
  });
  const storage = await buildKeelStorageGraph(prepared);
  assert.equal(storage.graph.protocol, "keel-hold@1");
  assert.equal(storage.graph.resources.length, 2);
  assert.ok(storage.nodes.length >= 2);
  const viewer = storage.graph.resources.find((resource) => resource.path === "scene/viewer.html");
  const engine = storage.graph.resources.find((resource) => resource.path === "scene/engine.mjs");
  assert.deepEqual(viewer.dependencies, [engine.resourceId]);
  assert.equal(engine.compression, "brotli");
  assert.notEqual(engine.decodedIntegrity.digest, engine.storedIntegrity.digest);

  const directory = await buildKeelDirectory(prepared, storage);
  assert.deepEqual(directory.files.map((file) => file.path), [
    "index.html",
    "scene/viewer.html",
    "scene/engine.mjs",
    "keel-hold.json",
  ]);
  assert.match(new TextDecoder().decode(directory.files[0].bytes), /src="\.\/scene\/viewer\.html"/u);
  assert.notEqual(new TextDecoder("ascii").decode(directory.files[0].bytes.subarray(0, 2)), "PK");
  assert.equal(JSON.parse(new TextDecoder().decode(directory.files.at(-1).bytes)).protocol, "keel-directory@1");
});

test("Studio builds one multi-chunk OnchFS directory with Keel bindings to the same bytes", async () => {
  const moduleBytes = new Uint8Array(75_000);
  let state = 0x5eed1234;
  for (let index = 0; index < moduleBytes.length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    moduleBytes[index] = state >>> 24;
  }
  const prepared = await prepareStudioArtifact({
    id: "unified-onchfs-carrier",
    name: "Unified OnchFS carrier",
    createdAt: "2026-08-11T00:00:00.000Z",
    assets: [
      {
        fileName: "index.html",
        mediaType: "text/html",
        role: "entrypoint",
        entrypoint: true,
        executable: true,
        bytes: new TextEncoder().encode('<script type="module" src="./scene.mjs"></script>'),
      },
      {
        fileName: "scene.mjs",
        mediaType: "text/javascript",
        role: "library",
        executable: true,
        bytes: moduleBytes,
      },
    ],
  });
  const storage = await buildKeelStorageGraph(prepared);
  const directory = await buildKeelDirectory(prepared, storage);
  const profile = {
    protocol: "keel-measured-read-profile@1",
    network: "tezos:NetXdQprcVkpaWU",
    contract: "KT1Ae7dT1gsLw2tRnUMXSCmEyF74KVkM6LUo",
    reader: "onchfs-compatible-view@1",
    measuredAt: "2026-08-11T00:00:00.000Z",
    pinnedBlock: "BLkeelcarrierfixture",
    maxFileBytes: 200_000,
    maxDirectoryBytes: 300_000,
    maxFiles: 16,
    evidenceDigest: `0x${"88".repeat(32)}`,
  };
  const [first, second] = await Promise.all([
    buildKeelOnchfsCarrier(directory, profile),
    buildKeelOnchfsCarrier(directory, profile),
  ]);
  assert.equal(first.receipt.documentIntegrity.digest, second.receipt.documentIntegrity.digest);
  assert.equal(first.receipt.rootCid, second.receipt.rootCid);
  assert.match(first.receipt.rootUri, /^onchfs:\/\/tezos:NetXdQprcVkpaWU:KT1Ae7dT1gsLw2tRnUMXSCmEyF74KVkM6LUo\/[0-9a-f]{64}\/$/u);
  assert.ok(first.receipt.metrics.chunks > 1, "fixture must exercise multiple on-chain chunks");
  assert.equal(first.receipt.metrics.bindings, directory.files.length);
  assert.equal(first.receipt.metrics.operations, first.document.inscriptions.length + directory.files.length);
  for (const file of directory.files) {
    const binding = first.receipt.objects.find((object) => object.path === file.path);
    assert.ok(binding, `missing Keel binding for ${file.path}`);
    assert.equal(binding.decodedIntegrity.digest, file.integrity.digest);
    assert.equal(binding.decodedIntegrity.byteLength, file.bytes.byteLength);
  }
  assert.notEqual(new TextDecoder("ascii").decode(directory.files[0].bytes.subarray(0, 2)), "PK");
});

test("delivery planning uses measured OnchFS limits and moves larger directories to IPFS without changing storage", async () => {
  const prepared = await prepareStudioArtifact({
    id: "delivery-plan",
    name: "Delivery plan",
    createdAt: "2026-08-11T00:00:00.000Z",
    assets: [{ fileName: "index.html", mediaType: "text/html", bytes: new TextEncoder().encode("<!doctype html><p>measured</p>"), entrypoint: true }],
  });
  const storage = await buildKeelStorageGraph(prepared);
  const directory = await buildKeelDirectory(prepared, storage);
  const measured = {
    protocol: "keel-measured-read-profile@1",
    network: "tezos:NetXsqzbfFenSTS",
    contract: "KT1MeasuredFacade",
    reader: "onchfs-compatible-view@1",
    measuredAt: "2026-08-11T00:00:00.000Z",
    pinnedBlock: "BLexample",
    maxFileBytes: 100_000,
    maxDirectoryBytes: 200_000,
    maxFiles: 32,
    evidenceDigest: `0x${"77".repeat(32)}`,
  };
  const native = planKeelDelivery({ storage, directory, onchfsProfile: measured, ipfsAvailable: true });
  assert.equal(native.canonical, "keel");
  assert.equal(native.recommended, "onchfs");
  assert.equal(native.onchfs.eligible, true);

  const tooSmall = planKeelDelivery({ storage, directory, onchfsProfile: { ...measured, maxFileBytes: 1 }, ipfsAvailable: true, generateZipCompatibility: true });
  assert.equal(tooSmall.recommended, "ipfs");
  assert.equal(tooSmall.onchfs.eligible, false);
  assert.equal(tooSmall.zip.kind, "generated-compatibility-only");
  assert.equal(tooSmall.storageGraph.digest, native.storageGraph.digest);
});

test("cross-chain Module Catalog merges byte-identical carriers and rejects version collisions", async () => {
  const moduleBytes = new TextEncoder().encode("export const REVISION='r180';");
  const identity = { namespace: "npm", name: "three", version: "0.180.0", entry: "build/three.module.min.js" };
  const ethereum = await createKeelModuleRelease({
    identity,
    bytes: moduleBytes,
    mediaType: "text/javascript",
    format: "es-module",
    license: "MIT",
    carriers: [{ kind: "keel", network: "eip155:1", store: "0x1111111111111111111111111111111111111111", objectId: `0x${"22".repeat(32)}`, reader: "recursive-object@1" }],
  });
  const tezos = await createKeelModuleRelease({
    identity,
    bytes: moduleBytes,
    mediaType: "text/javascript",
    format: "es-module",
    license: "MIT",
    carriers: [
      { kind: "keel", network: "tezos:NetXdQprcVkpaWU", store: "KT1KeelModuleStore", objectId: `0x${"33".repeat(32)}`, reader: "recursive-object@1" },
      { kind: "onchfs", network: "tezos:NetXdQprcVkpaWU", contract: "KT1KeelModuleStore", cid: "44".repeat(32), path: "build/three.module.min.js" },
    ],
  });
  const built = await buildKeelModuleCatalog([ethereum, tezos]);
  assert.equal(built.catalog.releases.length, 1);
  assert.deepEqual(searchKeelModuleCatalog(built.catalog, "three 180")[0].carrierKinds, ["keel", "onchfs"]);
  assert.equal(selectKeelModuleCarrier(built.catalog.releases[0]).kind, "keel");

  const hostile = await createKeelModuleRelease({
    identity,
    bytes: new TextEncoder().encode("export const REVISION='hostile';"),
    mediaType: "text/javascript",
    format: "es-module",
  });
  await assert.rejects(buildKeelModuleCatalog([ethereum, hostile]), /different bytes or formats/u);
});

test("built-in media profiles create exact WebP derivative receipts", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const result = await buildKeelWebpDerivative({
    sourceResourceId: "cover",
    outputResourceId: "cover-webp",
    sourceBytes: new Uint8Array(png),
    profile: "preview-webp-512-v1",
  });
  assert.equal(new TextDecoder("ascii").decode(result.bytes.subarray(0, 4)), "RIFF");
  assert.equal(new TextDecoder("ascii").decode(result.bytes.subarray(8, 12)), "WEBP");
  assert.equal(result.receipt.protocol, "keel-media-derivative@1");
  assert.equal(result.receipt.outputMediaType, "image/webp");
  assert.equal(result.receipt.outputResourceId, "cover-webp");
  assert.equal(result.receipt.outputWidth, 1);
  assert.equal(result.receipt.outputHeight, 1);
  assert.match(result.receipt.transform.recipeDigest, /^0x[0-9a-f]{64}$/u);
});

test("prepared manifests commit generated media derivatives and exact output resources", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const prepared = await prepareStudioArtifact({
    id: "derivative-artifact",
    name: "Derivative artifact",
    createdAt: "2026-08-11T00:00:00.000Z",
    assets: [{ id: "cover", fileName: "cover.png", mediaType: "image/png", role: "original", bytes: new Uint8Array(png) }],
    mediaDerivativeProfiles: ["preview-webp-512-v1"],
  });
  const receipt = prepared.manifest.mediaDerivatives?.[0];
  assert.ok(receipt);
  assert.equal(receipt.sourceResourceId, "cover");
  assert.equal(receipt.outputResourceId, "derivative:preview-webp-512-v1");
  const output = prepared.resources.find((item) => item.resource.id === receipt.outputResourceId);
  assert.ok(output);
  assert.equal(output.decodedIntegrity.digest, receipt.outputIntegrity.digest);
  assert.equal((await verifyPreparedStudioArtifact(prepared)).valid, true);

  const hostile = structuredClone(prepared.manifest);
  hostile.mediaDerivatives[0].outputIntegrity.digest = `0x${"ff".repeat(32)}`;
  assert.throws(() => assertValidManifest(hostile), /Derivative output commitment/u);
});
