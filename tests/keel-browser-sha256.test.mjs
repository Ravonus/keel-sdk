import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import test from "node:test";

import { browserSha256, sha256Fallback } from "../examples/demos/keel-creative-lab/sha256.js";

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const expected = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("opaque-document SHA-256 fallback matches standard vectors and boundary sizes", () => {
  for (const bytes of [
    new Uint8Array(),
    new TextEncoder().encode("abc"),
    new TextEncoder().encode("p5 · seed 🌊 </script>"),
    Uint8Array.from({ length: 55 }, (_, index) => index),
    Uint8Array.from({ length: 56 }, (_, index) => index),
    Uint8Array.from({ length: 64 }, (_, index) => index),
    Uint8Array.from({ length: 1_116_814 }, (_, index) => index % 251),
  ]) {
    assert.equal(hex(sha256Fallback(bytes)), expected(bytes));
  }
});

test("browser SHA-256 keeps WebCrypto behavior when a secure context provides it", async () => {
  const original = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
  try {
    const bytes = new TextEncoder().encode("keel verifier");
    assert.equal(hex(await browserSha256(bytes)), expected(bytes));
  } finally {
    Object.defineProperty(globalThis, "crypto", { value: original, configurable: true });
  }
});

test("browser SHA-256 falls back when an opaque data document has no subtle crypto", async () => {
  const original = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
  try {
    const bytes = new TextEncoder().encode("opaque data:text/html");
    assert.equal(hex(await browserSha256(bytes)), expected(bytes));
  } finally {
    Object.defineProperty(globalThis, "crypto", { value: original, configurable: true });
  }
});
