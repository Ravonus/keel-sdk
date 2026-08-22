import {
  OCA_CANONICALIZATION,
  OCA_CONTENT_GATEWAY_PROTOCOL,
  OCA_MANIFEST_SCHEMA,
  KEEL_RUNTIME_PROTOCOL,
  KEEL_VIEWER_PROTOCOL,
  assertValidManifest,
  manifestIntegrity,
  type ArtifactManifest,
  type ArtifactResource,
} from "@keel/protocol";
import { entrypointModeForMediaType } from "./media.js";
import type { BuiltStudioManifest, ResourceSourcePatch, StudioManifestInput } from "./types.js";

function resourceById(input: StudioManifestInput, id: string): StudioManifestInput["resources"][number] {
  const resource = input.resources.find((candidate) => candidate.id === id);
  if (resource === undefined) throw new Error(`Unknown studio resource ${id}.`);
  return resource;
}

export async function buildStudioManifest(input: StudioManifestInput): Promise<BuiltStudioManifest> {
  if (input.resources.length === 0) throw new RangeError("A studio artifact requires at least one resource.");
  const entrypoint = resourceById(input, input.entrypointResourceId);
  const fallbackId = input.fallbackImageResourceId ?? input.entrypointResourceId;
  resourceById(input, fallbackId);
  const totalBytes = input.resources.reduce((sum, resource) => sum + (resource.integrity.byteLength ?? 0), 0);
  const largestBytes = input.resources.reduce((largest, resource) => Math.max(largest, resource.integrity.byteLength ?? 0), 0);

  const resources: ArtifactResource[] = input.resources.map((resource) => ({
    id: resource.id,
    role: resource.role,
    mediaType: resource.mediaType,
    ...(resource.executable === undefined ? {} : { executable: resource.executable }),
    ...(resource.originalName === undefined ? {} : { originalName: resource.originalName }),
    ...(resource.description === undefined ? {} : { description: resource.description }),
    ...(resource.aliases === undefined ? {} : { aliases: resource.aliases }),
    sources: [
      {
        kind: "uri",
        uri: resource.uri,
        ...(resource.compression === undefined || resource.compression === "none" ? {} : { compression: resource.compression }),
        integrity: resource.integrity,
        immutable: true,
      },
    ],
  }));

  const manifest: ArtifactManifest = {
    schema: OCA_MANIFEST_SCHEMA,
    canonicalization: OCA_CANONICALIZATION,
    id: input.id,
    name: input.name,
    ...(input.description === undefined ? {} : { description: input.description }),
    entrypoint: { resource: entrypoint.id, mode: input.entrypointMode ?? entrypointModeForMediaType(entrypoint.mediaType) },
    resources,
    fallback: {
      image: fallbackId,
      animation: input.entrypointResourceId,
      ...(input.viewerBaseUrl === undefined ? {} : { externalUrl: input.viewerBaseUrl }),
      backgroundColor: "#07070a",
    },
    runtime: {
      engine: { protocol: KEEL_RUNTIME_PROTOCOL, viewerProtocol: KEEL_VIEWER_PROTOCOL, renderer: "browser" },
      determinism: { mode: "live" },
      content: {
        protocol: OCA_CONTENT_GATEWAY_PROTOCOL,
        mode: "verified-only",
        externalSources: "host-verified",
        manifestTrust: input.anchor === undefined ? "digest" : "registry",
        blockUndeclared: true,
        resourcePathPrefix: "/content/",
        onchainPathPrefix: "/onchain/",
        ipfsPathPrefix: "/ipfs/",
      },
      sandbox: "strict",
      capabilities: { downloads: input.downloadResourceId !== undefined },
      maxResourceBytes: Math.max(largestBytes + 4096, 64 * 1024),
      maxTotalBytes: Math.max(totalBytes + 16 * 1024, 256 * 1024),
      maxRecursionDepth: 32,
      maxResources: Math.max(resources.length + 8, 32),
      timeoutMs: 30_000,
    },
    ...(input.anchor === undefined ? {} : { anchor: input.anchor }),
    revision: {
      number: input.revision ?? 1,
      ...(input.parentRevision === undefined ? {} : { parent: input.parentRevision }),
      ...(input.parentDigest === undefined ? {} : { parentDigest: input.parentDigest }),
      compatibility: { min: 1, max: input.revision ?? 1 },
      policy: "creator-or-token-owner",
    },
    provenance: {
      createdAt: input.createdAt,
      ...(input.creator === undefined ? {} : { creator: input.creator }),
      ...(input.anchor === undefined ? {} : { chainId: input.anchor.chainId, collection: input.anchor.collection, tokenId: input.anchor.tokenId }),
    },
    ...(input.downloadResourceId === undefined
      ? {}
      : {
          downloads: [
            {
              resource: input.downloadResourceId,
              label: "Download verified original",
              ...(input.downloadFilename === undefined ? {} : { filename: input.downloadFilename }),
            },
          ],
        }),
    ...(input.attributes === undefined ? {} : { attributes: input.attributes }),
    ...(input.attributions === undefined ? {} : { attributions: input.attributions }),
    extensions: {
      "oca:studio": { generatedBy: "@keel/studio-core", contentPolicy: "verified-only" },
      ...(input.extensions ?? {}),
    },
  };
  assertValidManifest(manifest);
  return { manifest, integrity: await manifestIntegrity(manifest) };
}

export async function patchManifestSources(
  manifest: ArtifactManifest,
  patches: readonly ResourceSourcePatch[],
): Promise<BuiltStudioManifest> {
  const resources = manifest.resources.map((resource) => {
    const relevant = patches.filter((patch) => patch.resourceId === resource.id);
    if (relevant.length === 0) return resource;
    let sources = [...resource.sources];
    for (const patch of relevant) {
      sources = patch.prepend === false ? [...sources, patch.source] : [patch.source, ...sources];
    }
    return { ...resource, sources };
  });
  const next: ArtifactManifest = { ...manifest, resources };
  assertValidManifest(next);
  return { manifest: next, integrity: await manifestIntegrity(next) };
}
