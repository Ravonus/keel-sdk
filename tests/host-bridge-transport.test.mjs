import test from "node:test";
import assert from "node:assert/strict";
import { createHostBridge, receiveMessageEvent, validateInboundMessage } from "../packages/viewer/dist/index.js";

// A protocol with a numeric field and no session, to exercise origin policies
// and the number validator independently of the wallet/session machinery.
function policy(origin) {
  return {
    maxBytes: 2048,
    origin,
    protocols: [
      {
        protocol: "host.command@1",
        operationKey: "op",
        operations: {
          zoom: {
            fields: {
              level: { type: "number", min: 0, max: 10, optional: false },
              steps: { type: "number", min: 1, max: 100, integer: true, optional: true },
              flag: { type: "boolean", optional: true },
            },
          },
        },
      },
    ],
  };
}

function zoom(overrides = {}) {
  return { protocol: "host.command@1", op: "zoom", level: 3, ...overrides };
}

test("same-origin policy accepts the exact origin and rejects others", () => {
  const p = policy({ kind: "same-origin", origin: "https://gallery.example" });
  const ok = validateInboundMessage({ data: zoom(), origin: "https://gallery.example" }, p);
  assert.equal(ok.ok, true);
  const bad = validateInboundMessage({ data: zoom(), origin: "https://evil.example" }, p);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "bad-origin");
});

test("allowlist policy accepts listed origins only", () => {
  const p = policy({ kind: "allowlist", origins: ["https://a.example", "https://b.example"] });
  assert.equal(validateInboundMessage({ data: zoom(), origin: "https://b.example" }, p).ok, true);
  const bad = validateInboundMessage({ data: zoom(), origin: "https://c.example" }, p);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "bad-origin");
});

test("any-origin policy does not require a source and ignores origin", () => {
  const p = policy({ kind: "any" });
  assert.equal(validateInboundMessage({ data: zoom(), origin: "https://whatever" }, p).ok, true);
  assert.equal(validateInboundMessage({ data: zoom() }, p).ok, true);
});

test("number validator enforces range and integer constraints", () => {
  const p = policy({ kind: "any" });
  assert.equal(validateInboundMessage({ data: zoom({ level: 11 }) }, p).code, "schema"); // > max
  assert.equal(validateInboundMessage({ data: zoom({ level: -1 }) }, p).code, "schema"); // < min
  assert.equal(validateInboundMessage({ data: zoom({ steps: 2.5 }) }, p).code, "schema"); // not integer
  assert.equal(validateInboundMessage({ data: zoom({ steps: 5 }) }, p).ok, true); // integer in range
  assert.equal(validateInboundMessage({ data: zoom({ level: "3" }) }, p).code, "schema"); // wrong type
});

test("optional fields may be omitted but a required field cannot", () => {
  const p = policy({ kind: "any" });
  assert.equal(validateInboundMessage({ data: { protocol: "host.command@1", op: "zoom", level: 1 } }, p).ok, true);
  const missing = validateInboundMessage({ data: { protocol: "host.command@1", op: "zoom" } }, p);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "schema");
});

test("session lifecycle: register, accept, forget, re-reject", () => {
  const bridge = createHostBridge({
    maxBytes: 2048,
    origin: { kind: "any" },
    protocols: [
      { protocol: "s@1", operationKey: "op", sessionKey: "session", sequenceKey: "seq", operations: { go: { fields: {} } } },
    ],
  });
  const session = "0xdeadbeef";
  const msg = (seq) => ({ data: { protocol: "s@1", op: "go", session, seq } });

  assert.equal(bridge.accept(msg(1)).code, "unknown-session"); // not registered yet
  assert.equal(bridge.isSessionRegistered("s@1", session), false);
  bridge.registerSession("s@1", session);
  assert.equal(bridge.isSessionRegistered("s@1", session), true);
  assert.equal(bridge.accept(msg(1)).ok, true);
  assert.equal(bridge.accept(msg(1)).code, "replayed");
  bridge.forgetSession("s@1", session);
  assert.equal(bridge.isSessionRegistered("s@1", session), false);
  assert.equal(bridge.accept(msg(2)).code, "unknown-session"); // forgotten
});

test("distinct sessions keep independent sequence floors", () => {
  const bridge = createHostBridge({
    maxBytes: 2048,
    origin: { kind: "any" },
    protocols: [
      { protocol: "s@1", operationKey: "op", sessionKey: "session", sequenceKey: "seq", operations: { go: { fields: {} } } },
    ],
  });
  bridge.registerSession("s@1", "0xaaaa");
  bridge.registerSession("s@1", "0xbbbb");
  assert.equal(bridge.accept({ data: { protocol: "s@1", op: "go", session: "0xaaaa", seq: 5 } }).ok, true);
  // A high sequence on session A does not affect session B's independent floor.
  assert.equal(bridge.accept({ data: { protocol: "s@1", op: "go", session: "0xbbbb", seq: 1 } }).ok, true);
  assert.equal(bridge.accept({ data: { protocol: "s@1", op: "go", session: "0xbbbb", seq: 1 } }).code, "replayed");
});

test("receiveMessageEvent adapts a MessageEvent-shaped object", () => {
  const bridge = createHostBridge(policy({ kind: "opaque" }));
  const frame = {};
  const result = receiveMessageEvent(bridge, { data: zoom(), origin: "null", source: frame }, frame);
  assert.equal(result.ok, true);
  assert.equal(result.operation, "zoom");
});
