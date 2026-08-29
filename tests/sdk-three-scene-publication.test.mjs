import assert from "node:assert/strict";
import test from "node:test";
import { decodeFunctionData, parseAbi } from "viem";

import {
  KEEL_NATIVE_CHUNK_BYTES,
  KEEL_NATIVE_CHUNKS_PER_TRANSACTION,
  KEEL_NATIVE_CARRIER_V1,
  KEEL_THREE_SCENE_PUBLICATION_PROTOCOL,
  bundleKeelThreeScene,
  buildKeelImmutableThreeScenePublicationPlan,
  keelHoldAbi,
  recoverKeelImmutableThreeScenePublication,
} from "../packages/sdk/dist/index.js";

const OWNER = "0x1111111111111111111111111111111111111111";
const EXECUTOR = "0x2222222222222222222222222222222222222222";
const HOLD = "0x3333333333333333333333333333333333333333";
const FACTORY = "0x4444444444444444444444444444444444444444";
const INDEX = "0x5555555555555555555555555555555555555555";
const COLLECTION = "0x6666666666666666666666666666666666666666";
const THREE_MODULE = new TextEncoder().encode("export class Scene {};");

// The fixture is deliberately one immutable HTML scene. The Three.js module
// is bundled as a data URL, so the strict viewer has no undeclared /content
// request while the bytes still come from a declared exact module.
const SCENE_BYTES = bundleKeelThreeScene({
  html: "<!doctype html><body><script type=\"module\" src=\"/content/scene.js\"></script></body>",
  entrypointId: "scene.js",
  entrypointSource: `import * as THREE from "/content/three.min.js";\nconst scene=new THREE.Scene();document.documentElement.dataset.scene="keel-one-of-one";${"x".repeat(KEEL_NATIVE_CHUNK_BYTES * 3 + 17)}`,
  modules: [{ id: "three.min.js", bytes: THREE_MODULE, mediaType: "text/javascript" }],
});

function input(overrides = {}) {
  return {
    chainId: 31_337,
    owner: OWNER,
    executor: EXECUTOR,
    hold: HOLD,
    deadline: 2_000n,
    scene: {
      id: "keel-three-one",
      name: "Keel Three One",
      description: "One immutable Three.js scene.",
      bytes: SCENE_BYTES,
      mediaType: "text/html",
      modules: [{ id: "three.min.js", bytes: THREE_MODULE, mediaType: "text/javascript" }],
    },
    ...overrides,
  };
}

test("the exact one-of-one Three.js scene fixture uses native storage and default proof controls", async () => {
  const result = await buildKeelImmutableThreeScenePublicationPlan(input());

  assert.equal(result.protocol, KEEL_THREE_SCENE_PUBLICATION_PROTOCOL);
  assert.deepEqual(result.edition, { size: 1, serial: 1 });
  assert.equal(result.immutable, true);
  assert.equal(result.walletApproval, "required");
  assert.equal(result.signing, "not-performed");
  assert.equal(result.submitted, false);
  assert.equal(result.publication.storageMode, KEEL_NATIVE_CARRIER_V1);

  const manifest = result.viewer.manifest;
  assert.equal(manifest.runtime.content.manifestTrust, "digest");
  assert.equal(manifest.runtime.sandbox, "strict");
  assert.deepEqual(manifest.runtime.capabilities, {});
  assert.equal(manifest.revision.policy, "immutable");
  assert.equal(manifest.revision.frozen, true);
  assert.equal(manifest.entrypoint.resource, "scene");
  assert.deepEqual(manifest.fallback, { image: "scene", animation: "scene", backgroundColor: "#05060b" });

  const resource = manifest.resources.find(({ id }) => id === "scene");
  assert.ok(resource);
  assert.equal(resource.sources.length, 1);
  assert.equal(resource.sources[0].kind, "onchain");
  assert.equal(resource.sources[0].store, HOLD);
  assert.equal(resource.sources[0].objectId, result.sceneObjectId);
  assert.equal(resource.sources[0].integrity.byteLength, SCENE_BYTES.byteLength);
  assert.equal(result.viewer.manifestURI, `keel-onchain://31337/${HOLD}/${result.viewer.manifestObjectId}`);
  assert.equal(result.viewer.manifestPublication.storageMode, KEEL_NATIVE_CARRIER_V1);
  assert.equal(result.viewer.manifestPublication.operations.length, 1);
  assert.equal(result.viewer.modules.length, 1);
  assert.equal(result.logicalOperations.manifestStorage, 1);
  assert.equal(result.walletSendCalls.method, "wallet_sendCalls");
  assert.equal(result.walletStatusRequest.method, "wallet_getCallsStatus");
  assert.equal(new TextDecoder().decode(SCENE_BYTES).includes('/content/three.js'), false);
});

test("the scene publication has one logical weld operation and bounded native batches", async () => {
  const result = await buildKeelImmutableThreeScenePublicationPlan(input());
  const batches = result.publication.nativeCarrierBatches;

  assert.ok(batches);
  assert.equal(result.publication.operations.length, 1);
  assert.equal(batches.flat().length, 4);
  assert.ok(batches.every((batch) => batch.length >= 1 && batch.length <= KEEL_NATIVE_CHUNKS_PER_TRANSACTION));
  assert.ok(batches.flat().every((payload) => (payload.length - 2) / 2 <= KEEL_NATIVE_CHUNK_BYTES));
  assert.equal(result.publication.gas.chunkCount, 4);
  assert.equal(result.publication.gas.carrierTransactionCount, 2);

  const operation = result.publication.operations[0];
  assert.equal(operation.target, HOLD);
  assert.equal(decodeFunctionData({ abi: parseAbi(keelHoldAbi), data: operation.data }).functionName, "weldObject");
});

test("receipt evidence resumes the immutable scene without a second wallet approval", async () => {
  const result = await buildKeelImmutableThreeScenePublicationPlan(input());
  const resumed = recoverKeelImmutableThreeScenePublication({
    plan: result,
    savedJobId: "41",
    confirmedJobIds: [42n],
    recovery: {
      completedChunks: 3,
      completedOperations: 0,
      failedChunkIndexes: [2],
      failedOperationIndexes: [],
      transactionHashes: ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    },
  });

  assert.equal(resumed.jobId, 42n);
  assert.equal(resumed.walletApproval, "not-requested");
  assert.equal(resumed.storageMode, KEEL_NATIVE_CARRIER_V1);
  assert.deepEqual(resumed.recovery.failedChunkIndexes, [2]);
  assert.equal(resumed.recovery.completedChunks, 3);
});

test("token and presentation calls are separate from scene welds and fail closed for managed mode", async () => {
  const result = await buildKeelImmutableThreeScenePublicationPlan(input({
    token: { factory: FACTORY, collection: COLLECTION, index: INDEX, publicationJobDeployed: false },
  }));

  assert.equal(result.publication.operations.length, 1);
  assert.ok(result.token);
  assert.equal(result.token.route, "direct-eip5792");
  assert.equal(result.token.status, "review-only");
  assert.equal(result.token.managedBlocker, "publication-job-not-deployed");
  assert.equal(result.token.maxSupply, 1n);
  assert.equal(result.token.tokenId, 1n);
  assert.equal(result.token.presentation.policy, "immutable");
  assert.equal(result.token.presentation.frozen, true);
  assert.equal(result.token.operations.length, 5);
  assert.deepEqual(result.token.operations.map(({ kind }) => kind), [
    "factory-collection",
    "index-presentation-publish",
    "index-presentation-activate",
    "index-presentation-freeze",
    "token-mint",
  ]);
  assert.equal(result.logicalOperations.tokenPresentation, 5);
  assert.equal(result.walletSendCalls.params[0].calls.length, 10);
});

test("the scene planner rejects an undeclared external module request", async () => {
  await assert.rejects(
    () => buildKeelImmutableThreeScenePublicationPlan(input({
      scene: { ...input().scene, bytes: new TextEncoder().encode('<script type="module">import "/content/missing.js"</script>') },
    })),
    /bundle every module.*undeclared resource request/u,
  );
});

test("recovery omits an absent saved job id", async () => {
  const result = await buildKeelImmutableThreeScenePublicationPlan(input());
  const resumed = recoverKeelImmutableThreeScenePublication({
    plan: result,
    confirmedJobIds: [],
    recovery: {
      completedChunks: 0,
      completedOperations: 0,
      failedChunkIndexes: [],
      failedOperationIndexes: [],
      transactionHashes: [],
    },
  });

  assert.equal("jobId" in resumed, false);
  assert.equal(resumed.walletApproval, "not-requested");
});
