import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  KEEL_THREE_R180,
  assertKeelThreeR180OfficialBytes,
  createKeelThreeR180ModuleIndex,
  declareKeelThreeR180BrowserModules,
} from "../packages/sdk/dist/index.js";
import { isBrowserModuleDescriptorVerified } from "../packages/sdk/dist/module/index.js";
import {
  buildKeelModuleCatalog,
  createKeelModuleRelease,
  searchKeelModuleCatalog,
} from "../packages/studio-core/dist/index.js";

const HOLD = "0x0a4f31d5ab08029e4c68f6f3227d9fa3a2d66267";
const MAIN_OBJECT = `0x${"1".repeat(64)}`;
const CORE_OBJECT = `0x${"2".repeat(64)}`;

async function officialThreeR180Bytes() {
  const [keelMain, core] = await Promise.all([
    readFile("examples/demos/vendor/three.min.js", "utf8"),
    readFile("examples/demos/vendor/three.core.min.js"),
  ]);
  // The demo's maintained sandbox copy only changes this relative import to a
  // content alias. The shared module itself stays byte-identical to upstream.
  return {
    main: new TextEncoder().encode(keelMain.replaceAll('from"/content/three.core.min.js"', 'from"./three.core.min.js"')),
    core: new Uint8Array(core),
  };
}

test("Three r180 pins the official two-file ESM graph and rejects a rewritten or partial source", async () => {
  const bytes = await officialThreeR180Bytes();
  assert.deepEqual(await assertKeelThreeR180OfficialBytes(bytes), KEEL_THREE_R180);
  assert.equal(new TextDecoder().decode(bytes.main).includes('/content/three.core.min.js'), false);
  await assert.rejects(
    () => assertKeelThreeR180OfficialBytes({ ...bytes, main: bytes.main.subarray(0, bytes.main.byteLength - 1) }),
    /main.*digest|main.*byte length/u,
  );
});

test("Three r180 is declared as two exact current-chain shared modules, never creator bytes", async () => {
  const index = createKeelThreeR180ModuleIndex({
    chainId: 11155111,
    store: HOLD,
    mainObjectId: MAIN_OBJECT,
    coreObjectId: CORE_OBJECT,
  });
  const modules = declareKeelThreeR180BrowserModules(index);

  assert.deepEqual(modules.main.module.carrier, {
    moduleId: KEEL_THREE_R180.main.id,
    version: KEEL_THREE_R180.version,
    digest: KEEL_THREE_R180.main.digest,
    objectId: MAIN_OBJECT,
    store: HOLD,
    chain: "eip155:11155111",
  });
  assert.deepEqual(modules.main.module.dependencies, [`${KEEL_THREE_R180.core.id}@${KEEL_THREE_R180.version}`]);
  assert.equal(modules.main.descriptor.key, "three");
  assert.equal(modules.core.descriptor.key, "threeCore");
  assert.equal(isBrowserModuleDescriptorVerified(modules.main.descriptor), false);
  assert.equal(isBrowserModuleDescriptorVerified(modules.core.descriptor), false);
  assert.throws(
    () => createKeelThreeR180ModuleIndex({ chainId: 1, store: HOLD, mainObjectId: MAIN_OBJECT, coreObjectId: CORE_OBJECT }),
    /Sepolia/u,
  );
});

test("Three r180 is discoverable as a KEEL catalog release without pretending an unbound chain has it", async () => {
  const bytes = await officialThreeR180Bytes();
  const [main, core] = await Promise.all([
    createKeelModuleRelease({
      identity: KEEL_THREE_R180.main.identity,
      bytes: bytes.main,
      mediaType: KEEL_THREE_R180.mediaType,
      format: "es-module",
      license: KEEL_THREE_R180.license,
      sourceRepository: KEEL_THREE_R180.main.sourceUrl,
      carriers: [],
    }),
    createKeelModuleRelease({
      identity: KEEL_THREE_R180.core.identity,
      bytes: bytes.core,
      mediaType: KEEL_THREE_R180.mediaType,
      format: "es-module",
      license: KEEL_THREE_R180.license,
      sourceRepository: KEEL_THREE_R180.core.sourceUrl,
      carriers: [],
    }),
  ]);
  const catalog = await buildKeelModuleCatalog([main, core]);
  const result = searchKeelModuleCatalog(catalog.catalog, "three 180");
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "three");
  assert.equal(result[0].versions.length, 2);
  assert.deepEqual(result[0].carrierKinds, []);
});

test("network-denied rotating cube references the shared Three module and carries no Three engine bytes", async () => {
  const fixtureRoot = "examples/fixtures/three-r180-rotating-cube";
  const [fixtureText, html, scene] = await Promise.all([
    readFile(`${fixtureRoot}/keel.fixture.json`, "utf8"),
    readFile(`${fixtureRoot}/index.html`, "utf8"),
    readFile(`${fixtureRoot}/scene.mjs`, "utf8"),
  ]);
  const fixture = JSON.parse(fixtureText);
  assert.equal(fixture.network, "denied");
  assert.deepEqual(fixture.creatorResources, ["index.html", "scene.mjs", "fixture-probe.mjs"]);
  assert.deepEqual(fixture.externalModules.map((module) => module.id), ["three-r180-module", "three-r180-core"]);
  assert.match(scene, /from "\/content\/three\.module\.min\.js"/u);
  assert.doesNotMatch(`${html}\n${scene}`, /https?:\/\/|fetch\(|WebSocket|XMLHttpRequest|class WebGLRenderer/u);
  assert.ok(new TextEncoder().encode(`${html}\n${scene}`).byteLength < 2_500);
});

test("unsigned Sepolia quote stays bounded to 23KB chunks, three carriers per executor transaction, and no fee or wallet action", async () => {
  const quote = JSON.parse(await readFile("examples/fixtures/three-r180-rotating-cube/three-r180.sepolia.native-publication.quote.json", "utf8"));
  assert.equal(quote.status, "READY_FOR_REVIEW");
  assert.equal(quote.route, "native-carrier-v1");
  assert.equal(quote.chain.chainId, 11155111);
  assert.equal(quote.deduplication.schema, "keel-three-r180-sepolia-evidence@1");
  assert.equal(quote.deduplication.outcome, "absent");
  assert.equal(quote.deduplication.range.to.number, quote.deduplication.range.head.number);
  assert.match(quote.deduplication.range.head.hash, /^0x[0-9a-f]{64}$/u);
  assert.deepEqual(quote.deduplication.modules.map((module) => module.currentStoreMatch), [false, false]);
  assert.deepEqual(quote.source.modules.map((module) => module.digest), [KEEL_THREE_R180.main.digest, KEEL_THREE_R180.core.digest]);
  assert.deepEqual(quote.source.modules.map((module) => module.compression), ["brotli", "brotli"]);
  assert.equal(quote.packing.maxChunkBytes, 23_000);
  assert.equal(quote.packing.maxCarriersPerExecutorTransaction, 3);
  assert.equal(quote.packing.totalChunks, 7);
  assert.ok(quote.packing.carrierBatches.every((batch) => batch.chunkByteLengths.length <= 3));
  assert.ok(quote.packing.carrierBatches.flatMap((batch) => batch.chunkByteLengths).every((length) => length > 0 && length <= 23_000));
  assert.equal(quote.gas.executorEscrowWei, null);
  assert.equal(quote.gas.actualTransactionFeeWei, null);
  assert.equal(quote.wallet.approval, "not-requested");
  assert.equal(quote.wallet.submitted, false);
});
