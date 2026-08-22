import test from "node:test";
import assert from "node:assert/strict";
import { validateKeelPresentationMessage } from "../packages/viewer/dist/index.js";

// The gallery frame is sandboxed without allow-same-origin, so real messages
// arrive with origin "null" (opaque). The policy is origin:"opaque".
const ORIGIN = "null";

function presentationState(overrides = {}) {
  return {
    protocol: "keel-viewer-verification@1",
    action: "presentation-state",
    presentation: "weapon",
    character: { tokenId: "1234", seed: "0xabc", appearance: "shell/visor/core/skin" },
    weapon: {
      id: "wpn-1",
      name: "Ion Lance",
      assetId: "asset-42",
      build: { barrel: "long", "projectile-style": "bolt" },
      projectileStyle: "bolt",
      combat: { longRangeMode: "charged", cooldownMs: 800, projectileSpeed: 420, count: 1, spread: 0 },
    },
    ...overrides,
  };
}

test("presentation bridge accepts a well-formed state from the pinned opaque frame", () => {
  const frame = {};
  const result = validateKeelPresentationMessage(
    { data: presentationState(), origin: ORIGIN, source: frame },
    frame,
  );
  assert.equal(result.ok, true);
  assert.equal(result.action, "presentation-state");
  assert.equal(result.state.weapon.name, "Ion Lance");
  assert.equal(result.state.weapon.combat.cooldownMs, 800);
});

test("presentation bridge accepts preview-ready with the producer's state field", () => {
  const frame = {};
  const result = validateKeelPresentationMessage(
    { data: { protocol: "keel-viewer-verification@1", action: "preview-ready", state: "verified" }, origin: ORIGIN, source: frame },
    frame,
  );
  assert.equal(result.ok, true);
  assert.equal(result.action, "preview-ready");
});

test("presentation bridge accepts preview-ready with no state field", () => {
  const frame = {};
  const result = validateKeelPresentationMessage(
    { data: { protocol: "keel-viewer-verification@1", action: "preview-ready" }, origin: ORIGIN, source: frame },
    frame,
  );
  assert.equal(result.ok, true);
  assert.equal(result.action, "preview-ready");
});

test("presentation bridge rejects a non-opaque origin", () => {
  const frame = {};
  const result = validateKeelPresentationMessage(
    { data: presentationState(), origin: "https://evil.example", source: frame },
    frame,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "bad-origin");
});

test("presentation bridge requires an expected source (opaque policy)", () => {
  const result = validateKeelPresentationMessage(
    { data: presentationState(), origin: ORIGIN, source: {} },
    undefined,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "bad-source");
});

test("presentation bridge rejects a message from the wrong window", () => {
  const frame = {};
  const result = validateKeelPresentationMessage(
    { data: presentationState(), origin: ORIGIN, source: {} },
    frame,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "bad-source");
});

test("presentation bridge rejects an unbounded weapon.build map", () => {
  const frame = {};
  const build = {};
  for (let i = 0; i < 200; i += 1) build[`attr${i}`] = "x";
  const result = validateKeelPresentationMessage(
    { data: presentationState({ weapon: { ...presentationState().weapon, build } }), origin: ORIGIN, source: frame },
    frame,
  );
  assert.equal(result.ok, false);
  assert.ok(result.code === "too-many-keys" || result.code === "schema" || result.code === "oversize");
});

test("presentation bridge rejects an over-length string field", () => {
  const frame = {};
  const result = validateKeelPresentationMessage(
    { data: presentationState({ weapon: { ...presentationState().weapon, name: "x".repeat(500) } }), origin: ORIGIN, source: frame },
    frame,
  );
  assert.equal(result.ok, false);
});

test("presentation bridge rejects an out-of-range combat number", () => {
  const frame = {};
  const base = presentationState();
  const result = validateKeelPresentationMessage(
    { data: { ...base, weapon: { ...base.weapon, combat: { ...base.weapon.combat, cooldownMs: 9_999_999 } } }, origin: ORIGIN, source: frame },
    frame,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "schema");
});

test("presentation bridge rejects an undeclared action", () => {
  const frame = {};
  const result = validateKeelPresentationMessage(
    { data: { protocol: "keel-viewer-verification@1", action: "force-failure" }, origin: ORIGIN, source: frame },
    frame,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "unknown-operation");
});

test("presentation bridge rejects a prototype-pollution key in build", () => {
  const frame = {};
  const base = presentationState();
  const polluted = JSON.parse(JSON.stringify(base).replace('"build":{', '"build":{"__proto__":"x",'));
  const result = validateKeelPresentationMessage({ data: polluted, origin: ORIGIN, source: frame }, frame);
  assert.equal(result.ok, false);
  assert.equal(result.code, "dangerous-key");
});

test("presentation bridge accepts a realistically large but valid build within bounds", () => {
  const frame = {};
  // 40 attributes, values ~40 chars: valid per field bounds and under maxBytes.
  const build = {};
  for (let i = 0; i < 40; i += 1) build[`attribute-${i}`] = "v".repeat(40);
  const base = presentationState();
  const result = validateKeelPresentationMessage(
    { data: { ...base, weapon: { ...base.weapon, build } }, origin: ORIGIN, source: frame },
    frame,
  );
  assert.equal(result.ok, true);
});
