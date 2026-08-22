import {
  KEEL_CANONICALIZATION,
  KEEL_CONTENT_GATEWAY_PROTOCOL,
  KEEL_MANIFEST_SCHEMA,
  KEEL_MAX_OBJECT_CHILDREN,
  KEEL_MAX_THUMBNAIL_BYTES,
  KEEL_REGISTRY_ANCHOR_PROTOCOL,
  KEEL_THUMBNAIL_PROTOCOL,
  KEEL_RUNTIME_PROTOCOL,
  KEEL_VIEWER_PROTOCOL,
  KEEL_CONTRACT_PLUGIN_PROTOCOL,
  KEEL_GRAPH_ANCHOR_PROTOCOL,
  KEEL_LIBRARY_BINDINGS_PROTOCOL,
  KEEL_BUILD_PROVENANCE_PROTOCOL,
  KEEL_PROJECT_STACK_PROTOCOL,
  KEEL_PLUGIN_BINDINGS_PROTOCOL,
  KEEL_PLUGIN_TRUST_PROTOCOL,
  KEEL_WALLET_INTENTS_PROTOCOL,
} from "./types.js";
import { assertValidKeelMediaDerivative } from "./keel-hold.js";
import { assertValidKeelStakeObject } from "./stake-object.js";
import { assertValidKeelAttributions } from "./keel-attribution.js";
import {
  assertValidKeelCommunityReplicationPreference,
  KEEL_COMMUNITY_REPLICATION_EXTENSION_KEY,
} from "./community-replication.js";
import type {
  ArtifactManifest,
  KeelIndexAnchor,
  ArtifactResource,
  Integrity,
  ManifestValidationIssue,
  ManifestValidationResult,
  ResourceSource,
  RuntimeDeterminism,
  KeelContractPluginDescriptor,
  KeelGraphAnchor,
  KeelLibraryBindings,
  KeelBuildProvenance,
  KeelProjectStack,
  KeelPinnedPluginResource,
  KeelPluginBindings,
  KeelPluginTrustBinding,
} from "./types.js";

const HEX_32 = /^0x[0-9a-f]{64}$/;
const HEX_4 = /^0x[0-9a-f]{8}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const RESOURCE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
const DECIMAL_UINT = /^(0|[1-9][0-9]*)$/;
const UINT256_MAX = (1n << 256n) - 1n;
const VIRTUAL_PATH = /^\/(?:content|onchain|ipfs)\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/;
const KEEL_ALIAS = /^keel:\/\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%~-]+)+$/;
const THUMBNAIL_IMAGE_MEDIA = new Set(["image/gif", "image/avif", "image/webp", "image/png", "image/jpeg"]);
const THUMBNAIL_ANIMATION_MEDIA = new Set([...THUMBNAIL_IMAGE_MEDIA, "video/mp4"]);

function issue(
  issues: ManifestValidationIssue[],
  level: ManifestValidationIssue["level"],
  path: string,
  code: string,
  message: string,
): void {
  issues.push({ level, path, code, message });
}

function validateIntegrity(value: Integrity, path: string, issues: ManifestValidationIssue[]): void {
  if (!Number.isSafeInteger(value.byteLength ?? 0) || (value.byteLength ?? 0) < 0) {
    issue(issues, "error", `${path}.byteLength`, "integrity.length", "byteLength must be a non-negative safe integer.");
  }
  if (value.algorithm === "none") {
    if (value.digest !== "0x") issue(issues, "error", `${path}.digest`, "integrity.none", "none must use digest 0x.");
    return;
  }
  if (!HEX_32.test(value.digest)) {
    issue(issues, "error", `${path}.digest`, "integrity.digest", "SHA-256 and Keccak-256 digests must be lower-case bytes32.");
  }
}

function requireIntegrity(
  value: Integrity | undefined,
  path: string,
  sourceKind: string,
  issues: ManifestValidationIssue[],
): void {
  if (value === undefined) {
    issue(issues, "error", path, "integrity.required", `${sourceKind} sources require decoded-byte integrity.`);
    return;
  }
  validateIntegrity(value, path, issues);
  if (value.algorithm === "none") {
    issue(issues, "error", `${path}.algorithm`, "integrity.required", `${sourceKind} sources require a cryptographic digest.`);
  }
}

function validRetrievalUri(uri: string): boolean {
  if (uri.startsWith("./") || uri.startsWith("../")) return true;
  if (uri.startsWith("ipfs://") || uri.startsWith("ipns://") || uri.startsWith("ar://")) return uri.length > uri.indexOf("://") + 3;
  try {
    return new URL(uri).protocol === "https:";
  } catch {
    return false;
  }
}

function validateSource(
  source: ResourceSource,
  path: string,
  resourceIds: ReadonlySet<string>,
  issues: ManifestValidationIssue[],
): void {
  switch (source.kind) {
    case "inline":
      if (source.data.length === 0) issue(issues, "warning", `${path}.data`, "inline.empty", "Inline source is empty.");
      requireIntegrity(source.integrity, `${path}.integrity`, "Inline", issues);
      return;

    case "uri":
      if (!validRetrievalUri(source.uri)) {
        issue(
          issues,
          "error",
          `${path}.uri`,
          "uri.invalid",
          "URI sources must be HTTPS, IPFS, IPNS, Arweave, or manifest-relative. data:, blob:, file:, javascript:, and HTTP are forbidden.",
        );
      }
      for (const [index, gateway] of (source.gateways ?? []).entries()) {
        try {
          if (new URL(gateway).protocol !== "https:") throw new Error();
        } catch {
          issue(issues, "error", `${path}.gateways[${index}]`, "gateway.invalid", "Gateways must be absolute HTTPS URLs.");
        }
      }
      requireIntegrity(source.integrity, `${path}.integrity`, "URI", issues);
      return;

    case "onchain":
      if (!Number.isSafeInteger(source.chainId) || source.chainId <= 0) {
        issue(issues, "error", `${path}.chainId`, "chain.invalid", "chainId must be a positive safe integer.");
      }
      if (!ADDRESS.test(source.store)) issue(issues, "error", `${path}.store`, "address.invalid", "store must be an EVM address.");
      if (!HEX_32.test(source.objectId)) {
        issue(issues, "error", `${path}.objectId`, "object.invalid", "objectId must be lower-case bytes32.");
      }
      if ((source.chunks?.length ?? 0) > KEEL_MAX_OBJECT_CHILDREN) {
        issue(
          issues,
          "error",
          `${path}.chunks`,
          "chunk.too-many",
          `A leaf object may expose at most ${KEEL_MAX_OBJECT_CHILDREN} chunk hints; use a recursive object tree.`,
        );
      }
      for (const [index, chunk] of (source.chunks ?? []).entries()) {
        if (!HEX_32.test(chunk)) {
          issue(issues, "error", `${path}.chunks[${index}]`, "chunk.invalid", "Chunk ID must be lower-case bytes32.");
        }
      }
      requireIntegrity(source.integrity, `${path}.integrity`, "On-chain", issues);
      return;

    case "contract-call":
      if (!Number.isSafeInteger(source.chainId) || source.chainId <= 0) {
        issue(issues, "error", `${path}.chainId`, "chain.invalid", "chainId must be a positive safe integer.");
      }
      if (!ADDRESS.test(source.to)) issue(issues, "error", `${path}.to`, "address.invalid", "to must be an EVM address.");
      if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(source.data)) {
        issue(issues, "error", `${path}.data`, "calldata.invalid", "data must be even-length hexadecimal calldata.");
      }
      requireIntegrity(source.integrity, `${path}.integrity`, "Contract-call", issues);
      return;

    case "composite":
      if (source.parts.length === 0) {
        issue(issues, "error", `${path}.parts`, "composite.empty", "Composite source must reference at least one resource.");
      }
      if (source.parts.length > KEEL_MAX_OBJECT_CHILDREN) {
        issue(
          issues,
          "error",
          `${path}.parts`,
          "composite.too-wide",
          `Composite nodes may contain at most ${KEEL_MAX_OBJECT_CHILDREN} parts; build a balanced tree.`,
        );
      }
      for (const [index, part] of source.parts.entries()) {
        if (!resourceIds.has(part)) {
          issue(issues, "error", `${path}.parts[${index}]`, "resource.missing", `Composite source references unknown resource ${part}.`);
        }
      }
      requireIntegrity(source.integrity, `${path}.integrity`, "Composite", issues);
  }
}

function validateAlias(alias: string, path: string, issues: ManifestValidationIssue[]): void {
  if (
    (!VIRTUAL_PATH.test(alias) && !KEEL_ALIAS.test(alias)) ||
    alias.includes("..") ||
    alias.includes("\\") ||
    alias.includes("?") ||
    alias.includes("#") ||
    /[\u0000-\u001f\u007f]/u.test(alias)
  ) {
    issue(
      issues,
      "error",
      path,
      "alias.invalid",
      "Aliases must be normalized /content/, /onchain/, /ipfs/, or keel:// routes without traversal, queries, fragments, or control characters.",
    );
  }
}

function validateResource(
  resource: ArtifactResource,
  index: number,
  resourceIds: ReadonlySet<string>,
  aliases: Set<string>,
  issues: ManifestValidationIssue[],
): void {
  const path = `$.resources[${index}]`;
  if (!RESOURCE_ID.test(resource.id)) {
    issue(issues, "error", `${path}.id`, "resource.id", "Resource ID contains unsupported characters or is too long.");
  }
  if (!/^[\w.+-]+\/[\w.+-]+(?:;.*)?$/.test(resource.mediaType)) {
    issue(issues, "error", `${path}.mediaType`, "media.invalid", "mediaType must look like an Internet media type.");
  }
  for (const [aliasIndex, alias] of (resource.aliases ?? []).entries()) {
    validateAlias(alias, `${path}.aliases[${aliasIndex}]`, issues);
    if (aliases.has(alias)) issue(issues, "error", `${path}.aliases[${aliasIndex}]`, "alias.duplicate", `Duplicate virtual route ${alias}.`);
    aliases.add(alias);
  }
  if (resource.sources.length === 0) issue(issues, "error", `${path}.sources`, "source.empty", "Resource needs at least one source.");
  resource.sources.forEach((source, sourceIndex) => validateSource(source, `${path}.sources[${sourceIndex}]`, resourceIds, issues));
}

function detectCompositeCycles(manifest: ArtifactManifest, issues: ManifestValidationIssue[]): void {
  const byId = new Map(manifest.resources.map((resource) => [resource.id, resource] as const));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string, chain: readonly string[]): void => {
    if (visiting.has(id)) {
      issue(issues, "error", `$.resources.${id}`, "composite.cycle", `Composite cycle detected: ${[...chain, id].join(" -> ")}.`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const resource = byId.get(id);
    if (resource !== undefined) {
      for (const source of resource.sources) {
        if (source.kind === "composite") for (const part of source.parts) visit(part, [...chain, id]);
      }
    }
    visiting.delete(id);
    visited.add(id);
  };

  for (const resource of manifest.resources) visit(resource.id, []);
}

function validateReplay(determinism: RuntimeDeterminism, issues: ManifestValidationIssue[]): void {
  if (determinism.mode !== "replay") return;
  const path = "$.runtime.determinism";
  if (!HEX_32.test(determinism.seed)) {
    issue(issues, "error", `${path}.seed`, "runtime.seed", "Replay seed must be lower-case bytes32.");
  }
  if (determinism.randomAlgorithm !== "xoshiro128ss") {
    issue(issues, "error", `${path}.randomAlgorithm`, "runtime.random", "Unsupported deterministic random algorithm.");
  }
  for (const [value, member] of [
    [determinism.viewport.width, "width"],
    [determinism.viewport.height, "height"],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 16_384) {
      issue(issues, "error", `${path}.viewport.${member}`, "runtime.viewport", `${member} must be an integer from 1 through 16384.`);
    }
  }
  if (
    !Number.isFinite(determinism.viewport.devicePixelRatio) ||
    determinism.viewport.devicePixelRatio <= 0 ||
    determinism.viewport.devicePixelRatio > 16
  ) {
    issue(issues, "error", `${path}.viewport.devicePixelRatio`, "runtime.dpr", "devicePixelRatio must be greater than 0 and at most 16.");
  }
  if (!Number.isSafeInteger(determinism.clock.epochMs) || determinism.clock.epochMs < 0) {
    issue(issues, "error", `${path}.clock.epochMs`, "runtime.clock", "epochMs must be a non-negative safe integer.");
  }
  if (
    determinism.clock.mode === "frame" &&
    (!Number.isFinite(determinism.clock.frameDurationMs) || determinism.clock.frameDurationMs <= 0)
  ) {
    issue(issues, "error", `${path}.clock.frameDurationMs`, "runtime.clock", "frameDurationMs must be greater than zero.");
  }
  if (determinism.locale.trim().length === 0) {
    issue(issues, "error", `${path}.locale`, "runtime.locale", "Replay locale is required.");
  } else {
    try {
      Intl.getCanonicalLocales(determinism.locale);
    } catch {
      issue(issues, "error", `${path}.locale`, "runtime.locale", "Replay locale is not a recognized locale identifier.");
    }
  }
  if (determinism.timezone.trim().length === 0) {
    issue(issues, "error", `${path}.timezone`, "runtime.timezone", "Replay timezone is required.");
  } else {
    try {
      new Intl.DateTimeFormat("en", { timeZone: determinism.timezone }).format(0);
    } catch {
      issue(issues, "error", `${path}.timezone`, "runtime.timezone", "Replay timezone is not recognized by this runtime.");
    }
  }
}

function validViewerUri(value: string): boolean {
  if (value.startsWith("ipfs://") || value.startsWith("ipns://") || value.startsWith("ar://")) return true;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function validateRuntime(manifest: ArtifactManifest, issues: ManifestValidationIssue[]): void {
  const policy = manifest.runtime;
  if (policy.engine.protocol !== KEEL_RUNTIME_PROTOCOL) {
    issue(issues, "error", "$.runtime.engine.protocol", "runtime.protocol", `Expected ${KEEL_RUNTIME_PROTOCOL}.`);
  }
  if (policy.engine.viewerProtocol !== KEEL_VIEWER_PROTOCOL) {
    issue(issues, "error", "$.runtime.engine.viewerProtocol", "viewer.protocol", `Expected ${KEEL_VIEWER_PROTOCOL}.`);
  }
  if (policy.engine.renderer !== "browser") {
    issue(issues, "error", "$.runtime.engine.renderer", "runtime.renderer", "Only the browser renderer is defined by this release.");
  }

  const mirrorIds = new Set<string>();
  const mirrors = policy.engine.viewerMirrors ?? [];
  for (const [index, mirror] of mirrors.entries()) {
    const path = `$.runtime.engine.viewerMirrors[${index}]`;
    if (!RESOURCE_ID.test(mirror.id)) issue(issues, "error", `${path}.id`, "viewer.id", "Viewer mirror ID is invalid.");
    if (mirrorIds.has(mirror.id)) issue(issues, "error", `${path}.id`, "viewer.duplicate", `Duplicate viewer mirror ${mirror.id}.`);
    mirrorIds.add(mirror.id);
    if (!validViewerUri(mirror.uri)) {
      issue(issues, "error", `${path}.uri`, "viewer.uri", "Viewer mirrors must be HTTPS, IPFS, IPNS, or Arweave URIs.");
    }
    requireIntegrity(mirror.integrity, `${path}.integrity`, "Viewer bundle", issues);
    if (
      mirror.launchUrlTemplate !== undefined &&
      (!mirror.launchUrlTemplate.includes("{manifest}") || !mirror.launchUrlTemplate.includes("{digest}"))
    ) {
      issue(
        issues,
        "error",
        `${path}.launchUrlTemplate`,
        "viewer.template",
        "Launch URL templates must contain both {manifest} and {digest} placeholders.",
      );
    }
  }
  if (mirrors.length === 1) {
    issue(
      issues,
      "warning",
      "$.runtime.engine.viewerMirrors",
      "viewer.single-host",
      "A single viewer mirror is still an availability dependency; publish at least two or rely on a local viewer.",
    );
  }

  validateReplay(policy.determinism, issues);

  if (policy.content.protocol !== KEEL_CONTENT_GATEWAY_PROTOCOL) {
    issue(issues, "error", "$.runtime.content.protocol", "content.protocol", `Expected ${KEEL_CONTENT_GATEWAY_PROTOCOL}.`);
  }
  if (policy.content.mode !== "verified-only" || policy.content.externalSources !== "host-verified") {
    issue(issues, "error", "$.runtime.content", "content.mode", "Creator code must use host-verified content only.");
  }
  if (policy.content.blockUndeclared !== true) {
    issue(issues, "error", "$.runtime.content.blockUndeclared", "content.undeclared", "Undeclared requests must be blocked.");
  }
  for (const [value, path, expected] of [
    [policy.content.resourcePathPrefix, "$.runtime.content.resourcePathPrefix", "/content/"],
    [policy.content.onchainPathPrefix, "$.runtime.content.onchainPathPrefix", "/onchain/"],
    [policy.content.ipfsPathPrefix, "$.runtime.content.ipfsPathPrefix", "/ipfs/"],
  ] as const) {
    if (value !== undefined && value !== expected) {
      issue(issues, "error", path, "content.prefix", `This protocol version requires ${expected}.`);
    }
  }
  if (policy.content.manifestTrust === "registry" && manifest.anchor === undefined) {
    issue(issues, "error", "$.anchor", "anchor.required", "Registry trust requires a KeelIndex anchor.");
  }

  if (policy.sandbox !== "strict" && policy.sandbox !== "isolated-origin") {
    issue(issues, "error", "$.runtime.sandbox", "sandbox.invalid", "Unsupported sandbox policy.");
  }

  const positiveLimits: Array<[number | undefined, string]> = [
    [policy.maxResourceBytes, "$.runtime.maxResourceBytes"],
    [policy.maxTotalBytes, "$.runtime.maxTotalBytes"],
    [policy.maxRecursionDepth, "$.runtime.maxRecursionDepth"],
    [policy.maxResources, "$.runtime.maxResources"],
    [policy.timeoutMs, "$.runtime.timeoutMs"],
  ];
  for (const [value, path] of positiveLimits) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      issue(issues, "error", path, "limit.invalid", "Runtime limit must be a positive safe integer.");
    }
  }
}

function validateAnchor(anchor: KeelIndexAnchor, manifest: ArtifactManifest, issues: ManifestValidationIssue[]): void {
  const path = "$.anchor";
  if (anchor.protocol !== KEEL_REGISTRY_ANCHOR_PROTOCOL || anchor.kind !== "artifact-registry") {
    issue(issues, "error", path, "anchor.protocol", `Expected ${KEEL_REGISTRY_ANCHOR_PROTOCOL}.`);
  }
  if (!Number.isSafeInteger(anchor.chainId) || anchor.chainId <= 0) {
    issue(issues, "error", `${path}.chainId`, "chain.invalid", "Anchor chainId must be a positive safe integer.");
  }
  if (!ADDRESS.test(anchor.registry)) issue(issues, "error", `${path}.registry`, "address.invalid", "registry must be an EVM address.");
  if (!ADDRESS.test(anchor.collection)) issue(issues, "error", `${path}.collection`, "address.invalid", "collection must be an EVM address.");
  const collectionScope = anchor.scope === "collection";
  if (anchor.scope !== undefined && anchor.scope !== "token" && !collectionScope) {
    issue(issues, "error", `${path}.scope`, "anchor.scope", "Anchor scope must be token or collection.");
  }
  if (collectionScope ? anchor.tokenId !== "*" : !DECIMAL_UINT.test(anchor.tokenId)) {
    issue(
      issues,
      "error",
      `${path}.tokenId`,
      "token.invalid",
      collectionScope ? "Collection anchors must use the * token sentinel." : "tokenId must be a canonical decimal uint256 string.",
    );
  } else {
    try {
      if (!collectionScope && BigInt(anchor.tokenId) > UINT256_MAX) throw new Error();
    } catch {
      issue(issues, "error", `${path}.tokenId`, "token.invalid", "tokenId exceeds uint256.");
    }
  }
  if (anchor.revision !== undefined && (!Number.isSafeInteger(anchor.revision) || anchor.revision < 1)) {
    issue(issues, "error", `${path}.revision`, "revision.invalid", "Anchor revision must be a positive safe integer.");
  }
  if (anchor.revision !== undefined && anchor.revision !== manifest.revision.number) {
    issue(issues, "error", `${path}.revision`, "revision.mismatch", "Anchor revision must match manifest.revision.number.");
  }
  if (manifest.provenance.chainId !== undefined && manifest.provenance.chainId !== anchor.chainId) {
    issue(issues, "error", "$.provenance.chainId", "anchor.mismatch", "Provenance chainId does not match the registry anchor.");
  }
  if (
    manifest.provenance.collection !== undefined &&
    manifest.provenance.collection.toLowerCase() !== anchor.collection.toLowerCase()
  ) {
    issue(issues, "error", "$.provenance.collection", "anchor.mismatch", "Provenance collection does not match the registry anchor.");
  }
  if (collectionScope && manifest.provenance.tokenId !== undefined) {
    issue(issues, "error", "$.provenance.tokenId", "anchor.mismatch", "Collection-scoped provenance cannot pin one tokenId.");
  } else if (!collectionScope && manifest.provenance.tokenId !== undefined && manifest.provenance.tokenId !== anchor.tokenId) {
    issue(issues, "error", "$.provenance.tokenId", "anchor.mismatch", "Provenance tokenId does not match the registry anchor.");
  }
}

function validateThumbnail(
  manifest: ArtifactManifest,
  resources: ReadonlyMap<string, ArtifactResource>,
  issues: ManifestValidationIssue[],
): void {
  const thumbnail = manifest.thumbnail;
  if (thumbnail === undefined) return;
  if (thumbnail.protocol !== KEEL_THUMBNAIL_PROTOCOL) {
    issue(issues, "error", "$.thumbnail.protocol", "thumbnail.protocol", `Expected ${KEEL_THUMBNAIL_PROTOCOL}.`);
  }
  if (thumbnail.maxBytes !== KEEL_MAX_THUMBNAIL_BYTES) {
    issue(issues, "error", "$.thumbnail.maxBytes", "thumbnail.limit", `Thumbnail resources are capped at ${KEEL_MAX_THUMBNAIL_BYTES} bytes.`);
  }
  const checkResource = (id: string | undefined, path: string, allowed: ReadonlySet<string>): void => {
    if (id === undefined) return;
    const resource = resources.get(id);
    if (resource === undefined) {
      issue(issues, "error", path, "thumbnail.missing", `Thumbnail resource ${id} does not exist.`);
      return;
    }
    if (!allowed.has(resource.mediaType)) {
      issue(issues, "error", path, "thumbnail.media", `${resource.mediaType} is not a supported thumbnail media type.`);
    }
    for (const [index, source] of resource.sources.entries()) {
      const length = source.integrity.byteLength;
      if (length === undefined || length <= 0 || length > KEEL_MAX_THUMBNAIL_BYTES) {
        issue(issues, "error", `$.resources.${id}.sources[${index}].integrity.byteLength`, "thumbnail.bytes", "Every thumbnail source must declare from 1 through 2 MiB of decoded bytes.");
      }
    }
  };
  checkResource(thumbnail.image, "$.thumbnail.image", THUMBNAIL_IMAGE_MEDIA);
  checkResource(thumbnail.animation, "$.thumbnail.animation", THUMBNAIL_ANIMATION_MEDIA);
  if (thumbnail.image === undefined && thumbnail.animation === undefined && thumbnail.capture === undefined) {
    issue(issues, "error", "$.thumbnail", "thumbnail.empty", "A thumbnail needs committed media or a capture recipe.");
  }
  const capture = thumbnail.capture;
  if (capture === undefined) return;
  if (capture.delayMs !== undefined && (!Number.isSafeInteger(capture.delayMs) || capture.delayMs < 0 || capture.delayMs > 30_000)) {
    issue(issues, "error", "$.thumbnail.capture.delayMs", "thumbnail.capture.delay", "Capture delay must be from 0 through 30 seconds.");
  }
  if (capture.durationMs !== undefined && (!Number.isSafeInteger(capture.durationMs) || capture.durationMs < 100 || capture.durationMs > 30_000)) {
    issue(issues, "error", "$.thumbnail.capture.durationMs", "thumbnail.capture.duration", "Motion capture duration must be from 100 ms through 30 seconds.");
  }
  if (capture.frameRate !== undefined && (!Number.isSafeInteger(capture.frameRate) || capture.frameRate < 1 || capture.frameRate > 60)) {
    issue(issues, "error", "$.thumbnail.capture.frameRate", "thumbnail.capture.fps", "Capture frame rate must be from 1 through 60.");
  }
  if (capture.label !== undefined && (capture.label.trim().length === 0 || capture.label.length > 64)) {
    issue(issues, "error", "$.thumbnail.capture.label", "thumbnail.capture.label", "Capture label must contain from 1 through 64 characters.");
  }
}

function validateMediaDerivatives(
  manifest: ArtifactManifest,
  resources: ReadonlyMap<string, ArtifactResource>,
  issues: ManifestValidationIssue[],
): void {
  const outputs = new Set<string>();
  for (const [index, derivative] of (manifest.mediaDerivatives ?? []).entries()) {
    const path = `$.mediaDerivatives[${index}]`;
    try {
      assertValidKeelMediaDerivative(derivative);
    } catch (error) {
      issue(issues, "error", path, "derivative.invalid", error instanceof Error ? error.message : String(error));
      continue;
    }
    if (outputs.has(derivative.outputResourceId)) {
      issue(issues, "error", `${path}.outputResourceId`, "derivative.duplicate", "A derivative output resource may appear only once.");
    }
    outputs.add(derivative.outputResourceId);
    const source = resources.get(derivative.sourceResourceId);
    const output = resources.get(derivative.outputResourceId);
    if (source === undefined) {
      issue(issues, "error", `${path}.sourceResourceId`, "derivative.source", "Derivative source resource does not exist.");
    } else if (!source.sources.some((item) => item.integrity.algorithm === derivative.sourceIntegrity.algorithm && item.integrity.digest === derivative.sourceIntegrity.digest && item.integrity.byteLength === derivative.sourceIntegrity.byteLength)) {
      issue(issues, "error", `${path}.sourceIntegrity`, "derivative.source", "Derivative source commitment does not match the manifest resource.");
    }
    if (output === undefined) {
      issue(issues, "error", `${path}.outputResourceId`, "derivative.output", "Derivative output resource does not exist.");
    } else {
      if (output.mediaType !== derivative.outputMediaType) {
        issue(issues, "error", `${path}.outputMediaType`, "derivative.output", "Derivative media type does not match its output resource.");
      }
      if (!output.sources.some((item) => item.integrity.algorithm === derivative.outputIntegrity.algorithm && item.integrity.digest === derivative.outputIntegrity.digest && item.integrity.byteLength === derivative.outputIntegrity.byteLength)) {
        issue(issues, "error", `${path}.outputIntegrity`, "derivative.output", "Derivative output commitment does not match the manifest resource.");
      }
    }
  }
}

function validateKeelGraphAnchor(anchor: KeelGraphAnchor, path: string, issues: ManifestValidationIssue[]): void {
  if (anchor.protocol !== KEEL_GRAPH_ANCHOR_PROTOCOL) {
    issue(issues, "error", `${path}.protocol`, "plugin.graph.protocol", `Expected ${KEEL_GRAPH_ANCHOR_PROTOCOL}.`);
  }
  if (!Number.isSafeInteger(anchor.chainId) || anchor.chainId <= 0) {
    issue(issues, "error", `${path}.chainId`, "chain.invalid", "Plugin graph chainId must be a positive safe integer.");
  }
  if (!ADDRESS.test(anchor.registry)) issue(issues, "error", `${path}.registry`, "address.invalid", "Graph registry must be an EVM address.");
  if (!HEX_32.test(anchor.graphId)) issue(issues, "error", `${path}.graphId`, "plugin.graph.id", "graphId must be lower-case bytes32.");
  if (!Number.isSafeInteger(anchor.version) || anchor.version < 1) {
    issue(issues, "error", `${path}.version`, "plugin.graph.version", "Graph version must be a positive safe integer.");
  }
  if (!["remote-pinned", "content-addressed", "onchain"].includes(anchor.storageTier)) {
    issue(issues, "error", `${path}.storageTier`, "plugin.graph.tier", "Unsupported graph storage tier.");
  }
}

function validateKeelTrustBinding(binding: KeelPluginTrustBinding, path: string, issues: ManifestValidationIssue[]): void {
  if (binding.protocol !== KEEL_PLUGIN_TRUST_PROTOCOL) {
    issue(issues, "error", `${path}.protocol`, "plugin.trust.protocol", `Expected ${KEEL_PLUGIN_TRUST_PROTOCOL}.`);
  }
  if (!Number.isSafeInteger(binding.chainId) || binding.chainId <= 0) {
    issue(issues, "error", `${path}.chainId`, "chain.invalid", "Plugin trust chainId must be a positive safe integer.");
  }
  if (!ADDRESS.test(binding.registry)) issue(issues, "error", `${path}.registry`, "address.invalid", "Plugin registry must be an EVM address.");
  if (!HEX_32.test(binding.specDigest)) issue(issues, "error", `${path}.specDigest`, "plugin.spec.digest", "specDigest must be lower-case bytes32.");
  if (binding.requiredStatus !== "sanctioned") {
    issue(issues, "error", `${path}.requiredStatus`, "plugin.trust.status", "This viewer version permits wallet access only for sanctioned specs.");
  }
}

function sameIntegrity(left: Integrity, right: Integrity): boolean {
  return left.algorithm === right.algorithm && left.digest === right.digest && left.byteLength === right.byteLength;
}

function validatePinnedResource(
  pinned: KeelPinnedPluginResource,
  path: string,
  resources: ReadonlyMap<string, ArtifactResource>,
  issues: ManifestValidationIssue[],
): void {
  validateIntegrity(pinned.integrity, `${path}.integrity`, issues);
  if (pinned.integrity.algorithm === "none" || pinned.integrity.byteLength === undefined || pinned.integrity.byteLength <= 0) {
    issue(issues, "error", `${path}.integrity`, "plugin.resource.integrity", "Pinned plugin resources require a cryptographic digest and positive byteLength.");
  }
  const resource = resources.get(pinned.resource);
  if (resource === undefined) {
    issue(issues, "error", `${path}.resource`, "plugin.resource.missing", `Unknown pinned plugin resource ${pinned.resource}.`);
    return;
  }
  for (const [index, source] of resource.sources.entries()) {
    if (!sameIntegrity(source.integrity, pinned.integrity)) {
      issue(
        issues,
        "error",
        `$.resources.${pinned.resource}.sources[${index}].integrity`,
        "plugin.resource.mismatch",
        "Every fallback for a privileged plugin resource must resolve to the exact pinned bytes.",
      );
    }
  }
}

function sourceMeetsStorageTier(source: ResourceSource, tier: KeelGraphAnchor["storageTier"]): boolean {
  if (tier === "remote-pinned") return source.integrity.algorithm !== "none";
  if (tier === "onchain") return source.kind === "onchain";
  if (source.kind === "onchain" || source.kind === "inline") return true;
  if (source.kind !== "uri") return false;
  return source.immutable === true || source.uri.startsWith("ipfs://") || source.uri.startsWith("ar://");
}

function validatePluginStorageTier(
  descriptor: KeelContractPluginDescriptor,
  resources: readonly ArtifactResource[],
  issues: ManifestValidationIssue[],
): void {
  if (descriptor.graph.storageTier === "remote-pinned") return;
  for (const [index, resource] of resources.entries()) {
    if (!resource.sources.some((source) => sourceMeetsStorageTier(source, descriptor.graph.storageTier))) {
      issue(
        issues,
        "error",
        `$.resources[${index}].sources`,
        "plugin.storage.regression",
        descriptor.graph.storageTier === "onchain"
          ? "An onchain plugin graph requires an onchain source for every resource."
          : "A content-addressed plugin graph requires an inline, immutable URI, IPFS, Arweave, or onchain source for every resource.",
      );
    }
  }
}

function validatePluginBindings(
  bindings: KeelPluginBindings,
  resources: ReadonlyMap<string, ArtifactResource>,
  issues: ManifestValidationIssue[],
): void {
  if (bindings.protocol !== KEEL_PLUGIN_BINDINGS_PROTOCOL) {
    issue(issues, "error", "$.plugins.protocol", "plugin.bindings.protocol", `Expected ${KEEL_PLUGIN_BINDINGS_PROTOCOL}.`);
  }
  if (bindings.plugins.length === 0 || bindings.plugins.length > 16) {
    issue(issues, "error", "$.plugins.plugins", "plugin.bindings.count", "An artifact must bind between 1 and 16 plugins.");
  }
  const ids = new Set<string>();
  for (const [index, plugin] of bindings.plugins.entries()) {
    const path = `$.plugins.plugins[${index}]`;
    if (!RESOURCE_ID.test(plugin.id) || ids.has(plugin.id)) {
      issue(issues, "error", `${path}.id`, "plugin.id", "Plugin reference IDs must be valid and unique.");
    }
    ids.add(plugin.id);
    validateIntegrity(plugin.manifestIntegrity, `${path}.manifestIntegrity`, issues);
    if (plugin.manifestIntegrity.algorithm !== "sha256" || plugin.manifestIntegrity.byteLength === undefined || plugin.manifestIntegrity.byteLength <= 0) {
      issue(issues, "error", `${path}.manifestIntegrity`, "plugin.manifest.integrity", "Nested plugin manifests require SHA-256 and a positive byteLength.");
    }
    const resource = resources.get(plugin.manifestResource);
    if (resource === undefined) {
      issue(issues, "error", `${path}.manifestResource`, "plugin.manifest.missing", `Unknown plugin manifest resource ${plugin.manifestResource}.`);
    } else {
      if (resource.executable === true) {
        issue(issues, "error", `${path}.manifestResource`, "plugin.manifest.executable", "A nested plugin manifest is data, never directly executable.");
      }
      for (const [sourceIndex, source] of resource.sources.entries()) {
        if (!sameIntegrity(source.integrity, plugin.manifestIntegrity)) {
          issue(issues, "error", `$.resources.${resource.id}.sources[${sourceIndex}].integrity`, "plugin.manifest.mismatch", "Every plugin manifest mirror must match the exact bound manifest digest and length.");
        }
      }
    }
    validateKeelGraphAnchor(plugin.graph, `${path}.graph`, issues);
    validateKeelTrustBinding(plugin.trust, `${path}.trust`, issues);
    if (plugin.graph.chainId !== plugin.trust.chainId) {
      issue(issues, "error", path, "plugin.chain.mismatch", "Graph and plugin trust registries must use the same chain in v1.");
    }
  }
}

function validateLibraryBindings(
  bindings: KeelLibraryBindings,
  resources: ReadonlyMap<string, ArtifactResource>,
  issues: ManifestValidationIssue[],
): void {
  if (bindings.protocol !== KEEL_LIBRARY_BINDINGS_PROTOCOL) {
    issue(
      issues,
      "error",
      "$.libraries.protocol",
      "library.bindings.protocol",
      `Expected ${KEEL_LIBRARY_BINDINGS_PROTOCOL}.`,
    );
  }
  if (bindings.assets.length === 0 || bindings.assets.length > 64) {
    issue(issues, "error", "$.libraries.assets", "library.bindings.count", "An artifact must bind between 1 and 64 Library assets.");
  }
  const ids = new Set<string>();
  const versions = new Set<string>();
  for (const [index, asset] of bindings.assets.entries()) {
    const path = `$.libraries.assets[${index}]`;
    if (!RESOURCE_ID.test(asset.id) || ids.has(asset.id)) {
      issue(issues, "error", `${path}.id`, "library.id", "Library reference IDs must be valid and unique.");
    }
    ids.add(asset.id);
    const versionKey = `${asset.chainId}/${asset.registry.toLowerCase()}/${asset.assetId}/${asset.policyVersion}`;
    if (versions.has(versionKey)) {
      issue(issues, "error", path, "library.version.duplicate", "The same exact Library policy version may be bound only once.");
    }
    versions.add(versionKey);
    validateIntegrity(asset.resourceIntegrity, `${path}.resourceIntegrity`, issues);
    if (
      asset.resourceIntegrity.algorithm !== "sha256" ||
      asset.resourceIntegrity.byteLength === undefined ||
      asset.resourceIntegrity.byteLength <= 0
    ) {
      issue(issues, "error", `${path}.resourceIntegrity`, "library.resource.integrity", "Library resources require SHA-256 and a positive byteLength.");
    }
    const resource = resources.get(asset.resource);
    if (resource === undefined) {
      issue(issues, "error", `${path}.resource`, "library.resource.missing", `Unknown Library resource ${asset.resource}.`);
    } else {
      for (const [sourceIndex, source] of resource.sources.entries()) {
        if (!sameIntegrity(source.integrity, asset.resourceIntegrity)) {
          issue(
            issues,
            "error",
            `$.resources.${resource.id}.sources[${sourceIndex}].integrity`,
            "library.resource.mismatch",
            "Every Library resource fallback must resolve to the exact bound bytes.",
          );
        }
      }
    }
    if (!Number.isSafeInteger(asset.chainId) || asset.chainId <= 0) {
      issue(issues, "error", `${path}.chainId`, "chain.invalid", "Library chainId must be a positive safe integer.");
    }
    if (!ADDRESS.test(asset.registry)) issue(issues, "error", `${path}.registry`, "address.invalid", "Library registry must be an EVM address.");
    if (!HEX_32.test(asset.assetId)) issue(issues, "error", `${path}.assetId`, "library.asset.id", "assetId must be lower-case bytes32.");
    if (!Number.isSafeInteger(asset.policyVersion) || asset.policyVersion < 1) {
      issue(issues, "error", `${path}.policyVersion`, "library.policy.version", "policyVersion must be a positive safe integer.");
    }
    if (!HEX_32.test(asset.policyCommitment)) issue(issues, "error", `${path}.policyCommitment`, "library.policy.commitment", "policyCommitment must be lower-case bytes32.");
    if (!HEX_32.test(asset.manifestDigest)) issue(issues, "error", `${path}.manifestDigest`, "library.manifest.digest", "manifestDigest must be lower-case bytes32.");
    if (!HEX_32.test(asset.resourceGraphDigest)) issue(issues, "error", `${path}.resourceGraphDigest`, "library.graph.digest", "resourceGraphDigest must be lower-case bytes32.");
    validateKeelGraphAnchor(asset.graph, `${path}.graph`, issues);
    if (asset.graph.chainId !== asset.chainId) {
      issue(issues, "error", path, "library.chain.mismatch", "Library and Graph registries must use the same chain in v1.");
    }
    const compatibility = asset.updates.compatibleGraphVersions;
    if (asset.updates.mode === "auto-compatible") {
      if (
        compatibility === undefined ||
        !Number.isSafeInteger(compatibility.min) ||
        !Number.isSafeInteger(compatibility.max) ||
        compatibility.min < 1 ||
        compatibility.max < compatibility.min ||
        asset.graph.version < compatibility.min ||
        asset.graph.version > compatibility.max
      ) {
        issue(
          issues,
          "error",
          `${path}.updates.compatibleGraphVersions`,
          "library.updates.compatibility",
          "Auto-compatible bindings require an ordered graph-version range containing the pinned version.",
        );
      }
    } else if (compatibility !== undefined) {
      issue(
        issues,
        "error",
        `${path}.updates.compatibleGraphVersions`,
        "library.updates.unused",
        "Locked and manual bindings cannot declare an automatic compatibility range.",
      );
    }
  }
}

function validateBuildProvenance(
  build: KeelBuildProvenance,
  resources: ReadonlyMap<string, ArtifactResource>,
  issues: ManifestValidationIssue[],
): void {
  const path = "$.build";
  if (build.protocol !== KEEL_BUILD_PROVENANCE_PROTOCOL) {
    issue(issues, "error", `${path}.protocol`, "build.protocol", `Expected ${KEEL_BUILD_PROVENANCE_PROTOCOL}.`);
  }
  const verifyBuildIntegrity = (value: Integrity, valuePath: string): void => {
    validateIntegrity(value, valuePath, issues);
    if (value.algorithm === "none" || value.byteLength === undefined || value.byteLength <= 0) {
      issue(issues, "error", valuePath, "build.integrity", "Build stages require a cryptographic digest and positive byteLength.");
    }
  };
  verifyBuildIntegrity(build.source.integrity, `${path}.source.integrity`);
  if (build.source.availability === "included") {
    if (build.source.resource === undefined || !resources.has(build.source.resource)) {
      issue(issues, "error", `${path}.source.resource`, "build.source.missing", "Included build source must name a manifest resource.");
    } else {
      const source = resources.get(build.source.resource);
      if (source !== undefined && source.sources.some((candidate) => !sameIntegrity(candidate.integrity, build.source.integrity))) {
        issue(issues, "error", `${path}.source.resource`, "build.source.mismatch", "Included source mirrors must match the build source digest.");
      }
    }
  } else if (build.source.resource !== undefined) {
    issue(issues, "error", `${path}.source.resource`, "build.source.hidden", "Digest-only source cannot name an included resource.");
  }
  if (build.steps.length === 0 || build.steps.length > 32) {
    issue(issues, "error", `${path}.steps`, "build.steps.count", "A verified build needs between 1 and 32 deterministic steps.");
  }
  const ids = new Set<string>();
  let previous = build.source.integrity;
  for (const [index, step] of build.steps.entries()) {
    const stepPath = `${path}.steps[${index}]`;
    if (!RESOURCE_ID.test(step.id) || ids.has(step.id)) {
      issue(issues, "error", `${stepPath}.id`, "build.step.id", "Build step IDs must be valid and unique.");
    }
    ids.add(step.id);
    if (step.tool.name.trim().length === 0 || step.tool.version.trim().length === 0) {
      issue(issues, "error", `${stepPath}.tool`, "build.tool", "Build tool name and version are required.");
    }
    verifyBuildIntegrity(step.input, `${stepPath}.input`);
    verifyBuildIntegrity(step.output, `${stepPath}.output`);
    if (!sameIntegrity(step.input, previous)) {
      issue(issues, "error", `${stepPath}.input`, "build.chain", "Each build step must consume the exact previous output.");
    }
    if (!HEX_32.test(step.optionsDigest)) {
      issue(issues, "error", `${stepPath}.optionsDigest`, "build.options.digest", "Build options digest must be lower-case bytes32.");
    }
    previous = step.output;
  }
  verifyBuildIntegrity(build.final.integrity, `${path}.final.integrity`);
  const finalResource = resources.get(build.final.resource);
  if (finalResource === undefined) {
    issue(issues, "error", `${path}.final.resource`, "build.final.missing", "Build final resource does not exist.");
  } else if (finalResource.sources.some((source) => !sameIntegrity(source.integrity, build.final.integrity))) {
    issue(issues, "error", `${path}.final.integrity`, "build.final.mismatch", "Build final digest must match every resource mirror.");
  }
  if (!sameIntegrity(previous, build.final.integrity)) {
    issue(issues, "error", `${path}.final.integrity`, "build.final.chain", "Build final digest must match the last deterministic step.");
  }
  if (build.storage !== undefined) {
    verifyBuildIntegrity(build.storage.input, `${path}.storage.input`);
    verifyBuildIntegrity(build.storage.stored, `${path}.storage.stored`);
    if (!sameIntegrity(build.storage.input, build.final.integrity)) {
      issue(issues, "error", `${path}.storage.input`, "build.storage.input", "Storage compression must consume the verified final bytes.");
    }
    if (!HEX_32.test(build.storage.optionsDigest)) {
      issue(issues, "error", `${path}.storage.optionsDigest`, "build.options.digest", "Storage options digest must be lower-case bytes32.");
    }
  }
}

function validateProjectStack(
  stack: KeelProjectStack,
  manifest: ArtifactManifest,
  resources: ReadonlyMap<string, ArtifactResource>,
  issues: ManifestValidationIssue[],
): void {
  const path = "$.stack";
  if (stack.protocol !== KEEL_PROJECT_STACK_PROTOCOL) {
    issue(issues, "error", `${path}.protocol`, "stack.protocol", `Expected ${KEEL_PROJECT_STACK_PROTOCOL}.`);
  }
  if (stack.components.length === 0 || stack.components.length > 256) {
    issue(issues, "error", `${path}.components`, "stack.count", "A project stack must contain between 1 and 256 components.");
  }
  const ids = new Set<string>();
  const orders = new Set<number>();
  const libraries = new Map((manifest.libraries?.assets ?? []).map((asset) => [asset.id, asset] as const));
  const javascript = new Set(["text/javascript", "application/javascript", "application/ecmascript", "text/ecmascript"]);
  for (const [index, component] of stack.components.entries()) {
    const componentPath = `${path}.components[${index}]`;
    if (!RESOURCE_ID.test(component.id) || ids.has(component.id)) {
      issue(issues, "error", `${componentPath}.id`, "stack.id", "Project component IDs must be valid and unique.");
    }
    ids.add(component.id);
    if (component.label.trim().length === 0 || component.label.length > 96) {
      issue(issues, "error", `${componentPath}.label`, "stack.label", "Component labels must contain from 1 through 96 characters.");
    }
    if (!Number.isSafeInteger(component.order) || component.order < 0 || orders.has(component.order)) {
      issue(issues, "error", `${componentPath}.order`, "stack.order", "Component order must be a unique non-negative safe integer.");
    }
    orders.add(component.order);
    validateIntegrity(component.resourceIntegrity, `${componentPath}.resourceIntegrity`, issues);
    if (
      component.resourceIntegrity.algorithm !== "sha256" ||
      component.resourceIntegrity.byteLength === undefined ||
      component.resourceIntegrity.byteLength <= 0
    ) {
      issue(issues, "error", `${componentPath}.resourceIntegrity`, "stack.resource.integrity", "Stack components require SHA-256 and a positive byteLength.");
    }
    const resource = resources.get(component.resource);
    if (resource === undefined) {
      issue(issues, "error", `${componentPath}.resource`, "stack.resource.missing", `Unknown stack resource ${component.resource}.`);
    } else {
      for (const [sourceIndex, source] of resource.sources.entries()) {
        if (!sameIntegrity(source.integrity, component.resourceIntegrity)) {
          issue(
            issues,
            "error",
            `$.resources.${resource.id}.sources[${sourceIndex}].integrity`,
            "stack.resource.mismatch",
            "Every stack resource mirror must resolve to the exact component bytes.",
          );
        }
      }
      const mediaType = resource.mediaType.toLowerCase().split(";", 1)[0] ?? resource.mediaType.toLowerCase();
      if (component.format === "wasm") {
        if (mediaType !== "application/wasm") {
          issue(issues, "error", `${componentPath}.format`, "stack.format.wasm", "WASM components require application/wasm bytes.");
        }
        if (manifest.runtime.capabilities?.webAssembly !== true) {
          issue(issues, "error", `${componentPath}.format`, "stack.format.wasm-capability", "WASM components require the manifest WebAssembly capability.");
        }
      } else if (component.format !== "asset" && !javascript.has(mediaType)) {
        issue(issues, "error", `${componentPath}.format`, "stack.format.script", "Script and module formats require a JavaScript media type.");
      }
    }
    const compatibility = component.updates.compatibleGraphVersions;
    if (component.updates.mode === "auto-compatible") {
      if (
        compatibility === undefined ||
        !Number.isSafeInteger(compatibility.min) ||
        !Number.isSafeInteger(compatibility.max) ||
        compatibility.min < 1 ||
        compatibility.max < compatibility.min
      ) {
        issue(issues, "error", `${componentPath}.updates.compatibleGraphVersions`, "stack.updates.compatibility", "Automatic components require an ordered positive Library graph-version range.");
      }
      if (component.library === undefined) {
        issue(issues, "error", `${componentPath}.library`, "stack.updates.library", "Automatic components must bind an exact Library reference.");
      }
    } else if (compatibility !== undefined) {
      issue(issues, "error", `${componentPath}.updates.compatibleGraphVersions`, "stack.updates.unused", "Locked and manual components cannot declare an automatic compatibility range.");
    }
    if (component.library !== undefined) {
      const library = libraries.get(component.library);
      if (library === undefined) {
        issue(issues, "error", `${componentPath}.library`, "stack.library.missing", `Unknown Library reference ${component.library}.`);
      } else {
        if (library.resource !== component.resource || !sameIntegrity(library.resourceIntegrity, component.resourceIntegrity)) {
          issue(issues, "error", `${componentPath}.library`, "stack.library.resource", "The stack component must bind the same exact resource bytes as its Library reference.");
        }
        if (
          library.updates.mode !== component.updates.mode ||
          canonicalRange(library.updates.compatibleGraphVersions) !== canonicalRange(component.updates.compatibleGraphVersions)
        ) {
          issue(issues, "error", `${componentPath}.updates`, "stack.library.updates", "The stack and exact Library reference must commit the same update policy.");
        }
      }
    }
  }
}

function canonicalRange(value: { readonly min: number; readonly max: number } | undefined): string {
  return value === undefined ? "" : `${value.min}:${value.max}`;
}

function validateContractPlugin(
  descriptor: KeelContractPluginDescriptor,
  resources: ReadonlyMap<string, ArtifactResource>,
  manifest: ArtifactManifest,
  issues: ManifestValidationIssue[],
): void {
  const path = "$.contractPlugin";
  if (descriptor.protocol !== KEEL_CONTRACT_PLUGIN_PROTOCOL) {
    issue(issues, "error", `${path}.protocol`, "plugin.protocol", `Expected ${KEEL_CONTRACT_PLUGIN_PROTOCOL}.`);
  }
  if (!HEX_32.test(descriptor.pluginId)) issue(issues, "error", `${path}.pluginId`, "plugin.id", "pluginId must be lower-case bytes32.");
  if (!Number.isSafeInteger(descriptor.version) || descriptor.version < 1) {
    issue(issues, "error", `${path}.version`, "plugin.version", "Plugin version must be a positive safe integer.");
  }
  if (descriptor.parent !== undefined) {
    if (!Number.isSafeInteger(descriptor.parent.version) || descriptor.parent.version < 1 || descriptor.parent.version >= descriptor.version) {
      issue(issues, "error", `${path}.parent.version`, "plugin.parent", "Plugin parent must be an earlier positive version.");
    }
    if (!HEX_32.test(descriptor.parent.manifestDigest)) {
      issue(issues, "error", `${path}.parent.manifestDigest`, "plugin.parent.digest", "Parent manifest digest must be lower-case bytes32.");
    }
  }
  validateKeelGraphAnchor(descriptor.graph, `${path}.graph`, issues);
  if (descriptor.contract.chainId !== descriptor.graph.chainId) {
    issue(issues, "error", path, "plugin.chain.mismatch", "Plugin contract and graph registry must use one exact chain in v1.");
  }
  if (!ADDRESS.test(descriptor.contract.address)) issue(issues, "error", `${path}.contract.address`, "address.invalid", "Plugin target must be an EVM address.");
  if (!HEX_32.test(descriptor.contract.runtimeCodeHash)) issue(issues, "error", `${path}.contract.runtimeCodeHash`, "plugin.codehash", "Runtime code hash must be lower-case bytes32.");
  if (!HEX_4.test(descriptor.contract.requiredInterfaceId)) issue(issues, "error", `${path}.contract.requiredInterfaceId`, "plugin.interface", "requiredInterfaceId must be lower-case bytes4.");

  validatePinnedResource(descriptor.runtime.abi, `${path}.runtime.abi`, resources, issues);
  validatePinnedResource(descriptor.runtime.adapter, `${path}.runtime.adapter`, resources, issues);
  validatePinnedResource(descriptor.runtime.walletLibrary, `${path}.runtime.walletLibrary`, resources, issues);

  if (descriptor.permissions.protocol !== KEEL_WALLET_INTENTS_PROTOCOL) {
    issue(issues, "error", `${path}.permissions.protocol`, "plugin.permissions.protocol", `Expected ${KEEL_WALLET_INTENTS_PROTOCOL}.`);
  }
  if (!HEX_32.test(descriptor.permissions.digest)) issue(issues, "error", `${path}.permissions.digest`, "plugin.permissions.digest", "Permissions digest must be lower-case bytes32.");
  if (descriptor.permissions.intents.length === 0 || descriptor.permissions.intents.length > 32) {
    issue(issues, "error", `${path}.permissions.intents`, "plugin.intent.count", "A plugin must declare between 1 and 32 typed intents.");
  }
  const intentIds = new Set<string>();
  for (const [index, intent] of descriptor.permissions.intents.entries()) {
    const intentPath = `${path}.permissions.intents[${index}]`;
    if (!RESOURCE_ID.test(intent.id) || intentIds.has(intent.id)) issue(issues, "error", `${intentPath}.id`, "plugin.intent.id", "Intent IDs must be valid and unique.");
    intentIds.add(intent.id);
    if (!HEX_4.test(intent.selector)) issue(issues, "error", `${intentPath}.selector`, "plugin.intent.selector", "Intent selector must be lower-case bytes4.");
    if (intent.label.trim().length === 0 || intent.confirmation.trim().length === 0) issue(issues, "error", intentPath, "plugin.intent.copy", "Intent label and host confirmation copy are required.");
    if (intent.stateMutability !== "payable" && intent.valuePolicy !== "zero") issue(issues, "error", `${intentPath}.valuePolicy`, "plugin.intent.value", "Only payable intents may use an exact native-value quote.");
  }
  validatePluginStorageTier(descriptor, manifest.resources, issues);
}

export function validateManifest(manifest: ArtifactManifest): ManifestValidationResult {
  const issues: ManifestValidationIssue[] = [];

  if (manifest.schema !== KEEL_MANIFEST_SCHEMA) {
    issue(issues, "error", "$.schema", "schema.unsupported", `Expected ${KEEL_MANIFEST_SCHEMA}.`);
  }
  if (manifest.canonicalization !== KEEL_CANONICALIZATION) {
    issue(issues, "error", "$.canonicalization", "canonicalization.unsupported", `Expected ${KEEL_CANONICALIZATION}.`);
  }
  if (manifest.id.trim().length === 0) issue(issues, "error", "$.id", "id.empty", "Manifest ID is required.");
  if (manifest.name.trim().length === 0) issue(issues, "error", "$.name", "name.empty", "Name is required.");

  const resourceIds = new Set<string>();
  for (const [index, resource] of manifest.resources.entries()) {
    if (resourceIds.has(resource.id)) issue(issues, "error", `$.resources[${index}].id`, "resource.duplicate", `Duplicate resource ${resource.id}.`);
    resourceIds.add(resource.id);
  }
  const aliases = new Set<string>();
  manifest.resources.forEach((resource, index) => validateResource(resource, index, resourceIds, aliases, issues));
  const resourcesById = new Map(manifest.resources.map((resource) => [resource.id, resource] as const));

  if (!resourceIds.has(manifest.entrypoint.resource)) {
    issue(issues, "error", "$.entrypoint.resource", "entrypoint.missing", "Entrypoint resource does not exist.");
  }
  if (!resourceIds.has(manifest.fallback.image)) {
    issue(issues, "error", "$.fallback.image", "fallback.missing", "Preview image resource does not exist.");
  }
  if (manifest.fallback.animation !== undefined && !resourceIds.has(manifest.fallback.animation)) {
    issue(issues, "error", "$.fallback.animation", "fallback.missing", "Fallback animation resource does not exist.");
  }

  for (const [index, download] of (manifest.downloads ?? []).entries()) {
    if (!resourceIds.has(download.resource)) {
      issue(issues, "error", `$.downloads[${index}].resource`, "download.missing", `Download references unknown resource ${download.resource}.`);
    }
  }

  if (manifest.revision.number < 1 || !Number.isSafeInteger(manifest.revision.number)) {
    issue(issues, "error", "$.revision.number", "revision.invalid", "Revision number must be a positive safe integer.");
  }
  if (
    manifest.revision.parent !== undefined &&
    (!Number.isSafeInteger(manifest.revision.parent) || manifest.revision.parent < 1 || manifest.revision.parent >= manifest.revision.number)
  ) {
    issue(issues, "error", "$.revision.parent", "revision.parent", "Parent must be an earlier positive revision.");
  }
  if (manifest.revision.parentDigest !== undefined) validateIntegrity(manifest.revision.parentDigest, "$.revision.parentDigest", issues);
  if (
    !Number.isSafeInteger(manifest.revision.compatibility.min) ||
    !Number.isSafeInteger(manifest.revision.compatibility.max) ||
    manifest.revision.compatibility.min < 1 ||
    manifest.revision.compatibility.max < manifest.revision.compatibility.min ||
    manifest.revision.compatibility.max > manifest.revision.number
  ) {
    issue(issues, "error", "$.revision.compatibility", "revision.compatibility", "Compatibility range must be ordered and cannot exceed the current revision.");
  }

  if (Number.isNaN(Date.parse(manifest.provenance.createdAt))) {
    issue(issues, "error", "$.provenance.createdAt", "date.invalid", "createdAt must be an ISO-compatible date.");
  }
  if (manifest.revision.activationTime !== undefined && Number.isNaN(Date.parse(manifest.revision.activationTime))) {
    issue(issues, "error", "$.revision.activationTime", "date.invalid", "activationTime must be an ISO-compatible date.");
  }
  if (manifest.provenance.collection !== undefined && !ADDRESS.test(manifest.provenance.collection)) {
    issue(issues, "error", "$.provenance.collection", "address.invalid", "collection must be an EVM address.");
  }
  if (
    manifest.provenance.chainId !== undefined &&
    (!Number.isSafeInteger(manifest.provenance.chainId) || manifest.provenance.chainId <= 0)
  ) {
    issue(issues, "error", "$.provenance.chainId", "chain.invalid", "chainId must be a positive safe integer.");
  }

  validateRuntime(manifest, issues);
  if (manifest.stakeObject !== undefined) {
    try {
      assertValidKeelStakeObject(
        manifest.stakeObject,
        resourcesById,
        new Set((manifest.stack?.components ?? []).map((component) => component.id)),
      );
      const gated = new Set(manifest.stakeObject.gatedResources.map((item) => item.resource));
      if (gated.has(manifest.entrypoint.resource)) {
        issue(issues, "error", "$.stakeObject.gatedResources", "stake.entrypoint", "The unstaked entrypoint cannot be gated.");
      }
      if (gated.has(manifest.fallback.image) || (manifest.fallback.animation !== undefined && gated.has(manifest.fallback.animation))) {
        issue(issues, "error", "$.stakeObject.gatedResources", "stake.fallback", "Fallback resources must remain available while unstaked.");
      }
    } catch (error) {
      issue(issues, "error", "$.stakeObject", "stake.invalid", error instanceof Error ? error.message : String(error));
    }
  }
  if (manifest.plugins !== undefined) validatePluginBindings(manifest.plugins, resourcesById, issues);
  if (manifest.libraries !== undefined) validateLibraryBindings(manifest.libraries, resourcesById, issues);
  if (manifest.stack !== undefined) validateProjectStack(manifest.stack, manifest, resourcesById, issues);
  if (manifest.build !== undefined) validateBuildProvenance(manifest.build, resourcesById, issues);
  if (manifest.contractPlugin !== undefined) validateContractPlugin(manifest.contractPlugin, resourcesById, manifest, issues);
  if (manifest.anchor !== undefined) validateAnchor(manifest.anchor, manifest, issues);
  if (manifest.attributions !== undefined) {
    try {
      assertValidKeelAttributions(manifest.attributions);
    } catch (error) {
      issue(issues, "error", "$.attributions", "attribution.invalid", error instanceof Error ? error.message : String(error));
    }
  }
  const communityReplication = manifest.extensions?.[KEEL_COMMUNITY_REPLICATION_EXTENSION_KEY];
  if (communityReplication !== undefined) {
    try {
      assertValidKeelCommunityReplicationPreference(communityReplication);
    } catch (error) {
      issue(
        issues,
        "error",
        `$.extensions.${KEEL_COMMUNITY_REPLICATION_EXTENSION_KEY}`,
        "community-replication.invalid",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  validateThumbnail(manifest, resourcesById, issues);
  validateMediaDerivatives(manifest, resourcesById, issues);
  detectCompositeCycles(manifest, issues);
  return { valid: !issues.some((item) => item.level === "error"), issues };
}

export function assertValidManifest(manifest: ArtifactManifest): void {
  const result = validateManifest(manifest);
  const errors = result.issues.filter((item) => item.level === "error");
  if (errors.length > 0) {
    throw new TypeError(errors.map((item) => `${item.path} [${item.code}]: ${item.message}`).join("\n"));
  }
}
