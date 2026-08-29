// Watermarks — identity and shared-module commitments.

import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import { deriveIdentity, BACKGROUND_STYLES, PALETTES } from "../traits.js";
import {
  P5_BRUSH_BYTE_LENGTH,
  P5_BRUSH_DIGEST,
  vendoredBytes,
} from "../shared-module.mjs";

const SEEDS = Array.from({ length: 256 }, (_, index) =>
  `0x${createHash("sha256").update(`watermarks:${index}`).digest("hex")}`);

test("identity derivation is deterministic", () => {
  for (const seed of SEEDS.slice(0, 32)) {
    assert.deepEqual(deriveIdentity(seed), deriveIdentity(seed));
  }
});

test("the base three attributes are always present and lead the list", () => {
  for (const seed of SEEDS) {
    const { attributes } = deriveIdentity(seed);
    assert.deepEqual(
      attributes.slice(0, 3).map((attribute) => attribute.trait_type),
      ["Face", "Eyes", "Mouth"],
    );
    assert.equal(attributes.at(-1).trait_type, "Palette");
  }
});

test("optional attributes never exceed seven beyond the base", () => {
  for (const seed of SEEDS) {
    const { attributes } = deriveIdentity(seed);
    const optional = attributes.length - 3;
    assert.ok(optional >= 2 && optional <= 7, `got ${optional} optional attributes`);
    const types = attributes.map((attribute) => attribute.trait_type);
    assert.equal(new Set(types).size, types.length, "attribute types must be unique");
  }
});

test("attributes carry the OpenSea shape the protocol parses", () => {
  for (const seed of SEEDS.slice(0, 64)) {
    for (const attribute of deriveIdentity(seed).attributes) {
      assert.deepEqual(Object.keys(attribute).sort(), ["trait_type", "value"]);
      assert.equal(typeof attribute.trait_type, "string");
      assert.ok(typeof attribute.value === "string" || typeof attribute.value === "number");
    }
  }
});

test("background is derived but never an attribute, and the override holds", () => {
  for (const seed of SEEDS.slice(0, 64)) {
    const identity = deriveIdentity(seed);
    assert.ok(BACKGROUND_STYLES.some((style) => style.name === identity.background.style));
    assert.ok(!identity.attributes.some((attribute) => attribute.trait_type === "Background"));

    const overridden = deriveIdentity(seed, { background: "Deep Pool" });
    assert.equal(overridden.background.style, "Deep Pool");
    assert.equal(overridden.background.overridden, true);
    // Swapping the background must not move a single trait.
    assert.deepEqual(overridden.attributes, identity.attributes);
  }
});

test("every token animates", () => {
  for (const seed of SEEDS) {
    const { animations } = deriveIdentity(seed);
    assert.ok(animations.includes("boil"));
    assert.ok(animations.includes("blink"));
  }
});

test("palettes stay referenced and colorways resolve to concrete pigment", () => {
  const names = new Set(PALETTES.map((palette) => palette.name));
  for (const seed of SEEDS) {
    const identity = deriveIdentity(seed);
    assert.ok(names.has(identity.palette.name));
    for (const trait of identity.traits) {
      assert.match(trait.colorway.from, /^#[0-9a-f]{6}$/u);
      assert.match(trait.colorway.to, /^#[0-9a-f]{6}$/u);
    }
  }
});

test("no two seeds collide on the full recipe", () => {
  const seen = new Set();
  for (const seed of SEEDS) {
    const identity = deriveIdentity(seed);
    const fingerprint = JSON.stringify([identity.traits, identity.layout]);
    assert.ok(!seen.has(fingerprint), `seed ${seed} duplicates a prior recipe`);
    seen.add(fingerprint);
  }
});

test("the vendored p5.brush bytes match the shared-module commitment", async () => {
  const bytes = await vendoredBytes();
  assert.equal(bytes.byteLength, P5_BRUSH_BYTE_LENGTH);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  assert.equal(digest, P5_BRUSH_DIGEST);
});
