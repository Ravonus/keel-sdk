import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createIntegrity, utf8ToBytes } from "../packages/protocol/dist/index.js";
import { verifyKeelPublishReviewPlan, wrapInVerificationShell } from "../packages/sdk/dist/index.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

test("wrapInVerificationShell wraps an art entry in the canonical shell with a review-only plan", async () => {
  const assetBytes = utf8ToBytes("export const palette = [\"#05060b\", \"#d7ff63\"];\n");
  const result = await wrapInVerificationShell({
    repositoryRoot,
    title: "Wrap Smoke Piece",
    entry: {
      mediaType: "text/html",
      source: "<!doctype html><html><body><canvas id=\"c\"></canvas><script type=\"module\">import { palette } from \"/content/palette.js\"; document.title = palette.length;</script></body></html>",
    },
    assets: [{ id: "palette", mediaType: "text/javascript", aliases: ["/content/palette.js"], bytes: assetBytes }],
  });

  // The shell chrome and the verifier runtime are in the wrapped document.
  assert.match(result.html, /id="verify-seal"/u);
  assert.match(result.html, /data-keel-seal="stamp"/u);
  assert.match(result.html, /keel-verification-presentation@1/u);
  assert.match(result.html, /id="keel-verification-envelope"/u);
  assert.match(result.html, /VERIFYING KEEL GRAPH/u);
  // No CDN or network escape hatch: assets are committed inline in the graph.
  assert.doesNotMatch(result.html, /https:\/\/cdn\./u);

  // The envelope commits the entry and every asset with content addresses.
  assert.equal(result.envelope.deliveryProfile, "embedded-assembled");
  assert.equal(result.envelope.entrypoint, "entry");
  assert.equal(result.envelope.items.length, 2);
  const asset = result.envelope.items.find((item) => item.id === "palette");
  assert.deepEqual(asset.aliases, ["/content/palette.js"]);
  assert.equal(asset.integrity.digest, (await createIntegrity(assetBytes)).digest);
  assert.equal(asset.role, "module");

  // The returned HTML is exactly what the integrity and the plan commit to.
  const htmlIntegrity = await createIntegrity(utf8ToBytes(result.html));
  assert.equal(result.htmlIntegrity.digest, htmlIntegrity.digest);
  assert.equal(result.sourceReceipt.disposition, "reproducible-build");
  assert.equal(result.sourceReceipt.output.digest, htmlIntegrity.digest);

  // The publish plan is canonical, review-only, and bound to those bytes.
  const verdict = await verifyKeelPublishReviewPlan(result.publishPlan);
  assert.equal(verdict.valid, true, verdict.issues.join("; "));
  assert.equal(result.publishPlan.plan.status, "review-only");
  assert.equal(result.publishPlan.plan.signing, "not-performed");
  assert.equal(result.publishPlan.plan.submission, "not-performed");
  assert.equal(result.publishPlan.plan.source.mediaType, "text/html");
  assert.equal(result.publishPlan.plan.source.integrity.digest, htmlIntegrity.digest);
  assert.equal(result.publishPlan.plan.source.objectName, "wrap-smoke-piece.html");
  const weld = result.publishPlan.plan.operations.at(-1).descriptor;
  assert.equal(weld.compression, "brotli");
  assert.equal(weld.digest.digest, htmlIntegrity.digest);
  const compressedIntegrity = await createIntegrity(result.compressedHtml);
  const storedBytes = result.publishPlan.plan.operations
    .filter((operation) => operation.kind === "castSlugs")
    .flatMap((operation) => operation.descriptor.chunkByteLengths)
    .reduce((total, length) => total + length, 0);
  assert.equal(storedBytes, compressedIntegrity.byteLength);

  await assert.rejects(
    () => wrapInVerificationShell({
      repositoryRoot,
      title: "Duplicate ids",
      entry: { id: "palette", mediaType: "text/html", source: "<!doctype html><p>x</p>" },
      assets: [{ id: "palette", mediaType: "text/javascript", bytes: assetBytes }],
    }),
    /Duplicate item id/u,
  );
});

test("the studio viewer builder script and the SDK share one shell implementation", async () => {
  const studio = await import("../apps/studio/scripts/keel-viewer-builder.ts");
  const sdk = await import("../packages/sdk/dist/index.js");
  assert.equal(studio.buildStandaloneKeelViewer, sdk.buildStandaloneKeelViewer);
  assert.equal(studio.buildEmbeddedKeelViewerShell, sdk.buildEmbeddedKeelViewerShell);
  assert.equal(studio.buildEmbeddedKeelViewerSlot, sdk.buildEmbeddedKeelViewerSlot);
  assert.equal(studio.wrapInVerificationShell, sdk.wrapInVerificationShell);
});
