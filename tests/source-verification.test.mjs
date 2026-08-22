import assert from "node:assert/strict";
import test from "node:test";

import { analyzeSourceReadability, createSourceReceipt, verifySourceBuild } from "@keel/protocol";

const bytes = (value) => new TextEncoder().encode(value);

test("source analyzer deterministically separates readable and minified layouts", async () => {
  const readable = `// Palette helper\nexport function colorFor(index) {\n  const colors = ["#fff", "#000"];\n  return colors[index % colors.length];\n}\n`;
  const minified = `const ${Array.from({ length: 220 }, (_, index) => `a${index}=(${index}+1)`).join(",")};export{a0};`;
  const readableReport = analyzeSourceReadability(readable, "text/javascript");
  const minifiedReport = analyzeSourceReadability(minified, "text/javascript");
  assert.equal(readableReport.classification, "readable");
  assert.equal(minifiedReport.classification, "minified");
  assert.ok(readableReport.readabilityScore > minifiedReport.readabilityScore);
  assert.deepEqual(analyzeSourceReadability(readable, "text/javascript"), readableReport);
});

test("encoded dynamic code is queued as potentially obfuscated", () => {
  const encoded = "A".repeat(400);
  const report = analyzeSourceReadability(`const payload="${encoded}";eval(atob(payload));`, "application/javascript");
  assert.equal(report.classification, "potentially-obfuscated");
  assert.ok(report.reasons.some((reason) => reason.includes("Dynamic code")));
});

test("source receipts bind readable source, output, report, and build recipe", async () => {
  const source = bytes("export const answer = 40 + 2;\n");
  const exact = await createSourceReceipt({ sourceBytes: source, outputBytes: source, mediaType: "text/javascript" });
  assert.equal(exact.disposition, "exact-source-output");
  assert.equal(exact.source.digest, exact.output.digest);
  await assert.rejects(
    () => createSourceReceipt({ sourceBytes: source, outputBytes: bytes("export const answer=42;"), mediaType: "text/javascript" }),
    /build recipe/,
  );
  const queued = await createSourceReceipt({
    sourceBytes: source,
    outputBytes: bytes("export const answer=42;"),
    mediaType: "text/javascript",
    buildRecipeDigest: `0x${"11".repeat(32)}`,
  });
  assert.equal(queued.disposition, "queued");
});

test("source verifier distinguishes reproducible builds from mismatched submissions", async () => {
  const source = bytes("export const answer = 40 + 2;\n");
  const output = bytes("export const answer=42;");
  const verified = await verifySourceBuild({
    sourceBytes: source,
    outputBytes: output,
    rebuiltOutputBytes: output,
    mediaType: "text/javascript",
    buildRecipeDigest: `0x${"22".repeat(32)}`,
    verifier: { name: "keel-test-builder", version: "1.0.0" },
  });
  assert.equal(verified.disposition, "reproducible-build");
  assert.equal(verified.verification.rebuiltOutput.digest, verified.output.digest);
  await assert.rejects(
    () => verifySourceBuild({
      sourceBytes: source,
      outputBytes: output,
      rebuiltOutputBytes: bytes("export const answer=41;"),
      mediaType: "text/javascript",
      buildRecipeDigest: `0x${"22".repeat(32)}`,
      verifier: { name: "keel-test-builder", version: "1.0.0" },
    }),
    /does not match/,
  );
});
