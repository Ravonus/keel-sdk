import {
  assertValidManifest,
  assertValidKeelIPControlExtension,
  bytesToUtf8,
  concatBytes,
  decodeBase64,
  decodeText,
  hexToBytes,
  toBufferSource,
  verifyIntegrity,
  type ArtifactManifest,
  type ArtifactResource,
  type Compression,
  type KeelIPControlAction,
  type KeelIPControlExtension,
  type ResourceSource,
  KEEL_IP_CONTROL_EXTENSION_KEY,
} from "@keel/protocol";
import { remoteUrlAllowed, sourceLocations } from "./source-policy.js";
import type {
  FetchLike,
  ResolveOptions,
  ResolvedArtifact,
  ResolvedResource,
  ResolutionAudit,
  ResolverAdapters,
  ResolverLimits,
  IPControlReadResult,
  IPControlResourceResult,
  ResolvedIPControl,
  SourceAuditEntry,
  StakeObjectReadResult,
  StakeObjectManagerProof,
  VerifiedLibraryAccess,
} from "./types.js";

const DEFAULT_LIMITS: ResolverLimits = {
  maxResourceBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxRecursionDepth: 32,
  maxResources: 512,
  timeoutMs: 30_000,
};

const IP_ACTION_BITS: Readonly<Record<KeelIPControlAction, number>> = {
  view: 1,
  download: 2,
  remint: 4,
  "mint-to-backpack": 8,
};


class ResolutionError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ResolutionError";
  }
}

interface MutableContext {
  readonly manifest: ArtifactManifest;
  readonly resourcesById: ReadonlyMap<string, ArtifactResource>;
  readonly adapters: ResolverAdapters;
  readonly limits: ResolverLimits;
  readonly options: ResolveOptions;
  readonly controller: AbortController;
  readonly startedAt: number;
  readonly entries: SourceAuditEntry[];
  readonly warnings: string[];
  readonly cache: Map<string, Promise<ResolvedResource>>;
  readonly active: Set<string>;
  totalBytes: number;
}

function now(adapters: ResolverAdapters): number {
  return adapters.now?.() ?? Date.now();
}

function positiveLimit(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
  return resolved;
}

function resolveLimits(manifest: ArtifactManifest, overrides: Partial<ResolverLimits> | undefined): ResolverLimits {
  const policy = manifest.runtime;
  const declared = {
    maxResourceBytes: positiveLimit(policy.maxResourceBytes, DEFAULT_LIMITS.maxResourceBytes, "maxResourceBytes"),
    maxTotalBytes: positiveLimit(policy.maxTotalBytes, DEFAULT_LIMITS.maxTotalBytes, "maxTotalBytes"),
    maxRecursionDepth: positiveLimit(policy.maxRecursionDepth, DEFAULT_LIMITS.maxRecursionDepth, "maxRecursionDepth"),
    maxResources: positiveLimit(policy.maxResources, DEFAULT_LIMITS.maxResources, "maxResources"),
    timeoutMs: positiveLimit(policy.timeoutMs, DEFAULT_LIMITS.timeoutMs, "timeoutMs"),
  };
  return {
    maxResourceBytes: Math.min(positiveLimit(overrides?.maxResourceBytes, declared.maxResourceBytes, "maxResourceBytes override"), declared.maxResourceBytes),
    maxTotalBytes: Math.min(positiveLimit(overrides?.maxTotalBytes, declared.maxTotalBytes, "maxTotalBytes override"), declared.maxTotalBytes),
    maxRecursionDepth: Math.min(positiveLimit(overrides?.maxRecursionDepth, declared.maxRecursionDepth, "maxRecursionDepth override"), declared.maxRecursionDepth),
    maxResources: Math.min(positiveLimit(overrides?.maxResources, declared.maxResources, "maxResources override"), declared.maxResources),
    timeoutMs: Math.min(positiveLimit(overrides?.timeoutMs, declared.timeoutMs, "timeoutMs override"), declared.timeoutMs),
  };
}

function linkAbortSignal(parent: AbortSignal | undefined, controller: AbortController): () => void {
  if (parent === undefined) return () => undefined;
  if (parent.aborted) {
    controller.abort(parent.reason);
    return () => undefined;
  }
  const listener = (): void => controller.abort(parent.reason);
  parent.addEventListener("abort", listener, { once: true });
  return () => parent.removeEventListener("abort", listener);
}

function rejectOnAbort(signal: AbortSignal): { readonly promise: Promise<never>; dispose(): void } {
  let listener: (() => void) | undefined;
  const reason = (): Error =>
    signal.reason instanceof Error ? signal.reason : new ResolutionError("Artifact resolution aborted.", "resolution.aborted");
  const promise = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(reason());
      return;
    }
    listener = (): void => reject(reason());
    signal.addEventListener("abort", listener, { once: true });
  });
  return {
    promise,
    dispose(): void {
      if (listener !== undefined) signal.removeEventListener("abort", listener);
    },
  };
}

async function readStreamWithLimit(
  stream: ReadableStream<Uint8Array>,
  maximum: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason ?? new Error("Artifact resolution aborted.");
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      total += chunk.byteLength;
      if (total > maximum) {
        throw new ResolutionError(`Decompressed resource exceeds ${maximum} bytes.`, "limit.decompressed-bytes");
      }
      parts.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return concatBytes(parts);
}

async function defaultDecompress(
  compression: Exclude<Compression, "none">,
  bytes: Uint8Array,
  maximum: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (compression === "brotli") {
    throw new ResolutionError("Brotli requires a resolver decompress adapter in this runtime.", "compression.adapter");
  }
  if (typeof globalThis.DecompressionStream !== "function") {
    throw new ResolutionError(`${compression} decompression is unavailable in this runtime.`, "compression.unavailable");
  }
  const format = compression === "deflate" ? "deflate" : "gzip";
  const stream = new Blob([toBufferSource(bytes)]).stream().pipeThrough(new DecompressionStream(format));
  return readStreamWithLimit(stream, maximum, signal);
}

async function decompress(
  compression: Compression | undefined,
  bytes: Uint8Array,
  adapters: ResolverAdapters,
  maximum: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (compression === undefined || compression === "none") return bytes;
  return adapters.decompress?.(compression, bytes) ?? defaultDecompress(compression, bytes, maximum, signal);
}

function defaultFetch(): FetchLike {
  if (typeof globalThis.fetch !== "function") {
    throw new ResolutionError("fetch() is unavailable; provide a fetch adapter.", "fetch.unavailable");
  }
  return globalThis.fetch as unknown as FetchLike;
}

function enforceSize(context: MutableContext, resourceId: string, bytes: Uint8Array): void {
  if (bytes.byteLength > context.limits.maxResourceBytes) {
    throw new ResolutionError(
      `Resource ${resourceId} is ${bytes.byteLength} bytes; limit is ${context.limits.maxResourceBytes}.`,
      "limit.resource-bytes",
    );
  }
  if (context.totalBytes + bytes.byteLength > context.limits.maxTotalBytes) {
    throw new ResolutionError(
      `Artifact would exceed total byte limit ${context.limits.maxTotalBytes}.`,
      "limit.total-bytes",
    );
  }
}

function auditEntry(
  context: MutableContext,
  entry: Omit<SourceAuditEntry, "elapsedMs"> & { readonly startedAt: number },
): void {
  const { startedAt, ...rest } = entry;
  context.entries.push({ ...rest, elapsedMs: Math.max(0, now(context.adapters) - startedAt) });
}

async function verifySource(
  source: ResourceSource,
  bytes: Uint8Array,
  adapters: ResolverAdapters,
): Promise<boolean> {
  const integrity = source.kind === "inline" || source.kind === "composite" ? source.integrity : source.integrity;
  if (integrity === undefined) return false;
  return verifyIntegrity(bytes, integrity, adapters.customDigest);
}

async function loadUriSource(
  context: MutableContext,
  resourceId: string,
  source: Extract<ResourceSource, { kind: "uri" }>,
): Promise<{ readonly bytes: Uint8Array; readonly location: string }> {
  if (context.options.allowUriSources === false) {
    throw new ResolutionError(`Declared URI retrieval is disabled for ${resourceId}.`, "source-network.disabled");
  }
  const fetcher = context.adapters.fetch ?? defaultFetch();
  const locations = sourceLocations(source, context.options);
  let lastError: unknown;

  for (const location of locations) {
    if (!remoteUrlAllowed(location, context.options.sourceAllowlist, context.options.allowPrivateNetworkSources)) {
      lastError = new ResolutionError(`URI is not permitted by the manifest allowlist: ${location}`, "network.denied");
      continue;
    }
    try {
      await context.adapters.authorizeRemoteSource?.(location, context.controller.signal);
      const response = await fetcher(location, { signal: context.controller.signal, redirect: "error" });
      if (!response.ok) {
        throw new ResolutionError(`HTTP ${response.status} ${response.statusText} for ${location}.`, "fetch.http");
      }
      const finalLocation = response.url || location;
      if (!remoteUrlAllowed(finalLocation, context.options.sourceAllowlist, context.options.allowPrivateNetworkSources)) {
        throw new ResolutionError(`Response location is not permitted: ${finalLocation}`, "network.redirect-denied");
      }
      await context.adapters.authorizeRemoteSource?.(finalLocation, context.controller.signal);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > context.limits.maxResourceBytes) {
        throw new ResolutionError(
          `Encoded resource ${resourceId} is ${bytes.byteLength} bytes; limit is ${context.limits.maxResourceBytes}.`,
          "limit.encoded-bytes",
        );
      }
      return { bytes, location: finalLocation };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new ResolutionError("All URI gateways failed.", "fetch.failed");
}

async function loadSource(
  context: MutableContext,
  resource: ArtifactResource,
  source: ResourceSource,
  depth: number,
): Promise<{ readonly bytes: Uint8Array; readonly location?: string }> {
  switch (source.kind) {
    case "inline":
      return { bytes: decodeText(source.data, source.encoding) };

    case "uri":
      return loadUriSource(context, resource.id, source);

    case "onchain": {
      const reader = context.adapters.readOnchainObject;
      if (reader === undefined) {
        throw new ResolutionError("On-chain source requires readOnchainObject adapter.", "onchain.adapter");
      }
      const bytes = await reader(
        { chainId: source.chainId, store: source.store, objectId: source.objectId, ...(source.chunks === undefined ? {} : { chunks: source.chunks }) },
        context.controller.signal,
      );
      return { bytes, location: `eip155:${source.chainId}:${source.store}/object/${source.objectId}` };
    }

    case "contract-call": {
      const caller = context.adapters.callContract;
      if (caller === undefined) {
        throw new ResolutionError("Contract-call source requires callContract adapter.", "contract-call.adapter");
      }
      const result = await caller(
        { chainId: source.chainId, to: source.to, data: source.data },
        context.controller.signal,
      );
      let bytes: Uint8Array;
      if (result instanceof Uint8Array) {
        bytes = result;
      } else if (source.decode === "base64") {
        bytes = decodeBase64(result);
      } else if (source.decode === "string") {
        bytes = new TextEncoder().encode(result);
      } else {
        bytes = hexToBytes(result);
      }
      return { bytes, location: `eip155:${source.chainId}:${source.to}/call/${source.data.slice(0, 10)}` };
    }

    case "composite": {
      if (depth >= context.limits.maxRecursionDepth) {
        throw new ResolutionError(`Composite recursion exceeded ${context.limits.maxRecursionDepth}.`, "limit.recursion");
      }
      const separator = new TextEncoder().encode(source.separator ?? "");
      const parts: Uint8Array[] = [];
      for (const [index, resourceId] of source.parts.entries()) {
        if (index > 0 && separator.byteLength > 0) parts.push(separator);
        parts.push((await resolveResourceInternal(context, resourceId, depth + 1)).bytes);
      }
      return { bytes: concatBytes(parts), location: `keel:composite:${source.parts.join(",")}` };
    }
  }
}

async function resolveResourceUncached(
  context: MutableContext,
  resourceId: string,
  depth: number,
): Promise<ResolvedResource> {
  if (depth > context.limits.maxRecursionDepth) {
    throw new ResolutionError(`Recursion exceeded ${context.limits.maxRecursionDepth}.`, "limit.recursion");
  }
  if (context.active.has(resourceId)) {
    throw new ResolutionError(`Recursive resource cycle at ${resourceId}.`, "resource.cycle");
  }
  const resource = context.resourcesById.get(resourceId);
  if (resource === undefined) throw new ResolutionError(`Unknown resource ${resourceId}.`, "resource.missing");

  context.active.add(resourceId);
  try {
    const sourceErrors: string[] = [];
    for (const [sourceIndex, source] of resource.sources.entries()) {
      const startedAt = now(context.adapters);
      try {
        const loaded = await loadSource(context, resource, source, depth);
        if (loaded.bytes.byteLength > context.limits.maxResourceBytes) {
          throw new ResolutionError(
            `Encoded resource ${resourceId} is ${loaded.bytes.byteLength} bytes; limit is ${context.limits.maxResourceBytes}.`,
            "limit.encoded-bytes",
          );
        }
        const compression = source.kind === "composite" ? undefined : source.compression;
        const bytes = await decompress(
          compression,
          loaded.bytes,
          context.adapters,
          context.limits.maxResourceBytes,
          context.controller.signal,
        );
        const verified = await verifySource(source, bytes, context.adapters);
        if (!verified) {
          throw new ResolutionError(`Integrity check failed for ${resourceId}.`, "integrity.failed");
        }

        // Verify first, then reserve decoded bytes synchronously. This prevents
        // concurrent resources from racing past the aggregate byte ceiling.
        enforceSize(context, resourceId, bytes);
        context.totalBytes += bytes.byteLength;
        auditEntry(context, {
          resourceId,
          sourceIndex,
          sourceKind: source.kind,
          status: "loaded",
          ...(loaded.location === undefined ? {} : { location: loaded.location }),
          byteLength: bytes.byteLength,
          integrityVerified: verified,
          startedAt,
        });
        return {
          resource,
          bytes,
          source,
          sourceIndex,
          mediaType: resource.mediaType,
          verified: true,
          ...(loaded.location === undefined ? {} : { location: loaded.location }),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sourceErrors.push(`${source.kind}: ${message}`);
        auditEntry(context, {
          resourceId,
          sourceIndex,
          sourceKind: source.kind,
          status: error instanceof ResolutionError && error.code.endsWith("denied") ? "rejected" : "failed",
          message,
          startedAt,
        });
      }
    }
    throw new ResolutionError(`No valid source for ${resourceId}: ${sourceErrors.join(" | ")}`, "source.exhausted");
  } finally {
    context.active.delete(resourceId);
  }
}

function resolveResourceInternal(context: MutableContext, resourceId: string, depth: number): Promise<ResolvedResource> {
  const existing = context.cache.get(resourceId);
  if (existing !== undefined) return existing;
  if (context.cache.size >= context.limits.maxResources) {
    return Promise.reject(
      new ResolutionError(`Artifact exceeds resource limit ${context.limits.maxResources}.`, "limit.resources"),
    );
  }
  const pending = resolveResourceUncached(context, resourceId, depth);
  context.cache.set(resourceId, pending);
  return pending;
}

async function verifyLibraryAccess(context: MutableContext): Promise<readonly VerifiedLibraryAccess[] | undefined> {
  const bindings = context.manifest.libraries;
  if (bindings === undefined) return undefined;
  const reader = context.adapters.readLibraryAccess;
  if (reader === undefined) {
    throw new ResolutionError(
      "This artifact uses reusable Library assets, but the host supplied no Library access verifier.",
      "library.adapter",
    );
  }
  return Promise.all(
    bindings.assets.map(async (reference): Promise<VerifiedLibraryAccess> => {
      const result = await reader(
        {
          reference,
          ...(context.options.libraryAccessAccount === undefined
            ? {}
            : { account: context.options.libraryAccessAccount }),
        },
        context.controller.signal,
      );
      if (
        result.policyCommitment.toLowerCase() !== reference.policyCommitment.toLowerCase() ||
        result.graphId.toLowerCase() !== reference.graph.graphId.toLowerCase() ||
        result.graphVersion !== reference.graph.version ||
        result.manifestDigest.toLowerCase() !== reference.manifestDigest.toLowerCase() ||
        result.resourceGraphDigest.toLowerCase() !== reference.resourceGraphDigest.toLowerCase()
      ) {
        throw new ResolutionError(
          `Library asset ${reference.id} no longer matches its exact manifest binding.`,
          "library.binding",
        );
      }
      if (!result.allowed) {
        throw new ResolutionError(
          `Library asset ${reference.id} requires access for policy r${reference.policyVersion}.`,
          "library.access",
        );
      }
      return { reference, verified: true };
    }),
  );
}

function sameCaseInsensitive(left: string | undefined, right: string | undefined): boolean {
  return left !== undefined && right !== undefined && left.toLowerCase() === right.toLowerCase();
}

function positiveSafe(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ResolutionError(`${label} is not a positive safe integer.`, "ip-control.value");
  }
  return value as number;
}

function validIPMode(value: unknown): value is ResolvedIPControl["resources"][number]["mode"] {
  return value === "open" || value === "allowlist" || value === "token" || value === "creator-grant" || value === "external-rule";
}

function ipControlUnavailable(
  declaration: KeelIPControlExtension,
  warning: string,
): { readonly state: ResolvedIPControl; readonly gatedResourceIds: readonly string[] } {
  const gatedResourceIds = declaration.resources.map((binding) => binding.resource);
  return {
    state: {
      declaration,
      verified: false,
      resources: [],
      deniedResourceIds: gatedResourceIds,
      warnings: [warning],
    },
    gatedResourceIds,
  };
}

function verifyIPControlResult(
  declaration: KeelIPControlExtension,
  result: IPControlReadResult,
): { readonly state: ResolvedIPControl; readonly gatedResourceIds: readonly string[] } {
  if (
    result.chain !== declaration.chain
    || result.chainId !== declaration.chainId
    || !sameCaseInsensitive(result.registry, declaration.registry)
    || (declaration.chain === "tezos" && !sameCaseInsensitive(result.licenseRegistry, declaration.licenseRegistry))
    || !sameCaseInsensitive(result.policyId, declaration.policyId)
    || !sameCaseInsensitive(result.objectId, declaration.objectId)
    || result.objectRevision !== declaration.objectRevision
    || !sameCaseInsensitive(result.license.licenseId, declaration.license.licenseId)
    || !sameCaseInsensitive(result.license.contentObjectId, declaration.license.contentObjectId)
    || !sameCaseInsensitive(result.license.decodedDigest, declaration.license.decodedDigest)
    || result.license.compression !== declaration.license.compression
  ) {
    throw new ResolutionError("IP-control result does not match the manifest's exact policy, object, or license binding.", "ip-control.binding");
  }
  positiveSafe(result.version, "ip-control.version");
  positiveSafe(result.license.decodedByteLength, "ip-control.license.decodedByteLength");
  positiveSafe(result.license.storedByteLength, "ip-control.license.storedByteLength");
  if (result.license.identifier.length === 0 || result.license.name.length === 0 || result.license.publisher.length === 0) {
    throw new ResolutionError("IP-control license metadata is incomplete.", "ip-control.license");
  }
  if (result.resources.length !== declaration.resources.length) {
    throw new ResolutionError("IP-control result does not cover every declared resource.", "ip-control.resources");
  }
  const byResource = new Map(result.resources.map((entry) => [entry.resource, entry] as const));
  const resources: IPControlResourceResult[] = [];
  const deniedResourceIds: string[] = [];
  for (const declarationResource of declaration.resources) {
    const resource = byResource.get(declarationResource.resource);
    if (resource === undefined) throw new ResolutionError(`IP-control result is missing ${declarationResource.resource}.`, "ip-control.resources");
    if (
      !sameCaseInsensitive(resource.objectId, declarationResource.objectId)
      || resource.objectRevision !== declarationResource.objectRevision
      || !validIPMode(resource.mode)
      || !Number.isSafeInteger(resource.actionMask)
      || resource.actionMask < 0
      || resource.actionMask > 15
    ) {
      throw new ResolutionError(`IP-control resource ${declarationResource.resource} is not an exact rule match.`, "ip-control.rule");
    }
    const declaredActions = new Set(declarationResource.actions);
    const allowedActions = [...new Set(resource.allowedActions)];
    if (allowedActions.some((action) => !declaredActions.has(action))) {
      throw new ResolutionError(`IP-control resource ${declarationResource.resource} returned an undeclared action.`, "ip-control.action");
    }
    for (const action of allowedActions) {
      const bit = IP_ACTION_BITS[action as KeelIPControlAction];
      if (typeof bit !== "number" || (resource.actionMask & bit) !== bit) {
        throw new ResolutionError(`IP-control resource ${declarationResource.resource} returned an action outside its live mask.`, "ip-control.action");
      }
    }
    if (resource.allowed !== allowedActions.includes("view")) {
      throw new ResolutionError(`IP-control resource ${declarationResource.resource} returned an inconsistent view decision.`, "ip-control.action");
    }
    // A resource without a live `view` permission must never be hydrated into
    // the generic artifact graph. Download/remint/backpack capabilities are
    // consumed by their action executors and do not grant render-time bytes.
    if (!resource.allowed) deniedResourceIds.push(declarationResource.resource);
    resources.push({
      ...resource,
      allowedActions,
      ...(resource.currentAccount === undefined ? {} : { currentAccount: resource.currentAccount }),
    });
  }
  return {
    state: {
      declaration,
      verified: true,
      license: result.license,
      creator: result.creator,
      version: result.version,
      configFrozen: result.configFrozen,
      resources,
      deniedResourceIds,
      warnings: [],
      ...(result.blockNumber === undefined ? {} : { blockNumber: result.blockNumber }),
      ...(result.blockHash === undefined ? {} : { blockHash: result.blockHash }),
    },
    gatedResourceIds: deniedResourceIds,
  };
}

async function resolveIPControlState(
  manifest: ArtifactManifest,
  options: ResolveOptions,
  adapters: ResolverAdapters,
  signal: AbortSignal,
): Promise<{ readonly state?: ResolvedIPControl; readonly gatedResourceIds: readonly string[] }> {
  const raw = manifest.extensions?.[KEEL_IP_CONTROL_EXTENSION_KEY];
  if (raw === undefined) return { gatedResourceIds: [] };
  const declaration = raw as KeelIPControlExtension;
  assertValidKeelIPControlExtension(
    declaration,
    new Set(manifest.resources.map((resource) => resource.id)),
  );
  const reader = adapters.readIPControl;
  if (reader === undefined) {
    return ipControlUnavailable(
      declaration,
      "IP-control proof was declared but the host supplied no chain reader; controlled resources remain withheld.",
    );
  }
  try {
    const result = await reader(
      {
        declaration,
        ...(options.ipControlAccount === undefined ? {} : { account: options.ipControlAccount }),
      },
      signal,
    );
    return verifyIPControlResult(declaration, result);
  } catch (error) {
    return ipControlUnavailable(
      declaration,
      `IP-control proof could not be verified; controlled resources remain withheld: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const DEFAULT_STAKE_LOCKUP = { mode: "none" } as const;
const DEFAULT_OFFICIAL_MANAGER = { mode: "official" } as const;

function sameText(left: string | undefined, right: string | undefined): boolean {
  return left !== undefined && right !== undefined && left.toLowerCase() === right.toLowerCase();
}

function stakeCounter(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ResolutionError(`${label} is not a safe non-negative counter.`, "stake.counter");
  }
  return value as number;
}

function sameLockup(
  left: StakeObjectReadResult["lockup"],
  right: StakeObjectReadResult["lockup"],
): boolean {
  if (left.mode !== right.mode) return false;
  if (left.mode === "minimum-duration" && right.mode === "minimum-duration") return left.seconds === right.seconds;
  return true;
}

async function resolveStakeObjectState(
  manifest: ArtifactManifest,
  options: ResolveOptions,
  adapters: ResolverAdapters,
  signal: AbortSignal,
): Promise<import("./types.js").ResolvedStakeObject | undefined> {
  const declaration = manifest.stakeObject;
  if (declaration === undefined) return undefined;
  const gatedResourceIds = declaration.gatedResources.map((item) => item.resource);
  const lockup = declaration.lockup ?? DEFAULT_STAKE_LOCKUP;
  const managerPolicy = declaration.managerPolicy ?? DEFAULT_OFFICIAL_MANAGER;
  const reader = options.stakeObjectReader ?? adapters.readStakeObject;
  if (reader === undefined) {
    return {
      declaration,
      active: false,
      slot: declaration.gatedResources.find((item) => item.resource === declaration.stakedEntrypoint.resource)?.slot ?? 0,
      lockup,
      counters: { objectTokenLifetime: 0, objectLifetime: 0, objectActive: 0, tokenLifetime: 0, tokenActive: 0, globalLifetime: 0, globalActive: 0 },
      managerPolicy,
      managerVerified: false,
      gatedResourceIds,
    };
  }
  const stakedTokenId = options.stakeObjectTokenId ?? declaration.stakedTokenId;
  const result = await reader(
    {
      chain: declaration.chain,
      stakeObjectId: declaration.stakeObjectId,
      hostCollection: declaration.hostCollection,
      hostTokenId: declaration.hostTokenId,
      stakedTokenId,
    },
    signal,
  );
  const managerProof: StakeObjectManagerProof | undefined = result.managerProof
    ?? (adapters.readStakeObjectManagerProof === undefined
      ? undefined
      : await adapters.readStakeObjectManagerProof(
          { chain: declaration.chain, manager: declaration.chain.manager },
          signal,
        ));
  if (
    result.viewerId.toLowerCase() !== declaration.viewerId.toLowerCase()
    || !sameText(result.hostCollection, declaration.hostCollection)
    || result.hostTokenId !== declaration.hostTokenId
  ) {
    throw new ResolutionError("Stake manager state does not match the manifest's host/viewer binding.", "stake.binding");
  }
  const entrypointSlot = declaration.gatedResources.find(
    (item) => item.resource === declaration.stakedEntrypoint.resource,
  )?.slot;
  if (entrypointSlot !== undefined && result.slot !== entrypointSlot) {
    throw new ResolutionError("Stake manager slot does not match the manifest's staked entrypoint slot.", "stake.slot");
  }
  const entrypointBinding = declaration.gatedResources.find(
    (item) => item.resource === declaration.stakedEntrypoint.resource,
  );
  if (
    entrypointBinding?.objectId === undefined
    || entrypointBinding.objectRevision === undefined
    || !sameText(result.codeObjectId, entrypointBinding.objectId)
    || result.codeObjectRevision !== entrypointBinding.objectRevision
    || !sameText(result.runtimeSeed, declaration.runtime.seed)
    || !sameText(result.argumentsDigest, declaration.runtime.argumentsDigest)
    || !sameText(result.variablesDigest, declaration.runtime.variablesDigest)
    || !sameText(result.runtimeDigest, declaration.runtime.runtimeDigest)
  ) {
    throw new ResolutionError("Stake manager runtime does not match the manifest's code, seed, arguments, and variables commitments.", "stake.runtime");
  }
  if (!sameLockup(result.lockup, lockup)) {
    throw new ResolutionError("Stake manager lockup rules do not match the manifest declaration.", "stake.lockup");
  }
  if (managerProof === undefined || !sameText(managerProof.manager, declaration.chain.manager) || managerProof.immutable !== true) {
    throw new ResolutionError("Stake manager has no verified immutable proof.", "stake.manager");
  }
  if (managerPolicy.mode === "verified-custom") {
    const readPolicy = result.managerPolicy;
    if (
      managerProof.proofClass !== "verified-custom"
      || managerProof.paid !== true
      || result.managerVerified !== true
      || readPolicy?.mode !== "verified-custom"
    ) {
      throw new ResolutionError("Custom stake manager has no verified immutable adapter proof.", "stake.manager");
    }
    if (
      managerProof.adapterId !== managerPolicy.adapterId
      || managerProof.adapterVersion !== managerPolicy.adapterVersion
      || managerProof.codeHash.toLowerCase() !== managerPolicy.immutableCodeHash.toLowerCase()
      || managerProof.evidenceDigest?.toLowerCase() !== managerPolicy.evidenceDigest.toLowerCase()
      || managerProof.reviewReceipt?.toLowerCase() !== managerPolicy.reviewReceipt.toLowerCase()
      || managerProof.feeReceipt?.toLowerCase() !== managerPolicy.feeReceipt.toLowerCase()
      || readPolicy.adapterId !== managerPolicy.adapterId
      || readPolicy.adapterVersion !== managerPolicy.adapterVersion
      || readPolicy.immutableCodeHash.toLowerCase() !== managerPolicy.immutableCodeHash.toLowerCase()
      || readPolicy.evidenceDigest.toLowerCase() !== managerPolicy.evidenceDigest.toLowerCase()
      || readPolicy.reviewReceipt.toLowerCase() !== managerPolicy.reviewReceipt.toLowerCase()
      || readPolicy.feeReceipt.toLowerCase() !== managerPolicy.feeReceipt.toLowerCase()
    ) throw new ResolutionError("Custom stake manager proof does not match the committed adapter declaration.", "stake.manager");
  } else if (managerProof.proofClass !== "official" || result.managerVerified === false) {
    throw new ResolutionError("The official Keel stake manager was not verified by the host adapter.", "stake.manager");
  }
  const counters = {
    objectTokenLifetime: stakeCounter(result.counters.objectTokenLifetime, "stake.objectTokenLifetime"),
    objectLifetime: stakeCounter(result.counters.objectLifetime, "stake.objectLifetime"),
    objectActive: stakeCounter(result.counters.objectActive, "stake.objectActive"),
    tokenLifetime: stakeCounter(result.counters.tokenLifetime, "stake.tokenLifetime"),
    tokenActive: stakeCounter(result.counters.tokenActive, "stake.tokenActive"),
    globalLifetime: stakeCounter(result.counters.globalLifetime, "stake.globalLifetime"),
    globalActive: stakeCounter(result.counters.globalActive, "stake.globalActive"),
  } as const;
  if (result.active && (result.staker === undefined || result.activeTokenId !== stakedTokenId)) {
    throw new ResolutionError("Active stake state does not identify the selected token and staker.", "stake.state");
  }
  return {
    declaration,
    active: result.active,
    stakedTokenId,
    ...(result.staker === undefined ? {} : { staker: result.staker }),
    ...(result.controller === undefined ? {} : { controller: result.controller }),
    ...(result.hostOwner === undefined ? {} : { hostOwner: result.hostOwner }),
    ...(result.stakedCollection === undefined ? {} : { stakedCollection: result.stakedCollection }),
    ...(result.activeTokenId === undefined ? {} : { activeTokenId: result.activeTokenId }),
    ...(result.tokenOwner === undefined ? {} : { tokenOwner: result.tokenOwner }),
    ...(result.startedAt === undefined ? {} : { startedAt: result.startedAt }),
    slot: result.slot,
    lockup,
    counters,
    managerPolicy,
    managerVerified: true,
    managerProof,
    ...(result.runtimeDigest === undefined ? {} : { runtimeDigest: result.runtimeDigest }),
    ...(result.codeObjectId === undefined ? {} : { codeObjectId: result.codeObjectId }),
    ...(result.codeObjectRevision === undefined ? {} : { codeObjectRevision: result.codeObjectRevision }),
    ...(result.runtimeSeed === undefined ? {} : { runtimeSeed: result.runtimeSeed }),
    ...(result.argumentsDigest === undefined ? {} : { argumentsDigest: result.argumentsDigest }),
    ...(result.variablesDigest === undefined ? {} : { variablesDigest: result.variablesDigest }),
    gatedResourceIds,
  };
}

export async function resolveArtifact(manifest: ArtifactManifest, options: ResolveOptions = {}): Promise<ResolvedArtifact> {
  assertValidManifest(manifest);
  if (manifest.runtime.content.manifestTrust === "registry" && options.commitment?.registry?.verified !== true) {
    throw new ResolutionError(
      "This manifest requires a KeelIndex proof before resources can be resolved.",
      "anchor.required",
    );
  }
  const adapters = options.adapters ?? {};
  const ipControlResult = await resolveIPControlState(
    manifest,
    options,
    adapters,
    options.signal ?? new AbortController().signal,
  );
  const stakeObject = await resolveStakeObjectState(
    manifest,
    options,
    adapters,
    options.signal ?? new AbortController().signal,
  );
  const skipped = new Set(options.skipResourceIds ?? []);
  for (const resourceId of ipControlResult.gatedResourceIds) skipped.add(resourceId);
  if (stakeObject !== undefined && !stakeObject.active) {
    for (const resourceId of stakeObject.gatedResourceIds) skipped.add(resourceId);
  }
  const resourcesById = new Map(
    manifest.resources
      .filter((resource) => !skipped.has(resource.id))
      .map((resource) => [resource.id, resource] as const),
  );
  const limits = resolveLimits(manifest, options.limits);
  const controller = new AbortController();
  const unlink = linkAbortSignal(options.signal, controller);
  const startedAt = now(adapters);
  const timeout = setTimeout(
    () => controller.abort(new ResolutionError("Artifact resolution timed out.", "resolution.timeout")),
    limits.timeoutMs,
  );
  const abortGate = rejectOnAbort(controller.signal);
  const context: MutableContext = {
    manifest,
    resourcesById,
    adapters,
    limits,
    options,
    controller,
    startedAt,
    entries: [],
    warnings: [],
    cache: new Map(),
    active: new Set(),
    totalBytes: 0,
  };
  if (options.commitment === undefined) {
    context.warnings.push(
      manifest.runtime.content.manifestTrust === "digest"
        ? "Manifest bytes were supplied directly without a verified external digest. This is development-only trust."
        : "Registry commitment was not supplied.",
    );
  } else if (manifest.anchor !== undefined && options.commitment.registry === undefined) {
    context.warnings.push("Manifest declares a registry anchor, but this resolution used digest-only trust.");
  }
  if (stakeObject !== undefined && !stakeObject.managerVerified) {
    context.warnings.push("Stake object state was not read from a verified manager; gated resources remain withheld.");
  }
  if (ipControlResult.state !== undefined) {
    context.warnings.push(...ipControlResult.state.warnings);
  }

  const resolution = async (): Promise<ResolvedArtifact> => {
    const libraryAccess = await verifyLibraryAccess(context);
    const entrypointId = stakeObject?.active === true
      ? stakeObject.declaration.stakedEntrypoint.resource
      : manifest.entrypoint.resource;
    if (!resourcesById.has(entrypointId)) {
      throw new ResolutionError(`Stake entrypoint ${entrypointId} is not available for this state.`, "stake.entrypoint");
    }
    const entrypoint = await resolveResourceInternal(context, entrypointId, 0);
    const requiredIds = new Set<string>(resourcesById.keys());
    await Promise.all([...requiredIds].map((id) => resolveResourceInternal(context, id, 0)));

    const resolved = new Map<string, ResolvedResource>();
    for (const [id, pending] of context.cache) resolved.set(id, await pending);
    const completedAt = now(adapters);
    const audit: ResolutionAudit = {
      schema: "keel-resolution-audit@2",
      manifestId: manifest.id,
      ...(options.commitment === undefined ? {} : { manifestDigest: options.commitment.integrity.digest }),
      anchorVerified: options.commitment?.registry?.verified === true,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date(completedAt).toISOString(),
      totalBytes: context.totalBytes,
      resolvedResources: resolved.size,
      entries: context.entries,
      warnings: context.warnings,
      ...(ipControlResult.state === undefined
        ? {}
        : {
            ipControl: {
              status: ipControlResult.state.verified ? ("verified" as const) : ("unavailable" as const),
              policyId: ipControlResult.state.declaration.policyId,
              licenseId: ipControlResult.state.declaration.license.licenseId,
              deniedResourceIds: ipControlResult.state.deniedResourceIds,
            },
          }),
    };
    return {
      manifest,
      entrypoint,
      resources: resolved,
      ...(stakeObject === undefined ? {} : { stakeObject }),
      ...(options.commitment === undefined ? {} : { commitment: options.commitment }),
      ...(libraryAccess === undefined ? {} : { libraryAccess }),
      ...(ipControlResult.state === undefined ? {} : { ipControl: ipControlResult.state }),
      audit,
    };
  };

  try {
    return await Promise.race([resolution(), abortGate.promise]);
  } finally {
    clearTimeout(timeout);
    abortGate.dispose();
    unlink();
  }
}

export function resourceText(resource: ResolvedResource): string {
  return bytesToUtf8(resource.bytes);
}
