import assert from "node:assert/strict";
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  SpriteCodex,
  compileSpriteLibrary,
  compileSpriteCodex,
  decodeCodex,
  decodeSparseMask,
  decodeVarUint,
  deriveEmitterEventSeed,
  deriveMaterialStemSeed,
  emitterReplayHash,
  emitterTrace,
  encodeCodex,
  encodeSparseMask,
  inspectMaterialPixels,
  loadSpriteCodex,
  loadSpriteLibrary,
  materialCompositionDigest,
  materialStemDigest,
  parseWebpDimensions,
  resolveProfilePlan,
  sampleMaterialStem,
  sha256,
  splitMix64,
  tintGrayscalePixels,
  validateEmitterRecipe,
  validateMaterialComposition,
  validateMaterialStemRecipe,
} from "../dist/index.js";

const packageRequire = createRequire(new URL("../package.json", import.meta.url));
const sharp = packageRequire("sharp");

async function png(file, rgba) {
  await sharp({ create: { width: 2, height: 2, channels: 4, background: rgba } }).png().toFile(file);
}

async function preparedWriteFixturePaths(final, transactionId) {
  const key = await sha256(new TextEncoder().encode(`${transactionId}\0${path.resolve(final)}`));
  return {
    temporary: path.join(path.dirname(final), `.sprite-library-write-${key}.new`),
    backup: path.join(path.dirname(final), `.sprite-library-write-${key}.old`),
  };
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "sprite-codex-"));
  await png(path.join(directory, "one.png"), { r: 255, g: 0, b: 0, alpha: 1 });
  await png(path.join(directory, "two.png"), { r: 0, g: 255, b: 0, alpha: 1 });
  await png(path.join(directory, "three.png"), { r: 0, g: 0, b: 255, alpha: 1 });
  await writeFile(path.join(directory, "masks.json"), JSON.stringify({
    overrides: { one: { 0: { 0: "edge", 3: "core" } }, two: { 0: { 1: "fixed" } } },
  }));
  const source = {
    schema: "keel-sprite-source@1",
    id: "fixture",
    frame: { width: 2, height: 2 },
    defaultDisplaySize: 32,
    assets: [
      { id: 1, key: "one", label: "One", slot: 0, frameCapacity: 2, frames: ["one.png"] },
      { id: 2, key: "two", label: "Two", slot: 1, frameCapacity: 2, frames: ["two.png"] },
    ],
    selections: [{ revision: 1, activeAssetIds: [1, 2] }],
    masks: { path: "masks.json", root: "overrides" },
  };
  const manifestPath = path.join(directory, "source.json");
  const lockPath = path.join(directory, "source.lock.json");
  const outputDirectory = path.join(directory, "generated");
  await writeFile(manifestPath, JSON.stringify(source));
  const result = await compileSpriteCodex({ manifestPath, lockPath, outputDirectory });
  return { directory, source, manifestPath, lockPath, outputDirectory, result };
}

test("delta/varint sparse mask codec is exactly reversible", () => {
  const entries = [[0, 3], [1, 0], [127, 12], [128, 4], [9215, 255]];
  assert.deepEqual(decodeSparseMask(encodeSparseMask(entries)), entries);
});

test("SCX1 rejects non-canonical varints and duplicate mask pixels", () => {
  assert.throws(() => decodeVarUint(Uint8Array.from([0x80, 0x00])), /non-canonical/);
  assert.throws(() => decodeVarUint(Uint8Array.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00])), /truncated/);
  assert.throws(() => decodeSparseMask(Uint8Array.from([2, 1, 0, 0, 0])), /strictly increasing/);
});

test("compiler preserves source pixels and authored semantic masks", async () => {
  const built = await fixture();
  const atlas = path.join(built.outputDirectory, built.result.manifest.atlas.file);
  const { data: sourcePixels } = await sharp(path.join(built.directory, "one.png")).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data: atlasPixels } = await sharp(atlas).extract({ left: 0, top: 0, width: 2, height: 2 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([...atlasPixels], [...sourcePixels]);

  const codexBytes = new Uint8Array(await readFile(path.join(built.outputDirectory, built.result.manifest.codex.file)));
  const decoded = decodeCodex(codexBytes);
  const asset = decoded.metadata.assets.find((entry) => entry.id === 1);
  assert.ok(asset);
  const frame = asset.frames[0];
  assert.ok(frame);
  const encoded = decoded.masks.subarray(frame.maskOffset, frame.maskOffset + frame.maskLength);
  assert.deepEqual(
    decodeSparseMask(encoded).map(([pixel, region]) => [pixel, asset.regions[region]]),
    [[0, "edge"], [3, "core"]],
  );
});

test("append-only assets and selection snapshots allow retirement without rerolling revision 1", async () => {
  const built = await fixture();
  const appended = structuredClone(built.source);
  appended.assets.push({ id: 3, key: "three", label: "Three", slot: 2, frameCapacity: 2, frames: ["three.png"] });
  appended.selections.push({ revision: 2, activeAssetIds: [1, 3] });
  await writeFile(built.manifestPath, JSON.stringify(appended));
  const next = await compileSpriteCodex({ manifestPath: built.manifestPath, lockPath: built.lockPath, outputDirectory: built.outputDirectory });
  assert.deepEqual(next.lock.selections[0].activeAssetIds, [1, 2]);
  assert.deepEqual(next.lock.selections[1].activeAssetIds, [1, 3]);
  assert.deepEqual(next.lock.retiredAssetIds, [2]);

  const reactivated = structuredClone(appended);
  reactivated.selections.push({ revision: 3, activeAssetIds: [1, 2, 3] });
  await writeFile(built.manifestPath, JSON.stringify(reactivated));
  await assert.rejects(
    compileSpriteCodex({ manifestPath: built.manifestPath, lockPath: built.lockPath, outputDirectory: built.outputDirectory }),
    /reactivates retired asset 2/,
  );

  const rewritten = structuredClone(appended);
  rewritten.selections[0].activeAssetIds = [1];
  await writeFile(built.manifestPath, JSON.stringify(rewritten));
  await assert.rejects(
    compileSpriteCodex({ manifestPath: built.manifestPath, lockPath: built.lockPath, outputDirectory: built.outputDirectory }),
    /selection revision 1 is immutable/,
  );

  const deleted = structuredClone(appended);
  deleted.assets = deleted.assets.filter((asset) => asset.id !== 2);
  await writeFile(built.manifestPath, JSON.stringify(deleted));
  await assert.rejects(
    compileSpriteCodex({ manifestPath: built.manifestPath, lockPath: built.lockPath, outputDirectory: built.outputDirectory }),
    /unknown asset 2|asset 2 was deleted/,
  );

  await writeFile(built.manifestPath, JSON.stringify(appended));
  await png(path.join(built.directory, "one.png"), { r: 1, g: 2, b: 3, alpha: 1 });
  await assert.rejects(
    compileSpriteCodex({ manifestPath: built.manifestPath, lockPath: built.lockPath, outputDirectory: built.outputDirectory }),
    /changed or removed immutable frame pixels/,
  );
});

test("loader rejects a digest mismatch before decoding an image", async () => {
  const built = await fixture();
  const codex = await readFile(path.join(built.outputDirectory, built.result.manifest.codex.file));
  const atlas = await readFile(path.join(built.outputDirectory, built.result.manifest.atlas.file));
  const fetch = async (url) => new Response(String(url).endsWith(".bin") ? codex : atlas);
  await assert.rejects(loadSpriteCodex({
    codexUrl: "https://example.invalid/fixture.codex.bin",
    atlasUrl: "https://example.invalid/fixture.atlas.webp",
    codexSha256: "00".repeat(32),
    atlasSha256: built.result.manifest.atlas.sha256,
    fetch,
  }), /codex SHA-256 mismatch/);
  await assert.rejects(loadSpriteCodex({
    codexUrl: "https://example.invalid/fixture.codex.bin",
    atlasUrl: "https://example.invalid/fixture.atlas.webp",
    codexSha256: built.result.manifest.codex.sha256,
    atlasSha256: "ff".repeat(32),
    fetch,
  }), /atlas SHA-256 mismatch/);
});

test("CSS and canvas resolution use stable atlas coordinates and nearest-neighbor rendering", async () => {
  const built = await fixture();
  const bytes = new Uint8Array(await readFile(path.join(built.outputDirectory, built.result.manifest.codex.file)));
  const decoded = decodeCodex(bytes);
  const sprites = new SpriteCodex(decoded.metadata, decoded.masks, {}, "blob:atlas");
  const css = sprites.css(2, 0, 32);
  assert.ok(css.includes("background-position:0px -32px"));
  assert.ok(css.includes("image-rendering:pixelated"));
  const calls = [];
  const context = { imageSmoothingEnabled: true, drawImage(...values) { calls.push(values); } };
  sprites.draw(context, { asset: "two", frame: 0 });
  assert.equal(context.imageSmoothingEnabled, false);
  assert.deepEqual(calls[0].slice(1), [0, 2, 2, 2, 0, 0, 32, 32]);
});

test("SCX1 rejects duplicate identity, corrupt layout, mask ranges, dimensions, and unknown selections", async () => {
  const built = await fixture();
  const valid = decodeCodex(new Uint8Array(await readFile(path.join(built.outputDirectory, built.result.manifest.codex.file))));
  const validBytes = encodeCodex(valid.metadata, valid.masks);
  const metadataText = JSON.stringify(valid.metadata);
  const nonCanonicalHeader = Buffer.alloc(8);
  nonCanonicalHeader.write("SCX1");
  nonCanonicalHeader.writeUInt32LE(Buffer.byteLength(metadataText) + 1, 4);
  assert.throws(() => decodeCodex(new Uint8Array(Buffer.concat([nonCanonicalHeader, Buffer.from(` ${metadataText}`), valid.masks]))), /not canonically encoded/);
  const rejectMutation = (mutate, pattern) => {
    const metadata = structuredClone(valid.metadata);
    const masks = valid.masks.slice();
    mutate(metadata, masks);
    assert.throws(() => decodeCodex(encodeCodex(metadata, masks)), pattern);
  };
  rejectMutation((metadata) => { metadata.assets[1].id = metadata.assets[0].id; }, /duplicate asset id/);
  rejectMutation((metadata) => { metadata.assets[1].key = metadata.assets[0].key; }, /duplicate asset id, key, or slot/);
  rejectMutation((metadata) => { metadata.assets[1].slot = metadata.assets[0].slot; }, /duplicate asset id, key, or slot/);
  rejectMutation((metadata) => { metadata.assets[0].frames[0].x = 2; }, /outside or misaligned/);
  rejectMutation((metadata) => { metadata.assets[0].frames[0].y = 2; }, /outside or misaligned/);
  rejectMutation((metadata) => { metadata.assets[0].frames[0].maskOffset = 1; }, /invalid or non-canonical mask offsets/);
  rejectMutation((metadata) => { metadata.assets[0].frames[0].maskLength = valid.masks.length + 1; }, /invalid or non-canonical mask offsets/);
  rejectMutation((metadata) => { metadata.atlas.width = 1; }, /frame capacity exceeds atlas width|outside or misaligned/);
  rejectMutation((metadata) => { metadata.frame.width = 0; }, /frame.width/);
  rejectMutation((metadata) => { metadata.assets[0].regions.push(metadata.assets[0].regions[0]); }, /invalid or duplicate regions/);
  rejectMutation((metadata) => { metadata.selections[0].activeAssetIds.push(999); }, /unknown asset 999/);
  rejectMutation((metadata) => { metadata.selections.push({ revision: 2, activeAssetIds: [1] }, { revision: 3, activeAssetIds: [1, 2] }); }, /reactivates retired asset 2/);

  const firstFrame = valid.metadata.assets[0].frames[0];
  const corruptMasks = valid.masks.slice();
  corruptMasks[firstFrame.maskOffset + firstFrame.maskLength - 1] = 9;
  assert.throws(() => decodeCodex(encodeCodex(valid.metadata, corruptMasks)), /unknown region|trailing bytes|truncated/);
  const outsideMasks = valid.masks.slice();
  outsideMasks[firstFrame.maskOffset + 3] = 5;
  assert.throws(() => decodeCodex(encodeCodex(valid.metadata, outsideMasks)), /mask pixel is outside/);
  assert.deepEqual(decodeCodex(validBytes).metadata, valid.metadata);
});

test("strict configurable limits bound downloads, metadata, counts, masks, and decoded atlas pixels", async () => {
  const built = await fixture();
  const codex = new Uint8Array(await readFile(path.join(built.outputDirectory, built.result.manifest.codex.file)));
  const atlas = new Uint8Array(await readFile(path.join(built.outputDirectory, built.result.manifest.atlas.file)));
  assert.throws(() => decodeCodex(codex, { maxCodexBytes: codex.length - 1 }), /codex exceeds limit/);
  assert.throws(() => decodeCodex(codex, { maxMetadataBytes: 1 }), /metadata exceeds limit/);
  assert.throws(() => decodeCodex(codex, { maxAssets: 1 }), /asset count/);
  assert.throws(() => decodeCodex(codex, { maxTotalFrames: 1 }), /total frame count/);
  assert.throws(() => decodeCodex(codex, { maxRegionsPerAsset: 1 }), /regions/);
  assert.throws(() => decodeCodex(codex, { maxMaskEntriesPerFrame: 1 }), /entry count exceeds limit/);
  assert.throws(() => decodeCodex(codex, { maxTotalMaskEntries: 1 }), /total mask entries/);
  assert.throws(() => decodeCodex(codex, { maxAtlasWidth: 3 }), /atlas dimensions/);
  assert.throws(() => decodeCodex(codex, { maxDecodedPixels: 15 }), /decoded pixels/);
  assert.throws(() => decodeCodex(codex, { maxAssets: 0 }), /invalid sprite codex limit/);
  assert.deepEqual(parseWebpDimensions(atlas), { width: 4, height: 4 });
  assert.throws(() => parseWebpDimensions(Uint8Array.from([1, 2, 3])), /not a WebP/);
  const vaultCodex = new Uint8Array(await readFile(new URL("../vault/generated/vault-weapons-v1.codex.bin", import.meta.url)));
  assert.throws(() => decodeCodex(vaultCodex, { maxFramesPerAsset: 8 }), /frame count/);

  const fetch = async (url) => new Response(String(url).endsWith(".bin") ? codex : atlas);
  await assert.rejects(loadSpriteCodex({
    codexUrl: "https://example.invalid/fixture.codex.bin",
    atlasUrl: "https://example.invalid/fixture.atlas.webp",
    codexSha256: built.result.manifest.codex.sha256,
    atlasSha256: built.result.manifest.atlas.sha256,
    fetch,
    limits: { maxCodexBytes: codex.length - 1 },
  }), /exceeds byte limit/);
  await assert.rejects(loadSpriteCodex({
    codexUrl: "https://example.invalid/fixture.codex.bin",
    atlasUrl: "https://example.invalid/fixture.atlas.webp",
    codexSha256: built.result.manifest.codex.sha256,
    atlasSha256: built.result.manifest.atlas.sha256,
    fetch,
    limits: { maxAtlasBytes: atlas.length - 1 },
  }), /exceeds byte limit/);
  await assert.rejects(loadSpriteCodex({
    codexUrl: "https://example.invalid/fixture.codex.bin",
    atlasUrl: "https://example.invalid/fixture.atlas.webp",
    codexSha256: built.result.manifest.codex.sha256,
    atlasSha256: built.result.manifest.atlas.sha256,
    fetch,
    limits: { maxDecodedPixels: 15 },
  }), /decoded pixels/);
});

test("CLI rejects dangling values and requires an existing lock for check mode", async () => {
  const built = await fixture();
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  assert.notEqual(run("compile", built.manifestPath, "--out").status, 0);
  assert.notEqual(run("compile", built.manifestPath, "--out", "--check").status, 0);
  assert.notEqual(run("compile", built.manifestPath, "--out", built.outputDirectory, "--lock").status, 0);
  assert.notEqual(run("compile", built.manifestPath, "--out", built.outputDirectory, "--check").status, 0);
  const missing = run("compile", built.manifestPath, "--out", built.outputDirectory, "--lock", path.join(built.directory, "missing.lock.json"), "--check");
  assert.notEqual(missing.status, 0);
  assert.ok(missing.stderr.includes("check mode requires an existing --lock file"));
  assert.equal(run("compile", built.manifestPath, "--out", built.outputDirectory, "--lock", built.lockPath, "--check").status, 0);
});

test("Vault build preserves all 36 frames and every authored Gyro/Rift/Needle override", async () => {
  const vault = new URL("../vault/", import.meta.url);
  const source = JSON.parse(await readFile(new URL("weapons.sprite.json", vault), "utf8"));
  const authored = JSON.parse(await readFile(new URL("../../../examples/demos/vault-arcade/generated-attribute-proxy/weapon-region-overrides-v1.json", vault), "utf8"));
  const build = JSON.parse(await readFile(new URL("generated/vault-weapons-v1.build.json", vault), "utf8"));
  const decoded = decodeCodex(new Uint8Array(await readFile(new URL(`generated/${build.codex.file}`, vault))));
  assert.equal(decoded.metadata.assets.reduce((sum, asset) => sum + asset.frames.length, 0), 36);
  for (const asset of decoded.metadata.assets) {
    for (const [frameIndex, frame] of asset.frames.entries()) {
      const encoded = decoded.masks.subarray(frame.maskOffset, frame.maskOffset + frame.maskLength);
      const actual = Object.fromEntries(decodeSparseMask(encoded).map(([pixel, region]) => [pixel, asset.regions[region]]));
      assert.deepEqual(actual, authored.overrides[asset.key]?.[String(frameIndex)] ?? {});

      const sourceFile = new URL(source.assets.find((entry) => entry.id === asset.id).frames[frameIndex], new URL("weapons.sprite.json", vault));
      const { data: sourcePixels } = await sharp(fileURLToPath(sourceFile)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const { data: atlasPixels } = await sharp(fileURLToPath(new URL(`generated/${build.atlas.file}`, vault)))
        .extract({ left: frame.x, top: frame.y, width: 96, height: 96 })
        .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      assert.deepEqual([...atlasPixels], [...sourcePixels]);
    }
  }
});

test("sheet descriptors preserve exact Orb cells and Vault bundles keep incompatible geometry separate", async () => {
  const root = new URL("../vault/generated/library/", import.meta.url);
  const graph = JSON.parse(await readFile(new URL("vault-assets-v1.library.json", root), "utf8"));
  const geometries = new Map();
  for (const bundle of graph.bundles) {
    const build = JSON.parse(await readFile(new URL(bundle.buildManifest, root), "utf8"));
    geometries.set(bundle.key, [build.atlas.width, build.atlas.height]);
  }
  assert.deepEqual(geometries.get("character-orb"), [272, 102]);
  assert.deepEqual(geometries.get("shared-weapons"), [1536, 384]);
  assert.deepEqual(geometries.get("world-tiles"), [1672, 418]);
  assert.deepEqual(geometries.get("world-entities"), [1672, 627]);
  assert.deepEqual(geometries.get("world-fx"), [1672, 209]);

  const orbBundle = graph.bundles.find((entry) => entry.key === "character-orb");
  const orbBuildUrl = new URL(orbBundle.buildManifest, root);
  const orbBuild = JSON.parse(await readFile(orbBuildUrl, "utf8"));
  const orbAtlas = new URL(orbBuild.atlas.file, orbBuildUrl);
  const orbSource = new URL("../../../examples/demos/vault-arcade/generated-attribute-proxy/orb-core-v1-turnaround.png", import.meta.url);
  const { data: sourceCell } = await sharp(fileURLToPath(orbSource)).extract({ left: 68, top: 0, width: 34, height: 34 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data: atlasCell } = await sharp(fileURLToPath(orbAtlas)).extract({ left: 68, top: 0, width: 34, height: 34 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let offset = 0; offset < sourceCell.length; offset += 4) {
    assert.equal(atlasCell[offset + 3], sourceCell[offset + 3]);
    if (sourceCell[offset + 3] !== 0) assert.deepEqual([...atlasCell.subarray(offset, offset + 4)], [...sourceCell.subarray(offset, offset + 4)]);
  }
});

test("Vault dependency profiles load standalone characters without world and staked maps with all shared bundles", async () => {
  const root = new URL("../vault/generated/library/", import.meta.url);
  const graphBytes = new Uint8Array(await readFile(new URL("vault-assets-v1.library.json", root)));
  const graph = JSON.parse(new TextDecoder().decode(graphBytes));
  assert.deepEqual(resolveProfilePlan(graph, "unstaked-character", 1).map((entry) => entry.key), ["character-orb", "shared-weapons"]);
  assert.deepEqual(resolveProfilePlan(graph, "staked-map", 1).map((entry) => entry.key), ["character-orb", "shared-weapons", "world-tiles", "world-entities", "world-fx"]);

  const fileMap = new Map([["/vault-assets-v1.library.json", graphBytes]]);
  for (const bundle of graph.bundles) fileMap.set(`/${bundle.buildManifest}`, new Uint8Array(await readFile(new URL(bundle.buildManifest, root))));
  const fetch = async (url) => {
    const value = fileMap.get(new URL(url).pathname);
    return value === undefined ? new Response("missing", { status: 404 }) : new Response(value);
  };
  const loadedKeys = [];
  const library = await loadSpriteLibrary({
    graphUrl: "./vault-assets-v1.library.json", baseUrl: "https://vault.invalid/", graphSha256: await sha256(graphBytes), profileId: "unstaked-character", profileRevision: 1, fetch,
    loadBundle: async (bundle) => { loadedKeys.push(bundle.key); return new SpriteCodex({ schema: "keel-sprite-codex@1", id: bundle.key, frame: { width: 1, height: 1 }, atlas: { width: 1, height: 1, sha256: "00".repeat(32), mediaType: "image/webp" }, defaultDisplaySize: 32, assets: [], selections: [] }, new Uint8Array(), {}); },
  });
  assert.deepEqual(loadedKeys, ["character-orb", "shared-weapons"]);
  assert.throws(() => library.bundle("world-tiles"), /not in profile/);
  library.dispose();
});

test("Vault inventory excludes every candidate/rejected source from active bundles and deterministic check matches locks", async () => {
  const vault = new URL("../vault/", import.meta.url);
  const report = JSON.parse(await readFile(new URL("generated/library/vault-assets-v1.inventory.json", vault), "utf8"));
  assert.ok(report.included > 0);
  assert.ok(report.excluded > 0);
  assert.equal(report.entries.filter((entry) => entry.status === "included" && /candidate|rejected|concepts|asset-lab/i.test(entry.path)).length, 0);
  assert.ok(report.entries.some((entry) => entry.status === "excluded" && entry.path.includes("assets/enemies/candidates/")));
  const result = await compileSpriteLibrary({
    manifestPath: fileURLToPath(new URL("vault-library.sprite.json", vault)),
    outputDirectory: fileURLToPath(new URL("generated/library", vault)),
    lockPath: fileURLToPath(new URL("vault-library.sprite.lock.json", vault)),
    writeLock: false,
  });
  assert.equal(result.inventory.included, report.included);
  assert.equal(result.inventory.excluded, report.excluded);
});

test("library bundle and profile revisions append without rerolling or mutating pinned dependency plans", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sprite-library-"));
  await png(path.join(directory, "red.png"), { r: 255, g: 0, b: 0, alpha: 1 });
  await png(path.join(directory, "blue.png"), { r: 0, g: 0, b: 255, alpha: 1 });
  await png(path.join(directory, "world.png"), { r: 0, g: 255, b: 0, alpha: 1 });
  const spriteSource = (id, image) => ({ schema: "keel-sprite-source@1", id, frame: { width: 2, height: 2 }, assets: [{ id: 1, key: "asset", label: id, slot: 0, frameCapacity: 1, frames: [image] }], selections: [{ revision: 1, activeAssetIds: [1] }] });
  await writeFile(path.join(directory, "character-v1.json"), JSON.stringify(spriteSource("character", "red.png")));
  await writeFile(path.join(directory, "character-v2.json"), JSON.stringify(spriteSource("character", "blue.png")));
  await writeFile(path.join(directory, "world-v1.json"), JSON.stringify(spriteSource("world-v1", "world.png")));
  const graphPath = path.join(directory, "library.json");
  const lockPath = path.join(directory, "library.lock.json");
  const outputDirectory = path.join(directory, "out");
  const first = {
    schema: "keel-sprite-library-source@1", id: "fixture-library",
    bundles: [{ bundleId: 1, revision: 1, key: "character", role: "character", source: "character-v1.json", lock: "character-v1.lock.json", dependencies: [] }],
    profiles: [
      { id: "unstaked", revision: 1, roots: [{ bundleId: 1, revision: 1 }] },
      { id: "staked", revision: 1, roots: [{ bundleId: 1, revision: 1 }] },
    ], inventoryRoots: [],
  };
  await writeFile(graphPath, JSON.stringify(first));
  const built1 = await compileSpriteLibrary({ manifestPath: graphPath, outputDirectory, lockPath });
  const oldUnstaked = JSON.stringify(resolveProfilePlan(built1.manifest, "unstaked", 1));
  const oldStaked = JSON.stringify(resolveProfilePlan(built1.manifest, "staked", 1));

  const appended = structuredClone(first);
  appended.bundles.push(
    { bundleId: 1, revision: 2, key: "character", role: "character", source: "character-v2.json", lock: "character-v2.lock.json", dependencies: [] },
    { bundleId: 2, revision: 1, key: "world", role: "world", source: "world-v1.json", lock: "world-v1.lock.json", dependencies: [{ bundleId: 1, revision: 2 }] },
  );
  appended.profiles.push(
    { id: "unstaked", revision: 2, roots: [{ bundleId: 1, revision: 2 }] },
    { id: "staked", revision: 2, roots: [{ bundleId: 2, revision: 1 }] },
  );
  await writeFile(graphPath, JSON.stringify(appended));
  const built2 = await compileSpriteLibrary({ manifestPath: graphPath, outputDirectory, lockPath });
  assert.equal(JSON.stringify(resolveProfilePlan(built2.manifest, "unstaked", 1)), oldUnstaked);
  assert.equal(JSON.stringify(resolveProfilePlan(built2.manifest, "staked", 1)), oldStaked);
  assert.deepEqual(resolveProfilePlan(built2.manifest, "unstaked", 2).map((entry) => `${entry.key}@${entry.revision}`), ["character@2"]);
  assert.deepEqual(resolveProfilePlan(built2.manifest, "staked", 2).map((entry) => `${entry.key}@${entry.revision}`), ["character@2", "world@1"]);
  const characterBuilds = built2.manifest.bundles.filter((entry) => entry.bundleId === 1);
  assert.equal(new Set(characterBuilds.map((entry) => entry.buildManifest)).size, 2);
  for (const entry of characterBuilds) {
    const bytes = new Uint8Array(await readFile(path.join(outputDirectory, entry.buildManifest)));
    assert.equal(await sha256(bytes), entry.buildManifestSha256, `${entry.bundleId}@${entry.revision}`);
  }

  const replacedDependency = structuredClone(appended);
  replacedDependency.bundles[0].dependencies = [{ bundleId: 1, revision: 2 }];
  await writeFile(graphPath, JSON.stringify(replacedDependency));
  await assert.rejects(compileSpriteLibrary({ manifestPath: graphPath, outputDirectory, lockPath }), /bundle revision 1@1 changed/);

  const changedProfile = structuredClone(appended);
  changedProfile.profiles[0].roots = [{ bundleId: 1, revision: 2 }];
  await writeFile(graphPath, JSON.stringify(changedProfile));
  await assert.rejects(compileSpriteLibrary({ manifestPath: graphPath, outputDirectory, lockPath }), /profile unstaked@1 changed/);

  const changedKey = structuredClone(appended);
  changedKey.bundles[0].key = "renamed";
  await writeFile(graphPath, JSON.stringify(changedKey));
  await assert.rejects(compileSpriteLibrary({ manifestPath: graphPath, outputDirectory, lockPath }), /bundle id 1 changed key/);

  const deleted = structuredClone(appended);
  deleted.bundles = deleted.bundles.filter((entry) => !(entry.bundleId === 1 && entry.revision === 1));
  deleted.profiles = deleted.profiles.filter((entry) => entry.revision !== 1);
  await writeFile(graphPath, JSON.stringify(deleted));
  await assert.rejects(compileSpriteLibrary({ manifestPath: graphPath, outputDirectory, lockPath }), /bundle revision 1@1 was deleted/);
});

test("unreferenced provenance additions never mutate the committed sprite runtime graph", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sprite-library-provenance-"));
  await mkdir(path.join(directory, "assets"));
  await png(path.join(directory, "assets", "active.png"), { r: 255, g: 255, b: 255, alpha: 1 });
  await png(path.join(directory, "assets", "candidate.png"), { r: 255, g: 0, b: 255, alpha: 1 });
  await writeFile(path.join(directory, "character.json"), JSON.stringify({
    schema: "keel-sprite-source@1", id: "character", frame: { width: 2, height: 2 },
    assets: [{ id: 1, key: "active", label: "Active", slot: 0, frameCapacity: 1, frames: ["assets/active.png"] }],
    selections: [{ revision: 1, activeAssetIds: [1] }],
  }));
  await writeFile(path.join(directory, "library.json"), JSON.stringify({
    schema: "keel-sprite-library-source@1", id: "provenance-library",
    bundles: [{ bundleId: 1, revision: 1, key: "character", role: "character", source: "character.json", lock: "character.lock.json", dependencies: [] }],
    profiles: [{ id: "default", revision: 1, roots: [{ bundleId: 1, revision: 1 }] }],
    inventoryRoots: [{ path: "assets", label: "fixture provenance" }],
  }));
  const outputDirectory = path.join(directory, "out");
  const lockPath = path.join(directory, "library.lock.json");
  const first = await compileSpriteLibrary({ manifestPath: path.join(directory, "library.json"), outputDirectory, lockPath });
  const firstManifest = await readFile(path.join(outputDirectory, "provenance-library.library.json"), "utf8");
  assert.equal(first.manifest.inventory.file, "provenance-library.active-inventory.json");
  assert.equal(first.inventory.excluded, 1);

  await png(path.join(directory, "assets", "candidate-two.png"), { r: 0, g: 255, b: 255, alpha: 1 });
  const checked = await compileSpriteLibrary({ manifestPath: path.join(directory, "library.json"), outputDirectory, lockPath, writeLock: false });
  const secondManifest = await readFile(path.join(outputDirectory, "provenance-library.library.json"), "utf8");
  assert.equal(secondManifest, firstManifest);
  assert.equal(checked.lock.build.manifestSha256, first.lock.build.manifestSha256);
  assert.equal(checked.lock.build.inventorySha256, first.lock.build.inventorySha256);
  assert.equal(checked.inventory.excluded, 2);
});

test("source-root inventories exclude compiler transactions, staging output, generated output, and locks", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sprite-library-inventory-boundary-"));
  await png(path.join(directory, "active.png"), { r: 255, g: 255, b: 255, alpha: 1 });
  await png(path.join(directory, "candidate.png"), { r: 0, g: 255, b: 255, alpha: 1 });
  await mkdir(path.join(directory, "authored.sprite-library-transaction-notes"));
  await mkdir(path.join(directory, ".sprite-library-stage-notes"));
  await mkdir(path.join(directory, ".inventory-boundary-library.sprite-library-transaction.claim-AbC123"));
  await png(path.join(directory, "authored.sprite-library-transaction-notes", "candidate.png"), { r: 255, g: 0, b: 255, alpha: 1 });
  await png(path.join(directory, ".sprite-library-stage-notes", "candidate.png"), { r: 255, g: 255, b: 0, alpha: 1 });
  await png(path.join(directory, ".inventory-boundary-library.sprite-library-transaction.claim-AbC123", "candidate.png"), { r: 0, g: 0, b: 0, alpha: 1 });
  const sourcePath = path.join(directory, "source.json");
  const libraryPath = path.join(directory, "library.json");
  const outputDirectory = path.join(directory, "generated");
  const bundleLockPath = path.join(directory, "source.lock.json");
  const libraryLockPath = path.join(directory, "library.lock.json");
  await writeFile(sourcePath, JSON.stringify({
    schema: "keel-sprite-source@1", id: "inventory-boundary", frame: { width: 2, height: 2 },
    assets: [{ id: 1, key: "active", label: "Active", slot: 0, frameCapacity: 1, frames: ["active.png"] }],
    selections: [{ revision: 1, activeAssetIds: [1] }],
  }));
  await writeFile(libraryPath, JSON.stringify({
    schema: "keel-sprite-library-source@1", id: "inventory-boundary-library",
    bundles: [{ bundleId: 1, revision: 1, key: "material", role: "material", source: "source.json", lock: "source.lock.json", dependencies: [] }],
    profiles: [{ id: "default", revision: 1, roots: [{ bundleId: 1, revision: 1 }] }],
    inventoryRoots: [{ path: ".", label: "all source provenance" }],
  }));

  const first = await compileSpriteLibrary({ manifestPath: libraryPath, outputDirectory, lockPath: libraryLockPath });
  const second = await compileSpriteLibrary({ manifestPath: libraryPath, outputDirectory, lockPath: libraryLockPath });
  assert.deepEqual(second.inventory, first.inventory);
  assert.equal(first.inventory.entries.some((entry) => /^\.sprite-library-stage-[A-Za-z0-9]{6}\//u.test(entry.path)), false);
  assert.equal(first.inventory.entries.some((entry) => entry.path.startsWith(".inventory-boundary-library.sprite-library-transaction/")), false);
  assert.equal(first.inventory.entries.some((entry) => entry.path.startsWith(".inventory-boundary-library.sprite-library-transaction.claim-AbC123/")), false);
  assert.equal(first.inventory.entries.some((entry) => entry.path.startsWith("generated/")), false);
  assert.equal(first.inventory.entries.some((entry) => [path.basename(bundleLockPath), path.basename(libraryLockPath)].includes(entry.path)), false);
  assert.equal(first.inventory.entries.some((entry) => entry.path === "candidate.png" && entry.status === "excluded"), true);
  assert.equal(first.inventory.entries.some((entry) => entry.path === "active.png" && entry.status === "included"), true);
  assert.equal(first.inventory.entries.some((entry) => entry.path === "authored.sprite-library-transaction-notes/candidate.png" && entry.status === "excluded"), true);
  assert.equal(first.inventory.entries.some((entry) => entry.path === ".sprite-library-stage-notes/candidate.png" && entry.status === "excluded"), true);

  const overlong = JSON.parse(await readFile(libraryPath, "utf8"));
  overlong.id = `a${"b".repeat(128)}`;
  await writeFile(libraryPath, JSON.stringify(overlong));
  await assert.rejects(compileSpriteLibrary({ manifestPath: libraryPath, outputDirectory, lockPath: libraryLockPath }), /at most 128 characters/);
});

test("boundary-length library IDs use fixed prepared-write names independent of lock basenames", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sprite-library-boundary-id-"));
  await png(path.join(directory, "active.png"), { r: 255, g: 255, b: 255, alpha: 1 });
  const sourcePath = path.join(directory, "source.json");
  const libraryPath = path.join(directory, "library.json");
  const bundleLock = `bundle-${"b".repeat(112)}.lock.json`;
  const libraryLock = path.join(directory, `library-${"l".repeat(111)}.lock.json`);
  const libraryId = "a".repeat(128);
  await writeFile(sourcePath, JSON.stringify({
    schema: "keel-sprite-source@1", id: "boundary-id-source", frame: { width: 2, height: 2 },
    assets: [{ id: 1, key: "active", label: "Active", slot: 0, frameCapacity: 1, frames: ["active.png"] }],
    selections: [{ revision: 1, activeAssetIds: [1] }],
  }));
  await writeFile(libraryPath, JSON.stringify({
    schema: "keel-sprite-library-source@1", id: libraryId,
    bundles: [{ bundleId: 1, revision: 1, key: "material", role: "material", source: "source.json", lock: bundleLock, dependencies: [] }],
    profiles: [{ id: "default", revision: 1, roots: [{ bundleId: 1, revision: 1 }] }],
    inventoryRoots: [{ path: ".", label: "boundary id provenance" }],
  }));
  const result = await compileSpriteLibrary({
    manifestPath: libraryPath,
    outputDirectory: path.join(directory, "generated"),
    lockPath: libraryLock,
  });
  assert.equal(result.manifest.id, libraryId);
  assert.equal((await readdir(directory, { recursive: true })).filter((entry) => /\.sprite-library-write-[0-9a-f]{64}\.(?:new|old)$/u.test(entry)).length, 0);
});

test("rejected library revisions are transactional and manifest paths cannot escape their workspace", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sprite-library-transaction-"));
  await png(path.join(directory, "one.png"), { r: 255, g: 255, b: 255, alpha: 1 });
  await png(path.join(directory, "two.png"), { r: 255, g: 0, b: 0, alpha: 1 });
  const sourcePath = path.join(directory, "character.json");
  const libraryPath = path.join(directory, "library.json");
  const outputDirectory = path.join(directory, "out");
  const lockPath = path.join(directory, "library.lock.json");
  const source = {
    schema: "keel-sprite-source@1", id: "transaction-character", frame: { width: 2, height: 2 },
    assets: [{ id: 1, key: "one", label: "One", slot: 0, frameCapacity: 1, frames: ["one.png"] }],
    selections: [{ revision: 1, activeAssetIds: [1] }],
  };
  const library = {
    schema: "keel-sprite-library-source@1", id: "transaction-library",
    bundles: [{ bundleId: 1, revision: 1, key: "character", role: "character", source: "character.json", lock: "character.lock.json", dependencies: [] }],
    profiles: [{ id: "default", revision: 1, roots: [{ bundleId: 1, revision: 1 }] }], inventoryRoots: [],
  };
  await writeFile(sourcePath, JSON.stringify(source));
  await writeFile(libraryPath, JSON.stringify(library));
  await compileSpriteLibrary({ manifestPath: libraryPath, outputDirectory, lockPath });
  const protectedFiles = [
    path.join(directory, "character.lock.json"), lockPath,
    path.join(outputDirectory, "transaction-library.library.json"),
    path.join(outputDirectory, "bundles/1-1-transaction-character/transaction-character.atlas.webp"),
    path.join(outputDirectory, "bundles/1-1-transaction-character/transaction-character.codex.bin"),
    path.join(outputDirectory, "bundles/1-1-transaction-character/transaction-character.build.json"),
  ];
  const before = await Promise.all(protectedFiles.map(async (file) => [file, Buffer.from(await readFile(file)).toString("base64")]));
  const rejected = structuredClone(source);
  rejected.assets.push({ id: 2, key: "two", label: "Two", slot: 1, frameCapacity: 1, frames: ["two.png"] });
  rejected.selections = [{ revision: 1, activeAssetIds: [1] }, { revision: 2, activeAssetIds: [1, 2] }];
  await writeFile(sourcePath, JSON.stringify(rejected));
  await assert.rejects(compileSpriteLibrary({ manifestPath: libraryPath, outputDirectory, lockPath }), /bundle revision 1@1 changed/);
  for (const [file, bytes] of before) assert.equal(Buffer.from(await readFile(file)).toString("base64"), bytes, file);
  await writeFile(sourcePath, JSON.stringify(source));
  await compileSpriteLibrary({ manifestPath: libraryPath, outputDirectory, lockPath, writeLock: false });

  const escapedLock = structuredClone(library);
  escapedLock.bundles[0].lock = "../escaped.lock.json";
  await writeFile(libraryPath, JSON.stringify(escapedLock));
  await assert.rejects(compileSpriteLibrary({ manifestPath: libraryPath, outputDirectory, lockPath }), /lock escapes/);
  const escapedInventory = structuredClone(library);
  escapedInventory.inventoryRoots = [{ path: "../", label: "outside" }];
  await writeFile(libraryPath, JSON.stringify(escapedInventory));
  await assert.rejects(compileSpriteLibrary({ manifestPath: libraryPath, outputDirectory, lockPath }), /inventory root .* escapes/);
  const absoluteInventory = structuredClone(library);
  absoluteInventory.inventoryRoots = [{ path: path.dirname(directory), label: "absolute outside" }];
  await writeFile(libraryPath, JSON.stringify(absoluteInventory));
  await assert.rejects(compileSpriteLibrary({ manifestPath: libraryPath, outputDirectory, lockPath }), /must be a relative path/);

  const outside = await mkdtemp(path.join(tmpdir(), "sprite-library-outside-"));
  await symlink(outside, path.join(directory, "locks"), "dir");
  const symlinkEscape = structuredClone(library);
  symlinkEscape.bundles[0].lock = "locks/escaped.lock.json";
  await writeFile(libraryPath, JSON.stringify(symlinkEscape));
  await assert.rejects(compileSpriteLibrary({ manifestPath: libraryPath, outputDirectory, lockPath }), /resolves outside/);
  await assert.rejects(readFile(path.join(outside, "escaped.lock.json")), /ENOENT/);

  const readOnly = path.join(directory, "read-only");
  await mkdir(readOnly);
  await writeFile(path.join(directory, "character-v2.json"), JSON.stringify(source));
  const appendWithUnwritableLock = structuredClone(library);
  appendWithUnwritableLock.bundles.push({ bundleId: 1, revision: 2, key: "character", role: "character", source: "character-v2.json", lock: "read-only/character-v2.lock.json", dependencies: [] });
  appendWithUnwritableLock.profiles.push({ id: "default", revision: 2, roots: [{ bundleId: 1, revision: 2 }] });
  await writeFile(libraryPath, JSON.stringify(appendWithUnwritableLock));
  const beforeFailedCommit = await Promise.all(protectedFiles.map(async (file) => [file, Buffer.from(await readFile(file)).toString("base64")]));
  await chmod(readOnly, 0o500);
  try {
    await assert.rejects(compileSpriteLibrary({ manifestPath: libraryPath, outputDirectory, lockPath }), /EACCES|permission denied/i);
  } finally {
    await chmod(readOnly, 0o700);
  }
  for (const [file, bytes] of beforeFailedCommit) assert.equal(Buffer.from(await readFile(file)).toString("base64"), bytes, file);
  assert.equal((await readdir(directory, { recursive: true })).filter((entry) => /\.sprite-library-stage-|\.new$|\.old$/u.test(entry)).length, 0);

  const recoveryTransaction = path.join(directory, ".transaction-library.sprite-library-transaction");
  const recoveryStage = await mkdtemp(path.join(path.dirname(outputDirectory), ".sprite-library-stage-"));
  const recoveryWrites = [];
  const canonicalDirectory = await realpath(directory);
  const recoveryTransactionId = "fixture-transaction-1";
  for (const final of [path.join(canonicalDirectory, "character.lock.json"), path.join(canonicalDirectory, "library.lock.json")]) {
    const { temporary, backup } = await preparedWriteFixturePaths(final, recoveryTransactionId);
    await copyFile(final, backup);
    await writeFile(temporary, "uncommitted");
    await writeFile(final, "uncommitted");
    recoveryWrites.push({
      final,
      temporary,
      backup,
      hadPrevious: true,
      transactionId: recoveryTransactionId,
      previousSha256: await sha256(new Uint8Array(await readFile(backup))),
      nextSha256: await sha256(new Uint8Array(await readFile(temporary))),
    });
  }
  await cp(outputDirectory, path.join(recoveryStage, "previous-output"), { recursive: true });
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(recoveryTransaction);
  await writeFile(path.join(recoveryTransaction, "OWNER.json"), JSON.stringify({
    schema: "keel-sprite-library-owner@2",
    libraryId: "transaction-library",
    outputDirectory,
    transactionId: recoveryTransactionId,
    pid: 999999999,
    createdAt: new Date(0).toISOString(),
  }));
  await writeFile(path.join(recoveryTransaction, "RECOVERY_REQUIRED.json"), JSON.stringify({
    schema: "keel-sprite-library-recovery@2",
    libraryId: "transaction-library",
    transactionId: recoveryTransactionId,
    outputDirectory,
    stagedRecoveryDirectory: recoveryStage,
    preparedWrites: recoveryWrites,
  }));
  await writeFile(libraryPath, JSON.stringify(library));
  await compileSpriteLibrary({ manifestPath: libraryPath, outputDirectory, lockPath, writeLock: false });
  for (const [file, bytes] of beforeFailedCommit) assert.equal(Buffer.from(await readFile(file)).toString("base64"), bytes, file);
  await assert.rejects(readFile(path.join(recoveryTransaction, "RECOVERY_REQUIRED.json")), /ENOENT/);

  // A process can stop after installing the prepared top lock but before
  // moving the still-canonical old output into previous-output. Recovery must
  // prove that installed graph against the backed-up prior lock and restore
  // the lock; it must not wedge waiting for a move that never happened.
  const earlyCrashTransactionId = "fixture-early-crash-1";
  const earlyCrashStage = await mkdtemp(path.join(path.dirname(outputDirectory), ".sprite-library-stage-"));
  const earlyCrashFinal = path.join(canonicalDirectory, "library.lock.json");
  const { temporary: earlyCrashTemporary, backup: earlyCrashBackup } = await preparedWriteFixturePaths(earlyCrashFinal, earlyCrashTransactionId);
  const earlyCrashNext = new TextEncoder().encode("prepared next lock\n");
  await copyFile(earlyCrashFinal, earlyCrashBackup);
  await writeFile(earlyCrashTemporary, earlyCrashNext);
  await writeFile(earlyCrashFinal, earlyCrashNext);
  await mkdir(recoveryTransaction);
  await writeFile(path.join(recoveryTransaction, "OWNER.json"), JSON.stringify({
    schema: "keel-sprite-library-owner@2",
    libraryId: "transaction-library",
    outputDirectory,
    transactionId: earlyCrashTransactionId,
    pid: 999999999,
    createdAt: new Date(0).toISOString(),
  }));
  await writeFile(path.join(recoveryTransaction, "RECOVERY_REQUIRED.json"), JSON.stringify({
    schema: "keel-sprite-library-recovery@2",
    libraryId: "transaction-library",
    transactionId: earlyCrashTransactionId,
    outputDirectory,
    stagedRecoveryDirectory: earlyCrashStage,
    preparedWrites: [{
      final: earlyCrashFinal,
      temporary: earlyCrashTemporary,
      backup: earlyCrashBackup,
      hadPrevious: true,
      transactionId: earlyCrashTransactionId,
      previousSha256: await sha256(new Uint8Array(await readFile(earlyCrashBackup))),
      nextSha256: await sha256(earlyCrashNext),
    }],
  }));
  await compileSpriteLibrary({ manifestPath: libraryPath, outputDirectory, lockPath, writeLock: false });
  for (const [file, bytes] of beforeFailedCommit) assert.equal(Buffer.from(await readFile(file)).toString("base64"), bytes, file);
  await assert.rejects(readFile(path.join(recoveryTransaction, "RECOVERY_REQUIRED.json")), /ENOENT/);

  const concurrentA = structuredClone(library);
  const concurrentB = structuredClone(library);
  await writeFile(path.join(directory, "character-v2-a.json"), JSON.stringify(source));
  await writeFile(path.join(directory, "character-v2-b.json"), JSON.stringify({ ...source, assets: [{ ...source.assets[0], frames: ["two.png"] }] }));
  concurrentA.bundles.push({ bundleId: 1, revision: 2, key: "character", role: "character", source: "character-v2-a.json", lock: "character-v2-a.lock.json", dependencies: [] });
  concurrentB.bundles.push({ bundleId: 1, revision: 2, key: "character", role: "character", source: "character-v2-b.json", lock: "character-v2-b.lock.json", dependencies: [] });
  concurrentA.profiles.push({ id: "default", revision: 2, roots: [{ bundleId: 1, revision: 2 }] });
  concurrentB.profiles.push({ id: "default", revision: 2, roots: [{ bundleId: 1, revision: 2 }] });
  const concurrentAPath = path.join(directory, "library-a.json");
  const concurrentBPath = path.join(directory, "library-b.json");
  await writeFile(concurrentAPath, JSON.stringify(concurrentA));
  await writeFile(concurrentBPath, JSON.stringify(concurrentB));
  const concurrent = await Promise.allSettled([
    compileSpriteLibrary({ manifestPath: concurrentAPath, outputDirectory, lockPath }),
    compileSpriteLibrary({ manifestPath: concurrentBPath, outputDirectory, lockPath }),
  ]);
  assert.equal(concurrent.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(concurrent.filter((entry) => entry.status === "rejected" && /already in progress/.test(String(entry.reason))).length, 1);
  const committedGraphBytes = new Uint8Array(await readFile(path.join(outputDirectory, "transaction-library.library.json")));
  const committedGraph = JSON.parse(new TextDecoder().decode(committedGraphBytes));
  const committedLock = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(await sha256(committedGraphBytes), committedLock.build.manifestSha256);
  for (const entry of committedGraph.bundles) {
    assert.equal(await sha256(new Uint8Array(await readFile(path.join(outputDirectory, entry.buildManifest)))), entry.buildManifestSha256);
  }
});

test("sprite-emitter v1 is bounded, counter-deterministic, map-variable, and independent of appended presets", async () => {
  const recipe = {
    schema: "keel-sprite-emitter@1", presetId: 7, revision: 1, fxCatalogRevision: 1, mapGenerationEpoch: 3, seedDomainVersion: 1, eventKind: 12,
    sprite: { mode: "animated", bundleId: 9, bundleRevision: 2, assetId: 4, selectionRevision: 1, frameIndices: [0, 1], frameSha256: ["11".repeat(32), "22".repeat(32)] },
    animation: { frameTicks: [3, 5], playback: "loop", phaseJitterTicks: 7 },
    spawn: { mode: "rate", maxLive: 32, maxTotal: 64, startTick: 0, endTick: 120, countMin: 18, countMax: 30, timingJitterTicks: 3, rateNumerator: 1, rateDenominator: 4, initialPosition: { shape: "ellipse", offsetXMinQ16: -8 * 65536, offsetXMaxQ16: 8 * 65536, offsetYMinQ16: -4 * 65536, offsetYMaxQ16: 4 * 65536 } },
    motion: { speedMinQ16: 32768, speedMaxQ16: 98304, coneCenterTurns: 0, coneWidthTurns: 16384, accelerationXQ16: 0, accelerationYQ16: 0, dragQ16: 64225, gravityQ16: 128, turbulenceQ16: 256, lifetimeMinTicks: 30, lifetimeMaxTicks: 60 },
    transform: { startScaleMinQ16: 49152, startScaleMaxQ16: 98304, endScaleMinQ16: 8192, endScaleMaxQ16: 32768, rotationMinTurns: 0, rotationMaxTurns: 65535, angularVelocityMinTurns: -128, angularVelocityMaxTurns: 256, pivotXQ16: 16 * 65536, pivotYQ16: 16 * 65536 },
    appearance: { materialTarget: "core-light", paletteMode: "map", palette: ["#40f4ff", "#ff58e8"], alphaCurve: [{ tick: 0, value: 255 }, { tick: 60, value: 0 }], colorCurve: [{ tick: 0, value: 0, rgba: [64, 244, 255, 255] }, { tick: 60, value: 65536, rgba: [255, 88, 232, 0] }], blendMode: "lighter" },
    extras: { trailSamples: 4, trailWidthQ16: 65536, lightRadiusQ16: 8 * 65536, lightIntensity: 128 },
  };
  validateEmitterRecipe(recipe);
  const context = { mapSeed: `0x${"01".repeat(32)}`, mapId: `0x${"02".repeat(32)}`, worldEntityIndex: 44, eventOrdinal: 9 };
  const seedA = await deriveEmitterEventSeed(recipe, context);
  const seedB = await deriveEmitterEventSeed(recipe, context);
  assert.deepEqual(seedA, seedB);
  assert.equal(Buffer.from(seedA).toString("hex"), "b7a931a7a401d843cb4a2230b3744e5af9b7c15fe543e4fe23d297b01e3ae27d");
  assert.deepEqual(Array.from({ length: 4 }, (_, counter) => splitMix64(0xb7a931a7a401d843n, counter).toString(16)), ["99906df5c5ef3241", "e104bd1ba1f7a3fc", "64c9a5fe9ff087be", "b14a411a1fd2a8bf"]);
  const portableVector = JSON.parse(await readFile(new URL("../vault/emitter-v1.portable-vector.json", import.meta.url), "utf8"));
  assert.equal(portableVector.eventSeed, Buffer.from(seedA).toString("hex"));
  assert.deepEqual(portableVector.splitMix64Words, Array.from({ length: 128 }, (_, counter) => splitMix64(0xb7a931a7a401d843n, counter).toString(16).padStart(16, "0")));
  const traceA = emitterTrace(recipe, seedA, 90), traceB = emitterTrace(recipe, seedB, 90);
  assert.deepEqual(traceA, traceB);
  assert.equal(await emitterReplayHash(recipe, seedA, 90), await emitterReplayHash(recipe, seedB, 90));
  assert.ok(traceA.length <= recipe.spawn.maxLive);
  const otherSeed = await deriveEmitterEventSeed(recipe, { ...context, mapSeed: `0x${"03".repeat(32)}` });
  const otherTrace = emitterTrace(recipe, otherSeed, 90);
  assert.notDeepEqual(otherTrace, traceA);
  for (const field of ["bornTick", "scaleQ16", "rotationTurns", "angularVelocityTurns", "paletteIndex", "animationPhaseTicks", "frameIndex"]) {
    assert.notDeepEqual(traceA.map((entry) => entry[field]), otherTrace.map((entry) => entry[field]), `${field} must vary by map seed`);
  }
  assert.notDeepEqual(traceA.map((entry) => [entry.xQ16, entry.yQ16]), otherTrace.map((entry) => [entry.xQ16, entry.yQ16]), "spawn positions must vary by map seed");
  assert.notEqual(emitterTrace(recipe, seedA, 60).length, emitterTrace(recipe, otherSeed, 60).length, "enabled count range must vary by map seed fixture");
  assert.deepEqual([...tintGrayscalePixels(Uint8ClampedArray.from([128, 128, 128, 255]), [64, 244, 255, 128])], [32, 122, 128, 128]);
  const oldHash = await emitterReplayHash(recipe, seedA, 90);
  const catalog = [{ ...recipe }, { ...recipe, presetId: 8, revision: 1 }];
  assert.equal(await emitterReplayHash(catalog[0], seedA, 90), oldHash);
  assert.throws(() => validateEmitterRecipe({ ...recipe, spawn: { ...recipe.spawn, maxLive: 513 } }), /maxLive/);
  assert.throws(() => validateEmitterRecipe({ ...recipe, sprite: { ...recipe.sprite, frameSha256: ["11".repeat(32), "11".repeat(32)] } }), /non-identical/);
});

function proceduralMaterialStem(stemId, { mode = "autonomous", targets = ["s.face"], controllerId } = {}) {
  return {
    schema: "keel-material-stem@1",
    stemId,
    revision: 1,
    catalogRevision: 1,
    seedDomainVersion: 1,
    source: { kind: "procedural", procedural: { kernelId: "paper.grain", kernelRevision: 1, parametersDigest: "55".repeat(32) } },
    alphaMode: "opaque-data",
    alphaPolicy: { requireTransparentPixels: false, requirePartialPixels: false },
    channels: [
      { component: "r", semantic: "pigment-density", encoding: "unorm8", transfer: "linear" },
      { component: "g", semantic: "roughness", encoding: "unorm8", transfer: "linear" },
      { component: "b", semantic: "height", encoding: "unorm8", transfer: "linear" },
      { component: "a", semantic: "opaque", encoding: "unorm8", transfer: "linear" },
    ],
    clock: {
      id: `${stemId}.clock`, mode, ...(mode === "external" ? { controllerId: controllerId ?? "host.material" } : {}),
      ticksPerSecond: 60, durationTicks: 240, playback: "loop", phaseOrigin: "first-visible-tick",
      phaseJitterTicks: 0, startTick: 0, firstVisibleTick: 0, frameTicks: [],
    },
    contributions: [{ id: "deposit", domain: "physical-surface", targetMode: "listed", targets, excludes: [], polarity: "primary", blendMode: "multiply", opacityQ16: 65536 }],
  };
}

function singleRegionComposition(stems, region = "s.face") {
  return {
    schema: "keel-material-composition@1",
    revision: 1,
    semanticTargets: ["background", region],
    maximumAutonomousStems: 2,
    diagnosticPolicy: "preserve-selected-contributions",
    stems,
    materialRegions: [region],
    assignments: [{ id: "base.deposit", regions: [region], contribution: { stemId: stems[0].stemId, contributionId: "deposit" } }],
    adjacencies: [],
    transitions: [],
  };
}

test("material-stem v1 closes commitments, pins RGBA/poster frames, and starts first-visible phase at zero", async () => {
  const recipe = {
    schema: "keel-material-stem@1",
    stemId: "film.holographic-glint",
    revision: 1,
    catalogRevision: 3,
    seedDomainVersion: 1,
    source: {
      kind: "hybrid",
      sprite: {
        bundleId: 14, bundleRevision: 2, assetId: 7, selectionRevision: 1,
        frameIndices: [0, 1, 2], frameSha256: ["ab".repeat(32), "22".repeat(32), "33".repeat(32)],
      },
      procedural: { kernelId: "thin-film.interference", kernelRevision: 2, parametersDigest: "44".repeat(32) },
    },
    alphaMode: "premultiplied-alpha",
    alphaPolicy: { requireTransparentPixels: true, requirePartialPixels: true },
    channels: [
      { component: "r", semantic: "premultiplied-red", encoding: "unorm8", transfer: "linear" },
      { component: "g", semantic: "premultiplied-green", encoding: "unorm8", transfer: "linear" },
      { component: "b", semantic: "premultiplied-blue", encoding: "unorm8", transfer: "linear" },
      { component: "a", semantic: "alpha", encoding: "unorm8", transfer: "linear" },
    ],
    clock: {
      id: "global", mode: "autonomous", ticksPerSecond: 60, durationTicks: 12, playback: "ping-pong",
      phaseOrigin: "first-visible-tick", phaseJitterTicks: 0, startTick: 240, firstVisibleTick: 241,
      frameTicks: [3, 4, 5], posterFrameIndex: 2,
    },
    contributions: [
      { id: "clear-film", domain: "physical-film", targetMode: "listed", targets: ["s.face", "s.bevel"], excludes: [], polarity: "primary", blendMode: "screen", opacityQ16: 49152 },
      { id: "quiet-surround", domain: "optical-post", targetMode: "inverse-listed", targets: ["s.face", "s.bevel"], excludes: ["ui.diagnostics"], polarity: "counter", counterOf: "clear-film", blendMode: "multiply", opacityQ16: 8192 },
    ],
  };
  const semanticTargets = ["background", "s.face", "s.bevel", "s.side", "foreground", "ui.diagnostics"];
  const composition = {
    schema: "keel-material-composition@1", revision: 1, semanticTargets, maximumAutonomousStems: 2,
    diagnosticPolicy: "preserve-selected-contributions", stems: [recipe], materialRegions: ["s.face", "s.bevel"],
    assignments: [{ id: "film.face-and-bevel", regions: ["s.face", "s.bevel"], contribution: { stemId: recipe.stemId, contributionId: "clear-film" } }],
    adjacencies: [], transitions: [],
  };
  validateMaterialStemRecipe(recipe);
  validateMaterialComposition(composition);

  const context = { tokenSeed: `0x${"ab".repeat(32)}`, collectionId: `0x${"cd".repeat(32)}`, tokenId: "18446744073709551617" };
  const seedA = await deriveMaterialStemSeed(recipe, context);
  const seedB = await deriveMaterialStemSeed(recipe, context);
  assert.deepEqual(seedA, seedB);
  assert.equal(Buffer.from(seedA).toString("hex"), "529aa8d4d9e5dc8068a4f66d941165391f799413d811521435c51e09f28aeb50");
  assert.notDeepEqual(await deriveMaterialStemSeed(recipe, { ...context, tokenId: "18446744073709551618" }), seedA);

  const poster = sampleMaterialStem(recipe, seedA, semanticTargets, { mode: "poster" });
  assert.equal(poster.frameIndex, 2, "poster mode uses the pinned poster frame without making a visual-completeness claim");
  assert.equal(poster.visible, true);
  assert.equal(poster.localTick, 0);
  assert.equal(poster.proceduralSeed, Buffer.from(seedA).toString("hex"));
  assert.deepEqual(poster.routes[0].resolvedTargets, ["s.face", "s.bevel"]);
  assert.deepEqual(poster.routes[1].resolvedTargets, ["background", "s.side", "foreground"]);
  assert.equal(sampleMaterialStem(recipe, seedA, semanticTargets, { mode: "live", globalTick: 240 }).visible, false);
  const firstVisible = sampleMaterialStem(recipe, seedA, semanticTargets, { mode: "live", globalTick: 241 });
  assert.equal(firstVisible.visible, true);
  assert.equal(firstVisible.localTick, 0);
  assert.equal(firstVisible.frameIndex, 0);
  assert.deepEqual(
    sampleMaterialStem(recipe, seedA, semanticTargets, { mode: "live", globalTick: 247 }),
    sampleMaterialStem(recipe, seedB, semanticTargets, { mode: "live", globalTick: 247 }),
  );
  assert.equal(await materialStemDigest(recipe), await materialStemDigest(structuredClone(recipe)));
  assert.equal(await materialCompositionDigest(composition), await materialCompositionDigest(structuredClone(composition)));
  assert.equal(await materialStemDigest(recipe), "785e4b134945cb0ced6f1616c7497aa496a8a1f3697d0ad92cf808d2b438a36f");
  assert.equal(await materialCompositionDigest(composition), "f6872df7986b08a46859878a2dfeffcb1ffbd66ab6057929081aeeda78ceea6a");

  assert.deepEqual(inspectMaterialPixels(recipe, Uint8ClampedArray.from([
    0, 0, 0, 0, 32, 16, 8, 64, 255, 255, 255, 255,
  ])), { pixelCount: 3, transparentPixelCount: 1, partialPixelCount: 1, opaquePixelCount: 1, premultiplicationViolationCount: 0 });
  assert.throws(() => inspectMaterialPixels(recipe, Uint8ClampedArray.from([255, 255, 255, 255])), /no real transparent pixels/);
  assert.throws(() => inspectMaterialPixels(recipe, Uint8ClampedArray.from([4, 0, 0, 0, 8, 8, 8, 16])), /premultiplied-alpha violations/);
  for (const invalid of [new Uint16Array([0, 0, 0, 0]), new Float32Array([0, 0, 0, 0]), [0, 0, 0, 0], [0, 0, 0, Number.NaN], [0, 0, 0, 256]]) {
    assert.throws(() => inspectMaterialPixels(recipe, invalid), /Uint8Array or Uint8ClampedArray/);
  }
  const spoofedPixels = new Uint16Array([0, 0, 0, 0, 0, 0, 0, 256]);
  Object.defineProperty(spoofedPixels, Symbol.toStringTag, { value: "Uint8Array" });
  assert.throws(() => inspectMaterialPixels(recipe, spoofedPixels), /byte-backed Uint8Array or Uint8ClampedArray/);
  const spoofedSeed = new Uint16Array(32);
  spoofedSeed[0] = 0x200;
  Object.defineProperty(spoofedSeed, Symbol.toStringTag, { value: "Uint8Array" });
  assert.throws(() => sampleMaterialStem(recipe, spoofedSeed, semanticTargets, { mode: "poster" }), /seed must be 32 bytes/);

  const uppercase = structuredClone(recipe);
  uppercase.source.sprite.frameSha256[0] = uppercase.source.sprite.frameSha256[0].toUpperCase();
  assert.throws(() => validateMaterialStemRecipe(uppercase), /lowercase SHA-256/);
  assert.throws(() => validateMaterialStemRecipe({ ...recipe, extension: true }), /unknown property extension/);
  assert.throws(() => validateMaterialStemRecipe({ ...recipe, extension: undefined }), /non-JSON value/);
  assert.throws(() => validateMaterialStemRecipe({ ...recipe, source: { kind: "procedural", procedural: recipe.source.procedural, sprite: recipe.source.sprite } }), /unknown property sprite/);

  assert.throws(() => validateMaterialStemRecipe(Object.create(recipe)), /plain JSON objects/);
  const accessorRecipe = structuredClone(recipe);
  Object.defineProperty(accessorRecipe, "revision", { enumerable: true, get: () => 1 });
  assert.throws(() => validateMaterialStemRecipe(accessorRecipe), /accessor property/);

  const proxyRecipe = new Proxy(structuredClone(recipe), {
    get(target, property, receiver) {
      if (property === "revision") return 2;
      return Reflect.get(target, property, receiver);
    },
  });
  assert.throws(() => validateMaterialStemRecipe(proxyRecipe), /concrete structured-cloneable JSON data/);
  await assert.rejects(materialStemDigest(proxyRecipe), /concrete structured-cloneable JSON data/);
  assert.throws(() => inspectMaterialPixels(proxyRecipe, Uint8Array.from([0, 0, 0, 0])), /concrete structured-cloneable JSON data/);
  assert.throws(() => sampleMaterialStem(proxyRecipe, new Uint8Array(32), semanticTargets, { mode: "poster" }), /concrete structured-cloneable JSON data/);

  const beforeRecipe = structuredClone(recipe);
  const beforeContext = structuredClone(context);
  const expectedBeforeSeed = await deriveMaterialStemSeed(structuredClone(beforeRecipe), structuredClone(beforeContext));
  const pendingSeed = deriveMaterialStemSeed(beforeRecipe, beforeContext);
  beforeRecipe.stemId = "film.changed-after-call";
  beforeRecipe.revision = 9;
  beforeRecipe.catalogRevision = 10;
  beforeContext.tokenSeed = `0x${"01".repeat(32)}`;
  beforeContext.collectionId = `0x${"02".repeat(32)}`;
  beforeContext.tokenId = "99";
  assert.deepEqual(await pendingSeed, expectedBeforeSeed, "seed derivation snapshots one jointly validated preimage before its first await");

  const accessorContext = structuredClone(context);
  Object.defineProperty(accessorContext, "tokenId", { enumerable: true, get: () => context.tokenId });
  await assert.rejects(deriveMaterialStemSeed(recipe, accessorContext), /own enumerable data property/);
  const proxyContext = new Proxy(structuredClone(context), {
    get(target, property, receiver) {
      if (property === "tokenId") return "2";
      return Reflect.get(target, property, receiver);
    },
  });
  await assert.rejects(deriveMaterialStemSeed(recipe, proxyContext), /concrete structured-cloneable data/);
});

test("material ping-pong preserves unequal frame durations and explicit clock modes control advancement", () => {
  const sprite = {
    schema: "keel-material-stem@1", stemId: "timeline.unequal", revision: 1, catalogRevision: 1, seedDomainVersion: 1,
    source: { kind: "sprite", sprite: { bundleId: 1, bundleRevision: 1, assetId: 1, selectionRevision: 1, frameIndices: [0, 1, 2], frameSha256: ["11".repeat(32), "22".repeat(32), "33".repeat(32)] } },
    alphaMode: "opaque-color", alphaPolicy: { requireTransparentPixels: false, requirePartialPixels: false },
    channels: [
      { component: "r", semantic: "red", encoding: "unorm8", transfer: "srgb" },
      { component: "g", semantic: "green", encoding: "unorm8", transfer: "srgb" },
      { component: "b", semantic: "blue", encoding: "unorm8", transfer: "srgb" },
      { component: "a", semantic: "opaque", encoding: "unorm8", transfer: "linear" },
    ],
    clock: { id: "global", mode: "autonomous", ticksPerSecond: 60, durationTicks: 12, playback: "ping-pong", phaseOrigin: "first-visible-tick", phaseJitterTicks: 0, startTick: 0, firstVisibleTick: 0, frameTicks: [3, 4, 5], posterFrameIndex: 2 },
    contributions: [{ id: "color", domain: "physical-surface", targetMode: "listed", targets: ["s.face"], excludes: [], polarity: "primary", blendMode: "source-over", opacityQ16: 65536 }],
  };
  const seed = new Uint8Array(32);
  assert.deepEqual(
    Array.from({ length: 16 }, (_, globalTick) => sampleMaterialStem(sprite, seed, ["s.face"], { mode: "live", globalTick }).frameIndex),
    [0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 1, 1, 1, 1],
  );
  const oneFrame = structuredClone(sprite);
  oneFrame.stemId = "timeline.one-frame";
  oneFrame.source.sprite.frameIndices = [0];
  oneFrame.source.sprite.frameSha256 = ["11".repeat(32)];
  oneFrame.clock.durationTicks = 3;
  oneFrame.clock.frameTicks = [3];
  oneFrame.clock.posterFrameIndex = 0;
  assert.deepEqual(Array.from({ length: 6 }, (_, globalTick) => sampleMaterialStem(oneFrame, seed, ["s.face"], { mode: "live", globalTick }).frameIndex), [0, 0, 0, 0, 0, 0]);
  const twoFrames = structuredClone(sprite);
  twoFrames.stemId = "timeline.two-frames";
  twoFrames.source.sprite.frameIndices = [0, 1];
  twoFrames.source.sprite.frameSha256 = ["11".repeat(32), "22".repeat(32)];
  twoFrames.clock.durationTicks = 5;
  twoFrames.clock.frameTicks = [2, 3];
  twoFrames.clock.posterFrameIndex = 1;
  assert.deepEqual(Array.from({ length: 10 }, (_, globalTick) => sampleMaterialStem(twoFrames, seed, ["s.face"], { mode: "live", globalTick }).frameIndex), [0, 0, 1, 1, 1, 0, 0, 1, 1, 1]);
  const external = proceduralMaterialStem("external.grain", { mode: "external", controllerId: "pointer.effect" });
  assert.throws(() => sampleMaterialStem(external, seed, ["s.face"], { mode: "live", globalTick: 99 }), /requires an explicit tick/);
  assert.equal(sampleMaterialStem(external, seed, ["s.face"], { mode: "live", globalTick: 99, externalTicks: { "pointer.effect": 7 } }).tick, 7);
  const still = proceduralMaterialStem("static.grain", { mode: "static" });
  assert.equal(sampleMaterialStem(still, seed, ["s.face"], { mode: "live", globalTick: 999 }).localTick, 0);
  const jitteredHandoff = proceduralMaterialStem("bad.first-visible-jitter");
  jitteredHandoff.clock.phaseJitterTicks = 2;
  assert.throws(() => validateMaterialStemRecipe(jitteredHandoff), /first-visible material clocks must begin at phase zero/);
});

test("regional assignments require exact adjacency coverage and pinned transition implementations", async () => {
  const left = proceduralMaterialStem("media.graphite", { targets: ["s.vertical"] });
  const right = proceduralMaterialStem("media.watercolor", { targets: ["s.connector"] });
  const composition = {
    schema: "keel-material-composition@1", revision: 1,
    semanticTargets: ["paper", "s.vertical", "s.connector"], maximumAutonomousStems: 2,
    diagnosticPolicy: "preserve-selected-contributions", stems: [left, right],
    materialRegions: ["s.vertical", "s.connector"],
    assignments: [
      { id: "vertical.graphite", regions: ["s.vertical"], contribution: { stemId: left.stemId, contributionId: "deposit" } },
      { id: "connector.watercolor", regions: ["s.connector"], contribution: { stemId: right.stemId, contributionId: "deposit" } },
    ],
    adjacencies: [{ id: "vertical-to-connector", leftAssignmentId: "vertical.graphite", leftRegion: "s.vertical", rightAssignmentId: "connector.watercolor", rightRegion: "s.connector" }],
    transitions: [{
      id: "graphite-watercolor-bleed", adjacencyId: "vertical-to-connector",
      left: { assignmentId: "vertical.graphite", stemId: left.stemId, contributionId: "deposit" },
      right: { assignmentId: "connector.watercolor", stemId: right.stemId, contributionId: "deposit" },
      methodId: "absorption-bleed", methodRevision: 1, parametersDigest: "ab".repeat(32), implementationDigest: "77".repeat(32),
    }],
  };
  validateMaterialComposition(composition);
  assert.equal(await materialCompositionDigest(composition), await materialCompositionDigest(structuredClone(composition)));
  const proxyComposition = new Proxy(structuredClone(composition), {
    get(target, property, receiver) {
      if (property === "revision") return 2;
      return Reflect.get(target, property, receiver);
    },
  });
  assert.throws(() => validateMaterialComposition(proxyComposition), /concrete structured-cloneable JSON data/);
  await assert.rejects(materialCompositionDigest(proxyComposition), /concrete structured-cloneable JSON data/);
  assert.throws(() => validateMaterialComposition({ ...composition, transitions: [] }), /exactly one transition/);
  assert.throws(() => validateMaterialComposition({ ...composition, transitions: [...composition.transitions, { ...composition.transitions[0], id: "orphan", adjacencyId: "missing" }] }), /exactly one transition|missing adjacency/);
  const uppercase = structuredClone(composition);
  uppercase.transitions[0].parametersDigest = uppercase.transitions[0].parametersDigest.toUpperCase();
  assert.throws(() => validateMaterialComposition(uppercase), /lowercase SHA-256/);
  const duplicateRegion = structuredClone(composition);
  duplicateRegion.assignments[1].regions = ["s.vertical"];
  assert.throws(() => validateMaterialComposition(duplicateRegion), /assigned more than once|does not route|no assignment/);
  const spillover = structuredClone(composition);
  spillover.stems[0].contributions[0].targets = ["s.vertical", "s.connector"];
  assert.throws(() => validateMaterialComposition(spillover), /material-region route differs from its assignments/);
  const unassignedPhysical = structuredClone(composition);
  unassignedPhysical.stems[0].contributions.push({
    id: "undeclared-wash", domain: "physical-film", targetMode: "listed", targets: ["s.vertical"], excludes: [],
    polarity: "primary", blendMode: "soft-light", opacityQ16: 2048,
  });
  assert.throws(() => validateMaterialComposition(unassignedPhysical), /material-region route differs from its assignments/);
  assert.throws(() => validateMaterialComposition({ ...composition, extension: true }), /unknown property extension/);
});

test("material compositions reject route overlap, false alpha, hidden diagnostics, and excess autonomous motion", () => {
  const one = proceduralMaterialStem("grain.one");
  const two = proceduralMaterialStem("grain.two", { targets: ["background"] });
  validateMaterialStemRecipe(one);
  const base = singleRegionComposition([one, two]);
  validateMaterialComposition(base);
  assert.throws(() => validateMaterialComposition({ ...base, stems: [...base.stems, proceduralMaterialStem("grain.three")] }), /3 autonomous stems/);
  validateMaterialComposition({ ...base, stems: [...base.stems, proceduralMaterialStem("grain.external", { mode: "external", targets: ["background"] })] });
  assert.throws(() => validateMaterialComposition({ ...base, diagnosticPolicy: "disable-effects" }), /may not disable/);
  assert.throws(() => validateMaterialStemRecipe({ ...proceduralMaterialStem("bad.alpha"), channels: proceduralMaterialStem("copy").channels.map((channel) => channel.component === "a" ? { ...channel, semantic: "alpha" } : channel) }), /opaque alpha channel/);
  const badRoute = { ...proceduralMaterialStem("bad.route"), contributions: [{ ...proceduralMaterialStem("copy").contributions[0], targets: ["missing"] }] };
  assert.throws(() => validateMaterialComposition(singleRegionComposition([badRoute])), /unavailable semantic target/);
  assert.throws(() => validateMaterialStemRecipe({ ...proceduralMaterialStem("bad.counter"), contributions: [{ ...proceduralMaterialStem("copy").contributions[0], polarity: "counter" }] }), /must name their primary/);
  assert.throws(() => validateMaterialStemRecipe({ ...proceduralMaterialStem("bad.sprite"), clock: { ...proceduralMaterialStem("copy").clock, posterFrameIndex: 0 } }), /procedural-only stems/);
  assert.throws(() => inspectMaterialPixels(proceduralMaterialStem("bad.opacity"), Uint8Array.from([0, 0, 0, 254])), /non-opaque pixels/);

  const overlap = proceduralMaterialStem("bad.overlap", { targets: ["s.face", "s.bevel"] });
  overlap.contributions.push({ id: "counter", domain: "optical-post", targetMode: "listed", targets: ["s.bevel", "background"], excludes: [], polarity: "counter", counterOf: "deposit", blendMode: "multiply", opacityQ16: 1024 });
  const overlapComposition = {
    ...singleRegionComposition([overlap]), semanticTargets: ["background", "s.face", "s.bevel"],
    materialRegions: ["s.face", "s.bevel"], assignments: [{ id: "base.deposit", regions: ["s.face", "s.bevel"], contribution: { stemId: overlap.stemId, contributionId: "deposit" } }],
  };
  assert.throws(() => validateMaterialComposition(overlapComposition), /overlaps deposit on s.bevel/);
});
