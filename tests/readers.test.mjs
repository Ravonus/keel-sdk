import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  OCA_SOUND_BITS_CODEC,
  OCA_SPRITE_SOUND_SCHEMA,
  OCA_ATLAS_MATERIAL_BITS_CODEC,
  OCA_MATERIAL_BITS_CODEC,
  OCA_TRAIT_BITS_CODEC,
  OCA_APPEND_ONLY_TRAIT_BITS_CODEC,
  OCA_CHARACTER_METADATA_BITS_CODEC,
  OCA_SPRITE_ATTRIBUTE_SCHEMA,
  applySpriteTargets,
  assertTraitCatalogAppendOnly,
  applyAtlasMaterialMap,
  createAudioReader,
  createDirectionalAnimationAtlas,
  createGridSpriteAtlas,
  decodeAtlasMaterialMapBits,
  decodeSoundBits,
  decodeMaterialBits,
  decodeSpriteBitAtlas,
  decodeTraitCatalogBits,
  decodeCharacterMetadataBits,
  encodeSoundBits,
  encodeAtlasMaterialMapBits,
  encodeMaterialBits,
  encodeSpriteBitAtlas,
  encodeTraitCatalogBits,
  encodeCharacterMetadataBits,
  mat4Identity,
  mat4Multiply,
  mat4Perspective,
  mat4RotationY,
  mat4Translation,
  inspectDirectionalAnimationAtlasPixels,
  packSpriteFrames,
  parseAtlasMaterialMap,
  parseAudioReaderSpec,
  parseMaterialProfile,
  parseSonantLegacySong,
  parseSpriteSoundCatalog,
  parseSpriteAtlasJson,
  resolveMaterialProfile,
  resolveSpriteSound,
  resolveTraitCatalog,
  traitCombinationCount,
  compileSpriteEffects,
} from "../packages/viewer/dist/index.js";

class FakeAudioBuffer {
  constructor(channels, length, sampleRate) {
    this.length = length;
    this.duration = length / sampleRate;
    this.numberOfChannels = channels;
    this.sampleRate = sampleRate;
    this.channels = Array.from(
      { length: channels },
      () => new Float32Array(length),
    );
  }

  getChannelData(channel) {
    const data = this.channels[channel];
    if (data === undefined) throw new RangeError("unknown channel");
    return data;
  }
}

class FakeAudioContext {
  state = "running";
  currentTime = 0;
  destination = {};

  createBuffer(channels, length, sampleRate) {
    return new FakeAudioBuffer(channels, length, sampleRate);
  }

  async resume() {
    this.state = "running";
  }
  async close() {
    this.state = "closed";
  }
}

async function soundFixture(name) {
  const bytes = await readFile(`examples/demos/soundbox-synth/${name}.json`);
  return { bytes, value: JSON.parse(bytes) };
}

for (const name of ["shot", "laser", "song"]) {
  test(`${name} legacy JSON round-trips through the sound bit codec`, async () => {
    const fixture = await soundFixture(name);
    const canonical = parseSonantLegacySong(fixture.value);
    const encoded = encodeSoundBits(fixture.value);
    assert.deepEqual(decodeSoundBits(encoded), canonical);
    assert.ok(
      encoded.byteLength < fixture.bytes.byteLength,
      `${name} should shrink for on-chain storage`,
    );
  });
}

test("all four Vault weapon attacks compile to compact non-silent one-second sounds", async () => {
  const names = ["gyro-saw-attack", "rift-fork-attack", "aegis-star-attack", "needle-array-attack"];
  const signatures = [];
  for (const name of names) {
    const sourceBytes = await readFile(`examples/demos/vault-arcade/generated-attribute-proxy/audio/${name}.json`);
    const source = JSON.parse(sourceBytes);
    const encoded = encodeSoundBits(source);
    const context = new FakeAudioContext();
    const content = {
      protocol: "oca-content-gateway@1",
      manifestId: "vault-weapon-sound-test",
      bytes: () => encoded.slice(),
      text: () => "",
      json: () => source,
      integrity: () => undefined,
      url: () => "data:application/octet-stream;base64,",
    };
    const reader = createAudioReader({ content, context, noiseSeed: "vault-weapon-test", maxSeconds: 5 });
    const buffer = reader.render({ codec: OCA_SOUND_BITS_CODEC, resourceId: `${name}.ocas` });
    assert.equal(buffer.duration, 1, `${name} must be a bounded one-second patch`);
    assert.ok(encoded.byteLength < sourceBytes.byteLength / 8, `${name} must remain compact`);
    let energy = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      for (const sample of buffer.getChannelData(channel)) energy += sample * sample;
    }
    assert.ok(energy > 0.001, `${name} must be audible`);
    const channel = buffer.getChannelData(0);
    signatures.push(Array.from({ length: 16 }, (_, window) => {
      const start = Math.floor((window * channel.length) / 16);
      const end = Math.floor(((window + 1) * channel.length) / 16);
      let magnitude = 0;
      for (let sample = start; sample < end; sample += 1) magnitude += Math.abs(channel[sample]);
      return Math.round(magnitude * 1_000);
    }).join(":"));
  }
  assert.equal(new Set(signatures).size, names.length, "every weapon must render a distinct attack envelope");
});

test("sound bit codec rejects corruption and schema confusion", async () => {
  const fixture = await soundFixture("shot");
  const encoded = encodeSoundBits(fixture.value);
  assert.throws(
    () => decodeSoundBits(Uint8Array.from([0, ...encoded.slice(1)])),
    /not a Keel sound/iu,
  );
  assert.throws(
    () => decodeSoundBits(Uint8Array.from([...encoded, 0])),
    /trailing bytes/iu,
  );
  assert.throws(
    () =>
      parseAudioReaderSpec({
        codec: "soundbox-cplayer@1",
        resourceId: "shot.ocsa",
      }),
    /unsupported audio reader codec/iu,
  );
});

test("sprite sound profiles resolve deterministic event variations from pinned library resources", () => {
  const catalog = {
    schema: OCA_SPRITE_SOUND_SCHEMA,
    storage: "keel-object-revision",
    profiles: [{
      soundProfileId: 41,
      id: "test-weapon-sound",
      assetId: "test-weapon",
      events: [{
        eventId: "attack",
        retriggerMs: 80,
        variations: [
          { soundId: "attack-a", resourceId: "attack-a.ocas", codec: OCA_SOUND_BITS_CODEC, weight: 3, gain: 0.7, rate: 1 },
          { soundId: "attack-b", resourceId: "attack-b.ocas", codec: OCA_SOUND_BITS_CODEC, weight: 1, gain: 0.6, rate: 1.1 },
        ],
      }],
    }],
  };
  assert.deepEqual(parseSpriteSoundCatalog(catalog), catalog);
  const first = resolveSpriteSound(catalog, "test-weapon", "attack", "token-seed", 9);
  assert.deepEqual(resolveSpriteSound(catalog, "test-weapon", "attack", "token-seed", 9), first);
  assert.equal(first.profile.soundProfileId, 41);
  assert.match(first.sound.resourceId, /^attack-[ab]\.ocas$/u);
  assert.throws(() => parseSpriteSoundCatalog({ ...catalog, storage: "standalone" }), /Keel object revisions/iu);
  assert.throws(() => resolveSpriteSound(catalog, "missing", "attack", "seed"), /No sprite sound profile/iu);
});

for (const name of ["shot", "laser"]) {
  test(`${name} renders deterministic, finite, non-silent stereo PCM`, async () => {
    const fixture = await soundFixture(name);
    const bits = encodeSoundBits(fixture.value);
    const context = new FakeAudioContext();
    const content = {
      protocol: "oca-content-gateway@1",
      manifestId: "reader-test",
      bytes: () => bits.slice(),
      text: () => "",
      json: () => fixture.value,
      integrity: () => "0x00",
      url: () => "data:application/octet-stream;base64,",
    };
    const reader = createAudioReader({
      content,
      context,
      noiseSeed: "test-token",
      maxSeconds: 12,
    });
    const spec = { codec: OCA_SOUND_BITS_CODEC, resourceId: `${name}.ocsa` };
    const first = reader.render(spec);
    const second = reader.render(spec);
    assert.equal(first.sampleRate, 44_100);
    assert.equal(first.numberOfChannels, 2);
    assert.equal(first.length, 9 * 44_100);
    let energy = 0;
    for (let channel = 0; channel < 2; channel += 1) {
      const left = first.getChannelData(channel);
      const right = second.getChannelData(channel);
      assert.deepEqual(left, right, "PCM must not depend on render order");
      for (const sample of left) {
        assert.ok(Number.isFinite(sample), "PCM samples must be finite");
        energy += sample * sample;
      }
    }
    assert.ok(energy > 0.001, "PCM must be non-silent");
  });
}

test("grid, JSON, and bit sprite atlases preserve eight 16px frames", async () => {
  const grid = createGridSpriteAtlas({
    imageWidth: 128,
    imageHeight: 16,
    frameWidth: 16,
    frameHeight: 16,
    fps: 8,
  });
  const json = parseSpriteAtlasJson(
    JSON.parse(
      await readFile("examples/demos/sprite-forge/atlas.json", "utf8"),
    ),
  );
  const bits = decodeSpriteBitAtlas(encodeSpriteBitAtlas(json));
  assert.equal(grid.frames.length, 8);
  assert.deepEqual(
    bits.frames,
    json.frames.map((frame) => ({ ...frame, originX: 0, originY: 0 })),
  );
  for (const [index, frame] of grid.frames.entries()) {
    assert.deepEqual(frame, {
      x: index * 16,
      y: 0,
      width: 16,
      height: 16,
      durationMs: 125,
    });
  }
});

test("sprite atlas rejects overflow, reserved flags, and invalid grids", () => {
  assert.throws(
    () =>
      createGridSpriteAtlas({
        imageWidth: 127,
        imageHeight: 16,
        frameWidth: 16,
        frameHeight: 16,
      }),
    /divide the image dimensions/iu,
  );
  const valid = encodeSpriteBitAtlas({
    frames: [{ x: 0, y: 0, width: 16, height: 16, durationMs: 100 }],
  });
  const flagged = valid.slice();
  flagged[5] = 1;
  assert.throws(() => decodeSpriteBitAtlas(flagged), /flags/iu);
});

test("variable-size sprite packing preserves origins and saves atlas area", () => {
  const packed = packSpriteFrames({
    maxWidth: 64,
    padding: 1,
    frames: [
      { width: 48, height: 48, durationMs: 125, originX: 24, originY: 40 },
      { width: 24, height: 20, durationMs: 80, originX: 12, originY: 18 },
      { width: 12, height: 10, durationMs: 80, originX: 6, originY: 8 },
    ],
  });
  assert.equal(packed.imageWidth, 48);
  assert.equal(packed.imageHeight, 69);
  assert.ok(
    packed.imageWidth * packed.imageHeight < 48 * 48 * 3,
    "off-size frames must save raw atlas area",
  );
  assert.deepEqual(
    decodeSpriteBitAtlas(encodeSpriteBitAtlas(packed.atlas)).frames,
    packed.atlas.frames,
  );
  assert.throws(
    () =>
      packSpriteFrames({ maxWidth: 32, frames: [{ width: 48, height: 48 }] }),
    /exceeds maxWidth/iu,
  );
});

test("directional animation grid gives every attribute the same 120-cell registration", () => {
  const layout = createDirectionalAnimationAtlas({
    frameWidth: 48,
    frameHeight: 48,
    directions: ["south", "west", "north", "east"],
    clips: [
      { id: "idle", frames: 4, fps: 6 },
      { id: "walk", frames: 6, fps: 10 },
      { id: "attack", frames: 8, fps: 12 },
      { id: "hit", frames: 4, fps: 12 },
      { id: "death", frames: 8, fps: 8 },
    ],
  });
  assert.equal(layout.columns, 8);
  assert.equal(layout.rows.length, 20);
  assert.equal(layout.atlas.frames.length, 120);
  assert.equal(layout.imageWidth, 384);
  assert.equal(layout.imageHeight, 960);
  assert.deepEqual(layout.rows[0], {
    clipId: "idle",
    direction: "south",
    row: 0,
    frameOffset: 0,
    frameCount: 4,
  });
  assert.deepEqual(layout.rows[19], {
    clipId: "death",
    direction: "east",
    row: 19,
    frameOffset: 112,
    frameCount: 8,
  });
  assert.deepEqual(layout.atlas.frames[119], {
    x: 336,
    y: 912,
    width: 48,
    height: 48,
    durationMs: 125,
  });
});

test("directional atlas pixel audit reports missing and unexpected cells", () => {
  const layout = createDirectionalAnimationAtlas({
    frameWidth: 2,
    frameHeight: 2,
    directions: ["south"],
    clips: [{ id: "idle", frames: 1 }],
  });
  const empty = new Uint8Array(layout.imageWidth * layout.imageHeight * 4);
  const missing = inspectDirectionalAnimationAtlasPixels({
    pixels: empty,
    imageWidth: layout.imageWidth,
    imageHeight: layout.imageHeight,
    layout,
  });
  assert.equal(missing.complete, false);
  assert.deepEqual(missing.missingFrames, ["idle/south/0"]);
  empty[3] = 255;
  const complete = inspectDirectionalAnimationAtlasPixels({
    pixels: empty,
    imageWidth: layout.imageWidth,
    imageHeight: layout.imageHeight,
    layout,
  });
  assert.equal(complete.complete, true);
  assert.deepEqual(complete.frames[0].bounds, {
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    width: 1,
    height: 1,
    centerX: 0,
    centerY: 0,
    visiblePixels: 1,
  });
  assert.throws(
    () =>
      inspectDirectionalAnimationAtlasPixels({
        pixels: empty,
        imageWidth: 3,
        imageHeight: 2,
        layout,
      }),
    /Atlas must be/iu,
  );
});

test("material codec preserves locked accents, weighted colors, and luminance ramps", () => {
  const human = {
    codec: OCA_MATERIAL_BITS_CODEC,
    setId: 42,
    setWeight: 7,
    regions: [
      {
        regionId: 0,
        weight: 1,
        rule: { mode: "locked", color: [255, 214, 64] },
      },
      {
        regionId: 1,
        weight: 4,
        rule: {
          mode: "palette",
          colors: [
            { color: [32, 92, 180], weight: 12 },
            { color: [160, 38, 205], weight: 3 },
          ],
        },
      },
      {
        regionId: 2,
        weight: 2,
        rule: {
          mode: "ramp",
          dark: [8, 12, 28],
          mid: [52, 98, 160],
          light: [210, 242, 255],
        },
      },
      {
        regionId: 3,
        weight: 5,
        rule: {
          mode: "range",
          hue: [170, 230],
          saturation: [45, 90],
          lightness: [38, 62],
          darken: 22,
          lighten: 28,
        },
      },
    ],
  };
  const encoded = encodeMaterialBits(human);
  const decoded = decodeMaterialBits(encoded);
  assert.deepEqual(decoded, parseMaterialProfile(human));
  assert.ok(encoded.byteLength < Buffer.byteLength(JSON.stringify(human)) / 3);
  assert.deepEqual(
    resolveMaterialProfile(decoded, "token-77"),
    resolveMaterialProfile(decoded, "token-77"),
  );
  assert.deepEqual(resolveMaterialProfile(decoded, "token-77")[0], {
    regionId: 0,
    mode: "locked",
    colors: [[255, 214, 64]],
  });
  assert.deepEqual(resolveMaterialProfile(decoded, "token-77")[2].colors, [
    [8, 12, 28],
    [52, 98, 160],
    [210, 242, 255],
  ]);
  const ranged = resolveMaterialProfile(decoded, "token-77")[3];
  assert.equal(ranged.mode, "range");
  assert.equal(ranged.colors.length, 3);
  assert.deepEqual(ranged, resolveMaterialProfile(decoded, "token-77")[3]);
  const corrupted = encoded.slice();
  corrupted[5] = 1;
  assert.throws(() => decodeMaterialBits(corrupted), /flags/iu);
});

test("atlas material map binds multiple lossy color ranges to seeded regions and preserves fixed accents", () => {
  const human = {
    codec: OCA_ATLAS_MATERIAL_BITS_CODEC,
    unmatched: "preserve",
    targets: [
      {
        targetId: 1,
        label: "gold shadow",
        materialRegionId: 7,
        red: [70, 110],
        green: [40, 80],
        blue: [0, 30],
        alpha: [240, 255],
        shade: "luminance",
        priority: 10,
      },
      {
        targetId: 2,
        label: "gold mid",
        materialRegionId: 7,
        red: [140, 180],
        green: [90, 130],
        blue: [10, 45],
        alpha: [240, 255],
        shade: "luminance",
        priority: 10,
      },
      {
        targetId: 3,
        label: "gold highlight",
        materialRegionId: 7,
        red: [210, 245],
        green: [165, 210],
        blue: [55, 100],
        alpha: [240, 255],
        shade: "luminance",
        priority: 10,
      },
      {
        targetId: 4,
        label: "cloth",
        materialRegionId: 8,
        red: [45, 75],
        green: [45, 75],
        blue: [45, 75],
        alpha: [240, 255],
        shade: "red",
        priority: 20,
      },
      {
        targetId: 5,
        label: "fixed cyan",
        action: "preserve",
        red: [0, 35],
        green: [190, 240],
        blue: [230, 255],
        alpha: [240, 255],
        shade: "blue",
        priority: 255,
      },
    ],
  };
  const encoded = encodeAtlasMaterialMapBits(human);
  const decoded = decodeAtlasMaterialMapBits(encoded);
  assert.deepEqual(decoded, parseAtlasMaterialMap(human));
  assert.ok(encoded.byteLength < Buffer.byteLength(JSON.stringify(human)) / 2);

  const profile = {
    codec: OCA_MATERIAL_BITS_CODEC,
    setId: 91,
    regions: [
      {
        regionId: 7,
        rule: {
          mode: "range",
          hue: [30, 58],
          saturation: [60, 92],
          lightness: [42, 64],
          darken: 24,
          lighten: 28,
        },
      },
      {
        regionId: 8,
        rule: {
          mode: "range",
          hue: [170, 310],
          saturation: [42, 88],
          lightness: [34, 66],
          darken: 20,
          lighten: 25,
        },
      },
    ],
  };
  const source = Uint8Array.from([
    90, 60, 10, 255, 160, 110, 25, 255, 230, 190, 80, 255, 60, 60, 60, 255, 0,
    220, 255, 255,
  ]);
  const firstRegions = resolveMaterialProfile(profile, "character-1");
  const first = applyAtlasMaterialMap(source, decoded, firstRegions);
  assert.deepEqual(
    first,
    applyAtlasMaterialMap(
      source,
      decoded,
      resolveMaterialProfile(profile, "character-1"),
    ),
  );
  assert.notDeepEqual(
    first,
    applyAtlasMaterialMap(
      source,
      decoded,
      resolveMaterialProfile(profile, "character-2"),
    ),
  );
  assert.deepEqual(
    [...first.slice(16, 20)],
    [0, 220, 255, 255],
    "unmatched authored cyan must stay fixed",
  );
  assert.notDeepEqual(
    [...first.slice(0, 4)],
    [...source.slice(0, 4)],
    "gold source colors must resolve through one material region",
  );
  assert.throws(
    () =>
      parseAtlasMaterialMap({
        targets: [
          { ...human.targets[0], targetId: 50, label: "overlap a" },
          { ...human.targets[0], targetId: 51, label: "overlap b" },
        ],
      }),
    /overlap at equal priority/iu,
  );
  const corrupted = encoded.slice();
  corrupted[5] = 1;
  assert.throws(() => decodeAtlasMaterialMapBits(corrupted), /flags/iu);
});

test("extensible mint catalogue handles core slots plus arbitrary attributes with huge combination space", () => {
  const attributes = Array.from({ length: 24 }, (_, attributeId) => ({
    attributeId,
    ...(attributeId < 9 ? { coreSlot: attributeId } : {}),
    required: attributeId < 9,
    options: Array.from({ length: 16 }, (_, optionId) => ({
      optionId,
      weight: optionId === 15 ? 1 : 10,
      materialProfileId: attributeId * 16 + optionId,
    })),
  }));
  const human = {
    codec: OCA_TRAIT_BITS_CODEC,
    revision: 3,
    rejectExactDuplicates: true,
    attributes,
  };
  const encoded = encodeTraitCatalogBits(human);
  const decoded = decodeTraitCatalogBits(encoded);
  assert.deepEqual(decoded, human);
  assert.equal(traitCombinationCount(decoded), 2n ** 96n);
  assert.ok(
    traitCombinationCount(decoded) > 1_000_000n ** 3n,
    "catalogue should dwarf a million-character population",
  );
  const first = resolveTraitCatalog(decoded, "0x1234");
  assert.deepEqual(first, resolveTraitCatalog(decoded, "0x1234"));
  assert.equal(first.length, 24);
  assert.equal(
    first[23].attributeId,
    23,
    "custom attributes must resolve after the nine interoperable slots",
  );
  assert.ok(
    new Set(first.map((trait) => trait.optionId)).size > 1,
    "each attribute must have its own randomness domain",
  );
  assert.notDeepEqual(
    first,
    resolveTraitCatalog(decoded, "0x5678"),
    "different mint seeds must produce different trait sets",
  );
});

test("append-only trait epochs preserve every old roll after new assets are appended", () => {
  const domain = 0x12345678;
  const first = {
    codec: OCA_APPEND_ONLY_TRAIT_BITS_CODEC,
    revision: 1,
    rejectExactDuplicates: true,
    attributes: [{
      attributeId: 5,
      required: true,
      introducedAt: 1,
      entropyDomain: domain,
      options: [
        { optionId: 100, weight: 7, introducedAt: 1 },
        { optionId: 205, weight: 3, introducedAt: 1 },
      ],
    }],
  };
  const second = {
    ...first,
    revision: 2,
    attributes: [{
      ...first.attributes[0],
      options: [...first.attributes[0].options, { optionId: 999, weight: 100, introducedAt: 2 }],
    }],
  };
  assertTraitCatalogAppendOnly(first, second);
  const decoded = decodeTraitCatalogBits(encodeTraitCatalogBits(second));
  for (let token = 0; token < 1000; token += 1) {
    assert.deepEqual(resolveTraitCatalog(first, `token-${token}`), resolveTraitCatalog(decoded, `token-${token}`, 1));
  }
  assert.ok(Array.from({ length: 100 }, (_, token) => resolveTraitCatalog(decoded, `new-${token}`, 2)[0].optionId).includes(999));
  assert.throws(() => assertTraitCatalogAppendOnly(first, {
    ...second,
    attributes: [{ ...second.attributes[0], entropyDomain: domain + 1 }],
  }), /stable definition/iu);
  assert.throws(() => assertTraitCatalogAppendOnly(first, {
    ...second,
    attributes: [{
      ...second.attributes[0],
      options: [second.attributes[0].options[2], ...second.attributes[0].options.slice(0, 2)],
    }],
  }), /option .* changed/iu);
  assert.throws(() => assertTraitCatalogAppendOnly(first, {
    ...second,
    attributes: [{
      ...second.attributes[0],
      options: [...first.attributes[0].options, { optionId: 999, weight: 100, introducedAt: 1 }],
    }],
  }), /must start after revision/iu);
});

test("bit metadata round-trips all character, color, particle and FX selections compactly", () => {
  const vector = {
    codec: OCA_CHARACTER_METADATA_BITS_CODEC,
    catalogRevision: 17,
    sceneId: 4,
    attributes: Array.from({ length: 26 }, (_, attributeId) => ({
      attributeId,
      optionId: attributeId % 16,
      materialProfileId: attributeId % 4,
      colorProfileId: attributeId === 24 ? 12 : 0,
      effectProfileId: attributeId === 25 ? 7 : 0,
    })),
  };
  const encoded = encodeCharacterMetadataBits(vector);
  assert.deepEqual(decodeCharacterMetadataBits(encoded), vector);
  assert.ok(encoded.byteLength < Buffer.byteLength(JSON.stringify(vector)) / 8);
});

test("semantic sprite targets support exact hexes, ranges, recolor masks and sprite-wide filters", () => {
  const targetMap = {
    schema: OCA_SPRITE_ATTRIBUTE_SCHEMA,
    scope: "character.weapon",
    unmatched: "preserve",
    targets: [
      { targetId: 1, name: "core-light", selector: { red: [0, 0], green: [255, 255], blue: [0, 0], alpha: [255, 255] }, priority: 20, colorSlot: "particle-color", effectSlot: "core-glow" },
      { targetId: 2, name: "metal", selector: { red: [80, 180], green: [80, 180], blue: [80, 180], alpha: [200, 255] }, priority: 10, colorSlot: "weapon-metal" },
    ],
  };
  const source = Uint8Array.from([0, 255, 0, 255, 128, 128, 128, 255, 1, 2, 3, 255]);
  const applied = applySpriteTargets(source, targetMap, {
    "particle-color": [80, 240, 255, 255],
    "weapon-metal": [200, 100, 50, 255],
  });
  assert.notDeepEqual([...applied.pixels], [...source]);
  assert.deepEqual([...applied.masks.get("core-glow")], [255, 0, 0]);
  const effects = compileSpriteEffects([
    { id: "vault-hue", kind: "hue-rotate", target: "sprite", amount: 45 },
    { id: "core-glow", kind: "glow", target: "core-glow", amount: 8 },
  ]);
  assert.match(effects.filter, /hue-rotate/iu);
  assert.equal(effects.targeted.length, 1);
});

test("mini-3D matrix helpers compose finite transforms without Three.js", () => {
  const identity = mat4Identity();
  const model = mat4Multiply(
    mat4Translation(1, 2, -4),
    mat4RotationY(Math.PI / 4),
  );
  const projection = mat4Perspective(Math.PI / 3, 16 / 9, 0.1, 100);
  assert.deepEqual(mat4Multiply(identity, model), model);
  assert.ok([...mat4Multiply(projection, model)].every(Number.isFinite));
});
