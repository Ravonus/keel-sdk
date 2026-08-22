// Builds a self-contained oca-manifest@2 for each demo.
//
// Sources are inline and individually compressed with whichever of brotli,
// gzip, deflate, or none is actually smallest for that resource — the same
// per-resource decision the Studio creator pipeline makes. Integrity is always
// recorded over the *decoded* bytes, so the commitment describes the artifact
// rather than the encoding it happened to travel in.

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  KEEL_CANONICALIZATION,
  KEEL_CONTENT_GATEWAY_PROTOCOL,
  KEEL_MANIFEST_SCHEMA,
  KEEL_RUNTIME_PROTOCOL,
  KEEL_VIEWER_PROTOCOL,
  assertValidManifest,
  createIntegrity,
  encodeBase64,
  manifestIntegrity,
} from "../../packages/protocol/dist/index.js";
import { chooseSmallestCompression } from "../../packages/builder/dist/index.js";
import { DEMOS, demosDirectory, readDemoResources } from "./demos.mjs";

const CREATED_AT = "2026-08-07T00:00:00.000Z";

/**
 * @param demo one entry of DEMOS
 * @returns {Promise<{manifest: object, integrity: object, stats: object}>}
 */
export async function buildDemoManifest(demo) {
  const loaded = await readDemoResources(demo);

  const resources = [];
  const perResource = [];
  for (const resource of loaded) {
    const { compression, bytes: stored } = await chooseSmallestCompression(resource.bytes);
    const integrity = await createIntegrity(resource.bytes);

    resources.push({
      id: resource.id,
      role: resource.role,
      mediaType: resource.mediaType,
      ...(resource.executable === undefined ? {} : { executable: resource.executable }),
      originalName: path.basename(resource.file),
      sources: [
        {
          kind: "inline",
          data: encodeBase64(stored),
          encoding: "base64",
          ...(compression === "none" ? {} : { compression }),
          integrity,
        },
      ],
    });

    perResource.push({
      id: resource.id,
      compression,
      decodedByteLength: resource.bytes.byteLength,
      storedByteLength: stored.byteLength,
      digest: integrity.digest,
    });
  }

  const decodedTotal = perResource.reduce((sum, entry) => sum + entry.decodedByteLength, 0);
  const storedTotal = perResource.reduce((sum, entry) => sum + entry.storedByteLength, 0);
  const largestDecoded = perResource.reduce((max, entry) => Math.max(max, entry.decodedByteLength), 0);

  const posterResourceId = demo.resources.find((resource) => resource.role === "preview")?.id
    ?? demo.resources.find((resource) => resource.mediaType.startsWith("image/"))?.id
    ?? demo.entrypointResourceId;
  const manifest = {
    schema: KEEL_MANIFEST_SCHEMA,
    canonicalization: KEEL_CANONICALIZATION,
    id: demo.id,
    name: demo.name,
    description: demo.description,
    entrypoint: { resource: demo.entrypointResourceId, mode: "html" },
    resources,
    fallback: {
      image: posterResourceId,
      animation: demo.entrypointResourceId,
      backgroundColor: "#06050d",
    },
    runtime: {
      engine: {
        protocol: KEEL_RUNTIME_PROTOCOL,
        viewerProtocol: KEEL_VIEWER_PROTOCOL,
        renderer: "browser",
      },
      determinism: { mode: "live" },
      content: {
        protocol: KEEL_CONTENT_GATEWAY_PROTOCOL,
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
      maxResourceBytes: Math.max(largestDecoded + 4096, 64 * 1024),
      maxTotalBytes: Math.max(decodedTotal + 16 * 1024, 256 * 1024),
      maxRecursionDepth: 8,
      maxResources: Math.max(resources.length + 8, 16),
      timeoutMs: 30_000,
    },
    revision: { number: 1, compatibility: { min: 1, max: 1 }, policy: "immutable", frozen: true },
    provenance: {
      createdAt: CREATED_AT,
      creator: "Ravonus",
      sourceRepository: "oca-modern",
      license: demo.license,
    },
    extensions: {
      "oca:demo": { slug: demo.slug, accent: demo.accent, tagline: demo.tagline },
    },
  };

  assertValidManifest(manifest);

  return {
    manifest,
    integrity: await manifestIntegrity(manifest),
    stats: {
      resources: perResource,
      decodedTotal,
      storedTotal,
      savedBytes: decodedTotal - storedTotal,
      savedRatio: decodedTotal === 0 ? 0 : (decodedTotal - storedTotal) / decodedTotal,
    },
  };
}

export async function buildAllDemoManifests() {
  return Promise.all(DEMOS.map(async (demo) => ({ demo, ...(await buildDemoManifest(demo)) })));
}

// `node examples/demos/build.mjs` writes the manifests and a summary sidecar.
if (import.meta.url === `file://${process.argv[1]}`) {
  const outputDirectory = path.join(demosDirectory, "dist");
  await mkdir(outputDirectory, { recursive: true });

  const summary = [];
  for (const built of await buildAllDemoManifests()) {
    const file = path.join(outputDirectory, `${built.demo.slug}.manifest.json`);
    await writeFile(file, `${JSON.stringify(built.manifest, null, 2)}\n`);
    summary.push({
      id: built.demo.id,
      name: built.demo.name,
      manifestDigest: built.integrity.digest,
      resources: built.stats.resources.length,
      decodedBytes: built.stats.decodedTotal,
      storedBytes: built.stats.storedTotal,
      savedPercent: Number((built.stats.savedRatio * 100).toFixed(1)),
    });
    console.log(
      `${built.demo.name.padEnd(24)} ${built.integrity.digest.slice(0, 18)}…  ` +
        `${built.stats.decodedTotal} → ${built.stats.storedTotal} bytes ` +
        `(${(built.stats.savedRatio * 100).toFixed(1)}% saved)`,
    );
  }
  await writeFile(path.join(outputDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
}
