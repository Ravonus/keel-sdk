#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildVaultKeelViewer } from "../../../apps/studio/scripts/vault-keel-viewer-bundle.ts";

const packageRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const demoRoot = path.join(repositoryRoot, "examples/demos/vault-arcade/generated-attribute-proxy");
const outputDirectory = path.resolve(
  process.env.KEEL_ONCHFS_FIXTURE_DIRECTORY
    ?? path.join(packageRoot, "build/keel-onchfs-live-v1/input"),
);

// Tezos changes only the carrier/read adapter. The browser entrypoint is the
// exact Vault character viewer used by Ethereum: same HTML, verifier, game
// runtime, assets, and interaction code, built from the same source function.
const shell = await buildVaultKeelViewer(demoRoot);
await mkdir(outputDirectory, { recursive: true });
await writeFile(path.join(outputDirectory, "index.html"), shell);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
process.stdout.write(`${JSON.stringify({
  outputDirectory,
  files: [{ name: "index.html", byteLength: shell.byteLength, sha256: sha256(shell) }],
  verificationShell: {
    builder: "buildVaultKeelViewer",
    canonicalSources: [
      "vault-keel-viewer.html",
      "vault-keel-viewer.js",
      "vault-verification.js",
    ],
    digest: `0x${sha256(shell)}`,
  },
})}\n`);
