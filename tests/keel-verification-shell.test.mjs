import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureScript = path.join(repositoryRoot, "packages/tezos/scripts/build-keel-onchfs-live-fixture.mjs");
const demoRoot = path.join(repositoryRoot, "examples/demos/vault-arcade/generated-attribute-proxy");

async function buildFixture(outputDirectory) {
  const { stdout } = await execFileAsync(process.execPath, [fixtureScript], {
    cwd: repositoryRoot,
    env: { ...process.env, KEEL_ONCHFS_FIXTURE_DIRECTORY: outputDirectory },
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

test("Ethereum and Tezos use the exact existing Vault character verification shell", async (t) => {
  const [ethereumBuilder, tezosBuilder, bundleBuilder] = await Promise.all([
    readFile(path.join(repositoryRoot, "apps/studio/scripts/deploy-vault-keel-sepolia.ts"), "utf8"),
    readFile(fixtureScript, "utf8"),
    readFile(path.join(repositoryRoot, "apps/studio/scripts/vault-keel-viewer-bundle.ts"), "utf8"),
  ]);
  assert.match(ethereumBuilder, /buildVaultKeelViewer\s*\(/u);
  assert.match(tezosBuilder, /buildVaultKeelViewer\s*\(/u);
  assert.doesNotMatch(tezosBuilder, /buildStandaloneKeelViewer|keel-verifier-runtime/u);
  for (const source of ["vault-keel-viewer.html", "vault-keel-viewer.js", "vault-verification.js"]) {
    assert.match(bundleBuilder, new RegExp(source.replaceAll(".", "\\."), "u"));
    assert.match(tezosBuilder, new RegExp(source.replaceAll(".", "\\."), "u"));
  }

  const first = await mkdtemp(path.join(os.tmpdir(), "vault-shell-tezos-a-"));
  const second = await mkdtemp(path.join(os.tmpdir(), "vault-shell-tezos-b-"));
  t.after(async () => Promise.all([
    rm(first, { recursive: true, force: true }),
    rm(second, { recursive: true, force: true }),
  ]));
  const [firstReceipt, secondReceipt] = await Promise.all([buildFixture(first), buildFixture(second)]);
  const [firstBytes, secondBytes] = await Promise.all([
    readFile(path.join(first, "index.html")),
    readFile(path.join(second, "index.html")),
  ]);
  const { buildVaultKeelViewer } = await import("../apps/studio/scripts/vault-keel-viewer-bundle.ts");
  const canonicalBytes = await buildVaultKeelViewer(demoRoot);

  assert.deepEqual(firstBytes, secondBytes, "same sources must produce byte-identical Tezos carrier files");
  assert.ok(firstBytes.equals(Buffer.from(canonicalBytes)), "Tezos must carry the exact Ethereum Vault shell bytes");
  assert.deepEqual(firstReceipt.files, secondReceipt.files);
  assert.equal(firstReceipt.verificationShell.builder, "buildVaultKeelViewer");

  const shell = firstBytes.toString("utf8");
  assert.match(shell, /data-vault-surface="character-viewer"/u);
  assert.match(shell, /id="vault-character"/u);
  assert.match(shell, /id="verify-seal"/u);
  assert.match(shell, /data-verify-intent-zone="bottom-left"/u);
  assert.match(shell, /data-keel-seal="stamp"/u);
  assert.match(shell, /tabindex="-1" aria-hidden="true"/u);
  assert.match(shell, /\.verify-corner\{left:0!important;right:auto!important;bottom:0!important/u);
  assert.match(shell, /\.verify-corner \.seal-mark::before\{content:attr\(data-keel-seal-glyph\)/u);
  assert.match(shell, /visibility:hidden;pointer-events:none/u);
  assert.match(shell, /keel-verification-presentation@1/u);
  assert.match(shell, /"revision":2/u);
  assert.match(shell, /"motion":"slide"/u);
  assert.match(shell, /data-keel-seal-motion=slide/u);
  assert.match(shell, /translateX\(calc\(-1 \* \(var\(--keel-seal-size,40px\) \+ 32px\)\)\)/u);
  assert.match(shell, /var\(--keel-seal-fade-in,420ms\)/u);
  assert.match(shell, /var\(--keel-seal-fade-out,900ms\)/u);
  assert.match(shell, /verify-page-nav/u);
  assert.match(shell, /corner\.addEventListener\("pointerenter",\s*revealCorner\)/u);
  assert.match(shell, /corner\.addEventListener\("pointerdown",\s*revealCorner\)/u);
  assert.doesNotMatch(shell, /right:8px!important/u);
  assert.match(shell, /id="verify-panel"/u);
  assert.match(shell, /id="verify-details"/u);
  assert.match(shell, /Keel object trail/u);
  assert.match(shell, /evaluateVaultVerification/u);
  assert.match(shell, /__VAULT_VERIFICATION_UI__/u);
  assert.match(shell, /new URLSearchParams\(location\.search\)/u);
  assert.doesNotMatch(shell, /id="keel-proof-toggle"|Keel verification shell/u);
});

test("the shared EVM and Tezos shell accepts a versioned presentation manifest without changing verifier logic", async () => {
  const { buildEmbeddedKeelViewerShell } = await import("../apps/studio/scripts/keel-viewer-builder.ts");
  const custom = await buildEmbeddedKeelViewerShell({
    repositoryRoot,
    verificationPresentation: {
      revision: 7,
      seal: { glyph: "V", shape: "shield", motion: "rise", color: "#ffcc66", sizePx: 52, fadeInMs: 250, holdMs: 400, fadeOutMs: 700 },
      overlay: { placement: "right", width: "compact", navigation: "stepper", initialPage: "custom" },
      theme: {
        accent: "#ffcc66",
        surface: "#10131f",
        text: "#f4f0df",
        muted: "#989386",
        radiusPx: 12,
        cssResource: { id: "verification-theme-css", digest: `0x${"ab".repeat(32)}`, byteLength: 128 },
      },
      pages: [{
        id: "custom",
        label: "Custom",
        layout: "grid",
        columns: 2,
        panels: [
          { id: "custom-trail", type: "object-trail", title: "Object lineage", span: 2 },
          { id: "custom-checks", type: "checks", title: "Byte checks", span: 1 },
          { id: "custom-identity", type: "identity", title: "Binding", span: 1 },
        ],
      }],
    },
  });
  const prefix = Buffer.from(custom.prefix).toString("utf8");
  const shell = `${prefix}${Buffer.from(custom.suffix).toString("utf8")}`;
  assert.match(prefix, /"revision":7/u);
  assert.match(prefix, /"glyph":"V"/u);
  assert.match(prefix, /"shape":"shield"/u);
  assert.match(prefix, /"motion":"rise"/u);
  assert.match(prefix, /"placement":"right"/u);
  assert.match(prefix, /"type":"object-trail"/u);
  assert.match(prefix, /"cssResource":\{"byteLength":128,"digest":"0xabab/u);
  assert.match(shell, /The verification presentation CSS commitment does not match a verified Keel item/u);
  assert.match(shell, /Verification presentation CSS cannot perform external requests/u);
});

test("the existing Vault shell fails closed and refuses unsupported verifier receipts", async () => {
  const [viewer, verification, tezosRuntime] = await Promise.all([
    readFile(path.join(demoRoot, "vault-keel-viewer.js"), "utf8"),
    readFile(path.join(demoRoot, "vault-verification.js"), "utf8"),
    readFile(path.join(repositoryRoot, "packages/tezos/viewer/runtime.js"), "utf8"),
  ]);
  assert.match(viewer, /did not enable a supported Keel verifier API/u);
  assert.match(viewer, /no verifier receipt is being claimed/u);
  assert.match(viewer, /globalThis\.__VAULT_VERIFICATION_UI__\?\.fail/u);
  assert.match(verification, /state: "failed"/u);
  assert.match(verification, /Rejected proof/u);
  assert.match(tezosRuntime, /Verification not enabled for contract controls/u);
  assert.match(tezosRuntime, /no verifier receipt claimed/u);
});

test("the standalone verifier wraps headless entrypoints before injection", async () => {
  const runtime = await readFile(path.join(repositoryRoot, "examples/demos/keel-creative-lab/keel-verifier-runtime.js"), "utf8");
  assert.match(runtime, /A verified entrypoint may be a fragment/u);
  assert.match(runtime, /<!doctype html><html><head><meta charset="utf-8"><meta name="viewport"/u);
  assert.match(runtime, /<body>\$\{html\}<\/body><\/html>/u);
});
