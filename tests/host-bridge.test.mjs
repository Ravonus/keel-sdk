import test from "node:test";
import assert from "node:assert/strict";
import {
  createHostBridge,
  receiveMessageEvent,
  validateInboundMessage,
} from "../packages/viewer/dist/index.js";

// A policy that models the two existing artifact->host bridges under one
// declarative contract: the market wallet-intent protocol (session + operation
// key `intentId`) and the presentation protocol (operation key `action`).
function marketPolicy() {
  return {
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
                fields: {
                  priceEth: { type: "string", maxLength: 80 },
                  bidder: { type: "string", maxLength: 42, optional: true },
                },
              },
            },
          },
        },
      },
      {
        protocol: "keel-viewer-verification@1",
        operationKey: "action",
        operations: {
          "presentation-state": {
            fields: {
              presentation: { type: "enum", values: ["character", "weapon"] },
              build: { type: "string-map", maxEntries: 16, maxKeyLength: 32, maxValueLength: 64, optional: true },
            },
          },
        },
      },
    ],
  };
}

const SESSION = `0x${"ab".repeat(32)}`;

function validIntent(overrides = {}) {
  return {
    protocol: "keel-wallet-intent@1",
    intentId: "market.bid",
    session: SESSION,
    sequence: 1,
    proposal: { priceEth: "0.05", bidder: "" },
    ...overrides,
  };
}

// Helper: a bridge with the market session pre-registered and a frame window.
function connectedBridge() {
  const bridge = createHostBridge(marketPolicy());
  const frame = {};
  bridge.registerSession("keel-wallet-intent@1", SESSION);
  return { bridge, frame };
}

test("host bridge accepts a well-formed declared operation from the pinned opaque frame", () => {
  const { bridge, frame } = connectedBridge();
  const result = receiveMessageEvent(bridge, { data: validIntent(), origin: "null", source: frame }, frame);
  assert.equal(result.ok, true);
  assert.equal(result.protocol, "keel-wallet-intent@1");
  assert.equal(result.operation, "market.bid");
  assert.equal(result.session, SESSION);
  assert.equal(result.message.proposal.priceEth, "0.05");
});

test("host bridge requires an expected source under an opaque-origin policy", () => {
  const { bridge } = connectedBridge();
  // No expectedSource argument: must fail closed rather than trust any null frame.
  const result = bridge.accept({ data: validIntent(), origin: "null" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "bad-source");
});

test("host bridge rejects a message from the wrong source window", () => {
  const { bridge, frame } = connectedBridge();
  const result = bridge.accept({ data: validIntent(), origin: "null", source: {} }, frame);
  assert.equal(result.ok, false);
  assert.equal(result.code, "bad-source");
});

test("host bridge rejects a non-opaque origin under an opaque policy", () => {
  const frame = {};
  const result = validateInboundMessage(
    { data: validIntent(), origin: "https://evil.example", source: frame },
    marketPolicy(),
    frame,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "bad-origin");
});

test("host bridge treats a missing origin as a wiring bug, not a valid opaque origin", () => {
  const frame = {};
  const result = validateInboundMessage({ data: validIntent(), source: frame }, marketPolicy(), frame);
  assert.equal(result.ok, false);
  assert.equal(result.code, "bad-origin");
});

test("host bridge rejects an undeclared protocol and an undeclared operation", () => {
  const { bridge, frame } = connectedBridge();
  const badProtocol = bridge.accept({ data: { ...validIntent(), protocol: "evil@1" }, origin: "null", source: frame }, frame);
  assert.equal(badProtocol.ok, false);
  assert.equal(badProtocol.code, "unknown-protocol");

  const badOperation = bridge.accept({ data: validIntent({ intentId: "market.drain" }), origin: "null", source: frame }, frame);
  assert.equal(badOperation.ok, false);
  assert.equal(badOperation.code, "unknown-operation");
});

test("host bridge rejects extra top-level fields (no smuggled calldata)", () => {
  const { bridge, frame } = connectedBridge();
  const result = bridge.accept(
    { data: validIntent({ to: "0x0000000000000000000000000000000000000001", data: "0xdeadbeef" }), origin: "null", source: frame },
    frame,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "schema");
});

test("host bridge bounds the validation/forwarding cost of an oversize message", () => {
  const { bridge, frame } = connectedBridge();
  const huge = "0".repeat(20000);
  const result = bridge.accept(
    { data: validIntent({ proposal: { priceEth: huge, bidder: "" } }), origin: "null", source: frame },
    frame,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "oversize");
});

test("host bridge rejects prototype-pollution keys (__proto__, constructor, prototype)", () => {
  const { bridge, frame } = connectedBridge();
  for (const badKey of ["__proto__", "constructor", "prototype"]) {
    const polluted = JSON.parse(
      `{"protocol":"keel-wallet-intent@1","intentId":"market.bid","session":"${SESSION}","sequence":1,` +
        `"proposal":{"priceEth":"1","${badKey}":{"polluted":true}}}`,
    );
    const result = bridge.accept({ data: polluted, origin: "null", source: frame }, frame);
    assert.equal(result.ok, false, `expected rejection for ${badKey}`);
    assert.equal(result.code, "dangerous-key");
  }
});

test("host bridge rejects excessive nesting depth", () => {
  const bridge = createHostBridge({ ...marketPolicy(), maxDepth: 3 });
  const frame = {};
  let deep = { a: 1 };
  for (let i = 0; i < 12; i += 1) deep = { a: deep };
  const result = bridge.accept({ data: { protocol: "x", intentId: "y", nested: deep }, origin: "null", source: frame }, frame);
  assert.equal(result.ok, false);
  assert.equal(result.code, "too-deep");
});

test("host bridge rejects sequenced messages for an unregistered session", () => {
  const bridge = createHostBridge(marketPolicy());
  const frame = {};
  // No registerSession call.
  const result = bridge.accept({ data: validIntent(), origin: "null", source: frame }, frame);
  assert.equal(result.ok, false);
  assert.equal(result.code, "unknown-session");
});

test("host bridge enforces strictly increasing per-session sequence (replay defense)", () => {
  const { bridge, frame } = connectedBridge();
  const first = bridge.accept({ data: validIntent({ sequence: 5 }), origin: "null", source: frame }, frame);
  assert.equal(first.ok, true);

  const replay = bridge.accept({ data: validIntent({ sequence: 5 }), origin: "null", source: frame }, frame);
  assert.equal(replay.ok, false);
  assert.equal(replay.code, "replayed");

  const stale = bridge.accept({ data: validIntent({ sequence: 4 }), origin: "null", source: frame }, frame);
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "replayed");

  const advanced = bridge.accept({ data: validIntent({ sequence: 6 }), origin: "null", source: frame }, frame);
  assert.equal(advanced.ok, true);
});

test("host bridge replay floor survives session-table flooding (registration model)", () => {
  // Small capacity to make eviction trivial to trigger.
  const bridge = createHostBridge({ ...marketPolicy(), maxTrackedSessions: 4 });
  const frame = {};
  bridge.registerSession("keel-wallet-intent@1", SESSION);
  assert.equal(bridge.accept({ data: validIntent({ sequence: 100 }), origin: "null", source: frame }, frame).ok, true);

  // Attacker floods with many DISTINCT unregistered sessions. Each is rejected
  // as unknown-session and never enters the table, so it cannot evict the victim.
  for (let i = 0; i < 50; i += 1) {
    const junk = `0x${i.toString(16).padStart(64, "0")}`;
    const attack = bridge.accept(
      { data: validIntent({ session: junk, sequence: 1 }), origin: "null", source: frame },
      frame,
    );
    assert.equal(attack.ok, false);
    assert.equal(attack.code, "unknown-session");
  }

  // The victim floor is intact: replaying sequence 100 is still rejected.
  assert.equal(bridge.isSessionRegistered("keel-wallet-intent@1", SESSION), true);
  const replay = bridge.accept({ data: validIntent({ sequence: 100 }), origin: "null", source: frame }, frame);
  assert.equal(replay.ok, false);
  assert.equal(replay.code, "replayed");
});

test("host bridge rejects a malformed session value", () => {
  const bridge = createHostBridge(marketPolicy());
  const frame = {};
  bridge.registerSession("keel-wallet-intent@1", "not-a-valid-hex-session");
  const result = bridge.accept(
    { data: validIntent({ session: "not-a-valid-hex-session" }), origin: "null", source: frame },
    frame,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "schema");
});

test("host bridge rejects NaN / non-integer / negative sequence values", () => {
  const { bridge, frame } = connectedBridge();
  for (const bad of [Number.NaN, 1.5, -1, Number.POSITIVE_INFINITY]) {
    const result = bridge.accept({ data: validIntent({ sequence: bad }), origin: "null", source: frame }, frame);
    assert.equal(result.ok, false, `expected rejection for sequence ${bad}`);
    assert.equal(result.code, "schema");
  }
});

test("host bridge validates enum and string-map bounds for the presentation protocol", () => {
  const { bridge, frame } = connectedBridge();
  const ok = bridge.accept(
    {
      data: {
        protocol: "keel-viewer-verification@1",
        action: "presentation-state",
        presentation: "weapon",
        build: { barrel: "long", stock: "carbon" },
      },
      origin: "null",
      source: frame,
    },
    frame,
  );
  assert.equal(ok.ok, true);

  const badEnum = bridge.accept(
    { data: { protocol: "keel-viewer-verification@1", action: "presentation-state", presentation: "rocket" }, origin: "null", source: frame },
    frame,
  );
  assert.equal(badEnum.ok, false);
  assert.equal(badEnum.code, "schema");

  // 20 entries: under the bounded-scan key cap (32) so the schema-level
  // maxEntries (16) is the guard that fires, not the outer structural scan.
  const oversizedMap = {};
  for (let i = 0; i < 20; i += 1) oversizedMap[`k${i}`] = "v";
  const badMap = bridge.accept(
    {
      data: { protocol: "keel-viewer-verification@1", action: "presentation-state", presentation: "weapon", build: oversizedMap },
      origin: "null",
      source: frame,
    },
    frame,
  );
  assert.equal(badMap.ok, false);
  assert.equal(badMap.code, "schema");
});

test("host bridge string pattern is a pure function even for a stateful (global) regex", () => {
  const frame = {};
  const policy = {
    maxBytes: 1024,
    origin: { kind: "opaque" },
    protocols: [
      {
        protocol: "p@1",
        operationKey: "op",
        operations: { go: { fields: { token: { type: "string", maxLength: 16, pattern: /[a-z]+/gu } } } },
      },
    ],
  };
  const bridge = createHostBridge(policy);
  // Same input several times: a stateful lastIndex would flip pass/fail.
  for (let i = 0; i < 5; i += 1) {
    const result = bridge.accept({ data: { protocol: "p@1", op: "go", token: "abc" }, origin: "null", source: frame }, frame);
    assert.equal(result.ok, true, `iteration ${i} should pass deterministically`);
  }
});

test("host bridge rejects non-plain object payloads", () => {
  const { bridge, frame } = connectedBridge();
  const result = bridge.accept({ data: new Map([["protocol", "x"]]), origin: "null", source: frame }, frame);
  assert.equal(result.ok, false);
  assert.equal(result.code, "schema");
});

test("host bridge result is assembled on a null-prototype map", () => {
  const { bridge, frame } = connectedBridge();
  const result = bridge.accept({ data: validIntent(), origin: "null", source: frame }, frame);
  assert.equal(result.ok, true);
  assert.equal(Object.getPrototypeOf(result.message), null);
});

test("host bridge with an 'any' origin policy does not require a source", () => {
  const policy = { ...marketPolicy(), origin: { kind: "any" } };
  const bridge = createHostBridge(policy);
  bridge.registerSession("keel-wallet-intent@1", SESSION);
  const result = bridge.accept({ data: validIntent(), origin: "https://host.example" });
  assert.equal(result.ok, true);
});
