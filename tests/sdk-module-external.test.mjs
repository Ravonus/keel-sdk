import assert from "node:assert/strict";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SDK_ROOT = path.join(ROOT, "packages", "sdk");
const MODULE = pathToFileURL(path.join(SDK_ROOT, "dist", "module", "index.js")).href;
const EXTERNAL_SOURCE = path.join(SDK_ROOT, "src", "module", "external.ts");
const requireFromSdk = createRequire(path.join(SDK_ROOT, "package.json"));
const hash = (text) => `sha256:${crypto.createHash("sha256").update(text).digest("hex")}`;
const DIGEST = hash("module bytes");
const RECEIPT = hash("source receipt");
const OBJECT_ID = `0x${"a".repeat(64)}`;
const SPEC = `0x${"b".repeat(64)}`;
const REVIEW = `0x${"c".repeat(64)}`;
const BLOCK = `0x${"d".repeat(64)}`;

function entry(sdk, overrides = {}) {
  const fields = {
    id: "artist-tools",
    version: "1.2.3",
    publisher: "keel.example/artist",
    digest: DIGEST,
    byteLength: 12,
    mediaType: "text/javascript",
    objectId: OBJECT_ID,
    store: "keel://objects",
    chain: "eip155:11155111",
    sourceReceiptId: "build-42",
    sourceReceiptDigest: RECEIPT,
    reviewSpecDigest: SPEC,
    reviewDigest: REVIEW,
    isolation: "shared-library",
    provenance: "publisher-attested",
    dependencies: ["color-core@1.0.0"],
    ...overrides,
  };
  return sdk.externalModuleIndexEntry(
    fields.id,
    fields.version,
    fields.publisher,
    fields.digest,
    fields.byteLength,
    fields.mediaType,
    fields.objectId,
    fields.store,
    fields.chain,
    fields.sourceReceiptId,
    fields.sourceReceiptDigest,
    fields.reviewSpecDigest,
    fields.reviewDigest,
    fields.isolation,
    fields.provenance,
    ...fields.dependencies,
  );
}

test("the local index is immutable provenance only, with deterministic code-unit search", async () => {
  const sdk = await import(MODULE);
  const artist = entry(sdk);
  const sideEffect = entry(sdk, {
    id: "install-theme",
    publisher: "keel.example/theme",
    objectId: `0x${"e".repeat(64)}`,
    isolation: "side-effect",
    provenance: "unverified",
    reviewSpecDigest: undefined,
    reviewDigest: undefined,
    dependencies: [],
  });
  const first = sdk.createExternalModuleIndex(artist, sideEffect);
  const second = sdk.createExternalModuleIndex(sideEffect, artist);
  const [result] = sdk.searchExternalModules(first, sdk.externalModuleQuery("artist-tools", "1.2.3"));

  assert.deepEqual(result, {
    id: "artist-tools",
    version: "1.2.3",
    publisher: "keel.example/artist",
    objectId: OBJECT_ID,
    digest: DIGEST,
    carrier: {
      moduleId: "artist-tools",
      version: "1.2.3",
      digest: DIGEST,
      objectId: OBJECT_ID,
      store: "keel://objects",
      chain: "eip155:11155111",
    },
    sourceReceipt: { id: "build-42", digest: RECEIPT },
    dependencies: ["color-core@1.0.0"],
    isolation: "shared-library",
    verification: "publisher-attested",
    review: { kind: "provenance-only" },
  });
  assert.equal(Object.isFrozen(artist), true);
  assert.equal(Object.isFrozen(artist.output), true);
  assert.equal(Object.isFrozen(artist.dependencies), true);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(result), true);
  assert.equal("current" in result, false);
  assert.equal("revoked" in result, false);
  assert.deepEqual(sdk.searchExternalModules(first), sdk.searchExternalModules(second));
  assert.deepEqual(
    sdk.searchExternalModules(first, sdk.externalModuleQuery(undefined, undefined, undefined, undefined, undefined, "ARTIST")),
    [result],
  );
  assert.deepEqual(sdk.searchExternalModules(first, sdk.externalModuleQuery(undefined, undefined, undefined, undefined, "unverified")), [
    sdk.searchExternalModules(first, sdk.externalModuleQuery("install-theme", "1.2.3"))[0],
  ]);
  assert.throws(() => sdk.externalModuleIndexEntry(
    "bad", "1.0.0", "keel.example/bad", DIGEST, 1, "text/javascript", OBJECT_ID, "keel://objects", "eip155:1",
    "receipt", RECEIPT, undefined, undefined, "shared-library", "unverified", "z", "a",
  ), /strict UTF-16/u);
});

test("publishable browser modules fail closed unless every module is bound to the target chain", async () => {
  const sdk = await import(MODULE);
  const unresolved = sdk.browserModule("unresolved@1.0.0", { as: "unresolved", api: sdk.moduleApi() });
  assert.throws(
    () => sdk.defineModule("Unresolved", {
      target: "@keel/eth/eip155:11155111/browser",
      extends: [unresolved],
    }),
    /not resolved to an on-chain carrier/u,
  );

  const sepolia = sdk.customExternalBrowserModule(
    sdk.createExternalModuleIndex(entry(sdk, { store: `0x${"1".repeat(40)}` })),
    "artist-tools",
    "1.2.3",
    sdk.moduleApi(),
    "tools",
  );
  assert.throws(() => sdk.defineModule("Unverified", {
    target: "@keel/eth/eip155:11155111/browser",
    extends: [sepolia.descriptor],
  }), /has not passed an exact on-chain byte read/u);

  const originalFetch = globalThis.fetch;
  const bytes = Buffer.from("module bytes");
  const abiBytes = `0x${(32n).toString(16).padStart(64, "0")}${BigInt(bytes.length).toString(16).padStart(64, "0")}${bytes.toString("hex").padEnd(64, "0")}`;
  globalThis.fetch = async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: abiBytes }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  try {
    await sdk.verifyExternalBrowserModuleOnchain(sepolia, "https://ethereum-sepolia-rpc.publicnode.com");
  } finally {
    globalThis.fetch = originalFetch;
  }
  const project = sdk.defineModule("Resolved", {
    target: "@keel/eth/eip155:11155111/browser",
    extends: [sepolia.descriptor],
  });
  assert.deepEqual(project.manifest.moduleBindings, [sepolia.module.carrier]);

  assert.throws(
    () => sdk.defineModule("Wrong chain", {
      target: "@keel/eth/eip155:1/browser",
      extends: [sepolia.descriptor],
    }),
    /resolved on eip155:11155111.*targets eip155:1/u,
  );
});

test("typed custom and raw lanes stay separate, while unsupported legacy options fail without reads", async () => {
  const sdk = await import(MODULE);
  const custom = entry(sdk);
  const sideEffect = entry(sdk, {
    id: "install-theme",
    objectId: `0x${"e".repeat(64)}`,
    isolation: "side-effect",
    provenance: "unverified",
    reviewSpecDigest: undefined,
    reviewDigest: undefined,
    dependencies: [],
  });
  const index = sdk.createExternalModuleIndex(custom, sideEffect);
  const typed = sdk.customExternalBrowserModule(index, "artist-tools", "1.2.3", sdk.moduleApi(), "tools");
  const raw = sdk.rawBrowserModule(index, "install-theme", "1.2.3", "theme");
  assert.equal(typed.module.verification, "publisher-attested");
  assert.equal(raw.module.verification, "unverified");
  assert.equal(raw.module.isolation, "side-effect");
  assert.equal(typed.descriptor.key, "tools");
  assert.equal(raw.descriptor.key, "theme");
  assert.throws(() => sdk.customExternalBrowserModule(index, "install-theme", "1.2.3", sdk.moduleApi()), /side-effect/u);
  assert.throws(() => sdk.rawBrowserModule(index, "artist-tools", "1.2.3"), /side-effect/u);
  assert.throws(() => sdk.reviewedBrowserModule(index, "install-theme", "1.2.3", sdk.moduleApi()), /side-effect/u);
  assert.throws(() => sdk.reviewedBrowserModule(index, "artist-tools", "1.2.3", sdk.moduleApi()), /opaque current review-registry observation/u);

  let proxyGets = 0;
  const legacyOptions = new Proxy({ as: "tools", api: sdk.moduleApi() }, {
    get() { proxyGets += 1; throw new Error("must not read caller options"); },
  });
  assert.throws(() => sdk.customExternalBrowserModule(index, "artist-tools", "1.2.3", legacyOptions), /module API name|module api must be created/u);
  assert.equal(proxyGets, 0);
  assert.throws(() => sdk.rawBrowserModule(index, "install-theme", "1.2.3", legacyOptions), /positional string/u);
  assert.equal(proxyGets, 0);
});

test("no caller authored object, array, booleans, resolver, or Proxy can self-brand review evidence", async () => {
  const sdk = await import(MODULE);
  const artist = entry(sdk);
  const index = sdk.createExternalModuleIndex(artist);
  assert.equal("createKeelVerifiedEvidence" in sdk, false);
  assert.equal("keelVerifiedBrowserModule" in sdk, false);
  assert.equal("keelVerifiedEvidence" in sdk, false);
  assert.throws(() => sdk.createExternalModuleIndex([artist]), /created with externalModuleIndexEntry/u);
  assert.throws(() => sdk.withKeelModuleReviewRegistryObservations(index, {
    id: artist.id,
    version: artist.version,
    digest: artist.output.digest,
    objectId: artist.carrier.objectId,
    review: {
      kind: "keel-module-review-registry",
      trustBoundary: "governed-rpc-read-at-canonical-block",
      chain: "eip155:11155111",
      registry: "0x1111111111111111111111111111111111111111",
      blockHash: BLOCK,
      specDigest: SPEC,
      reviewDigest: REVIEW,
    },
  }), /returned by observe/u);

  let reads = 0;
  const trap = new Proxy({}, {
    get() { reads += 1; throw new Error("get trap"); },
    ownKeys() { reads += 1; throw new Error("ownKeys trap"); },
    getPrototypeOf() { reads += 1; throw new Error("prototype trap"); },
  });
  assert.throws(() => sdk.createExternalModuleIndex(trap), /created with externalModuleIndexEntry/u);
  assert.throws(() => sdk.searchExternalModules(trap), /created with createExternalModuleIndex/u);
  assert.throws(() => sdk.searchExternalModules(index, trap), /created with externalModuleQuery/u);
  assert.throws(() => sdk.withKeelModuleReviewRegistryObservations(index, trap), /returned by observe/u);
  await assert.rejects(() => sdk.observeKeelModuleReviewRegistry(trap, artist, BLOCK), /created with createKeelModuleReviewRegistryReader/u);
  assert.equal(reads, 0, "opaque-brand lookups must not inspect caller proxies");

  assert.throws(() => sdk.createKeelModuleReviewRegistryReader(0, "0x1111111111111111111111111111111111111111", "https://example.invalid"), /chainId/u);
  assert.throws(() => sdk.createKeelModuleReviewRegistryReader(1, "bad", "https://example.invalid"), /address/u);
});

test("strict source boundary has no object introspection, locale comparator, or raw Keel-verified constructor", async () => {
  const source = await readFile(EXTERNAL_SOURCE, "utf8");
  assert.doesNotMatch(source, /Object\.getPrototypeOf|Reflect\.ownKeys|Object\.getOwnPropertyDescriptors|structuredClone|\.localeCompare/u);
  assert.doesNotMatch(source, /createKeelVerifiedEvidence|keelVerifiedBrowserModule|current\s*:/u);
  assert.match(source, /moduleAuthorized/u);
  assert.match(source, /bindingsMatch/u);
  assert.match(source, /submission/u);
  assert.match(source, /review/u);
  assert.match(source, /0xedb960c2/u);
  assert.match(source, /0x76e89920/u);
  assert.match(source, /0x24ce1c3f/u);
  assert.match(source, /0x9028d8b0/u);
  assert.match(source, /governed-rpc-read-at-canonical-block/u);
  assert.match(source, /review-registry-observed/u);
});

test("external declaration types preserve custom APIs and force raw side effects to unknown", { timeout: 30_000 }, async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "keel-external-module-types-"));
  try {
    const linkedSdk = path.join(fixture, "node_modules", "@keel", "sdk");
    await mkdir(path.dirname(linkedSdk), { recursive: true });
    await symlink(SDK_ROOT, linkedSdk, "dir");
    await writeFile(path.join(fixture, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(path.join(fixture, "entry.ts"), [
      'import { createExternalModuleIndex, customExternalBrowserModule, defineModule, externalModuleIndexEntry, moduleApi, rawBrowserModule } from "@keel/sdk/module";',
      'const hash = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";',
      'const objectId = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";',
      'const tools = externalModuleIndexEntry("tools", "1.0.0", "example/tools", hash, 1, "text/javascript", objectId, "keel://objects", "eip155:1", "build", hash, undefined, undefined, "shared-library", "publisher-attested");',
      'const theme = externalModuleIndexEntry("theme", "1.0.0", "example/theme", hash, 1, "text/javascript", objectId, "keel://objects", "eip155:1", "build", hash, undefined, undefined, "side-effect", "unverified");',
      'const index = createExternalModuleIndex(tools, theme);',
      'const typed = customExternalBrowserModule(index, "tools", "1.0.0", moduleApi<{ readonly palette: string }>(), "tools");',
      'const raw = rawBrowserModule(index, "theme", "1.0.0", "theme");',
      'export default defineModule("External", { target: "@keel/eth/sepolia", extends: [typed.descriptor, raw.descriptor], init({ tools, theme }) {',
      '  const palette: string = tools.palette;',
      '  void palette;',
      '  // @ts-expect-error raw side effects intentionally expose unknown.',
      '  theme.install();',
      '} });',
    ].join("\n"));
    await writeFile(path.join(fixture, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: false },
      include: ["entry.ts"],
    }));
    const tsc = path.join(ROOT, "node_modules", ".bin", "tsc");
    const result = spawnSync(tsc, ["-p", path.join(fixture, "tsconfig.json")], { encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("external module APIs remain browser-bundleable without Node implementation code", { timeout: 30_000 }, async () => {
  const { build } = await import(requireFromSdk.resolve("esbuild"));
  const fixture = await mkdtemp(path.join(os.tmpdir(), "keel-external-module-browser-"));
  try {
    const linkedSdk = path.join(fixture, "node_modules", "@keel", "sdk");
    await mkdir(path.dirname(linkedSdk), { recursive: true });
    await symlink(SDK_ROOT, linkedSdk, "dir");
    await writeFile(path.join(fixture, "entry.js"), [
      'import { createExternalModuleIndex, createKeelModuleReviewRegistryReader, externalModuleIndexEntry } from "@keel/sdk/module";',
      'const digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";',
      'const objectId = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";',
      'const entry = externalModuleIndexEntry("tools", "1.0.0", "example/tools", digest, 1, "text/javascript", objectId, "keel://objects", "eip155:1", "build", digest, undefined, undefined, "shared-library", "unverified");',
      'globalThis.externalModuleIndex = createExternalModuleIndex(entry);',
      'globalThis.createReviewReader = createKeelModuleReviewRegistryReader;',
    ].join("\n"));
    const output = path.join(fixture, "out.js");
    const result = await build({
      entryPoints: [path.join(fixture, "entry.js")],
      bundle: true,
      platform: "browser",
      format: "esm",
      outfile: output,
      logLevel: "silent",
      metafile: true,
    });
    assert.deepEqual(result.warnings, []);
    const source = await readFile(output, "utf8");
    assert.doesNotMatch(source, /node:|child_process|worker_threads|verification-shell|onchaininator/iu);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
