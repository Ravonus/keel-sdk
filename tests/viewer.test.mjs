import test from "node:test";
import assert from "node:assert/strict";
import {
  KEEL_REGISTRY_ANCHOR_PROTOCOL,
  canonicalJson,
  createIntegrity,
  encodeBase64,
  hexToBytes,
  manifestIntegrity,
  sha256Hex,
  utf8ToBytes,
} from "../packages/protocol/dist/index.js";
import {
  INITIAL_VIEWER_VERIFICATION_HOST_STATE,
  createKeelIndexPresentationReader,
  createKeelHoldObjectReader,
  createEthereumStakeObjectReader,
  createEthereumIPControlReader,
  createSandboxDocument,
  createKeelMarketplaceApi,
  createTezosStakeObjectReader,
  createTezosIPControlReader,
  createVerifiedContentGateway,
  createVerifiedContentFetchHandler,
  bindKeelManifest,
  loadArtifactManifest,
  installElectronViewerEgressGuard,
  loadVerifiedViewerBundle,
  installKeelMarketplaceGlobal,
  parseKeelPluginFrameMessage,
  resolveArtifact,
  resolveArtifactFromManifestUri,
  resolveArtifactFromRegistry,
  resolveKeelContractPlugin,
  resolveKeelArtifact,
  transitionViewerVerificationHost,
  viewerLaunches,
} from "../packages/viewer/dist/index.js";
import { getAddress, keccak256 } from "viem";
import { deriveEmitterEventSeedFromIdentity, splitMix64 } from "../packages/sprite-codex/dist/index.js";
import { baseManifest, runtimePolicy } from "./fixtures.mjs";

test("sprite emitter identity matches the Solidity fixed-width event seed vector", async () => {
  const seed = await deriveEmitterEventSeedFromIdentity(
    { mapGenerationEpoch: 3, presetId: 9, revision: 2, eventKind: 7 },
    {
      mapSeed: `0x${"11".repeat(32)}`,
      mapId: `0x${"22".repeat(32)}`,
      worldEntityIndex: 42,
      eventOrdinal: 5,
    },
  );
  assert.equal(Buffer.from(seed).toString("hex"), "3f0bbc6a00dd08ff09424b1bc58b9b6b7d4c37450b27ca04e842e4758488f9a6");
  const seed64 = seed.slice(0, 8).reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
  assert.deepEqual(
    Array.from({ length: 4 }, (_, counter) => splitMix64(seed64, counter)),
    [0x0eaf2091be21fd86n, 0x26dbbbb73d8a5402n, 0x82159fa92046f3e1n, 0x46b9618a77c8dbf7n],
  );
});

async function inline(id, role, mediaType, text, executable = false, aliases) {
  const bytes = new TextEncoder().encode(text);
  return {
    id,
    role,
    mediaType,
    executable,
    ...(aliases === undefined ? {} : { aliases }),
    sources: [{ kind: "inline", data: encodeBase64(bytes), encoding: "base64", integrity: await createIntegrity(bytes) }],
  };
}

async function manifest() {
  const viewer = await inline(
    "viewer",
    "entrypoint",
    "text/html",
    '<main><img src="/content/image"><script src="oca://script"></script></main>',
    true,
  );
  const image = await inline(
    "image",
    "fallback",
    "image/svg+xml",
    '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>',
    false,
    ["/content/art.svg"],
  );
  const script = await inline("script", "script", "text/javascript", 'document.body.dataset.ready="yes"', true);
  return baseManifest([viewer, image, script], {
    id: "viewer-test",
    name: "Viewer Test",
    fallback: { image: "image", animation: "viewer" },
  });
}

test("stake objects gate the staked entrypoint and expose global/token counters", async () => {
  const value = await manifest();
  const stakedViewer = await inline("staked-viewer", "entrypoint", "text/html", "<main data-staked>map</main>", true);
  value.resources.push(stakedViewer);
  value.stakeObject = {
    protocol: "keel-stake-object@1",
    chain: { family: "ethereum", chainId: 1, manager: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    hostCollection: `0x${"bb".repeat(20)}`,
    hostTokenId: "1",
    stakedTokenId: "7",
    stakeObjectId: `0x${"11".repeat(32)}`,
    viewerId: `0x${"22".repeat(32)}`,
    stakedEntrypoint: { resource: "staked-viewer", mode: "html" },
    gatedResources: [{ resource: "staked-viewer", slot: 3, objectId: `0x${"44".repeat(32)}`, objectRevision: 2 }],
    requireStaked: true,
    lockup: { mode: "minimum-duration", seconds: 60 },
    managerPolicy: { mode: "official" },
    runtime: {
      seed: `0x${"55".repeat(32)}`,
      argumentsDigest: `0x${"66".repeat(32)}`,
      variablesDigest: `0x${"77".repeat(32)}`,
      runtimeDigest: `0x${"88".repeat(32)}`,
    },
  };
  const proof = {
    manager: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    proofClass: "official",
    immutable: true,
    codeHash: `0x${"33".repeat(32)}`,
  };
  const readStake = async (request) => ({
    active: request.stakedTokenId === "7" && request.hostTokenId === "1" && request.stakeObjectId === value.stakeObject.stakeObjectId && readStake.active,
    staker: readStake.active ? "0xcccccccccccccccccccccccccccccccccccccccc" : undefined,
    controller: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    hostOwner: "0xdddddddddddddddddddddddddddddddddddddddd",
    stakedCollection: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    activeTokenId: "7",
    tokenOwner: readStake.active ? "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" : "0xcccccccccccccccccccccccccccccccccccccccc",
    viewerId: value.stakeObject.viewerId,
    hostCollection: value.stakeObject.hostCollection,
    hostTokenId: value.stakeObject.hostTokenId,
    slot: 3,
    startedAt: readStake.active ? "100" : "0",
    lockup: { mode: "minimum-duration", seconds: 60 },
    counters: {
      objectTokenLifetime: 2,
      objectLifetime: 4,
      objectActive: readStake.active ? 2 : 1,
      tokenLifetime: 2,
      tokenActive: readStake.active ? 1 : 0,
      globalLifetime: 9,
      globalActive: readStake.active ? 2 : 1,
    },
    managerVerified: true,
    managerProof: proof,
    codeObjectId: value.stakeObject.gatedResources[0].objectId,
    codeObjectRevision: value.stakeObject.gatedResources[0].objectRevision,
    runtimeSeed: value.stakeObject.runtime.seed,
    argumentsDigest: value.stakeObject.runtime.argumentsDigest,
    variablesDigest: value.stakeObject.runtime.variablesDigest,
    runtimeDigest: value.stakeObject.runtime.runtimeDigest,
  });
  readStake.active = false;
  const inactive = await resolveArtifact(value, { stakeObjectReader: readStake });
  assert.equal(inactive.entrypoint.resource.id, "viewer");
  assert.equal(inactive.resources.has("staked-viewer"), false);
  assert.equal(inactive.stakeObject.active, false);
  assert.equal(inactive.stakeObject.counters.tokenLifetime, 2);
  assert.equal(inactive.stakeObject.counters.globalLifetime, 9);
  readStake.active = true;
  const active = await resolveArtifact(value, { stakeObjectReader: readStake });
  assert.equal(active.entrypoint.resource.id, "staked-viewer");
  assert.equal(active.resources.has("staked-viewer"), true);
  assert.equal(active.stakeObject.active, true);
  assert.equal(active.stakeObject.staker, "0xcccccccccccccccccccccccccccccccccccccccc");
  assert.equal(active.stakeObject.counters.tokenActive, 1);
  assert.equal(active.stakeObject.counters.globalActive, 2);
  assert.equal(active.stakeObject.lockup.mode, "minimum-duration");
});

test("official Ethereum and Tezos stake readers expose identical map, character, and global accounting", async () => {
  const stakeObjectId = `0x${"11".repeat(32)}`;
  const viewerId = `0x${"22".repeat(32)}`;
  const codeObjectId = `0x${"33".repeat(32)}`;
  const runtimeSeed = `0x${"44".repeat(32)}`;
  const argumentsDigest = `0x${"55".repeat(32)}`;
  const variablesDigest = `0x${"66".repeat(32)}`;
  const runtimeDigest = `0x${"77".repeat(32)}`;
  const ethManager = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const ethHost = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const ethStaked = "0xcccccccccccccccccccccccccccccccccccccccc";
  const officialProof = (manager) => ({ manager, proofClass: "official", immutable: true, codeHash: `0x${"88".repeat(32)}` });
  const ethValues = {
    stakeObjectActive: true,
    stakeObject: { hostCollection: ethHost, hostTokenId: 42n, stakedCollection: ethStaked, viewerId, lockup: { mode: 1n, minimumSeconds: 3600n } },
    stakeObjectRuntime: { codeObjectId, codeObjectRevision: 4n, seed: runtimeSeed, argumentsDigest, variablesDigest, slot: 9n, runtimeDigest },
    stakeCounts: { objectTokenLifetime: 3n, objectLifetime: 12n, objectActive: 2n, tokenLifetime: 5n, tokenActive: 1n },
    globalStakeCounts: { lifetime: 81n, active: 9n },
    stakeObjectController: { hostOwner: "0xdddddddddddddddddddddddddddddddddddddddd", creator: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", manager: ethManager },
    stakeObjectState: { active: true, staker: "0xffffffffffffffffffffffffffffffffffffffff", stakedCollection: ethStaked, activeTokenId: 7n, objectTokenLifetime: 3n, objectLifetime: 12n, objectActive: 2n, tokenLifetime: 5n, tokenActive: 1n, globalLifetime: 81n, globalActive: 9n, runtimeDigest, hostOwner: "0xdddddddddddddddddddddddddddddddddddddddd", viewerId, lockupMode: 1n, minimumSeconds: 3600n, startedAt: 100n },
  };
  const ethReader = createEthereumStakeObjectReader({
    readContract: async ({ functionName }) => ethValues[functionName],
    readManagerProof: async ({ manager }) => officialProof(manager),
  });
  const eth = await ethReader({
    chain: { family: "ethereum", chainId: 11155111, manager: ethManager },
    stakeObjectId,
    hostCollection: ethHost,
    hostTokenId: "42",
    stakedTokenId: "7",
  }, new AbortController().signal);

  const tezManager = "KT1RJ6PbjHpwc3M5rw5s2Nbmefwbuwbdxton";
  const tezHost = "KT1PWx2mnDueood7fEmfbBDKx1D9BAnnXitn";
  const tezStaked = "KT1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb";
  const tezValues = {
    stake_object_active: true,
    stake_object_config: { creator: "tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb", enabled: true, host_fa2: tezHost, host_token_id: 42n, lockup_mode: 1n, minimum_seconds: 3600n, staked_fa2: tezStaked, viewer_id: viewerId.slice(2) },
    stake_object_runtime: { code_object_id: codeObjectId.slice(2), code_object_revision: 4n, seed: runtimeSeed.slice(2), arguments_digest: argumentsDigest.slice(2), variables_digest: variablesDigest.slice(2), slot: 9n, runtime_digest: runtimeDigest.slice(2) },
    stake_counts: { object_token_lifetime: 3n, object_lifetime: 12n, object_active: 2n, token_lifetime: 5n, token_active: 1n },
    global_stake_counts: { lifetime: 81n, active: 9n },
    stake_object_state: { staker: "tz1aSkwEot3L2kmUvcoxzjMomb9mvBNuzFK6", started_at: 100n },
  };
  const tezReader = createTezosStakeObjectReader({
    runView: async ({ view }) => tezValues[view],
    readManagerProof: async ({ manager }) => officialProof(manager),
  });
  const tez = await tezReader({
    chain: { family: "tezos", network: "tezos:NetXsqzbfFenSTS", manager: tezManager },
    stakeObjectId,
    hostCollection: tezHost,
    hostTokenId: "42",
    stakedTokenId: "7",
  }, new AbortController().signal);

  for (const state of [eth, tez]) {
    assert.equal(state.active, true);
    assert.equal(state.slot, 9);
    assert.equal(state.codeObjectId, codeObjectId);
    assert.equal(state.codeObjectRevision, 4);
    assert.equal(state.runtimeSeed, runtimeSeed);
    assert.deepEqual(state.counters, { objectTokenLifetime: 3, objectLifetime: 12, objectActive: 2, tokenLifetime: 5, tokenActive: 1, globalLifetime: 81, globalActive: 9 });
    assert.equal(state.lockup.mode, "minimum-duration");
    assert.equal(state.lockup.seconds, 3600);
    assert.equal(state.managerVerified, true);
  }
});

test("IP-control readers keep Ethereum and Tezos license/policy reads on their exact registries", async () => {
  const objectId = `0x${"11".repeat(32)}`;
  const policyId = `0x${"22".repeat(32)}`;
  const licenseId = `0x${"33".repeat(32)}`;
  const digest = `0x${"44".repeat(32)}`;
  const creator = `0x${"55".repeat(20)}`;
  const ethRegistry = `0x${"66".repeat(20)}`;
  const ethDeclaration = {
    protocol: "keel-ip-control@1",
    chain: "ethereum",
    chainId: 1,
    registry: ethRegistry,
    policyId,
    objectId,
    objectRevision: 1,
    license: { licenseId, contentObjectId: objectId, decodedDigest: digest, compression: "brotli" },
    resources: [{ resource: "viewer", objectId, objectRevision: 1, actions: ["view", "download"] }],
  };
  const ethReader = createEthereumIPControlReader({
    readContract: async ({ functionName }) => {
      if (functionName === "ipPolicy") return { objectId, objectRevision: 1, creator, licenseId, version: 1, configFrozen: true, exists: true };
      if (functionName === "ipLicense") return { contentObjectId: objectId, decodedDigest: digest, byteLength: 128, storedByteLength: 64, compression: 3, identifier: "CC0-1.0", name: "CC0", publisher: creator, standard: true, exists: true };
      if (functionName === "ipRule") return { mode: 0, actionMask: 3, objectRevision: 1, exists: true };
      if (functionName === "ipAuthorizationStatus") return { allowed: true, mode: 0, actionMask: 3, effectiveRuleId: `0x${"77".repeat(32)}`, licenseId, policyVersion: 1 };
      return true;
    },
  });
  const eth = await ethReader({ declaration: ethDeclaration }, new AbortController().signal);
  assert.deepEqual(eth.resources[0].allowedActions, ["view", "download"]);

  const tezRegistry = "KT1RJ6PbjHpwc3M5rw5s2Nbmefwbuwbdxton";
  const tezLicenseRegistry = "KT1Q2QvJk2oXf3x3N3h7p2c9G6d4s8m1aBcd";
  const tezDeclaration = {
    ...ethDeclaration,
    chain: "tezos",
    chainId: 1,
    registry: tezRegistry,
    licenseRegistry: tezLicenseRegistry,
  };
  const addresses = [];
  const tezReader = createTezosIPControlReader({
    network: "NetXdQprcVkpaWU",
    runView: async ({ address, view }) => {
      addresses.push({ address, view });
      if (view === "get_license") return {
        object_id: objectId.slice(2), decoded_sha256: digest.slice(2), decoded_byte_length: 128,
        stored_byte_length: 64, compression: "0x62726f746c69", identifier: "0x4343302d312e30",
        name: "0x434330", publisher: "tz1burnburnburnburnburnburnburjAYjjX", standard: true,
      };
      return {
        allowed: true, mode: 0, action_mask: 3, effective_resource_object_id: "0x" + "00".repeat(32),
        license_id: licenseId.slice(2), policy_version: 1, object_id: objectId.slice(2), object_revision: 1,
        creator: "tz1burnburnburnburnburnburnburjAYjjX", config_frozen: true,
      };
    },
  });
  const tez = await tezReader({ declaration: tezDeclaration }, new AbortController().signal);
  assert.deepEqual(tez.resources[0].allowedActions, ["view", "download"]);
  assert.equal(addresses[0].address, tezLicenseRegistry);
  assert.ok(addresses.slice(1).every(({ address, view }) => address === tezRegistry && view === "authorization_status"));
});

function fetchResponse(url, bytes, ok = true) {
  return {
    ok,
    status: ok ? 200 : 404,
    statusText: ok ? "OK" : "Not Found",
    url,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

test("resolver verifies all resources and creates an audit trail", async () => {
  const artifact = await resolveArtifact(await manifest());
  assert.equal(artifact.resources.size, 3);
  assert.equal(artifact.audit.resolvedResources, 3);
  assert.ok(artifact.audit.entries.every((entry) => entry.status === "loaded"));
  assert.ok(artifact.audit.entries.every((entry) => entry.integrityVerified === true));
  assert.equal(artifact.audit.anchorVerified, false);
});

test("resolver fails closed until an exact Library policy and graph binding grants access", async () => {
  const value = await manifest();
  const library = await inline("renderer-library", "library", "text/javascript", "export const render = true;", true);
  value.resources.push(library);
  const reference = {
    id: "renderer",
    resource: "renderer-library",
    resourceIntegrity: library.sources[0].integrity,
    chainId: 31338,
    registry: "0x1111111111111111111111111111111111111111",
    assetId: `0x${"22".repeat(32)}`,
    policyVersion: 3,
    policyCommitment: `0x${"33".repeat(32)}`,
    graph: {
      protocol: "keel-graph-registry@1",
      chainId: 31338,
      registry: "0x4444444444444444444444444444444444444444",
      graphId: `0x${"55".repeat(32)}`,
      version: 7,
      storageTier: "onchain",
    },
    manifestDigest: `0x${"66".repeat(32)}`,
    resourceGraphDigest: `0x${"77".repeat(32)}`,
    updates: { mode: "locked" },
  };
  value.libraries = { protocol: "keel-library-bindings@1", assets: [reference] };
  await assert.rejects(() => resolveArtifact(value), /no Library access verifier/i);

  const allowed = await resolveArtifact(value, {
    libraryAccessAccount: "0x8888888888888888888888888888888888888888",
    adapters: {
      async readLibraryAccess(request) {
        assert.equal(request.reference.id, "renderer");
        assert.equal(request.account, "0x8888888888888888888888888888888888888888");
        return {
          allowed: true,
          policyCommitment: reference.policyCommitment,
          graphId: reference.graph.graphId,
          graphVersion: reference.graph.version,
          manifestDigest: reference.manifestDigest,
          resourceGraphDigest: reference.resourceGraphDigest,
        };
      },
    },
  });
  assert.equal(allowed.libraryAccess.length, 1);
  assert.equal(allowed.libraryAccess[0].reference.policyVersion, 3);

  await assert.rejects(
    () => resolveArtifact(value, {
      adapters: {
        async readLibraryAccess() {
          return {
            allowed: true,
            policyCommitment: `0x${"99".repeat(32)}`,
            graphId: reference.graph.graphId,
            graphVersion: reference.graph.version,
            manifestDigest: reference.manifestDigest,
            resourceGraphDigest: reference.resourceGraphDigest,
          };
        },
      },
    }),
    /no longer matches/i,
  );
  await assert.rejects(
    () => resolveArtifact(value, {
      adapters: {
        async readLibraryAccess() {
          return {
            allowed: false,
            policyCommitment: reference.policyCommitment,
            graphId: reference.graph.graphId,
            graphVersion: reference.graph.version,
            manifestDigest: reference.manifestDigest,
            resourceGraphDigest: reference.resourceGraphDigest,
          };
        },
      },
    }),
    /requires access/i,
  );
});

test("resolver rejects a corrupt source and uses the next verified fallback", async () => {
  const value = await manifest();
  const image = value.resources[1];
  image.sources.unshift({
    kind: "inline",
    data: encodeBase64(new TextEncoder().encode("corrupt")),
    encoding: "base64",
    integrity: image.sources[0].integrity,
  });
  const artifact = await resolveArtifact(value);
  const imageAudit = artifact.audit.entries.filter((entry) => entry.resourceId === "image");
  assert.equal(imageAudit[0].status, "failed");
  assert.equal(imageAudit[1].status, "loaded");
});

test("verified gateway exposes only committed aliases and never falls through to the network", async () => {
  const artifact = await resolveArtifact(await manifest());
  const gateway = createVerifiedContentGateway(artifact);
  const content = gateway.resolve("/content/image");
  assert.equal(content.status, 200);
  assert.equal(content.resourceId, "image");
  assert.equal(content.headers["X-Keel-Verified"], artifact.resources.get("image").source.integrity.digest);
  assert.equal(gateway.resolve("/content/art.svg", "HEAD").status, 200);
  assert.equal(gateway.resolve("/content/not-declared").status, 404);
  assert.equal(gateway.resolve("https://evil.example/inject.js").status, 403);
  assert.equal(gateway.resolve("/content/image", "POST").status, 405);
});



test("Fetch API gateway adapter serves only verified manifest-scoped routes", async () => {
  const artifact = await resolveArtifact(await manifest());
  const handle = createVerifiedContentFetchHandler(artifact);
  const response = handle(new Request("https://viewer.example/content/image"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Keel-Resource"), "image");
  assert.equal(response.headers.get("X-Keel-Verified"), artifact.resources.get("image").source.integrity.digest);
  assert.match(await response.text(), /<svg/);
  assert.equal(handle("https://viewer.example/content/not-declared").status, 404);
  assert.equal(handle("https://evil.example/inject.js").status, 403);
  assert.equal(handle("https://viewer.example/content/image", { method: "POST" }).status, 405);
});

test("marketplace API verifies exact bytes and committed optimized derivatives", async () => {
  const value = await manifest();
  const sourceDescriptor = value.resources.find((resource) => resource.id === "image");
  const optimized = new TextEncoder().encode("committed-webp-output");
  const outputIntegrity = await createIntegrity(optimized);
  value.resources.push({
    id: "optimized-image",
    role: "image",
    mediaType: "image/webp",
    executable: false,
    sources: [{ kind: "inline", data: encodeBase64(optimized), encoding: "base64", integrity: outputIntegrity }],
  });
  const derivative = {
    protocol: "keel-media-derivative@1",
    sourceResourceId: "image",
    sourceIntegrity: sourceDescriptor.sources[0].integrity,
    outputResourceId: "optimized-image",
    outputIntegrity,
    outputMediaType: "image/webp",
    outputWidth: 512,
    outputHeight: 512,
    transform: {
      profile: "preview-webp-512-v1",
      codec: "webp",
      width: 512,
      height: 512,
      fit: "inside",
      withoutEnlargement: true,
      colorSpace: "srgb",
      quality: 78,
      effort: 6,
      smartSubsample: true,
      implementation: { name: "sharp-libvips", sharpVersion: "0.35.3", vipsVersion: "8.18.0" },
      recipeDigest: `0x${"44".repeat(32)}`,
    },
    authority: "manifest-output-digest",
  };
  value.mediaDerivatives = [derivative];
  const artifact = await resolveArtifact(value);
  const source = artifact.resources.get("image");
  const api = createKeelMarketplaceApi(artifact);
  assert.equal(api.protocol, "keel-marketplace-api@1");
  assert.equal(api.resolve("image").digest, source.source.integrity.digest);
  assert.equal((await api.verifyMedia({ sourceResourceId: "image", candidate: source.bytes })).status, "exact");
  const verified = await api.verifyMedia({ sourceResourceId: "image", candidate: optimized, profile: "preview-webp-512-v1" });
  assert.equal(verified.status, "verified-derivative");
  assert.equal(verified.outputDigest, outputIntegrity.digest);
  const corrupt = optimized.slice();
  corrupt[0] ^= 1;
  assert.equal((await api.verifyMedia({ sourceResourceId: "image", candidate: corrupt })).status, "unverified");
  const target = {};
  installKeelMarketplaceGlobal(api, target);
  assert.equal(target.Keel, api);
});

test("sandbox injects the small immutable Keel caller API", async () => {
  const artifact = await resolveArtifact(await manifest());
  const document = createSandboxDocument(artifact);
  assert.match(document.html, /__KEEL__/u);
  assert.match(document.html, /keel-marketplace-api@1/u);
  assert.match(document.html, /crypto\.subtle\.digest\("SHA-256"/u);
});

test("host capabilityCeiling clamps sandbox browser capabilities without touching composition", async () => {
  const value = await manifest();
  value.runtime = runtimePolicy({ capabilities: { webAssembly: true, fullscreen: true } });
  const artifact = await resolveArtifact(value);

  // No ceiling: the manifest's declared capabilities pass through unchanged.
  const open = createSandboxDocument(artifact);
  assert.match(open.csp, /wasm-unsafe-eval/u);
  assert.match(open.allow, /fullscreen/u);

  // Ceiling allows fullscreen but not webAssembly: wasm is clamped off.
  const clamped = createSandboxDocument(artifact, { capabilityCeiling: { fullscreen: true } });
  assert.doesNotMatch(clamped.csp, /wasm-unsafe-eval/u);
  assert.match(clamped.allow, /fullscreen/u);

  // Empty ceiling denies everything the manifest requested (host can only narrow).
  const locked = createSandboxDocument(artifact, { capabilityCeiling: {} });
  assert.doesNotMatch(locked.csp, /wasm-unsafe-eval/u);
  assert.equal(locked.allow, "");
  // Composition is untouched: the verified Keel content API is still injected.
  assert.match(locked.html, /__KEEL__/u);
  assert.match(locked.html, /__KEEL_CONTENT__/u);
});

test("declared external URLs become local verified aliases instead of runtime network permissions", async () => {
  const value = await manifest();
  const externalUrl = "https://artist.example/releases/image.svg";
  const bytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h8v8z"/></svg>');
  value.resources[1] = {
    id: "image",
    role: "fallback",
    mediaType: "image/svg+xml",
    sources: [{ kind: "uri", uri: externalUrl, integrity: await createIntegrity(bytes) }],
  };
  value.resources[0] = await inline(
    "viewer",
    "entrypoint",
    "text/html",
    `<img src="${externalUrl}"><script>fetch(${JSON.stringify(externalUrl)})</script>`,
    true,
  );
  let fetches = 0;
  const authorized = [];
  const artifact = await resolveArtifact(value, {
    sourceAllowlist: ["artist.example"],
    adapters: {
      async authorizeRemoteSource(url) { authorized.push(url); },
      async fetch(url, init) {
        fetches += 1;
        assert.equal(url, externalUrl);
        assert.equal(init.redirect, "error");
        return fetchResponse(url, bytes);
      },
    },
  });
  assert.equal(fetches, 1);
  assert.deepEqual(authorized, [externalUrl, externalUrl]);
  const gateway = createVerifiedContentGateway(artifact);
  assert.equal(gateway.resolve(externalUrl).status, 200);
  assert.equal(fetches, 1);
  const sandbox = createSandboxDocument(artifact);
  assert.ok(sandbox.html.includes("data:image/svg+xml;base64,"));
  assert.ok(sandbox.html.includes(externalUrl)); // alias table only; runtime lookup is local
  assert.ok(sandbox.csp.includes("connect-src 'none'"));
});

test("sandbox wraps doctype-only HTML so CSP cannot be skipped", async () => {
  const value = await manifest();
  value.resources[0] = await inline(
    "viewer",
    "entrypoint",
    "text/html",
    "<!doctype html><main>doctype-only document</main>",
    true,
  );
  const artifact = await resolveArtifact(value);
  const sandbox = createSandboxDocument(artifact);
  assert.ok(sandbox.html.includes('http-equiv="Content-Security-Policy"'));
  assert.ok(sandbox.html.includes("<html>"));
});

test("sandbox materializes static virtual routes and blocks all raw creator networking", async () => {
  const artifact = await resolveArtifact(await manifest());
  const sandbox = createSandboxDocument(artifact);
  assert.ok(sandbox.html.includes("data:image/svg+xml;base64,"));
  assert.ok(sandbox.html.includes("data:text/javascript;base64,"));
  assert.ok(sandbox.html.includes("__KEEL_CONTENT__"));
  assert.ok(sandbox.html.includes("__KEEL_THUMBNAIL__"));
  assert.ok(sandbox.html.includes("keel-thumbnail-capture@1"));
  assert.ok(sandbox.html.includes("Keel blocked undeclared content request"));
  assert.ok(sandbox.html.includes("addEventListener(\"navigate\""));
  assert.ok(sandbox.html.includes("Location?.prototype"));
  // The iframe sandbox tokens enforce top-navigation denial. Avoid installing
  // beforeunload inside the opaque-origin frame: Chromium ignores it and emits
  // a console error instead of adding another security boundary.
  assert.equal(sandbox.html.includes("beforeunload"), false);
  assert.ok(sandbox.html.includes("!sameDocument && !download"));
  assert.ok(sandbox.sandboxTokens.includes("allow-scripts"));
  assert.equal(sandbox.sandboxTokens.includes("allow-same-origin"), false);
  assert.ok(sandbox.csp.includes("connect-src 'none'"));
  // Chromium removed CSP `navigate-to`; retaining it only creates a noisy
  // unsupported-directive warning. Navigation stays blocked by the iframe
  // sandbox and the guarded Navigation/Location APIs asserted above.
  assert.equal(sandbox.csp.includes("navigate-to 'none'"), false);
  assert.equal(sandbox.csp.includes("https:"), false);
});

test("sandbox exposes only a validated pinned Keel chain context", async () => {
  const artifact = await resolveArtifact(await manifest());
  const context = {
    protocol: "keel-context@1",
    chainId: 31338,
    blockNumber: "42",
    blockHash: `0x${"ab".repeat(32)}`,
    blockTimestamp: "1700000000",
    tokenId: "7",
    derivedTokenSeed: `0x${"cd".repeat(32)}`,
  };
  const sandbox = createSandboxDocument(artifact, { runtimeContext: context });
  assert.ok(sandbox.html.includes("__KEEL_CONTEXT__"));
  assert.ok(sandbox.html.includes('"blockNumber":"42"'));
  assert.ok(sandbox.html.includes('"blockTimestamp":"1700000000"'));
  assert.ok(sandbox.html.includes('"tokenId":"7"'));
  assert.throws(
    () => createSandboxDocument(artifact, { runtimeContext: { ...context, blockHash: "0x12" } }),
    /block hash/i,
  );
  assert.throws(
    () => createSandboxDocument(artifact, { runtimeContext: { ...context, tokenId: (1n << 256n).toString() } }),
    /token ID exceeds uint256/i,
  );
});

test("viewer verification host state is ordered while an optional child handshake stays non-fatal", () => {
  const mounted = transitionViewerVerificationHost(INITIAL_VIEWER_VERIFICATION_HOST_STATE, { action: "mounted" }, true);
  assert.deepEqual(mounted, { mountedSeen: true, readySeen: false, terminalFailed: false, status: "pending" });
  assert.equal(transitionViewerVerificationHost(mounted, { action: "state", childState: "verified" }, true), mounted);
  assert.equal(transitionViewerVerificationHost(mounted, { action: "state", childState: "unavailable" }, true), mounted);
  const verified = transitionViewerVerificationHost(mounted, { action: "ready", childState: "verified" }, true);
  assert.deepEqual(verified, { mountedSeen: true, readySeen: true, terminalFailed: false, status: "verified" });
  assert.equal(
    transitionViewerVerificationHost(verified, { action: "state", childState: "verified" }, true).status,
    "verified",
  );
  const failed = transitionViewerVerificationHost(verified, { action: "state", childState: "failed" }, true);
  assert.deepEqual(failed, { mountedSeen: true, readySeen: true, terminalFailed: true, status: "failed" });
  assert.equal(transitionViewerVerificationHost(failed, { action: "ready", childState: "verified" }, true), failed);

  const outOfOrder = transitionViewerVerificationHost(
    INITIAL_VIEWER_VERIFICATION_HOST_STATE,
    { action: "ready", childState: "verified" },
    true,
  );
  assert.deepEqual(outOfOrder, { mountedSeen: false, readySeen: false, terminalFailed: true, status: "failed" });
  const timedOut = transitionViewerVerificationHost(INITIAL_VIEWER_VERIFICATION_HOST_STATE, { action: "timeout" }, true);
  assert.deepEqual(timedOut, { mountedSeen: false, readySeen: false, terminalFailed: false, status: "unavailable" });
  const lateReady = transitionViewerVerificationHost(timedOut, { action: "mounted" }, true);
  assert.deepEqual(transitionViewerVerificationHost(lateReady, { action: "ready", childState: "verified" }, true), { mountedSeen: true, readySeen: true, terminalFailed: false, status: "verified" });
  const duplicateMounted = transitionViewerVerificationHost(mounted, { action: "mounted" }, true);
  assert.deepEqual(duplicateMounted, { mountedSeen: true, readySeen: false, terminalFailed: true, status: "failed" });
  const unavailable = transitionViewerVerificationHost(mounted, { action: "ready", childState: "verified" }, false);
  assert.deepEqual(unavailable, { mountedSeen: true, readySeen: true, terminalFailed: false, status: "unavailable" });
  assert.equal(
    transitionViewerVerificationHost(unavailable, { action: "state", childState: "verified" }, true).status,
    "unavailable",
  );
  assert.equal(
    transitionViewerVerificationHost(verified, { action: "state", childState: "unavailable" }, true).status,
    "unavailable",
  );
  assert.equal(
    transitionViewerVerificationHost(verified, { action: "ready", childState: "verified" }, true).terminalFailed,
    true,
  );
  assert.equal(
    transitionViewerVerificationHost(mounted, { action: "state", childState: "failed" }, false).terminalFailed,
    true,
  );
});

test("viewer verification host transition space never verifies before the first valid ready", () => {
  const events = [
    { action: "mounted" },
    { action: "ready", childState: "verified" },
    { action: "ready", childState: "failed" },
    { action: "ready", childState: "unavailable" },
    { action: "state", childState: "verified" },
    { action: "state", childState: "failed" },
    { action: "state", childState: "unavailable" },
    { action: "timeout" },
  ];
  for (const parentVerified of [false, true]) {
    let frontier = [INITIAL_VIEWER_VERIFICATION_HOST_STATE];
    for (let depth = 0; depth < 5; depth += 1) {
      const next = [];
      for (const before of frontier) {
        for (const event of events) {
          const after = transitionViewerVerificationHost(before, event, parentVerified);
          if (before.terminalFailed) assert.equal(after, before);
          if (after.readySeen) assert.equal(after.mountedSeen, true);
          if (!after.readySeen) assert.notEqual(after.status, "verified");
          if (after.status === "verified") {
            assert.equal(parentVerified, true);
            assert.equal(after.mountedSeen, true);
            assert.equal(after.readySeen, true);
            assert.equal(after.terminalFailed, false);
          }
          if (before.status !== "verified" && after.status === "verified") {
            assert.deepEqual(event, { action: "ready", childState: "verified" });
            assert.equal(before.mountedSeen, true);
            assert.equal(before.readySeen, false);
          }
          if (!before.readySeen && event.action === "state" && event.childState !== "failed") {
            assert.equal(after, before);
          }
          if (before.readySeen && before.status === "unavailable" && event.action === "state") {
            assert.notEqual(after.status, "verified");
          }
          next.push(after);
        }
      }
      frontier = next;
    }
  }
});

test("recursive KeelHold reader verifies leaf and composite objects", async () => {
  const left = new TextEncoder().encode("left-");
  const right = new TextEncoder().encode("right");
  const joined = new Uint8Array([...left, ...right]);
  const [leftIntegrity, rightIntegrity, rootIntegrity] = await Promise.all([
    createIntegrity(left),
    createIntegrity(right),
    createIntegrity(joined),
  ]);
  const leftObject = `0x${"11".repeat(32)}`;
  const rightObject = `0x${"22".repeat(32)}`;
  const rootObject = `0x${"33".repeat(32)}`;
  const leftPointer = `0x${"aa".repeat(20)}`;
  const rightPointer = `0x${"bb".repeat(20)}`;
  const records = new Map([
    [leftObject, { digest: leftIntegrity.digest, byteLength: left.length, storedByteLength: left.length, chunkCount: 1, compression: 0, composite: false }],
    [rightObject, { digest: rightIntegrity.digest, byteLength: right.length, storedByteLength: right.length, chunkCount: 1, compression: 0, composite: false }],
    [rootObject, { digest: rootIntegrity.digest, byteLength: joined.length, storedByteLength: joined.length, chunkCount: 2, compression: 0, composite: true }],
  ]);
  const reader = createKeelHoldObjectReader({
    async getObject({ objectId }) { return records.get(objectId); },
    async getObjectSlugPointers({ objectId }) { return objectId === leftObject ? [leftPointer] : [rightPointer]; },
    async getObjectPartIds() { return [leftObject, rightObject]; },
    async getCode({ address }) {
      const payload = address === leftPointer ? left : right;
      return new Uint8Array([0, ...payload]);
    },
  });
  const controller = new AbortController();
  const result = await reader({ chainId: 1, store: "0x1111111111111111111111111111111111111111", objectId: rootObject }, controller.signal);
  assert.equal(new TextDecoder().decode(result), "left-right");
});

test("manifest loader verifies RFC 8785 JSON and resolves relative resources", async () => {
  const viewerBytes = new TextEncoder().encode('<main><img src="/content/image"></main>');
  const imageBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>');
  const value = await manifest();
  value.resources = [
    {
      id: "viewer",
      role: "entrypoint",
      mediaType: "text/html",
      executable: true,
      sources: [{ kind: "uri", uri: "./viewer.html", integrity: await createIntegrity(viewerBytes) }],
    },
    {
      id: "image",
      role: "fallback",
      mediaType: "image/svg+xml",
      sources: [{ kind: "uri", uri: "./image.svg", integrity: await createIntegrity(imageBytes) }],
    },
  ];
  value.fallback = { image: "image", animation: "viewer" };
  const expected = await manifestIntegrity(value);
  const manifestBytes = new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
  const files = new Map([
    ["https://cdn.example/art/manifest.json", manifestBytes],
    ["https://cdn.example/art/viewer.html", viewerBytes],
    ["https://cdn.example/art/image.svg", imageBytes],
  ]);
  const fetch = async (url) => {
    const bytes = files.get(url);
    if (bytes === undefined) throw new Error(`Unexpected URL ${url}`);
    return fetchResponse(url, bytes);
  };

  const loaded = await loadArtifactManifest("https://cdn.example/art/manifest.json", expected.digest, {
    adapters: { fetch },
    sourceAllowlist: ["cdn.example"],
  });
  assert.equal(loaded.integrityVerified, true);
  assert.equal(loaded.baseUrl, "https://cdn.example/art/");

  const artifact = await resolveArtifactFromManifestUri("https://cdn.example/art/manifest.json", expected.digest, {
    adapters: { fetch },
    sourceAllowlist: ["cdn.example"],
  });
  assert.equal(artifact.resources.size, 2);
  assert.equal(artifact.entrypoint.resource.id, "viewer");
});

test("manifest loader resolves a canonical KeelIndex URI directly from KeelHold without HTTP", async () => {
  const value = await manifest();
  const bytes = utf8ToBytes(canonicalJson(value));
  const integrity = await manifestIntegrity(value);
  const store = "0x1111111111111111111111111111111111111111";
  const objectId = `0x${"22".repeat(32)}`;
  const uri = `oca-onchain://31338/${store}/${objectId}`;
  let reads = 0;
  const loaded = await loadArtifactManifest(uri, integrity, {
    adapters: {
      async readOnchainObject(request) {
        reads += 1;
        assert.deepEqual(request, { chainId: 31338, store, objectId });
        return bytes;
      },
      async fetch() {
        throw new Error("HTTP must not be used for an onchain manifest URI.");
      },
    },
  });
  assert.equal(reads, 1);
  assert.equal(loaded.integrityVerified, true);
  assert.equal(loaded.sourceUrl, uri);
  await assert.rejects(
    () => loadArtifactManifest(`${uri}?redirect=https://evil.example`, integrity, {
      adapters: { async readOnchainObject() { return bytes; } },
    }),
    /cannot contain.*query/i,
  );
});


test("registry adapter performs explicit active and confirmation contract calls", async () => {
  const calls = [];
  const reader = createKeelIndexPresentationReader(async request => {
    calls.push(request.functionName);
    if (request.functionName === "activePresentation") {
      return ["ipfs://manifest", `0x${"12".repeat(32)}`, 3n];
    }
    return true;
  });
  const controller = new AbortController();
  const result = await reader({
    chainId: 1,
    registry: "0x1111111111111111111111111111111111111111",
    collection: "0x2222222222222222222222222222222222222222",
    tokenId: "99",
    revision: 3,
  }, controller.signal);
  assert.deepEqual(calls, ["activePresentation", "presentationMatches"]);
  assert.equal(result.revision, 3);
});

test("registry resolution enforces contract -> manifest -> resource commitment chain", async () => {
  const anchor = {
    protocol: KEEL_REGISTRY_ANCHOR_PROTOCOL,
    kind: "artifact-registry",
    chainId: 8453,
    registry: "0x1111111111111111111111111111111111111111",
    collection: "0x2222222222222222222222222222222222222222",
    tokenId: "7",
    revision: 1,
  };
  const value = await manifest();
  value.runtime = runtimePolicy({ content: { manifestTrust: "registry" } });
  value.anchor = anchor;
  value.provenance = {
    createdAt: "2026-08-07T00:00:00.000Z",
    chainId: anchor.chainId,
    collection: anchor.collection,
    tokenId: anchor.tokenId,
  };
  const integrity = await manifestIntegrity(value);
  const manifestUrl = "https://cdn.example/registry/manifest.json";
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let contractReads = 0;
  const artifact = await resolveArtifactFromRegistry(anchor, {
    adapters: {
      async readArtifactPresentation(request) {
        contractReads += 1;
        assert.equal(request.registry, anchor.registry);
        return { manifestURI: manifestUrl, manifestDigest: integrity.digest, revision: 1 };
      },
      async fetch(url) {
        assert.equal(url, manifestUrl);
        return fetchResponse(url, bytes);
      },
    },
    sourceAllowlist: ["cdn.example"],
  });
  assert.equal(contractReads, 1);
  assert.equal(artifact.commitment.registry.verified, true);
  assert.equal(artifact.audit.anchorVerified, true);
  assert.equal(createVerifiedContentGateway(artifact).resolve("/content/image").status, 200);
});

test("registry-trusted manifests cannot mount through an unanchored resolver path", async () => {
  const value = await manifest();
  value.runtime = runtimePolicy({ content: { manifestTrust: "registry" } });
  value.anchor = {
    protocol: KEEL_REGISTRY_ANCHOR_PROTOCOL,
    kind: "artifact-registry",
    chainId: 1,
    registry: "0x1111111111111111111111111111111111111111",
    collection: "0x2222222222222222222222222222222222222222",
    tokenId: "1",
    revision: 1,
  };
  await assert.rejects(() => resolveArtifact(value), /KeelIndex proof|verified registry commitment/i);
});

test("sandbox recursively materializes nested text resource references", async () => {
  const value = await manifest();
  value.resources[0] = await inline(
    "viewer",
    "entrypoint",
    "text/html",
    '<link rel="stylesheet" href="/content/style"><main>nested</main>',
    true,
  );
  value.resources.push(await inline("style", "style", "text/css", 'main{background-image:url("/content/image")}'));
  const artifact = await resolveArtifact(value);
  const sandbox = createSandboxDocument(artifact);
  const match = sandbox.html.match(/data:text\/css;base64,([^"']+)/);
  assert.ok(match);
  const css = Buffer.from(match[1], "base64").toString("utf8");
  assert.ok(css.includes("data:image/svg+xml;base64,"));
});

test("sandbox enables WebAssembly only when explicitly declared", async () => {
  const value = await manifest();
  value.runtime.capabilities.webAssembly = true;
  const sandbox = createSandboxDocument(await resolveArtifact(value));
  assert.ok(sandbox.csp.includes("'wasm-unsafe-eval'"));
  assert.equal(sandbox.sandboxTokens.includes("allow-same-origin"), false);
});

test("portable viewer mirrors are hash verified and launch templates remain host-independent", async () => {
  const bad = new TextEncoder().encode("corrupt viewer");
  const good = new TextEncoder().encode("verified viewer bundle");
  const integrity = await createIntegrity(good);
  const mirrors = [
    { id: "primary", uri: "https://viewer-one.example/viewer.js", integrity },
    {
      id: "mirror",
      uri: "https://viewer-two.example/viewer.js",
      integrity,
      launchUrlTemplate: "https://viewer-two.example/?manifest={manifest}&digest={digest}",
    },
  ];
  const bundle = await loadVerifiedViewerBundle(mirrors, {
    sourceAllowlist: ["viewer-one.example", "viewer-two.example"],
    async fetch(url) {
      return fetchResponse(url, url.includes("viewer-one") ? bad : good);
    },
  });
  assert.equal(bundle.mirror.id, "mirror");
  assert.equal(bundle.integrityVerified, true);
  const launches = viewerLaunches(mirrors, "ipfs://manifest", integrity.digest);
  assert.ok(launches[1].launchUrl.includes(encodeURIComponent("ipfs://manifest")));
  assert.ok(launches[1].launchUrl.includes(encodeURIComponent(integrity.digest)));
});


test("Electron guard denies all renderer egress below the iframe sandbox", () => {
  let registeredFilter;
  let registeredListener;
  const session = {
    webRequest: {
      onBeforeRequest(filter, listener) {
        registeredFilter = filter;
        registeredListener = listener;
      },
    },
  };
  const guard = installElectronViewerEgressGuard(session);
  assert.deepEqual(registeredFilter, { urls: ["<all_urls>"] });
  let decision;
  registeredListener({ url: "https://evil.example/exfil" }, result => { decision = result; });
  assert.deepEqual(decision, { cancel: true });
  guard.dispose();
  assert.equal(registeredFilter, null);
  assert.equal(registeredListener, null);
});

const keelAddresses = {
  artifact: "0x1111111111111111111111111111111111111111",
  collection: "0x2222222222222222222222222222222222222222",
  object: "0x333333333333333333333333333333333333abcd",
  viewer: "0x4444444444444444444444444444444444444444",
  link: "0x5555555555555555555555555555555555555555",
  seed: "0x6666666666666666666666666666666666666666",
  inventory: "0x7777777777777777777777777777777777777777",
  store: "0x888888888888888888888888888888888888abcd",
  characterRegistry: "0x9999999999999999999999999999999999999999",
  arcade: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  mapCollection: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  portableAnchors: "0xcccccccccccccccccccccccccccccccccccccccc",
  verification: "0xdddddddddddddddddddddddddddddddddddddddd",
};

const keelIds = {
  viewer: `0x${"10".repeat(32)}`,
  object: `0x${"20".repeat(32)}`,
  content: `0x${"30".repeat(32)}`,
  selection: `0x${"40".repeat(32)}`,
  seedSet: `0x${"50".repeat(32)}`,
  provenance: `0x${"60".repeat(32)}`,
  loadout: `0x${"70".repeat(32)}`,
  definition: `0x${"80".repeat(32)}`,
  gearObject: `0x${"90".repeat(32)}`,
  gearContent: `0x${"a0".repeat(32)}`,
  policy: `0x${"b1".repeat(32)}`,
  receipt: `0x${"b2".repeat(32)}`,
  presentationRoot: `0x${"b3".repeat(32)}`,
  presentationAnchor: `0x${"b4".repeat(32)}`,
  presentationContent: `0x${"b5".repeat(32)}`,
  evidence: `0x${"b6".repeat(32)}`,
  runtimeCodeHash: `0x${"b7".repeat(32)}`,
};

async function keelManifest(
  extension,
  determinism = { mode: "live" },
  anchor = { collection: keelAddresses.collection, tokenId: "7" },
) {
  const value = await manifest();
  value.runtime = runtimePolicy({ content: { manifestTrust: "registry" }, determinism });
  value.anchor = {
    protocol: KEEL_REGISTRY_ANCHOR_PROTOCOL,
    kind: "artifact-registry",
    chainId: 31337,
    registry: keelAddresses.artifact,
    collection: anchor.collection,
    tokenId: anchor.tokenId,
    ...(anchor.scope === undefined ? {} : { scope: anchor.scope }),
    revision: 1,
  };
  value.provenance = {
    createdAt: "2026-08-08T00:00:00.000Z",
    chainId: 31337,
    collection: anchor.collection,
    ...(anchor.scope === "collection" ? {} : { tokenId: anchor.tokenId }),
  };
  value.extensions = {
    "keel.runtime": extension,
    ...(extension.collectionVerification === undefined ? {} : {
      "keel.portable": {
        protocol: "keel-presentation-portable-binding@1",
        portableRoot: keelIds.presentationRoot,
        portableAnchorRoot: keelIds.presentationAnchor,
        manifestObjectId: `0x${"b8".repeat(32)}`,
        manifestObjectRevision: "1",
        decodedObjectId: `0x${"b9".repeat(32)}`,
        decodedObjectRevision: "1",
      },
    }),
  };
  const integrity = await manifestIntegrity(value);
  const commitment = {
    integrity,
    digestVerified: true,
    registry: {
      anchor: value.anchor,
      driveAnchor: {
        ...value.anchor,
        scope: "token",
        tokenId: anchor.requestTokenId ?? anchor.tokenId,
      },
      presentation: { manifestURI: "ipfs://keel-manifest", manifestDigest: integrity.digest, revision: 1 },
      verified: true,
    },
  };
  return { value, integrity, commitment };
}

function baseKeelExtension(overrides = {}) {
  return {
    protocol: "keel-runtime@1",
    chainId: 31337,
    mode: "exact",
    artifactRegistry: keelAddresses.object,
    harnessRegistry: keelAddresses.viewer,
    linkRegistry: keelAddresses.link,
    viewerId: keelIds.viewer,
    tokenId: "7",
    slotResources: ["image"],
    expectedViewer: { harnessRevision: 1, forkRevision: 0, selectionDigest: keelIds.selection },
    ...overrides,
  };
}

function keelReader({
  manifestDigest,
  objectBytes,
  gearBytes,
  derivedSeed,
  loadoutDigest = keelIds.loadout,
  harnessCollection = keelAddresses.collection,
}) {
  const objectDigest = keccak256(objectBytes);
  const gearDigest = gearBytes === undefined ? undefined : keccak256(gearBytes);
  const zeroAddress = "0x0000000000000000000000000000000000000000";
  const zeroBytes = `0x${"00".repeat(32)}`;
  const emptyLoadout = Array.from({ length: 9 }, (_, slot) => [
    slot,
    zeroBytes,
    zeroAddress,
    0n,
    0,
    zeroBytes,
    0n,
    zeroBytes,
    false,
  ]);
  if (gearBytes !== undefined) {
    emptyLoadout[8] = [
      8,
      keelIds.definition,
      "0x9999999999999999999999999999999999999999",
      42n,
      0,
      keelIds.gearObject,
      3n,
      keelIds.provenance,
      true,
    ];
  }

  return async request => {
    assert.equal(request.chainId, 31337);
    assert.equal(request.blockNumber, 123n);
    switch (`${request.address}:${request.functionName}`) {
      case `${keelAddresses.viewer}:artifactRegistry`:
      case `${keelAddresses.link}:artifactRegistry`:
      case `${keelAddresses.inventory}:artifactRegistry`:
        return getAddress(keelAddresses.object);
      case `${keelAddresses.viewer}:keelIndex`:
      case `${keelAddresses.seed}:keelIndex`:
      case `${keelAddresses.inventory}:keelIndex`:
        return keelAddresses.artifact;
      case `${keelAddresses.viewer}:harnessCollection`:
        return harnessCollection;
      case `${keelAddresses.inventory}:characterCollection`:
        return keelAddresses.collection;
      case `${keelAddresses.seed}:harnessRegistry`:
        return keelAddresses.viewer;
      case `${keelAddresses.viewer}:effectiveHarness`:
        return [1n, 0n, 0n, manifestDigest, keelIds.selection, [keelIds.object], [1n]];
      case `${keelAddresses.object}:artifactRevisionSource`: {
        const [objectId] = request.args;
        if (objectId === keelIds.gearObject) {
          return [getAddress(keelAddresses.store), keelIds.gearContent, 1, gearDigest, BigInt(gearBytes.length), 0, "image/svg+xml"];
        }
        return [getAddress(keelAddresses.store), keelIds.content, 1, objectDigest, BigInt(objectBytes.length), 0, "image/svg+xml"];
      }
      case `${keelAddresses.link}:linkExists`:
        return request.args[2] === 2;
      case `${keelAddresses.link}:fidelityLink`:
        return [
          keelIds.object,
          1n,
          2,
          0,
          1,
          0,
          "https://mirror.example/object.svg",
          "image/svg+xml",
          objectDigest,
          keelIds.provenance,
          BigInt(objectBytes.length),
          1n,
          keelAddresses.collection,
          keelAddresses.collection,
          true,
        ];
      case `${keelAddresses.seed}:seedSetForViewerRevision`:
        return [
          keelIds.viewer,
          1n,
          keelAddresses.collection,
          manifestDigest,
          keelIds.provenance,
          keelIds.provenance,
          1n,
          keelAddresses.collection,
          keelAddresses.collection,
          true,
        ];
      case `${keelAddresses.seed}:predictSeedSetId`:
        return keelIds.seedSet;
      case `${keelAddresses.seed}:deriveTokenSeed`:
        return derivedSeed;
      case `${keelAddresses.inventory}:loadout`:
        return [emptyLoadout, loadoutDigest];
      case `${keelAddresses.inventory}:equipmentSource`:
        return [
          keelIds.definition,
          keelIds.gearObject,
          3n,
          getAddress(keelAddresses.store),
          keelIds.gearContent,
          1,
          gearDigest,
          BigInt(gearBytes.length),
          0,
          "image/svg+xml",
        ];
      default:
        throw new Error(`Unexpected Keel read ${request.address}:${request.functionName}`);
    }
  };
}

test("Keel reads the chain by default and never touches the declared mirror", async () => {
  // The default transport is the chain the proof lives on. A mirror that is
  // still declared, still committed, and still byte-identical is simply not
  // consulted -- so a gateway going down, going slow, or going hostile is not
  // in the render path at all.
  const objectBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect width="9" height="9"/></svg>');
  const { value, integrity, commitment } = await keelManifest(baseKeelExtension());
  const reader = keelReader({ manifestDigest: integrity.digest, objectBytes });
  const result = await resolveKeelArtifact(value, commitment, {
    readContract: reader,
    blockNumber: 123n,
    sourceAllowlist: ["mirror.example"],
    adapters: {
      async fetch(url) {
        throw new Error(`the default transport fetched ${url}`);
      },
      async readOnchainObject({ objectId }) {
        assert.equal(objectId, keelIds.content);
        return objectBytes;
      },
      async customDigest(algorithm, bytes) {
        return keccak256(bytes, "bytes");
      },
    },
  });
  assert.equal(result.artifact.resources.get("image").source.kind, "onchain");
  // The mirror is still bound and still proven; it is only not the transport.
  assert.equal(result.binding.objects[0].fidelityLinks.length, 1);
  const audits = result.artifact.audit.entries.filter(entry => entry.resourceId === "image");
  assert.deepEqual(audits.map(entry => entry.status), ["loaded"]);
});

test("Keel binds exact viewer state and falls back from a corrupt hybrid to verified Keccak onchain bytes", async () => {
  const objectBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect width="9" height="9"/></svg>');
  const { value, integrity, commitment } = await keelManifest(baseKeelExtension());
  const reader = keelReader({ manifestDigest: integrity.digest, objectBytes });
  const result = await resolveKeelArtifact(value, commitment, {
    readContract: reader,
    blockNumber: 123n,
    sourceAllowlist: ["mirror.example"],
    // Mirror-first is opt-in now. The corrupt-mirror rejection it proves still
    // has to work for anyone who turns it on, so the proof runs against the
    // opt-in rather than being deleted with the default.
    gatewayTransport: "preferred",
    adapters: {
      async fetch(url) {
        assert.equal(url, "https://mirror.example/object.svg");
        return fetchResponse(url, new TextEncoder().encode("corrupt mirror"));
      },
      async readOnchainObject({ objectId }) {
        assert.equal(objectId, keelIds.content);
        return objectBytes;
      },
      async customDigest(algorithm, bytes) {
        assert.equal(algorithm, "keccak256");
        return keccak256(bytes, "bytes");
      },
    },
  });
  assert.equal(result.binding.effectiveHarness.selectionDigest, keelIds.selection);
  assert.equal(result.binding.objects[0].fidelityLinks.length, 1);
  assert.equal(result.artifact.resources.get("image").source.kind, "onchain");
  const audits = result.artifact.audit.entries.filter(entry => entry.resourceId === "image");
  assert.deepEqual(audits.map(entry => entry.status), ["failed", "loaded"]);
});

test("Keel live injection pins reads while exposing only manifest-declared context fields", async () => {
  const objectBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
  const extension = baseKeelExtension({
    injection: {
      protocol: "keel-injection@1",
      fields: ["block.hash", "block.timestamp", "token.id"],
    },
  });
  const { value, integrity, commitment } = await keelManifest(extension);
  const blockHash = `0x${"de".repeat(32)}`;
  const baseReader = keelReader({ manifestDigest: integrity.digest, objectBytes });
  const reader = request => {
    assert.equal(request.blockHash, blockHash);
    return baseReader(request);
  };
  const bound = await bindKeelManifest(value, commitment, {
    readContract: reader,
    blockNumber: 123n,
    blockHash,
    blockTimestamp: 1700000000n,
  });
  assert.deepEqual(bound.binding.runtimeContext, {
    protocol: "keel-context@1",
    blockHash,
    blockTimestamp: "1700000000",
    tokenId: "7",
  });
  await assert.rejects(
    () => bindKeelManifest(value, commitment, { readContract: reader, blockNumber: 123n }),
    /block number, hash, and timestamp/i,
  );
});

function collectionVerificationState(overrides = {}) {
  const zeroAddress = "0x0000000000000000000000000000000000000000";
  const zeroBytes = `0x${"00".repeat(32)}`;
  return {
    expectedTokenURIHash: `0x${"ca".repeat(32)}`,
    resolver: keelAddresses.artifact,
    keelIndex: keelAddresses.artifact,
    presentationScope: 0n,
    routeLocked: true,
    pointerAuthority: zeroAddress,
    presentationRevision: 1n,
    portableRoot: keelIds.presentationRoot,
    manifestDigest: overrides.manifestDigest,
    revisionPolicy: 1,
    publisherAuthority: zeroAddress,
    activationAuthority: zeroAddress,
    governanceTimelock: zeroAddress,
    revisionLineageRoot: `0x${"cb".repeat(32)}`,
    appendOnlyRevisions: true,
    revisionFrozen: false,
    governanceVerifiable: false,
    mintStatus: 1,
    mintAccessMode: 3,
    mintAuthority: zeroAddress,
    mintAuthoritiesRoot: zeroBytes,
    mintAuthorityCount: 0,
    mintPolicyAuthority: zeroAddress,
    mintTimelock: zeroAddress,
    mintVerifiable: false,
    totalSupply: 1n,
    lifetimeMinted: 1n,
    burnedCount: 0n,
    remainingMintable: 99n,
    maxSupply: 100n,
    reservedSupply: 0n,
    supplyKnownFlags: 0x3f,
    maxSupplyKind: 1,
    capMutable: false,
    capAuthority: zeroAddress,
    supplyTimelock: zeroAddress,
    supplyVerifiable: true,
    burnPolicy: 0,
    implementation: zeroAddress,
    proxyAdmin: zeroAddress,
    beacon: zeroAddress,
    upgradeMutable: false,
    upgradeAuthority: zeroAddress,
    upgradeTimelock: zeroAddress,
    upgradeVerifiable: true,
    ...overrides,
  };
}

function collectionVerificationReceipt(manifestDigest, facets, overrides = {}) {
  const zeroAddress = "0x0000000000000000000000000000000000000000";
  return {
    policyId: keelIds.policy,
    evidenceRoot: keelIds.evidence,
    tokenURIHash: `0x${"ca".repeat(32)}`,
    portableRoot: keelIds.presentationRoot,
    portableAnchorRoot: keelIds.presentationAnchor,
    presentationContentDigest: keelIds.presentationContent,
    manifestDigest,
    runtimeCodeHash: keelIds.runtimeCodeHash,
    collection: keelAddresses.collection,
    resolver: keelAddresses.artifact,
    keelIndex: keelAddresses.artifact,
    pointerAuthority: zeroAddress,
    publisherAuthority: zeroAddress,
    activationAuthority: zeroAddress,
    governanceTimelock: zeroAddress,
    mintAuthority: zeroAddress,
    mintPolicyAuthority: zeroAddress,
    mintTimelock: zeroAddress,
    capAuthority: zeroAddress,
    supplyTimelock: zeroAddress,
    implementation: zeroAddress,
    proxyAdmin: zeroAddress,
    beacon: zeroAddress,
    upgradeAuthority: zeroAddress,
    upgradeTimelock: zeroAddress,
    presentationScope: 0n,
    tokenId: 7n,
    chainId: 31337n,
    presentationRevision: 1n,
    policyVersion: 1n,
    observedBlock: 100n,
    evidenceBlock: 100n,
    evidenceBlockHash: `0x${"cc".repeat(32)}`,
    expiresAt: 0n,
    lane: 1,
    facets,
    revoked: false,
    exists: true,
    ...overrides,
  };
}

async function bindCollectionVerificationScenario({ current = true, missing = false, receipt = {}, state = {}, facets, lane = 1 } = {}) {
  const objectBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
  const extension = baseKeelExtension({
    collectionVerification: {
      registry: keelAddresses.verification,
      policyId: keelIds.policy,
      tokenId: "7",
    },
    injection: {
      protocol: "keel-injection@1",
      fields: ["chain.id", "block.number", "block.hash", "token.id", "collection.verification"],
    },
  });
  const { value, integrity, commitment } = await keelManifest(extension);
  const stateValue = collectionVerificationState({ manifestDigest: integrity.digest, ...state });
  const facetValue = facets ?? { route: 1, content: 1, governance: 0, mint: 0, supply: 1, upgrade: 1 };
  const receiptValue = collectionVerificationReceipt(integrity.digest, facetValue, { lane, ...receipt });
  const policyValue = {
    input: { lane, runtimeCodeHash: keelIds.runtimeCodeHash, version: 1n },
    enabled: true,
    exists: true,
  };
  const baseReader = keelReader({ manifestDigest: integrity.digest, objectBytes });
  const blockHash = `0x${"de".repeat(32)}`;
  const reader = request => {
    assert.equal(request.blockHash, blockHash);
    if (request.address !== keelAddresses.verification) return baseReader(request);
    switch (request.functionName) {
      case "latestReceipt": return missing ? `0x${"00".repeat(32)}` : keelIds.receipt;
      case "policy": return policyValue;
      case "receipt": return receiptValue;
      case "receiptCurrent": return current;
      case "inspectCurrent": return [stateValue, facetValue];
      case "approvedEvidenceRoot": return current ? keelIds.evidence : `0x${"ef".repeat(32)}`;
      default: throw new Error(`Unexpected verification read ${request.functionName}`);
    }
  };
  return bindKeelManifest(value, commitment, {
    readContract: reader,
    blockNumber: 123n,
    blockHash,
    blockTimestamp: 1_700_000_000n,
  });
}

test("production Keel receipt injection consumes one pinned current onchain inspection", async () => {
  const bound = await bindCollectionVerificationScenario();
  const proof = bound.binding.runtimeContext.collectionVerification;
  assert.equal(proof.proofClass, "native-proof");
  assert.equal(proof.receiptId, keelIds.receipt);
  assert.equal(proof.observationBlockNumber, "100");
  assert.equal(proof.observationBlockHash, `0x${"cc".repeat(32)}`);
  assert.equal(proof.blockNumber, "123");
  assert.equal(proof.blockHash, `0x${"de".repeat(32)}`);
  assert.equal(proof.collection, keelAddresses.collection);
  assert.equal(proof.facets.route.verdict, "green");
  assert.equal(proof.facets.governance.verdict, "unknown");
  assert.match(proof.facets.supply.reason, /1 outstanding, cap 100, 99 remaining/u);
});

test("production Keel receipt injection surfaces stale, revoked, changed, red, and content-only states", async () => {
  const stale = await bindCollectionVerificationScenario({ current: false });
  assert.equal(stale.binding.runtimeContext.collectionVerification.facets.content.verdict, "red");
  const revoked = await bindCollectionVerificationScenario({ current: false, receipt: { revoked: true } });
  assert.equal(revoked.binding.runtimeContext.collectionVerification.revoked, true);
  const changed = await bindCollectionVerificationScenario({
    current: false,
    state: { portableRoot: `0x${"fa".repeat(32)}` },
  });
  assert.equal(changed.binding.runtimeContext.collectionVerification.facets.content.verdict, "red");
  const red = await bindCollectionVerificationScenario({
    facets: { route: 1, content: 1, governance: 0, mint: 3, supply: 3, upgrade: 1 },
  });
  assert.equal(red.binding.runtimeContext.collectionVerification.facets.mint.verdict, "red");
  assert.equal(red.binding.runtimeContext.collectionVerification.facets.supply.verdict, "red");
  const noHook = await bindCollectionVerificationScenario({
    lane: 0,
    receipt: { evidenceBlockHash: `0x${"00".repeat(32)}` },
    facets: { route: 0, content: 1, governance: 0, mint: 0, supply: 0, upgrade: 0 },
  });
  assert.equal(noHook.binding.runtimeContext.collectionVerification.proofClass, "content-only");
  assert.equal(noHook.binding.runtimeContext.collectionVerification.facets.route.verdict, "unknown");
});

test("production Keel receipt injection rejects a missing or substituted receipt", async () => {
  await assert.rejects(
    () => bindCollectionVerificationScenario({ missing: true }),
    /latestReceipt/u,
  );
  await assert.rejects(
    () => bindCollectionVerificationScenario({ receipt: { policyId: `0x${"ee".repeat(32)}` } }),
    /does not bind this exact manifest/u,
  );
});

function vaultRecipeFixture() {
  const value = {
    derivedTokenSeed: `0x${"a1".repeat(32)}`,
    packedAttributes: `0x${"0123456789abcdef".repeat(4)}`,
    portableRoot: `0x${"ab".repeat(32)}`,
    portableManifestObjectId: `0x${"ac".repeat(32)}`,
    portableDecodedObjectId: `0x${"ad".repeat(32)}`,
    portableAnchorRoot: `0x${"ae".repeat(32)}`,
    portableManifestObjectRevision: 5,
    portableDecodedObjectRevision: 6,
    assetFamilyId: `0x${"b2".repeat(32)}`,
    assetId: `0x${"c3".repeat(32)}`,
    spriteObjectId: `0x${"d4".repeat(32)}`,
    targetMapObjectId: `0x${"e5".repeat(32)}`,
    effectProfileObjectId: `0x${"f6".repeat(32)}`,
    soundProfileObjectId: `0x${"17".repeat(32)}`,
    emitterSpriteBundleId: 49,
    emitterSpriteAssetId: 56,
    emitterMaterialTargetId: `0x${"5a".repeat(32)}`,
    catalogRevision: 2,
    assetFamilyRevision: 3,
    emitterPresetId: 9,
    emitterRevision: 1,
    emitterSpriteBundleRevision: 2,
    emitterSpriteSelectionRevision: 7,
    fxCatalogRevision: 4,
    mapGenerationEpoch: 3,
    emitterSeedDomainVersion: 1,
    emitterPaletteMode: 2,
    sceneId: 11,
  };
  return {
    value,
    tuple: [
      value.derivedTokenSeed,
      value.packedAttributes,
      Array.from({ length: 6 }, (_, index) => `0x${String(index + 1).padStart(2, "0").repeat(32)}`),
      [2n, 2n, 2n, 2n, 2n, 2n],
      value.portableRoot,
      value.portableManifestObjectId,
      value.portableDecodedObjectId,
      value.portableAnchorRoot,
      BigInt(value.portableManifestObjectRevision),
      BigInt(value.portableDecodedObjectRevision),
      value.assetFamilyId,
      value.assetId,
      value.spriteObjectId,
      value.targetMapObjectId,
      value.effectProfileObjectId,
      value.soundProfileObjectId,
      value.emitterSpriteBundleId,
      value.emitterSpriteAssetId,
      value.emitterMaterialTargetId,
      2n,
      2n,
      3n,
      2n,
      2n,
      2n,
      2n,
      9,
      1,
      2,
      7,
      4,
      3,
      1,
      2,
      11,
    ],
  };
}

function vaultInjectionFields(includeMap = false) {
  return [
    "token.id",
    "character.seed",
    "character.packedAttributes",
    "character.portableRoot",
    "character.portableManifestObjectId",
    "character.portableDecodedObjectId",
    "character.portableAnchorRoot",
    "character.portableManifestObjectRevision",
    "character.portableDecodedObjectRevision",
    "character.assetFamilyId",
    "character.assetId",
    "character.spriteObjectId",
    "character.targetMapObjectId",
    "character.effectProfileObjectId",
    "character.soundProfileObjectId",
    "character.emitterSpriteBundleId",
    "character.emitterSpriteAssetId",
    "character.emitterMaterialTargetId",
    "character.catalogRevision",
    "character.assetFamilyRevision",
    "character.emitterPresetId",
    "character.emitterRevision",
    "character.emitterSpriteBundleRevision",
    "character.emitterSpriteSelectionRevision",
    "character.fxCatalogRevision",
    "character.mapGenerationEpoch",
    "character.emitterSeedDomainVersion",
    "character.emitterPaletteMode",
    "character.sceneId",
    ...(includeMap ? [
      "map.characterSeed",
      "map.seed",
      "map.buildRevision",
      "map.portableRoot",
      "map.portableManifestObjectId",
      "map.portableDecodedObjectId",
      "map.portableAnchorRoot",
      "map.portableManifestObjectRevision",
      "map.portableDecodedObjectRevision",
    ] : []),
  ];
}

function portableBindingRead(request, recipe) {
  if (request.address === keelAddresses.characterRegistry && request.functionName === "portableAnchorRegistry") {
    return keelAddresses.portableAnchors;
  }
  if (request.address === keelAddresses.portableAnchors && request.functionName === "sourceAnchor") {
    assert.deepEqual(request.args, [recipe.value.portableManifestObjectId, BigInt(recipe.value.portableManifestObjectRevision)]);
    return recipe.value.portableAnchorRoot;
  }
  if (request.address === keelAddresses.portableAnchors && request.functionName === "anchor") {
    assert.deepEqual(request.args, [recipe.value.portableAnchorRoot]);
    return [
      recipe.value.portableManifestObjectId,
      BigInt(recipe.value.portableManifestObjectRevision),
      recipe.value.portableDecodedObjectId,
      BigInt(recipe.value.portableDecodedObjectRevision),
      recipe.value.portableRoot,
      `0x${"af".repeat(32)}`,
      keelAddresses.collection,
      true,
    ];
  }
  return undefined;
}

test("direct Keel character resolution injects the committed onchain recipe without a host overlay", async () => {
  const objectBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>');
  const recipe = vaultRecipeFixture();
  const blockHash = `0x${"bc".repeat(32)}`;
  const extension = baseKeelExtension({
    character: {
      registry: keelAddresses.characterRegistry,
      collection: keelAddresses.collection,
      characterId: "7",
    },
    injection: { protocol: "keel-injection@1", fields: vaultInjectionFields() },
  });
  const { value, integrity, commitment } = await keelManifest(extension);
  const baseReader = keelReader({ manifestDigest: integrity.digest, objectBytes });
  const reader = request => {
    assert.equal(request.blockHash, blockHash);
    if (request.address === keelAddresses.characterRegistry && request.functionName === "characterCollection") {
      return keelAddresses.collection;
    }
    if (request.address === keelAddresses.characterRegistry && request.functionName === "renderRecipe") {
      assert.deepEqual(request.args, [7n]);
      return recipe.tuple;
    }
    const portable = portableBindingRead(request, recipe);
    if (portable !== undefined) return portable;
    return baseReader(request);
  };
  const result = await resolveKeelArtifact(value, commitment, {
    readContract: reader,
    blockNumber: 123n,
    blockHash,
    blockTimestamp: 1_700_000_123n,
    adapters: {
      async readOnchainObject({ objectId }) {
        assert.equal(objectId, keelIds.content);
        return objectBytes;
      },
      async customDigest(algorithm, bytes) {
        assert.equal(algorithm, "keccak256");
        return keccak256(bytes, "bytes");
      },
    },
  });
  assert.deepEqual(result.binding.runtimeContext, {
    protocol: "keel-context@1",
    tokenId: "7",
    ...recipe.value,
  });
  assert.equal(result.binding.characterRecipe.assetId, recipe.value.assetId);
});

test("one collection-scoped Keel viewer resolves each anchored character without a per-token manifest", async () => {
  const objectBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>');
  const recipe = vaultRecipeFixture();
  const blockHash = `0x${"be".repeat(32)}`;
  const extension = baseKeelExtension({
    tokenId: "$anchor.tokenId",
    character: {
      registry: keelAddresses.characterRegistry,
      collection: keelAddresses.collection,
      characterId: "$anchor.tokenId",
    },
    injection: { protocol: "keel-injection@1", fields: vaultInjectionFields() },
  });
  const { value, integrity, commitment } = await keelManifest(
    extension,
    { mode: "live" },
    { collection: keelAddresses.collection, tokenId: "*", scope: "collection", requestTokenId: "7" },
  );
  const baseReader = keelReader({ manifestDigest: integrity.digest, objectBytes });
  const reader = request => {
    if (request.address === keelAddresses.characterRegistry && request.functionName === "characterCollection") {
      return keelAddresses.collection;
    }
    if (request.address === keelAddresses.characterRegistry && request.functionName === "renderRecipe") {
      assert.deepEqual(request.args, [7n]);
      return recipe.tuple;
    }
    const portable = portableBindingRead(request, recipe);
    if (portable !== undefined) return portable;
    return baseReader(request);
  };
  const result = await resolveKeelArtifact(value, commitment, {
    readContract: reader,
    blockNumber: 123n,
    blockHash,
    blockTimestamp: 1_700_000_123n,
    adapters: {
      async readOnchainObject() { return objectBytes; },
      async customDigest(_algorithm, bytes) { return keccak256(bytes, "bytes"); },
    },
  });
  assert.equal(result.binding.runtimeContext.tokenId, "7");
  assert.equal(result.binding.runtimeContext.assetId, recipe.value.assetId);
});

test("direct Keel map resolution injects the staked runtime recipe and map seed without Studio state", async () => {
  const objectBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>');
  const recipe = vaultRecipeFixture();
  const mapCharacterSeed = `0x${"28".repeat(32)}`;
  const mapSeed = `0x${"29".repeat(32)}`;
  const mapPortableRoot = `0x${"31".repeat(32)}`;
  const mapPortableManifestObjectId = `0x${"32".repeat(32)}`;
  const mapPortableDecodedObjectId = `0x${"33".repeat(32)}`;
  const mapPortableAnchorRoot = `0x${"34".repeat(32)}`;
  const blockHash = `0x${"cd".repeat(32)}`;
  const extension = baseKeelExtension({
    tokenId: "$anchor.tokenId",
    character: {
      registry: keelAddresses.characterRegistry,
      collection: keelAddresses.collection,
      characterId: "$staked.characterId",
    },
    map: { registry: keelAddresses.arcade, collection: keelAddresses.mapCollection, mapId: "$anchor.tokenId" },
    injection: { protocol: "keel-injection@1", fields: vaultInjectionFields(true) },
  });
  const { value, integrity, commitment } = await keelManifest(
    extension,
    { mode: "live" },
    { collection: keelAddresses.mapCollection, tokenId: "9" },
  );
  const baseReader = keelReader({
    manifestDigest: integrity.digest,
    objectBytes,
    harnessCollection: keelAddresses.mapCollection,
  });
  const reader = request => {
    assert.equal(request.blockHash, blockHash);
    if (request.address === keelAddresses.characterRegistry && request.functionName === "characterCollection") {
      return keelAddresses.collection;
    }
    if (request.address === keelAddresses.characterRegistry && request.functionName === "renderRecipe") {
      assert.deepEqual(request.args, [7n]);
      return recipe.tuple;
    }
    if (request.address === keelAddresses.arcade) {
      switch (request.functionName) {
        case "characterCollection": return keelAddresses.collection;
        case "mapCollection": return keelAddresses.mapCollection;
        case "characterRegistry": return keelAddresses.characterRegistry;
        case "portableAnchorRegistry": return keelAddresses.portableAnchors;
        case "mapCharacterRuntime":
          assert.deepEqual(request.args, [9n, 7n]);
          return [4n, [
            `0x${"01".repeat(32)}`,
            `0x${"02".repeat(32)}`,
            mapPortableRoot,
            mapPortableManifestObjectId,
            mapPortableDecodedObjectId,
            mapPortableAnchorRoot,
            `0x${"03".repeat(32)}`,
            mapSeed,
            7n, 8n, 1n, 1n, 0n, 1n, keelAddresses.admin, false, true,
          ], recipe.tuple];
        case "mapCharacterSeed":
          assert.deepEqual(request.args, [9n, 7n]);
          return mapCharacterSeed;
        default: break;
      }
    }
    if (request.address === keelAddresses.portableAnchors && request.functionName === "sourceAnchor") {
      if (request.args[0] === mapPortableManifestObjectId) return mapPortableAnchorRoot;
    }
    if (request.address === keelAddresses.portableAnchors && request.functionName === "anchor") {
      if (request.args[0] === mapPortableAnchorRoot) {
        return [
          mapPortableManifestObjectId, 7n, mapPortableDecodedObjectId, 8n, mapPortableRoot,
          `0x${"35".repeat(32)}`, keelAddresses.collection, true,
        ];
      }
    }
    const portable = portableBindingRead(request, recipe);
    if (portable !== undefined) return portable;
    return baseReader(request);
  };
  const result = await resolveKeelArtifact(value, commitment, {
    readContract: reader,
    blockNumber: 123n,
    blockHash,
    blockTimestamp: 1_700_000_456n,
    stakedCharacterId: "7",
    adapters: {
      async readOnchainObject() { return objectBytes; },
      async customDigest(_algorithm, bytes) { return keccak256(bytes, "bytes"); },
    },
  });
  assert.deepEqual(result.binding.runtimeContext, {
    protocol: "keel-context@1",
    tokenId: "9",
    ...recipe.value,
    mapCharacterSeed,
    mapSeed,
    mapBuildRevision: 4,
    mapPortableRoot,
    mapPortableManifestObjectId,
    mapPortableDecodedObjectId,
    mapPortableAnchorRoot,
    mapPortableManifestObjectRevision: 7,
    mapPortableDecodedObjectRevision: 8,
  });
  const emitterIdentity = {
    mapGenerationEpoch: result.binding.runtimeContext.mapGenerationEpoch,
    presetId: result.binding.runtimeContext.emitterPresetId,
    revision: result.binding.runtimeContext.emitterRevision,
    eventKind: 7,
  };
  const emitterContext = { mapSeed, mapId: `0x${9n.toString(16).padStart(64, "0")}`, worldEntityIndex: 42, eventOrdinal: 5 };
  const firstSeed = await deriveEmitterEventSeedFromIdentity(emitterIdentity, emitterContext);
  const replaySeed = await deriveEmitterEventSeedFromIdentity(emitterIdentity, emitterContext);
  assert.deepEqual(firstSeed, replaySeed);
  const first64 = bytes => bytes.slice(0, 8).reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
  assert.deepEqual(
    Array.from({ length: 128 }, (_, counter) => splitMix64(first64(firstSeed), counter)),
    Array.from({ length: 128 }, (_, counter) => splitMix64(first64(replaySeed), counter)),
  );
  const changedMapSeed = await deriveEmitterEventSeedFromIdentity(emitterIdentity, {
    ...emitterContext,
    mapSeed: `0x${"2a".repeat(32)}`,
  });
  assert.notDeepEqual(firstSeed, changedMapSeed);
});

test("Keel replay requires the contract-derived seed and a pinned exact viewer snapshot", async () => {
  const objectBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
  const derivedSeed = `0x${"ab".repeat(32)}`;
  const determinism = {
    mode: "replay",
    seed: derivedSeed,
    randomAlgorithm: "xoshiro128ss",
    viewport: { width: 512, height: 512, devicePixelRatio: 1 },
    clock: { mode: "fixed", epochMs: 0 },
    locale: "en-US",
    timezone: "UTC",
  };
  const { value, integrity, commitment } = await keelManifest(
    baseKeelExtension({ seedRegistry: keelAddresses.seed }),
    determinism,
  );
  const reader = keelReader({ manifestDigest: integrity.digest, objectBytes, derivedSeed });
  const bound = await bindKeelManifest(value, commitment, { readContract: reader, blockNumber: 123n });
  assert.equal(bound.binding.seed.derivedTokenSeed, derivedSeed);

  const mismatched = structuredClone(value);
  mismatched.runtime.determinism.seed = `0x${"cd".repeat(32)}`;
  await assert.rejects(
    () => bindKeelManifest(mismatched, commitment, { readContract: reader, blockNumber: 123n }),
    /replay seed does not match/i,
  );
  await assert.rejects(
    () => bindKeelManifest(value, commitment, { readContract: reader }),
    /pinned blockNumber/i,
  );
});

test("Keel exact equipment overlays a manifest resource only after loadout and source agreement", async () => {
  const objectBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
  const gearBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><circle/></svg>');
  const extension = baseKeelExtension({
    equipment: {
      inventory: keelAddresses.inventory,
      characterCollection: keelAddresses.collection,
      characterId: "7",
      mode: "exact",
      expectedLoadoutDigest: keelIds.loadout,
      resources: [{ slot: 8, resource: "image" }],
    },
  });
  const { value, integrity, commitment } = await keelManifest(extension);
  const reader = keelReader({ manifestDigest: integrity.digest, objectBytes, gearBytes });
  const bound = await bindKeelManifest(value, commitment, { readContract: reader, blockNumber: 123n });
  assert.equal(bound.binding.equipment.entries[8].definitionId, keelIds.definition);
  assert.equal(bound.binding.equipment.sources.get(8).contentObjectId, keelIds.gearContent);
  assert.equal(bound.manifest.resources.find(resource => resource.id === "image").sources[0].objectId, keelIds.gearContent);

  const wrong = structuredClone(value);
  wrong.extensions["keel.runtime"].equipment.expectedLoadoutDigest = `0x${"ef".repeat(32)}`;
  await assert.rejects(
    () => bindKeelManifest(wrong, commitment, { readContract: reader, blockNumber: 123n }),
    /loadout does not match/i,
  );
});

async function contractPluginFixture() {
  const chainId = 31338;
  const graphRegistry = "0x1111111111111111111111111111111111111111";
  const pluginRegistry = "0x2222222222222222222222222222222222222222";
  const market = "0x3333333333333333333333333333333333333333";
  const graphId = `0x${"44".repeat(32)}`;
  const specDigest = `0x${"55".repeat(32)}`;
  const pluginId = `0x${"66".repeat(32)}`;
  const requiredInterfaceId = "0x12345678";
  const reviewDigest = `0x${"77".repeat(32)}`;
  const runtimeCode = Uint8Array.from([0x60, 0x00, 0x60, 0x00, 0x56]);
  const runtimeCodeHash = keccak256(runtimeCode);
  const abiBytes = utf8ToBytes('[{"type":"function","name":"buy"}]');
  const adapterBytes = utf8ToBytes('{"protocol":"keel-market-adapter@1"}');
  const walletBytes = utf8ToBytes("export const walletRuntime = 'keel-host-v1';");
  const intents = [
    {
      id: "market.buy",
      label: "Buy NFT",
      target: "plugin-contract",
      selector: "0x12345678",
      stateMutability: "payable",
      valuePolicy: "exact-quote",
      confirmation: "Buy this exact token using the verified listing quote.",
    },
  ];
  const permissionsDigest = await sha256Hex(
    utf8ToBytes(canonicalJson({ protocol: "keel-wallet-intents@1", intents })),
  );
  const resources = [];
  for (const [id, role, mediaType, bytes] of [
    ["plugin-ui", "entrypoint", "text/html", utf8ToBytes("<main>Verified market</main>")],
    ["image", "fallback", "image/png", utf8ToBytes("image")],
    ["market-abi", "data", "application/json", abiBytes],
    ["market-adapter", "data", "application/json", adapterBytes],
    ["wallet-runtime", "library", "text/javascript", walletBytes],
  ]) {
    resources.push({
      id,
      role,
      mediaType,
      executable: id === "plugin-ui",
      sources: [{ kind: "inline", data: encodeBase64(bytes), encoding: "base64", integrity: await createIntegrity(bytes) }],
    });
  }
  const byId = new Map(resources.map(resource => [resource.id, resource]));
  const pluginManifest = baseManifest(resources, {
    id: "keel-market-plugin-v1",
    name: "Keel Market Plugin",
    entrypoint: { resource: "plugin-ui", mode: "html" },
    fallback: { image: "image" },
  });
  pluginManifest.contractPlugin = {
    protocol: "keel-contract-plugin@1",
    pluginId,
    version: 1,
    graph: {
      protocol: "keel-graph-registry@1",
      chainId,
      registry: graphRegistry,
      graphId,
      version: 1,
      storageTier: "remote-pinned",
    },
    contract: { chainId, address: market, runtimeCodeHash, requiredInterfaceId },
    runtime: {
      abi: { resource: "market-abi", integrity: byId.get("market-abi").sources[0].integrity },
      adapter: { resource: "market-adapter", integrity: byId.get("market-adapter").sources[0].integrity },
      walletLibrary: { resource: "wallet-runtime", integrity: byId.get("wallet-runtime").sources[0].integrity },
    },
    permissions: { protocol: "keel-wallet-intents@1", digest: permissionsDigest, intents },
  };
  const pluginIntegrity = await manifestIntegrity(pluginManifest);
  const pluginBytes = utf8ToBytes(canonicalJson(pluginManifest));
  const resourceGraphDigest = await sha256Hex(utf8ToBytes(canonicalJson(pluginManifest.resources)));
  const outerResources = [
    await inline("viewer", "entrypoint", "text/html", "<main>NFT with market</main>", true),
    await inline("image", "fallback", "image/png", "image"),
    {
      id: "market-plugin-manifest",
      role: "data",
      mediaType: "application/json",
      executable: false,
      sources: [{ kind: "inline", data: encodeBase64(pluginBytes), encoding: "base64", integrity: pluginIntegrity }],
    },
  ];
  const outerManifest = baseManifest(outerResources, {
    id: "nft-with-market",
    name: "NFT With Market",
    entrypoint: { resource: "viewer", mode: "html" },
    fallback: { image: "image" },
  });
  outerManifest.plugins = {
    protocol: "keel-plugin-bindings@1",
    plugins: [
      {
        id: "keel-market",
        manifestResource: "market-plugin-manifest",
        manifestIntegrity: pluginIntegrity,
        graph: pluginManifest.contractPlugin.graph,
        trust: {
          protocol: "keel-plugin-registry@1",
          chainId,
          registry: pluginRegistry,
          specDigest,
          requiredStatus: "sanctioned",
        },
      },
    ],
  };
  const outer = await resolveArtifact(outerManifest, {
    commitment: { integrity: await manifestIntegrity(outerManifest), digestVerified: true },
  });
  const spec = {
    pluginId,
    pluginVersion: 1n,
    kind: 0,
    target: market,
    targetRuntimeCodeHash: runtimeCodeHash,
    requiredInterfaceId,
    graphId,
    graphVersion: 1n,
    pluginManifestDigest: pluginIntegrity.digest,
    abiDigest: byId.get("market-abi").sources[0].integrity.digest,
    walletRuntimeDigest: byId.get("wallet-runtime").sources[0].integrity.digest,
    adapterDigest: byId.get("market-adapter").sources[0].integrity.digest,
    permissionsDigest,
    legacyTarget: "0x0000000000000000000000000000000000000000",
    legacyRuntimeCodeHash: `0x${"00".repeat(32)}`,
  };
  const readContract = async request => {
    assert.equal(request.blockNumber, 91n);
    assert.equal(request.blockHash, `0x${"99".repeat(32)}`);
    switch (request.functionName) {
      case "graphRegistry": return graphRegistry;
      case "versionOf":
        return {
          manifestURI: "https://plugins.example/keel-market/v1.json",
          manifestDigest: pluginIntegrity.digest,
          resourceGraphDigest,
          metadataDigest: `0x${"88".repeat(32)}`,
          number: 1n,
          parentVersion: 0n,
          createdAt: 1n,
          storageTier: 0,
          active: true,
          graphFrozen: false,
        };
      case "submission": return { spec, submitter: graphRegistry, submittedAt: 1n, exists: true };
      case "review":
        return {
          status: 2,
          reviewDigest,
          reasonDigest: `0x${"00".repeat(32)}`,
          replacementSpecDigest: `0x${"00".repeat(32)}`,
          walletValidUntil: 0n,
          updatedAt: 1n,
          reviewer: graphRegistry,
        };
      case "walletAuthorized":
      case "bindingsMatch":
      case "supportsInterface": return true;
      case "pluginProtocol": return "0x0e0eb5162ca8df7c079e8d31eaf2f514a536c16bf86ea734ab562928f4dac159";
      case "pluginId": return pluginId;
      case "pluginVersion": return 1n;
      default: throw new Error(`Unexpected plugin read ${request.functionName}`);
    }
  };
  const customDigest = async (algorithm, bytes) => {
    assert.equal(algorithm, "keccak256");
    return hexToBytes(keccak256(bytes));
  };
  return {
    outer,
    readContract,
    readCode: async request => {
      assert.equal(request.address, market);
      return runtimeCode;
    },
    installedRuntime: { abi: abiBytes, adapter: adapterBytes, walletLibrary: walletBytes },
    customDigest,
    blockNumber: 91n,
    blockHash: `0x${"99".repeat(32)}`,
  };
}

test("recursive plugin verifier binds manifest, graph, trust, runtime code, installed wallet bytes, and intents", async () => {
  const fixture = await contractPluginFixture();
  const verified = await resolveKeelContractPlugin(fixture.outer, "keel-market", fixture);
  assert.equal(verified.walletAuthorized, true);
  assert.equal(verified.trust.status, "sanctioned");
  assert.equal(verified.graph.storageTier, "remote-pinned");
  assert.equal(verified.intents.get("market.buy").selector, "0x12345678");
  assert.equal(new TextDecoder().decode(verified.runtime.adapter.bytes), '{"protocol":"keel-market-adapter@1"}');
});

test("recursive plugin verifier rejects a host wallet build not pinned by the sanctioned graph", async () => {
  const fixture = await contractPluginFixture();
  await assert.rejects(
    () => resolveKeelContractPlugin(fixture.outer, "keel-market", {
      ...fixture,
      installedRuntime: { ...fixture.installedRuntime, walletLibrary: utf8ToBytes("mutated host wallet") },
    }),
    /installed wallet library does not match/i,
  );
});

test("plugin frame parser accepts only symbolic session-bound market intents", () => {
  const session = `0x${"12".repeat(32)}`;
  assert.deepEqual(
    parseKeelPluginFrameMessage({
      protocol: "keel-wallet-intent@1",
      session,
      plugin: "keel-market",
      intentId: "market.list",
      proposal: { priceEth: "0.05", bidder: "" },
    }),
    {
      kind: "intent",
      session,
      plugin: "keel-market",
      intentId: "market.list",
      proposal: { priceEth: "0.05", bidder: "" },
    },
  );
  assert.equal(parseKeelPluginFrameMessage({ protocol: "unrelated-viewer-message" }), undefined);
  assert.throws(
    () => parseKeelPluginFrameMessage({
      protocol: "keel-wallet-intent@1",
      session,
      plugin: "keel-market",
      intentId: "market.list",
      proposal: { priceEth: "0.05", bidder: "" },
      to: "0x0000000000000000000000000000000000000001",
      data: "0xdeadbeef",
    }),
    /envelope/i,
  );
  assert.throws(
    () => parseKeelPluginFrameMessage({
      protocol: "keel-wallet-intent@1",
      session,
      plugin: "keel-market",
      intentId: "market.list",
      proposal: { priceEth: "0.05", bidder: "", cursor: "steal" },
    }),
    /proposal/i,
  );
});
