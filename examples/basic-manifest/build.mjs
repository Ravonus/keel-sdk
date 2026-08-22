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
  encodeBase64,
  manifestIntegrity,
} from "../../packages/protocol/dist/index.js";

const directory = path.dirname(fileURLToPath(import.meta.url));

async function resource(id, role, mediaType, filename, executable = false) {
  const bytes = new Uint8Array(await readFile(path.join(directory, filename)));
  return {
    id,
    role,
    mediaType,
    executable,
    originalName: filename,
    aliases: [`/content/${id}`],
    sources: [
      {
        kind: "inline",
        data: encodeBase64(bytes),
        encoding: "base64",
        integrity: await createIntegrity(bytes),
      },
    ],
  };
}

const resources = await Promise.all([
  resource("viewer", "entrypoint", "text/html", "viewer.html", true),
  resource("style", "style", "text/css", "style.css"),
  resource("runtime", "script", "text/javascript", "runtime.js", true),
  resource("fallback", "fallback", "image/svg+xml", "fallback.svg"),
]);
const replaySeed = await createIntegrity(new TextEncoder().encode("oca-orbit-example/replay/v1"));
const manifest = {
  schema: OCA_MANIFEST_SCHEMA,
  canonicalization: OCA_CANONICALIZATION,
  id: "oca-orbit-example",
  name: "Keel Orbit Example",
  description: "A minimal multi-resource interactive artifact using the verified virtual content gateway.",
  entrypoint: { resource: "viewer", mode: "html" },
  resources,
  fallback: { image: "fallback", animation: "viewer", backgroundColor: "#09090b" },
  runtime: {
    engine: {
      protocol: KEEL_RUNTIME_PROTOCOL,
      viewerProtocol: KEEL_VIEWER_PROTOCOL,
      renderer: "browser",
    },
    determinism: {
      mode: "replay",
      seed: replaySeed.digest,
      randomAlgorithm: "xoshiro128ss",
      viewport: { width: 1280, height: 1280, devicePixelRatio: 1 },
      clock: { mode: "frame", epochMs: 1_786_060_800_000, frameDurationMs: 1000 / 60 },
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
    capabilities: {},
    maxResourceBytes: 100_000,
    maxTotalBytes: 300_000,
    maxRecursionDepth: 8,
    maxResources: 16,
    timeoutMs: 8_000,
  },
  revision: { number: 1, compatibility: { min: 1, max: 1 }, policy: "immutable", frozen: true },
  provenance: {
    createdAt: "2026-08-07T00:00:00.000Z",
    creator: "Ravonus",
    sourceRepository: "oca-modern",
    license: "MIT",
  },
};

const integrity = await manifestIntegrity(manifest);
await writeFile(path.join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(
  path.join(directory, "manifest.integrity.json"),
  `${JSON.stringify({ schema: "oca-manifest-integrity@2", manifest: "manifest.json", canonicalization: OCA_CANONICALIZATION, integrity }, null, 2)}\n`,
);
const metadata = {
  name: manifest.name,
  description: manifest.description,
  image: "./fallback.svg",
  animation_url: "https://viewer.example/?manifest=./manifest.json",
  oca_schema: manifest.schema,
  oca_manifest: "./manifest.json",
  oca_manifest_digest: integrity.digest,
};
await writeFile(path.join(directory, "metadata.example.json"), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(path.join(directory, "manifest.json"));
