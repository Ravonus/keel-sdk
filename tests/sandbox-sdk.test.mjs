import test from "node:test";
import assert from "node:assert/strict";

import { prepareSandboxProject } from "../packages/sandbox-sdk/dist/index.js";

test("sandbox SDK prepares, resolves, and isolates a labelled project with the production viewer", async () => {
  const result = await prepareSandboxProject({
    id: "sdk-project",
    name: "SDK Project",
    files: [
      {
        path: "index.html",
        bytes: new TextEncoder().encode('<main id="app">SDK</main><script src="/content/renderer.js"></script>'),
        mediaType: "text/html",
        component: {
          label: "Collector entrypoint",
          role: "entrypoint",
          format: "asset",
          updates: { mode: "locked" },
        },
      },
      {
        path: "renderer.js",
        bytes: new TextEncoder().encode("globalThis.rendered = true;"),
        mediaType: "text/javascript",
        component: {
          label: "Rendering script",
          role: "renderer",
          format: "classic-script",
          updates: { mode: "manual" },
        },
      },
    ],
  });
  assert.equal(result.report.valid, true);
  assert.equal(result.report.summary.components, 2);
  assert.equal(result.report.summary.locked, 1);
  assert.deepEqual(result.report.componentCommitments.map((entry) => entry.componentId), ["index.html", "renderer.js"]);
  assert.ok(result.report.componentCommitments.every((entry) => entry.commitment.algorithm === "sha256"));
  assert.equal(result.audit.resolvedResources, 2);
  assert.match(result.sandbox.csp, /connect-src blob:/);
  assert.doesNotMatch(result.sandbox.csp, /connect-src 'none' blob:/);
  assert.match(result.sandbox.html, /__KEEL_CONTENT__/);
  assert.equal(result.prepared.manifest.stack.components[1].label, "Rendering script");
});

test("sandbox SDK tells a creator when CommonJS needs a deterministic browser build", async () => {
  const result = await prepareSandboxProject({
    id: "commonjs-project",
    name: "CommonJS Project",
    files: [{
      path: "helper.cjs",
      bytes: new TextEncoder().encode("module.exports = { frame: 1 };"),
      mediaType: "text/javascript",
      component: {
        label: "Frame helper",
        role: "module",
        format: "commonjs",
        updates: { mode: "manual" },
      },
    }],
  });
  assert.equal(result.report.valid, true);
  assert.ok(result.report.diagnostics.some((diagnostic) => diagnostic.code === "module.commonjs-build"));
  assert.ok(result.report.diagnostics.some((diagnostic) => diagnostic.code === "fallback.non-image"));
});
