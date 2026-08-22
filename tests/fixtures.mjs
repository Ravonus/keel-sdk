import {
  OCA_CANONICALIZATION,
  OCA_CONTENT_GATEWAY_PROTOCOL,
  OCA_MANIFEST_SCHEMA,
  KEEL_RUNTIME_PROTOCOL,
  KEEL_VIEWER_PROTOCOL,
} from "../packages/protocol/dist/index.js";

export function runtimePolicy(overrides = {}) {
  return {
    engine: {
      protocol: KEEL_RUNTIME_PROTOCOL,
      viewerProtocol: KEEL_VIEWER_PROTOCOL,
      renderer: "browser",
      ...(overrides.engine ?? {}),
    },
    determinism: overrides.determinism ?? { mode: "live" },
    content: {
      protocol: OCA_CONTENT_GATEWAY_PROTOCOL,
      mode: "verified-only",
      externalSources: "host-verified",
      manifestTrust: "digest",
      blockUndeclared: true,
      resourcePathPrefix: "/content/",
      onchainPathPrefix: "/onchain/",
      ipfsPathPrefix: "/ipfs/",
      ...(overrides.content ?? {}),
    },
    sandbox: "strict",
    capabilities: {},
    maxTotalBytes: 100_000,
    maxResourceBytes: 50_000,
    maxRecursionDepth: 16,
    maxResources: 64,
    timeoutMs: 10_000,
    ...Object.fromEntries(
      Object.entries(overrides).filter(([key]) => !["engine", "determinism", "content"].includes(key)),
    ),
  };
}

export function baseManifest(resources, overrides = {}) {
  return {
    schema: OCA_MANIFEST_SCHEMA,
    canonicalization: OCA_CANONICALIZATION,
    id: overrides.id ?? "test-artifact",
    name: overrides.name ?? "Test Artifact",
    entrypoint: overrides.entrypoint ?? { resource: "viewer", mode: "html" },
    resources,
    fallback: overrides.fallback ?? { image: "image" },
    runtime: overrides.runtime ?? runtimePolicy(),
    ...(overrides.anchor === undefined ? {} : { anchor: overrides.anchor }),
    revision: overrides.revision ?? { number: 1, compatibility: { min: 1, max: 1 }, policy: "creator" },
    provenance: overrides.provenance ?? { createdAt: "2026-08-07T00:00:00.000Z" },
    ...(overrides.downloads === undefined ? {} : { downloads: overrides.downloads }),
    ...(overrides.extensions === undefined ? {} : { extensions: overrides.extensions }),
  };
}
