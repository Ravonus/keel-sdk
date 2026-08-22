import test from "node:test";
import assert from "node:assert/strict";
import {
  OCA_CANONICALIZATION,
  OCA_MANIFEST_SCHEMA,
  assertValidKeelIPControlExtension,
  canonicalJson,
  chunkUtf8,
  createIntegrity,
  evaluateProjectRevision,
  packUint48Ids,
  parseArtifactManifest,
  projectComponentCommitment,
  projectStackCommitments,
  normalizeKeelAttributions,
  unpackUint48Ids,
  validateManifest,
} from "../packages/protocol/dist/index.js";
import { baseManifest } from "./fixtures.mjs";

async function inlineSource(text) {
  const bytes = new TextEncoder().encode(text);
  return { kind: "inline", data: Buffer.from(bytes).toString("base64"), encoding: "base64", integrity: await createIntegrity(bytes) };
}

test("RFC 8785 canonical JSON is stable, UTF-16 sorted, and normalizes negative zero", () => {
  assert.equal(canonicalJson({ z: 1, a: { y: true, b: null } }), '{"a":{"b":null,"y":true},"z":1}');
  assert.equal(canonicalJson({ b: -0, a: "\n" }), '{"a":"\\n","b":0}');
  // U+10000 sorts before U+E000 in UTF-16 code-unit order, as required by JCS.
  assert.equal(canonicalJson({ "\uE000": 2, "\u{10000}": 1 }), '{"𐀀":1,"":2}');
  assert.throws(() => canonicalJson({ value: Number.NaN }), /finite/);
  assert.throws(() => canonicalJson({ value: "\uD800" }), /surrogate/);
});

test("uint48 packing round-trips five IDs per word", () => {
  const values = [1n, 2n, (1n << 48n) - 1n, 42n, 9n, 77n];
  const packed = packUint48Ids(values);
  assert.equal(packed.length, 2);
  assert.deepEqual(unpackUint48Ids(packed[0].value, 5), values.slice(0, 5));
  assert.deepEqual(unpackUint48Ids(packed[1].value, 1), values.slice(5));
});

test("UTF-8 chunking is byte accurate", () => {
  const chunks = chunkUtf8("🔥".repeat(20), 13);
  assert.ok(chunks.every((chunk) => chunk.length <= 13));
  assert.equal(chunks.reduce((total, chunk) => total + chunk.length, 0), 80);
});

test("manifest validation catches missing resource references", async () => {
  const manifest = baseManifest([
    {
      id: "viewer",
      role: "entrypoint",
      mediaType: "text/html",
      sources: [await inlineSource("<p>hello</p>")],
    },
  ]);
  const result = validateManifest(manifest);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "fallback.missing"));
});

test("Keel attributions support custom roles without becoming access policy", async () => {
  const attributions = normalizeKeelAttributions([
    {
      account: "0x1111111111111111111111111111111111111111",
      tag: "artist",
      displayName: "Second artist",
      target: { kind: "viewer", id: "0xviewer" },
    },
    {
      account: "0x2222222222222222222222222222222222222222",
      tag: "engineer",
      target: { kind: "object", id: "0xobject", revision: 2 },
    },
  ]);
  assert.equal(attributions.length, 2);
  assert.equal(attributions[0].tag, "artist");
  assert.equal(attributions[1].target.revision, 2);
  assert.throws(
    () => normalizeKeelAttributions([
      { account: "0x1", tag: "artist" },
      { account: "0x1", tag: "artist" },
    ]),
    /Duplicate attribution/,
  );

  const manifest = {
    ...baseManifest([
      { id: "viewer", role: "entrypoint", mediaType: "text/html", sources: [await inlineSource("<p>hello</p>")] },
    ], { fallback: { image: "viewer" } }),
    attributions,
  };
  assert.equal(validateManifest(manifest).valid, true);
  assert.equal(parseArtifactManifest(manifest).attributions[0].displayName, "Second artist");
});

test("untrusted manifest parsing rejects malformed v2 structure before resolution", () => {
  assert.throws(() => parseArtifactManifest({ schema: OCA_MANIFEST_SCHEMA }), /canonicalization/);
  assert.throws(
    () => parseArtifactManifest({ schema: OCA_MANIFEST_SCHEMA, canonicalization: OCA_CANONICALIZATION }),
    /\$\.id/,
  );
  assert.throws(() => parseArtifactManifest([]), /must be an object/);
});

test("thumbnail manifests support animated image or MP4 resources up to 2 MiB", async () => {
  const viewer = await inlineSource("<canvas></canvas>");
  const preview = await inlineSource("animated-webp");
  const manifest = baseManifest([
    { id: "viewer", role: "entrypoint", mediaType: "text/html", sources: [viewer] },
    { id: "preview", role: "preview", mediaType: "image/webp", sources: [preview] },
  ], { fallback: { image: "preview", animation: "viewer" } });
  manifest.thumbnail = {
    protocol: "oca-thumbnail@1",
    image: "preview",
    animation: "preview",
    maxBytes: 2 * 1024 * 1024,
    capture: { mode: "after-init", target: "canvas", delayMs: 250, durationMs: 2_000, frameRate: 30, label: "hero" },
  };
  assert.equal(validateManifest(manifest).valid, true);
  assert.equal(parseArtifactManifest(manifest).thumbnail.capture.mode, "after-init");
  const oversized = structuredClone(manifest);
  oversized.resources[1].sources[0].integrity.byteLength = 2 * 1024 * 1024 + 1;
  assert.ok(validateManifest(oversized).issues.some((issue) => issue.code === "thumbnail.bytes"));
});

test("manifest validation checks contract chains and immutable chunk identifiers", async () => {
  const bytes = new TextEncoder().encode("artifact");
  const integrity = await createIntegrity(bytes);
  const manifest = baseManifest([
    {
      id: "viewer",
      role: "entrypoint",
      mediaType: "text/html",
      sources: [{
        kind: "contract-call",
        chainId: 0,
        to: "0x1111111111111111111111111111111111111111",
        data: "0x",
        decode: "bytes",
        integrity,
      }],
    },
    {
      id: "image",
      role: "fallback",
      mediaType: "image/png",
      sources: [{
        kind: "onchain",
        chainId: 1,
        store: "0x1111111111111111111111111111111111111111",
        objectId: `0x${"ab".repeat(32)}`,
        chunks: [`0x${"AB".repeat(32)}`],
        integrity,
      }],
    },
  ]);
  const result = validateManifest(manifest);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.path.endsWith("chainId") && issue.code === "chain.invalid"));
  assert.ok(result.issues.some((issue) => issue.code === "chunk.invalid"));
});

test("v2 rejects raw network capability and requires integrity on every source", async () => {
  const validViewer = await inlineSource("<main></main>");
  const validImage = await inlineSource("image");
  const value = baseManifest([
    { id: "viewer", role: "entrypoint", mediaType: "text/html", sources: [validViewer] },
    {
      id: "image",
      role: "fallback",
      mediaType: "image/png",
      sources: [{ kind: "uri", uri: "https://cdn.example/image.png" }],
    },
  ]);
  const parsedNetwork = JSON.parse(JSON.stringify(baseManifest([
    { id: "viewer", role: "entrypoint", mediaType: "text/html", sources: [validViewer] },
    { id: "image", role: "fallback", mediaType: "image/png", sources: [validImage] },
  ])));
  parsedNetwork.runtime.capabilities.network = true;
  assert.throws(() => parseArtifactManifest(parsedNetwork), /network/);
  const result = validateManifest(value);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "integrity.required"));
});

test("Keel IP-control manifests require a separate Tezos license registry", () => {
  const base = {
    protocol: "keel-ip-control@1",
    chain: "tezos",
    chainId: 1,
    network: "NetXdQprcVkpaWU",
    registry: "KT1RJ6PbjHpwc3M5rw5s2Nbmefwbuwbdxton",
    licenseRegistry: "KT1Q2QvJk2oXf3x3N3h7p2c9G6d4s8m1aBcd",
    policyId: `0x${"11".repeat(32)}`,
    objectId: `0x${"22".repeat(32)}`,
    objectRevision: 1,
    license: {
      licenseId: `0x${"33".repeat(32)}`,
      contentObjectId: `0x${"44".repeat(32)}`,
      decodedDigest: `0x${"55".repeat(32)}`,
      compression: "brotli",
    },
    resources: [{
      resource: "viewer",
      objectId: `0x${"22".repeat(32)}`,
      objectRevision: 1,
      actions: ["view", "download", "remint", "mint-to-backpack"],
      delivery: {
        chain: "tezos",
        chainId: 1,
        network: "NetXdQprcVkpaWU",
        store: "KT1RJ6PbjHpwc3M5rw5s2Nbmefwbuwbdxton",
        contentObjectId: `0x${"44".repeat(32)}`,
        decodedDigest: `0x${"55".repeat(32)}`,
        fileName: "viewer.bin",
      },
    }],
  };
  assert.doesNotThrow(() => assertValidKeelIPControlExtension(base, new Set(["viewer"])));
  const missing = structuredClone(base);
  delete missing.licenseRegistry;
  assert.throws(() => assertValidKeelIPControlExtension(missing), /licenseRegistry/);
  const ethereum = {
    ...base,
    chain: "ethereum",
    network: undefined,
    registry: "0x1111111111111111111111111111111111111111",
    resources: [{
      ...base.resources[0],
      delivery: {
        ...base.resources[0].delivery,
        chain: "ethereum",
        network: undefined,
        store: "0x1111111111111111111111111111111111111111",
      },
    }],
  };
  assert.throws(() => assertValidKeelIPControlExtension(ethereum), /combined registry/);
});

test("artifact plugin bindings pin one exact nested manifest graph and sanctioned spec", async () => {
  const viewer = await inlineSource("<main>plugin host</main>");
  const image = await inlineSource("fallback");
  const pluginBytes = new TextEncoder().encode('{"schema":"oca-manifest@2","id":"keel-market"}');
  const pluginIntegrity = await createIntegrity(pluginBytes);
  const value = baseManifest([
    { id: "viewer", role: "entrypoint", mediaType: "text/html", sources: [viewer] },
    { id: "image", role: "fallback", mediaType: "image/png", sources: [image] },
    {
      id: "keel-market-manifest",
      role: "data",
      mediaType: "application/json",
      sources: [{ kind: "inline", data: Buffer.from(pluginBytes).toString("base64"), encoding: "base64", integrity: pluginIntegrity }],
    },
  ]);
  value.plugins = {
    protocol: "keel-plugin-bindings@1",
    plugins: [{
      id: "keel-market",
      manifestResource: "keel-market-manifest",
      manifestIntegrity: pluginIntegrity,
      graph: {
        protocol: "keel-graph-registry@1",
        chainId: 31338,
        registry: "0x1111111111111111111111111111111111111111",
        graphId: `0x${"22".repeat(32)}`,
        version: 1,
        storageTier: "remote-pinned",
      },
      trust: {
        protocol: "keel-plugin-registry@1",
        chainId: 31338,
        registry: "0x3333333333333333333333333333333333333333",
        specDigest: `0x${"44".repeat(32)}`,
        requiredStatus: "sanctioned",
      },
    }],
  };
  assert.equal(validateManifest(value).valid, true);
  assert.equal(parseArtifactManifest(value).plugins.plugins[0].id, "keel-market");

  value.resources[2].sources[0].integrity = await createIntegrity(new TextEncoder().encode("other manifest"));
  const mismatch = validateManifest(value);
  assert.equal(mismatch.valid, false);
  assert.ok(mismatch.issues.some((issue) => issue.code === "plugin.manifest.mismatch"));
});

test("library bindings pin one exact reusable asset version and resource", async () => {
  const viewer = await inlineSource("<main>library host</main>");
  const image = await inlineSource("fallback");
  const library = await inlineSource("export const frame = 1;");
  const value = baseManifest([
    { id: "viewer", role: "entrypoint", mediaType: "text/html", sources: [viewer] },
    { id: "image", role: "fallback", mediaType: "image/png", sources: [image] },
    { id: "sprite-library", role: "library", mediaType: "text/javascript", sources: [library] },
  ]);
  value.libraries = {
    protocol: "keel-library-bindings@1",
    assets: [{
      id: "sprite-tools",
      resource: "sprite-library",
      resourceIntegrity: library.integrity,
      chainId: 31338,
      registry: "0x1111111111111111111111111111111111111111",
      assetId: `0x${"22".repeat(32)}`,
      policyVersion: 4,
      policyCommitment: `0x${"33".repeat(32)}`,
      graph: {
        protocol: "keel-graph-registry@1",
        chainId: 31338,
        registry: "0x4444444444444444444444444444444444444444",
        graphId: `0x${"55".repeat(32)}`,
        version: 9,
        storageTier: "onchain",
      },
      manifestDigest: `0x${"66".repeat(32)}`,
      resourceGraphDigest: `0x${"77".repeat(32)}`,
      updates: { mode: "locked" },
    }],
  };
  assert.equal(validateManifest(value).valid, true);
  assert.equal(parseArtifactManifest(value).libraries.assets[0].policyVersion, 4);

  value.resources[2].sources[0].integrity = await createIntegrity(new TextEncoder().encode("changed"));
  const mismatch = validateManifest(value);
  assert.equal(mismatch.valid, false);
  assert.ok(mismatch.issues.some((issue) => issue.code === "library.resource.mismatch"));
});

test("project stack labels and independently locks exact components", async () => {
  const viewer = await inlineSource("<main>stack host</main>");
  const image = await inlineSource("fallback");
  const renderer = await inlineSource("export const renderer = 9;");
  const shader = await inlineSource("export const shader = 'pink';");
  const parent = baseManifest([
    { id: "viewer", role: "entrypoint", mediaType: "text/html", executable: true, sources: [viewer] },
    { id: "image", role: "fallback", mediaType: "image/png", sources: [image] },
    { id: "three-runtime", role: "library", mediaType: "text/javascript", executable: true, sources: [renderer] },
    { id: "aurora-shader", role: "shader", mediaType: "text/javascript", executable: true, sources: [shader] },
  ]);
  parent.libraries = {
    protocol: "keel-library-bindings@1",
    assets: [{
      id: "three",
      resource: "three-runtime",
      resourceIntegrity: renderer.integrity,
      chainId: 31338,
      registry: "0x1111111111111111111111111111111111111111",
      assetId: `0x${"22".repeat(32)}`,
      policyVersion: 4,
      policyCommitment: `0x${"33".repeat(32)}`,
      graph: {
        protocol: "keel-graph-registry@1",
        chainId: 31338,
        registry: "0x4444444444444444444444444444444444444444",
        graphId: `0x${"55".repeat(32)}`,
        version: 9,
        storageTier: "onchain",
      },
      manifestDigest: `0x${"66".repeat(32)}`,
      resourceGraphDigest: `0x${"77".repeat(32)}`,
      updates: { mode: "auto-compatible", compatibleGraphVersions: { min: 9, max: 12 } },
    }],
  };
  parent.stack = {
    protocol: "keel-project-stack@1",
    components: [
      {
        id: "mount",
        label: "Artwork entrypoint",
        role: "entrypoint",
        order: 0,
        resource: "viewer",
        resourceIntegrity: viewer.integrity,
        labelOrigin: "creator",
        format: "asset",
        updates: { mode: "locked" },
      },
      {
        id: "renderer",
        label: "Three.js renderer",
        role: "renderer",
        order: 1,
        resource: "three-runtime",
        resourceIntegrity: renderer.integrity,
        library: "three",
        labelOrigin: "library-default",
        format: "es-module",
        updates: { mode: "auto-compatible", compatibleGraphVersions: { min: 9, max: 12 } },
      },
      {
        id: "shader",
        label: "Aurora shader",
        role: "shader",
        order: 2,
        resource: "aurora-shader",
        resourceIntegrity: shader.integrity,
        format: "es-module",
        updates: { mode: "manual" },
      },
    ],
  };
  assert.equal(validateManifest(parent).valid, true);
  assert.equal(parseArtifactManifest(parent).stack.components[1].role, "renderer");
  const commitment = await projectComponentCommitment(parent.stack.components[1], parent.libraries.assets[0]);
  assert.equal(commitment.algorithm, "sha256");
  const componentCommitments = await projectStackCommitments(parent);
  assert.deepEqual(componentCommitments.map((entry) => entry.componentId), ["mount", "renderer", "shader"]);
  assert.equal(componentCommitments[1].commitment.digest, commitment.digest);

  const nextRenderer = await inlineSource("export const renderer = 10;");
  const next = structuredClone(parent);
  next.revision = { number: 2, parent: 1, compatibility: { min: 1, max: 2 }, policy: "creator" };
  next.resources[2].sources = [nextRenderer];
  next.libraries.assets[0].resourceIntegrity = nextRenderer.integrity;
  next.libraries.assets[0].policyVersion = 5;
  next.libraries.assets[0].policyCommitment = `0x${"88".repeat(32)}`;
  next.libraries.assets[0].graph.version = 10;
  next.libraries.assets[0].manifestDigest = `0x${"99".repeat(32)}`;
  next.libraries.assets[0].resourceGraphDigest = `0x${"aa".repeat(32)}`;
  next.stack.components[1].resourceIntegrity = nextRenderer.integrity;
  assert.equal(validateManifest(next).valid, true);
  const compatible = await evaluateProjectRevision(parent, next);
  assert.equal(compatible.valid, true);
  assert.equal(compatible.changes.find((change) => change.componentId === "renderer").decision, "allowed");

  const relabeledLocked = structuredClone(next);
  relabeledLocked.stack.components[0].label = "Different entrypoint meaning";
  const locked = await evaluateProjectRevision(parent, relabeledLocked, { manualApproval: true });
  assert.equal(locked.valid, false);
  assert.equal(locked.changes.find((change) => change.componentId === "mount").decision, "blocked");

  const nextShader = await inlineSource("export const shader = 'violet';");
  const manual = structuredClone(parent);
  manual.revision = { number: 2, parent: 1, compatibility: { min: 1, max: 2 }, policy: "creator" };
  manual.resources[3].sources = [nextShader];
  manual.stack.components[2].resourceIntegrity = nextShader.integrity;
  assert.equal((await evaluateProjectRevision(parent, manual)).requiresManualApproval, true);
  assert.equal((await evaluateProjectRevision(parent, manual, { manualApproval: true })).valid, true);

  const outOfRange = structuredClone(next);
  outOfRange.libraries.assets[0].graph.version = 13;
  const rejected = await evaluateProjectRevision(parent, outOfRange);
  assert.equal(rejected.valid, false);
  assert.match(rejected.changes.find((change) => change.componentId === "renderer").reason, /outside/);

  const tightened = structuredClone(next);
  tightened.stack.components[1].updates = { mode: "locked" };
  tightened.libraries.assets[0].updates = { mode: "locked" };
  const tighteningWithoutApproval = await evaluateProjectRevision(parent, tightened);
  assert.equal(tighteningWithoutApproval.valid, false);
  assert.equal(tighteningWithoutApproval.requiresManualApproval, true);
  assert.equal((await evaluateProjectRevision(parent, tightened, { manualApproval: true })).valid, true);

  const broadened = structuredClone(next);
  broadened.stack.components[1].updates.compatibleGraphVersions.max = 13;
  broadened.libraries.assets[0].updates.compatibleGraphVersions.max = 13;
  const broadenedResult = await evaluateProjectRevision(parent, broadened, { manualApproval: true });
  assert.equal(broadenedResult.valid, false);
  assert.match(broadenedResult.changes.find((change) => change.componentId === "renderer").reason, /broaden/);

  const skippedRevision = structuredClone(next);
  skippedRevision.revision.number = 3;
  const skippedResult = await evaluateProjectRevision(parent, skippedRevision, { manualApproval: true });
  assert.equal(skippedResult.valid, false);
  assert.match(skippedResult.changes[0].reason, /next sequential child/);

  const duplicate = structuredClone(next);
  duplicate.stack.components.push(structuredClone(duplicate.stack.components[0]));
  await assert.rejects(() => projectStackCommitments(duplicate), /Duplicate project component ID/);
  const duplicateResult = await evaluateProjectRevision(parent, duplicate, { manualApproval: true });
  assert.equal(duplicateResult.valid, false);
  assert.match(duplicateResult.changes[0].reason, /unique/);
});

test("verified build provenance chains readable source to exact published bytes", async () => {
  const viewer = await inlineSource("<main>built artifact</main>");
  const image = await inlineSource("fallback");
  const source = await inlineSource("export const answer = 40 + 2;");
  const output = await inlineSource("export const answer=42;");
  const value = baseManifest([
    { id: "viewer", role: "entrypoint", mediaType: "text/html", sources: [viewer] },
    { id: "image", role: "fallback", mediaType: "image/png", sources: [image] },
    { id: "source", role: "original", mediaType: "text/javascript", sources: [source] },
    { id: "bundle", role: "script", mediaType: "text/javascript", sources: [output] },
  ]);
  value.build = {
    protocol: "keel-build-provenance@1",
    source: { availability: "included", resource: "source", integrity: source.integrity },
    steps: [{
      id: "minify",
      operation: "minify",
      tool: { name: "terser", version: "5.43.1" },
      input: source.integrity,
      output: output.integrity,
      optionsDigest: `0x${"12".repeat(32)}`,
      deterministic: true,
    }],
    final: { resource: "bundle", integrity: output.integrity },
  };
  assert.equal(validateManifest(value).valid, true);
  assert.equal(parseArtifactManifest(value).build.steps[0].operation, "minify");
  value.build.steps[0].input = image.integrity;
  assert.ok(validateManifest(value).issues.some((issue) => issue.code === "build.chain"));
});

test("contract plugin manifest pins ABI, adapter, wallet runtime, code, and typed intents", async () => {
  const resources = [];
  for (const [id, role, mediaType, text] of [
    ["plugin-ui", "entrypoint", "text/html", "<main>market</main>"],
    ["image", "fallback", "image/png", "image"],
    ["market-abi", "data", "application/json", "[]"],
    ["market-adapter", "library", "text/javascript", "export const adapter = 1"],
    ["wallet-runtime", "library", "text/javascript", "export const wallet = 1"],
  ]) {
    const source = await inlineSource(text);
    resources.push({ id, role, mediaType, executable: role === "entrypoint", sources: [source] });
  }
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  const value = baseManifest(resources, {
    id: "keel-market-plugin-v1",
    entrypoint: { resource: "plugin-ui", mode: "html" },
    fallback: { image: "image" },
  });
  value.contractPlugin = {
    protocol: "keel-contract-plugin@1",
    pluginId: `0x${"11".repeat(32)}`,
    version: 1,
    graph: {
      protocol: "keel-graph-registry@1",
      chainId: 31338,
      registry: "0x1111111111111111111111111111111111111111",
      graphId: `0x${"22".repeat(32)}`,
      version: 1,
      storageTier: "remote-pinned",
    },
    contract: {
      chainId: 31338,
      address: "0x5555555555555555555555555555555555555555",
      runtimeCodeHash: `0x${"66".repeat(32)}`,
      requiredInterfaceId: "0x12345678",
    },
    runtime: {
      abi: { resource: "market-abi", integrity: byId.get("market-abi").sources[0].integrity },
      adapter: { resource: "market-adapter", integrity: byId.get("market-adapter").sources[0].integrity },
      walletLibrary: { resource: "wallet-runtime", integrity: byId.get("wallet-runtime").sources[0].integrity },
    },
    permissions: {
      protocol: "keel-wallet-intents@1",
      digest: `0x${"77".repeat(32)}`,
      intents: [
        {
          id: "market.buy",
          label: "Buy NFT",
          target: "plugin-contract",
          selector: "0x01020304",
          stateMutability: "payable",
          valuePolicy: "exact-quote",
          confirmation: "Buy this exact token using the verified listing quote.",
        },
      ],
    },
  };
  assert.equal(validateManifest(value).valid, true);
  assert.equal(parseArtifactManifest(value).contractPlugin.runtime.abi.resource, "market-abi");

  const circular = structuredClone(value);
  circular.contractPlugin.trust = {
    protocol: "keel-plugin-registry@1",
    chainId: 31338,
    registry: "0x3333333333333333333333333333333333333333",
    specDigest: `0x${"44".repeat(32)}`,
    requiredStatus: "sanctioned",
  };
  assert.throws(() => parseArtifactManifest(circular), /circular manifest\/spec digest/i);

  value.contractPlugin = {
    ...value.contractPlugin,
    graph: { ...value.contractPlugin.graph, storageTier: "onchain" },
  };
  const prematurePromotion = validateManifest(value);
  assert.equal(prematurePromotion.valid, false);
  assert.ok(prematurePromotion.issues.some((issue) => issue.code === "plugin.storage.regression"));
});

test("plugin parser rejects self-declared trust and arbitrary selectors", async () => {
  const viewer = await inlineSource("<main></main>");
  const image = await inlineSource("image");
  const value = baseManifest([
    { id: "viewer", role: "entrypoint", mediaType: "text/html", sources: [viewer] },
    { id: "image", role: "fallback", mediaType: "image/png", sources: [image] },
  ]);
  value.plugins = {
    protocol: "keel-plugin-bindings@1",
    plugins: [{
      id: "bad",
      manifestResource: "missing",
      manifestIntegrity: { algorithm: "sha256", digest: `0x${"11".repeat(32)}`, byteLength: 1 },
      graph: {
        protocol: "keel-graph-registry@1",
        chainId: 1,
        registry: "0x1111111111111111111111111111111111111111",
        graphId: `0x${"22".repeat(32)}`,
        version: 1,
        storageTier: "remote-pinned",
      },
      trust: {
        protocol: "keel-plugin-registry@1",
        chainId: 1,
        registry: "0x3333333333333333333333333333333333333333",
        specDigest: `0x${"44".repeat(32)}`,
        requiredStatus: "plugin-says-trust-me",
      },
    }],
  };
  assert.throws(() => parseArtifactManifest(value), /requiredStatus/);
});
