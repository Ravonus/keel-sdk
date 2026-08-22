// Adversarial boundary proof. A single cohesive scenario: a simulated hostile
// application, running beneath the Keel trusted runtime, tries the boundary
// violations the design brief enumerates, against a simulated marketplace host.
// Every undeclared behavior must fail at the Keel boundary; declared,
// policy-permitted operations must keep working. This is the executable form of
// the "adversarial sandbox example" — living proof for approaching galleries.
import test from "node:test";
import assert from "node:assert/strict";
import {
  allowedWalletIntents,
  createHostBridge,
  effectiveRuntimeCapabilities,
  intersectCapabilities,
  narrowWalletOperations,
  validateKeelPresentationMessage,
} from "../packages/viewer/dist/index.js";

// ---- The marketplace host declares what it trusts (once) ----
const HOST_POLICY = {
  label: "host",
  ceiling: true,
  allow: [
    "wallet.market.bid",
    "wallet.market.buy",
    "network.manifested",
    "chain.read",
    "storage",
    "browser.fullscreen",
    "browser.webassembly",
  ],
  // No camera/microphone/parent-navigation; no arbitrary wallet, no raw RPC.
  deny: ["browser.camera", "browser.microphone", "navigation.parent"],
};

// The app manifest asks for a subset (it may narrow, never widen).
const MANIFEST_LAYER = {
  label: "manifest",
  allow: ["wallet.market.bid", "browser.fullscreen", "browser.webassembly", "chain.read", "network.manifested"],
};

// The verified plugin manifest declares this intent table (the hard gate the
// adapter cryptographically verifies; host policy only further-restricts it).
const DECLARED_PLUGIN_INTENTS = {
  "market.bid": { selector: "0x11111111" },
  "market.buy": { selector: "0x22222222" },
  "market.approve": { selector: "0x33333333" },
};

const SESSION = `0x${"cd".repeat(32)}`;
const APP_FRAME = {}; // stands in for the sandboxed app's window

function marketBridge() {
  const bridge = createHostBridge({
    maxBytes: 4096,
    origin: { kind: "opaque" },
    protocols: [
      {
        protocol: "keel-wallet-intent@1",
        operationKey: "intentId",
        sessionKey: "session",
        sequenceKey: "sequence",
        sessionPattern: /^0x[0-9a-f]{64}$/u,
        operations: {
          "market.bid": {
            fields: {
              proposal: {
                type: "object",
                fields: { priceEth: { type: "string", maxLength: 80 }, bidder: { type: "string", maxLength: 42, optional: true } },
              },
            },
          },
          "market.buy": {
            fields: {
              proposal: {
                type: "object",
                fields: { priceEth: { type: "string", maxLength: 80 }, bidder: { type: "string", maxLength: 42, optional: true } },
              },
            },
          },
        },
      },
    ],
  });
  bridge.registerSession("keel-wallet-intent@1", SESSION);
  return bridge;
}

function intent(overrides = {}) {
  return {
    protocol: "keel-wallet-intent@1",
    intentId: "market.bid",
    session: SESSION,
    sequence: 1,
    proposal: { priceEth: "0.05", bidder: "" },
    ...overrides,
  };
}

// ============================ LEGITIMATE PATH ============================

test("LEGIT: a declared, policy-permitted market bid is accepted", () => {
  const bridge = marketBridge();
  const result = bridge.accept({ data: intent(), origin: "null", source: APP_FRAME }, APP_FRAME);
  assert.equal(result.ok, true);
  assert.equal(result.operation, "market.bid");
  // Only the symbolic intent + bounded proposal crossed — no calldata, no target.
  assert.deepEqual(Object.keys(result.message.proposal).sort(), ["bidder", "priceEth"]);
});

test("LEGIT: the effective policy enables exactly the intended capabilities", () => {
  const effective = intersectCapabilities([HOST_POLICY, MANIFEST_LAYER]);
  assert.equal(effective.isAllowed("wallet.market.bid"), true);
  assert.equal(effective.isAllowed("browser.webassembly"), true);
  const caps = effectiveRuntimeCapabilities(effective);
  assert.equal(caps.webAssembly, true);
  assert.equal(caps.fullscreen, true);
  assert.equal(caps.gamepad, false); // never requested
});

// ============================ ATTACKS ============================

test("ATTACK: forged host message / spoofed source window is rejected", () => {
  const bridge = marketBridge();
  const attacker = {}; // a different window than APP_FRAME
  const result = bridge.accept({ data: intent(), origin: "null", source: attacker }, APP_FRAME);
  assert.equal(result.ok, false);
  assert.equal(result.code, "bad-source");
});

test("ATTACK: calling an undeclared intent is rejected", () => {
  const bridge = marketBridge();
  const result = bridge.accept({ data: intent({ intentId: "market.drain" }), origin: "null", source: APP_FRAME }, APP_FRAME);
  assert.equal(result.ok, false);
  assert.equal(result.code, "unknown-operation");
});

test("ATTACK: smuggling a raw transaction (target/selector/calldata/value) is rejected", () => {
  const bridge = marketBridge();
  const result = bridge.accept(
    {
      data: intent({ to: "0xdeadbeef00000000000000000000000000000000", data: "0xa9059cbb", value: "1000000000000000000" }),
      origin: "null",
      source: APP_FRAME,
    },
    APP_FRAME,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "schema"); // extra keys rejected — no calldata crosses the boundary
});

test("ATTACK: requesting excessive ETH is not expressible past the schema", () => {
  const bridge = marketBridge();
  // priceEth is a bounded string the host re-derives value from; an 9000-char
  // number cannot even cross the boundary.
  const result = bridge.accept(
    { data: intent({ proposal: { priceEth: "9".repeat(9000), bidder: "" } }), origin: "null", source: APP_FRAME },
    APP_FRAME,
  );
  assert.equal(result.ok, false);
  assert.ok(result.code === "oversize" || result.code === "schema");
});

test("ATTACK: forged session id is rejected", () => {
  const bridge = marketBridge();
  const forged = `0x${"ff".repeat(32)}`;
  const result = bridge.accept({ data: intent({ session: forged }), origin: "null", source: APP_FRAME }, APP_FRAME);
  assert.equal(result.ok, false);
  assert.equal(result.code, "unknown-session");
});

test("ATTACK: replaying a captured intent is rejected", () => {
  const bridge = marketBridge();
  assert.equal(bridge.accept({ data: intent({ sequence: 7 }), origin: "null", source: APP_FRAME }, APP_FRAME).ok, true);
  const replay = bridge.accept({ data: intent({ sequence: 7 }), origin: "null", source: APP_FRAME }, APP_FRAME);
  assert.equal(replay.ok, false);
  assert.equal(replay.code, "replayed");
});

test("ATTACK: prototype pollution in a proposal is rejected", () => {
  const bridge = marketBridge();
  const polluted = JSON.parse(
    `{"protocol":"keel-wallet-intent@1","intentId":"market.bid","session":"${SESSION}","sequence":1,` +
      `"proposal":{"priceEth":"1","__proto__":{"polluted":true}}}`,
  );
  const result = bridge.accept({ data: polluted, origin: "null", source: APP_FRAME }, APP_FRAME);
  assert.equal(result.ok, false);
  assert.equal(result.code, "dangerous-key");
});

test("ATTACK: message flooding cannot evict a victim session's replay floor", () => {
  const bridge = marketBridge();
  assert.equal(bridge.accept({ data: intent({ sequence: 100 }), origin: "null", source: APP_FRAME }, APP_FRAME).ok, true);
  for (let i = 0; i < 50; i += 1) {
    const junk = `0x${i.toString(16).padStart(64, "0")}`;
    assert.equal(bridge.accept({ data: intent({ session: junk, sequence: 1 }), origin: "null", source: APP_FRAME }, APP_FRAME).code, "unknown-session");
  }
  const replay = bridge.accept({ data: intent({ sequence: 100 }), origin: "null", source: APP_FRAME }, APP_FRAME);
  assert.equal(replay.code, "replayed"); // floor intact
});

test("ATTACK: requesting a blocked browser permission (camera) is denied by policy", () => {
  const greedyApp = { label: "app", allow: ["browser.camera", "browser.microphone", "wallet.market.bid"] };
  const effective = intersectCapabilities([HOST_POLICY, greedyApp]);
  assert.equal(effective.isAllowed("browser.camera"), false);
  assert.equal(effective.isAllowed("browser.microphone"), false);
  assert.equal(effective.explain("browser.camera").deniedBy.includes("host"), true);
});

test("ATTACK: an app cannot widen wallet authority above the host policy", () => {
  const greedyApp = { label: "app", allow: ["wallet.market.bid", "wallet.market.transferAll", "wallet.market.approve"] };
  const effective = intersectCapabilities([HOST_POLICY, greedyApp]);
  // Host never granted transferAll; approve is host-denied. Only bid survives.
  const allowedIntents = allowedWalletIntents(effective, ["market.bid", "market.transferAll", "market.approve"]);
  assert.deepEqual(allowedIntents, ["market.bid"]);
  // And narrowing the verified plugin table by policy drops approve.
  const narrowed = narrowWalletOperations(DECLARED_PLUGIN_INTENTS, effective);
  assert.deepEqual(Object.keys(narrowed).sort(), ["market.bid"]);
});

test("ATTACK: tampering with frozen presentation data is bounded and rejected", () => {
  // Oversized weapon.build map (the classic unbounded-record injection).
  const build = {};
  for (let i = 0; i < 400; i += 1) build[`k${i}`] = "x";
  const tampered = {
    data: {
      protocol: "keel-viewer-verification@1",
      action: "presentation-state",
      presentation: "weapon",
      character: { tokenId: "1", seed: "s", appearance: "a" },
      weapon: {
        id: "w",
        name: "n",
        assetId: "a",
        build,
        projectileStyle: "p",
        combat: { longRangeMode: "m", cooldownMs: 1, projectileSpeed: 1, count: 1, spread: 0 },
      },
    },
    origin: "null",
    source: APP_FRAME,
  };
  const result = validateKeelPresentationMessage(tampered, APP_FRAME);
  assert.equal(result.ok, false);
});

test("ATTACK: an undeclared presentation action is rejected", () => {
  const result = validateKeelPresentationMessage(
    { data: { protocol: "keel-viewer-verification@1", action: "exfiltrate" }, origin: "null", source: APP_FRAME },
    APP_FRAME,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "unknown-operation");
});
