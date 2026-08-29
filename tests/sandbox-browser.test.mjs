import test from "node:test";
import assert from "node:assert/strict";

import { prepareBrowserSandboxProject } from "../packages/sandbox-sdk/dist/browser.js";

const text = (value) => new TextEncoder().encode(value);

test("browser sandbox prepares HTML entirely in memory through the production viewer", async () => {
  const result = await prepareBrowserSandboxProject({
    id: "local-html",
    name: "Local HTML",
    files: [{ path: "index.html", bytes: text('<h1>Hello</h1><script>fetch("https://undeclared.invalid/file")</script>') }],
  });

  assert.equal(result.report.valid, true);
  assert.match(result.manifestIntegrity.digest, /^0x[0-9a-f]{64}$/u);
  assert.match(result.sandbox.csp, /connect-src blob:/u);
  assert.doesNotMatch(result.sandbox.csp, /connect-src 'none' blob:/u);
  assert.equal(result.sandbox.sandboxTokens.includes("allow-same-origin"), false);
  assert.equal(result.manifest.extensions?.sandbox?.persistence, "none");
  assert.equal(result.manifest.extensions?.sandbox?.networkWrites, false);
});

test("browser sandbox uses the same viewer for direct image media", async () => {
  const result = await prepareBrowserSandboxProject({
    id: "local-image",
    name: "Local image",
    files: [{ path: "art.png", mediaType: "image/png", bytes: new Uint8Array([137, 80, 78, 71]) }],
  });

  assert.equal(result.report.valid, true);
  assert.equal(result.manifest.entrypoint.mode, "image");
  assert.match(result.sandbox.html, /<img /u);
});

test("browser sandbox wraps generic WASM in a denied-by-default local verifier", async () => {
  const result = await prepareBrowserSandboxProject({
    id: "local-wasm",
    name: "Local WASM",
    files: [{ path: "art.wasm", mediaType: "application/wasm", bytes: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]) }],
  });

  assert.equal(result.report.valid, true);
  assert.equal(result.manifest.resources.length, 2);
  assert.equal(result.manifest.runtime.capabilities.webAssembly, true);
  assert.match(result.sandbox.csp, /'wasm-unsafe-eval'/u);
  assert.match(result.sandbox.html, /WASM verified locally/u);
});

test("browser sandbox rejects traversal and duplicate virtual paths", async () => {
  await assert.rejects(() => prepareBrowserSandboxProject({
    id: "bad-path",
    name: "Bad path",
    files: [{ path: "../secret.html", bytes: text("no") }],
  }), /Unsafe sandbox path/u);
  await assert.rejects(() => prepareBrowserSandboxProject({
    id: "duplicate-path",
    name: "Duplicate path",
    files: [{ path: "index.html", bytes: text("one") }, { path: "./index.html", bytes: text("two") }],
  }), /Duplicate sandbox path/u);
});
