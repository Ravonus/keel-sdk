import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  DEFAULT_SCENE_SEED,
  normalizeSeedHex,
  resolveSceneSeed,
  seedWord,
} from "../scene-seed.mjs";
import { buildDemoManifest } from "../../build.mjs";
import { DEMOS, readDemoResources } from "../../demos.mjs";

const SHADOWNET_SEEDS = [
  "0x5a5553b51e3d705baa6af64fcab768c3eb6efd3f3adf62fb4b40ea93c713e81a",
  "0x9e3fa3dc2046c833a1ef1068289f0815dbf643d247f2649a7524b169f1582407",
  "0xe88dfc87e4aa8fb06912bdcc08193f158f7254bb252ea4cdc1cea4230429519f",
];

test("three-vault scene seeds accept only canonical bytes32 values", () => {
  assert.equal(normalizeSeedHex(SHADOWNET_SEEDS[0]), SHADOWNET_SEEDS[0]);
  assert.equal(normalizeSeedHex(SHADOWNET_SEEDS[0].slice(2)), SHADOWNET_SEEDS[0]);
  assert.equal(normalizeSeedHex("0x1234"), undefined);
  assert.equal(normalizeSeedHex(1234), undefined);
  assert.equal(seedWord(SHADOWNET_SEEDS[0]), 0xc713e81a);
});

test("contract context wins over preview seed injection", () => {
  const resolved = resolveSceneSeed(
    {
      tokenId: "0",
      derivedTokenSeed: SHADOWNET_SEEDS[0],
      source: "Tezos ShadowNet get_recipe",
      contract: "KT1LpCu73gb87jz96tnkiU6nfWgunHUue7VP",
      view: "get_recipe",
    },
    0xdeadbeef,
  );

  assert.deepEqual(resolved, {
    hex: SHADOWNET_SEEDS[0],
    word: 0xc713e81a,
    source: "Tezos ShadowNet get_recipe",
    contract: "KT1LpCu73gb87jz96tnkiU6nfWgunHUue7VP",
    view: "get_recipe",
  });
});

test("different ShadowNet token seeds produce different scene inputs", () => {
  const resolved = SHADOWNET_SEEDS.map((seed) => resolveSceneSeed({ derivedTokenSeed: seed }));
  assert.deepEqual(
    resolved.map(({ word }) => word),
    [0xc713e81a, 0xf1582407, 0x0429519f],
  );
  assert.equal(new Set(resolved.map(({ word }) => word)).size, 3);
});

test("invalid contract context falls back deterministically", () => {
  assert.equal(resolveSceneSeed({ derivedTokenSeed: "not-bytes32" }).hex, DEFAULT_SCENE_SEED);
  assert.equal(resolveSceneSeed({}, 0x12345678).hex, `0x${"12345678".padStart(64, "0")}`);
  assert.equal(resolveSceneSeed({}, 0x12345678).source, "injected preview");
});

test("three-vault manifest carries the contract-seed helper as a verified resource", async () => {
  const demo = DEMOS.find(({ slug }) => slug === "three-vault");
  assert.ok(demo);

  const { manifest } = await buildDemoManifest(demo);
  const resourceIds = manifest.resources.map(({ id }) => id);
  assert.deepEqual(resourceIds, [
    "index.html",
    "three.min.js",
    "three.core.min.js",
    "scene.js",
    "scene-seed.mjs",
    "poster.webp",
  ]);

  const resources = await readDemoResources(demo);
  const scene = resources.find(({ id }) => id === "scene.js");
  const seedHelper = resources.find(({ id }) => id === "scene-seed.mjs");
  assert.ok(scene);
  assert.ok(seedHelper);
  const sceneSource = new TextDecoder().decode(scene.bytes);
  assert.match(sceneSource, /\/content\/scene-seed\.mjs/u);
  assert.match(sceneSource, /resolveSceneSeed\(CONTEXT\)/u);
  assert.ok(seedHelper.bytes.byteLength > 0);
});

test("three-vault source does not call a raw network endpoint", async () => {
  const source = await readFile(new URL("../scene.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /https?:\/\//u);
  assert.doesNotMatch(source, /fetch\(/u);
});
