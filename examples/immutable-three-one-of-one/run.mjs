import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chooseSmallestCompression, decompressBytes } from "../../packages/builder/dist/index.js";
import {
  KEEL_NATIVE_CHUNK_BYTES,
  KEEL_NATIVE_CHUNKS_PER_TRANSACTION,
  buildKeelImmutableThreeScenePublicationPlan,
  bundleKeelThreeScene,
} from "../../packages/sdk/dist/index.js";
import { createSandboxDocument, resolveArtifact } from "../../packages/viewer/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const demo = resolve(here, "../demos/three-vault");
const vendor = resolve(here, "../demos/vendor/three.min.js");
const configuration = JSON.parse(await readFile(resolve(here, "keel.modules.json"), "utf8"));

const requiredModules = configuration.modules.filter((module) => module.required);
for (const module of requiredModules) {
  assert.ok(module.address ?? module.package, `Required module ${module.id} has no declaration.`);
}
assert.equal(configuration.publication.storageMode, "native-carrier-v1");
assert.equal(configuration.publication.maxChunkBytes, KEEL_NATIVE_CHUNK_BYTES);
assert.equal(configuration.publication.maxChunksPerCarrierTransaction, KEEL_NATIVE_CHUNKS_PER_TRANSACTION);
assert.equal(configuration.publication.immutable, true);
assert.equal(configuration.publication.editionSize, 1);

const [html, sceneSource, seedBytes, threeBytes] = await Promise.all([
  readFile(resolve(demo, "index.html"), "utf8"),
  readFile(resolve(demo, "scene.js"), "utf8"),
  readFile(resolve(demo, "scene-seed.mjs")),
  readFile(vendor),
]);
const declaredSceneModules = [
  { id: "three.min.js", bytes: threeBytes, mediaType: "text/javascript" },
  { id: "scene-seed.mjs", bytes: seedBytes, mediaType: "text/javascript" },
];
const decodedScene = bundleKeelThreeScene({
  html,
  entrypointId: "scene.js",
  entrypointSource: sceneSource,
  modules: declaredSceneModules,
});
const selected = await chooseSmallestCompression(decodedScene);

const hold = configuration.modules.find(({ id }) => id === "keel-hold").address;
const index = configuration.modules.find(({ id }) => id === "keel-index").address;
const factory = configuration.modules.find(({ id }) => id === "keel-factory").address;
const plan = await buildKeelImmutableThreeScenePublicationPlan({
  chainId: configuration.chain.id,
  owner: configuration.fixture.owner,
  executor: configuration.fixture.owner,
  hold,
  deadline: 4_102_444_800n,
  scene: {
    id: "vault-of-the-fallen-one-of-one",
    name: configuration.name,
    description: "One immutable Three.js scene verified by the default KEEL viewer and sandbox.",
    bytes: decodedScene,
    storedBytes: selected.bytes,
    compression: selected.compression,
    mediaType: "text/html",
    modules: declaredSceneModules,
  },
  token: {
    collection: configuration.fixture.predictedCollection,
    factory,
    index,
    publicationJobDeployed: false,
    name: "Vault Of The Fallen",
    symbol: "KEEL1",
  },
});

const resolved = await resolveArtifact(plan.viewer.manifest, {
  commitment: { integrity: plan.viewer.integrity, digestVerified: true },
  adapters: {
    readOnchainObject: async (request) => {
      assert.equal(request.chainId, configuration.chain.id);
      assert.equal(request.store, hold);
      assert.equal(request.objectId, plan.sceneObjectId);
      return selected.bytes;
    },
    decompress: (compression, bytes) => decompressBytes(compression, bytes),
  },
});
const sandbox = createSandboxDocument(resolved);

assert.equal(resolved.entrypoint.verified, true);
assert.deepEqual(resolved.entrypoint.bytes, decodedScene);
assert.equal(plan.viewer.manifest.revision.policy, "immutable");
assert.equal(plan.viewer.manifest.revision.frozen, true);
assert.equal(plan.viewer.manifest.runtime.sandbox, "strict");
assert.deepEqual(plan.viewer.manifest.runtime.capabilities, {});
assert.match(sandbox.csp, /(?:^|; )connect-src blob:(?:;|$)/u);
assert.deepEqual(sandbox.sandboxTokens, ["allow-scripts"]);
assert.equal(plan.walletSendCalls.method, "wallet_sendCalls");
assert.equal(plan.walletStatusRequest.method, "wallet_getCallsStatus");
assert.equal(plan.token.maxSupply, 1n);
assert.equal(plan.token.managedBlocker, "publication-job-not-deployed");
assert.equal(plan.publication.gas.executorControlGas, 0);
assert.equal(plan.viewer.manifestPublication.gas.executorControlGas, 0);

const gas = [plan.publication.gas, plan.viewer.manifestPublication.gas];
const sum = (field) => gas.reduce((total, item) => total + item[field], 0);
const proof = {
  schema: "keel-publication-harness-proof@1",
  status: "passed",
  chain: configuration.chain,
  modules: configuration.modules.map(({ id, kind, required, address, package: packageName, status }) => ({
    id,
    kind,
    required,
    declared: Boolean(address ?? packageName),
    ...(status === undefined ? {} : { status }),
  })),
  artifact: {
    name: configuration.name,
    edition: plan.edition,
    immutable: plan.immutable,
    storageMode: plan.storageMode,
    decodedBytes: decodedScene.byteLength,
    storedBytes: selected.bytes.byteLength,
    compression: selected.compression,
    sceneObjectId: plan.sceneObjectId,
    manifestObjectId: plan.viewer.manifestObjectId,
    manifestDigest: plan.viewer.integrity.digest,
    manifestURI: plan.viewer.manifestURI,
  },
  batching: {
    chunkBytes: KEEL_NATIVE_CHUNK_BYTES,
    maxChunksPerCarrierTransaction: KEEL_NATIVE_CHUNKS_PER_TRANSACTION,
    sceneChunks: plan.publication.gas.chunkCount,
    manifestChunks: plan.viewer.manifestPublication.gas.chunkCount,
    carrierTransactions: sum("carrierTransactionCount"),
    logicalObjectOperations: 2,
    tokenPresentationOperations: plan.token.logicalOperationCount,
    walletApprovalRequests: 1,
    walletCallCount: plan.walletSendCalls.params[0].calls.length,
    ethereumTransactions: "wallet-dependent-one-or-more",
    executorTransactions: 0,
  },
  gas: {
    scope: "native scene and manifest storage lane only",
    calldataIntrinsicGas: sum("calldataIntrinsicGas"),
    nativeCarrierWriteGas: sum("nativeCarrierWriteGas"),
    objectCreationGas: sum("objectCreationGas"),
    logicalRegistryOperationGas: sum("logicalRegistryOperationGas"),
    executorControlGas: sum("executorControlGas"),
    totalNativeObjectLaneGas: sum("totalExecutorGas"),
    tokenPresentationGas: null,
    walletApprovalGas: null,
    executorEscrowWei: "0",
    actualTransactionFeeWei: null,
    selectedTestnetGasPriceWei: null,
    mainnetReferencePriceWei: null,
  },
  verification: {
    manifestDigestVerified: resolved.commitment?.digestVerified === true,
    entrypointBytesVerified: resolved.entrypoint.verified,
    sandbox: plan.viewer.manifest.runtime.sandbox,
    sandboxTokens: sandbox.sandboxTokens,
    cspBlocksNetwork: /(?:^|; )connect-src blob:(?:;|$)/u.test(sandbox.csp),
    undeclaredContentBlocked: plan.viewer.manifest.runtime.content.blockUndeclared,
  },
  recovery: {
    submissionMethod: plan.walletSendCalls.method,
    reconciliationMethod: plan.walletStatusRequest.method,
    managedRoute: "blocked-until-publication-job-is-deployed",
  },
  publicSubmissionReady: configuration.fixture.publicSubmissionReady,
  publicSubmissionBlocker: configuration.fixture.blocker,
  signingPerformed: false,
  walletTransactionsSent: 0,
};

process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
