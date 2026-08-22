import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OCA_CANONICALIZATION,
  OCA_CONTENT_GATEWAY_PROTOCOL,
  OCA_MANIFEST_SCHEMA,
  KEEL_RUNTIME_PROTOCOL,
  KEEL_VIEWER_PROTOCOL,
  createIntegrity,
  manifestIntegrity,
} from "../../packages/protocol/dist/index.js";

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), "release");
const names = {
  viewer: "original-preserved.viewer.html",
  preview: "original-preserved.preview.webp",
  original: "original-preserved.original.svg",
};

async function resource(id, role, mediaType, originalName, executable = false) {
  const bytes = new Uint8Array(await readFile(path.join(directory, names[id])));
  return {
    id,
    role,
    mediaType,
    executable,
    originalName,
    aliases: [`/content/${id}`],
    sources: [{ kind: "uri", uri: `./${names[id]}`, integrity: await createIntegrity(bytes) }],
  };
}

const resources = await Promise.all([
  resource("viewer", "entrypoint", "text/html", names.viewer, true),
  resource("preview", "preview", "image/webp", names.preview),
  resource("original", "original", "image/svg+xml", "source.svg"),
]);
const originalIntegrity = resources[2].sources[0].integrity;
const byteLengths = resources.map((entry) => entry.sources[0].integrity.byteLength ?? 0);
const createdAt = "2026-08-07T22:04:43.049Z";
const manifest = {
  schema: OCA_MANIFEST_SCHEMA,
  canonicalization: OCA_CANONICALIZATION,
  id: "original-preserved",
  name: "Original Preserved",
  description: "WebP display with exact SVG original download",
  entrypoint: { resource: "viewer", mode: "html" },
  resources,
  fallback: { image: "preview", animation: "viewer", backgroundColor: "#09090b" },
  runtime: {
    engine: {
      protocol: KEEL_RUNTIME_PROTOCOL,
      viewerProtocol: KEEL_VIEWER_PROTOCOL,
      renderer: "browser",
    },
    determinism: {
      mode: "replay",
      seed: originalIntegrity.digest,
      randomAlgorithm: "xoshiro128ss",
      viewport: { width: 1024, height: 1024, devicePixelRatio: 1 },
      clock: { mode: "fixed", epochMs: Date.parse(createdAt) },
      locale: "en-US",
      timezone: "UTC",
    },
    content: {
      protocol: OCA_CONTENT_GATEWAY_PROTOCOL,
      mode: "verified-only",
      externalSources: "host-verified",
      manifestTrust: "digest",
      blockUndeclared: true,
      resourcePathPrefix: "/content/",
      onchainPathPrefix: "/onchain/",
      ipfsPathPrefix: "/ipfs/",
    },
    sandbox: "strict",
    capabilities: { downloads: true },
    maxResourceBytes: Math.max(...byteLengths) + 1024,
    maxTotalBytes: byteLengths.reduce((sum, value) => sum + value, 0) + 4096,
    maxRecursionDepth: 8,
    maxResources: 16,
    timeoutMs: 15_000,
  },
  revision: { number: 1, compatibility: { min: 1, max: 1 }, policy: "creator" },
  provenance: { createdAt, creator: "Ravonus", sourceRepository: "oca-modern" },
  downloads: [{ resource: "original", label: "Download original", filename: "source.svg" }],
  extensions: {
    "oca:derived": {
      preview: "WebP",
      originalPreserved: true,
      sourceMode: "files",
      canonicalization: OCA_CANONICALIZATION,
    },
  },
};
const integrity = await manifestIntegrity(manifest);
await writeFile(path.join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(
  path.join(directory, "manifest.integrity.json"),
  `${JSON.stringify({ schema: "oca-manifest-integrity@2", manifest: "manifest.json", canonicalization: OCA_CANONICALIZATION, integrity }, null, 2)}\n`,
);
console.log(path.join(directory, "manifest.json"));
