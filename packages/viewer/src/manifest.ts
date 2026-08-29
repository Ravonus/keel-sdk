import {
  parseArtifactManifest,
  bytesToUtf8,
  canonicalJson,
  utf8ToBytes,
  verifyIntegrity,
  type KeelIndexAnchor,
  type Hex,
  type Integrity,
} from "@keel/protocol";
import { resolveArtifact } from "./resolver.js";
import { remoteUrlAllowed, uriLocations } from "./source-policy.js";
import { parseKeelWakeUri, verifyKeelWakeObjectRead } from "./wake-adapter.js";
import type {
  ArtifactPresentationResult,
  FetchLike,
  LoadedArtifactManifest,
  ManifestLoadOptions,
  ResolveManifestOptions,
  ResolvedArtifact,
} from "./types.js";

const DEFAULT_MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DIGEST = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const KEEL_ONCHAIN_MANIFEST_PROTOCOL = "keel-onchain:";

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw new RangeError(`${label} must be a positive safe integer.`);
  return result;
}

function defaultFetch(): FetchLike {
  if (typeof globalThis.fetch !== "function") throw new Error("fetch() is unavailable; provide a fetch adapter.");
  return globalThis.fetch as unknown as FetchLike;
}

function expectedIntegrity(value: Integrity | Hex): Integrity {
  const integrity = typeof value === "string" ? { algorithm: "sha256" as const, digest: value } : value;
  if (integrity.algorithm !== "sha256") throw new TypeError("Manifest registry digests must use SHA-256.");
  if (!DIGEST.test(integrity.digest) || integrity.digest !== integrity.digest.toLowerCase()) {
    throw new TypeError("Expected manifest digest must be lower-case bytes32 hex.");
  }
  return integrity;
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

function abortPromise(signal: AbortSignal): { readonly promise: Promise<never>; dispose(): void } {
  let listener: (() => void) | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    const fail = (): void => reject(signal.reason instanceof Error ? signal.reason : new Error("Manifest load aborted."));
    if (signal.aborted) return fail();
    listener = fail;
    signal.addEventListener("abort", listener, { once: true });
  });
  return {
    promise,
    dispose(): void {
      if (listener !== undefined) signal.removeEventListener("abort", listener);
    },
  };
}

function directoryUrl(url: string): string {
  return new URL(".", url).toString();
}

function onchainManifestRequest(uri: string): { readonly chainId: number; readonly store: Hex; readonly objectId: Hex } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== KEEL_ONCHAIN_MANIFEST_PROTOCOL) return undefined;
  if (parsed.username.length > 0 || parsed.password.length > 0 || parsed.port.length > 0 || parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new TypeError("Onchain manifest URI cannot contain credentials, a port, query, or fragment.");
  }
  const chainId = Number(parsed.hostname);
  const segments = parsed.pathname.split("/").filter(Boolean);
  const store = segments[0];
  const objectId = segments[1];
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || segments.length !== 2 || store === undefined || !ADDRESS.test(store) || objectId === undefined || !DIGEST.test(objectId)) {
    throw new TypeError("Onchain manifest URI must be keel-onchain://<chainId>/<lowercase-store>/<objectId>.");
  }
  return { chainId, store: store as Hex, objectId: objectId as Hex };
}

async function parsedManifest(
  bytes: Uint8Array,
  integrity: Integrity,
  sourceUrl: string,
  options: ManifestLoadOptions,
): Promise<LoadedArtifactManifest> {
  const text = bytesToUtf8(bytes).replace(/^\uFEFF/, "");
  const parsed = JSON.parse(text) as unknown;
  const manifest = parseArtifactManifest(parsed);
  const canonical = utf8ToBytes(canonicalJson(manifest));
  if (!(await verifyIntegrity(canonical, integrity, options.adapters?.customDigest))) {
    throw new Error("RFC 8785 canonical manifest digest does not match the committed digest.");
  }
  const commitment = {
    integrity,
    digestVerified: true as const,
    sourceUrl,
  };
  return {
    manifest,
    integrity,
    integrityVerified: true,
    commitment,
    sourceUrl,
    baseUrl: directoryUrl(sourceUrl),
    byteLength: bytes.byteLength,
  };
}

function sameAnchor(left: KeelIndexAnchor, right: KeelIndexAnchor): boolean {
  const rightCollectionScope = right.scope === "collection" && right.tokenId === "*";
  return (
    left.protocol === right.protocol &&
    left.kind === right.kind &&
    left.chainId === right.chainId &&
    left.registry.toLowerCase() === right.registry.toLowerCase() &&
    left.collection.toLowerCase() === right.collection.toLowerCase() &&
    (rightCollectionScope || left.tokenId === right.tokenId) &&
    (left.revision === undefined || right.revision === undefined || left.revision === right.revision)
  );
}

function validatePresentation(anchor: KeelIndexAnchor, presentation: ArtifactPresentationResult): void {
  if (!DIGEST.test(presentation.manifestDigest)) throw new TypeError("KeelIndex returned an invalid manifest digest.");
  if (!Number.isSafeInteger(presentation.revision) || presentation.revision < 1) {
    throw new TypeError("KeelIndex returned an invalid revision.");
  }
  if (anchor.revision !== undefined && anchor.revision !== presentation.revision) {
    throw new Error(`KeelIndex revision ${presentation.revision} does not match required revision ${anchor.revision}.`);
  }
  if (presentation.manifestURI.length === 0) throw new Error("KeelIndex returned an empty manifest URI.");
}

export async function loadArtifactManifest(
  uri: string,
  expected: Integrity | Hex,
  options: ManifestLoadOptions = {},
): Promise<LoadedArtifactManifest> {
  const integrity = expectedIntegrity(expected);
  const maxBytes = positiveInteger(options.maxManifestBytes, DEFAULT_MAX_MANIFEST_BYTES, "maxManifestBytes");
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
  const controller = new AbortController();
  const unlink = linkAbortSignal(options.signal, controller);
  const timeout = setTimeout(() => controller.abort(new Error("Manifest load timed out.")), timeoutMs);
  const gate = abortPromise(controller.signal);
  let lastError: unknown;

  const load = async (): Promise<LoadedArtifactManifest> => {
    const wake = parseKeelWakeUri(uri);
    if (wake !== undefined) {
      if (wake.kind !== "object") {
        throw new TypeError("KEEL Wake chunk URIs are transport-only and cannot be used as manifest locators.");
      }
      const reader = options.adapters?.readWakeObject;
      if (reader === undefined) throw new Error("KEEL Wake URI requires a readWakeObject adapter.");
      const result = await reader({
        chainId: wake.chainId,
        coordinator: wake.coordinator,
        publicationId: wake.publicationId,
        expectedIntegrity: integrity,
      }, controller.signal);
      const provenance = await verifyKeelWakeObjectRead(wake, result);
      if (result.bytes.byteLength > maxBytes) throw new RangeError(`Manifest exceeds ${maxBytes} bytes.`);
      const loaded = await parsedManifest(result.bytes, integrity, uri, options);
      return {
        ...loaded,
        commitment: {
          ...loaded.commitment,
          wake: provenance,
        },
      };
    }
    const onchain = onchainManifestRequest(uri);
    if (onchain !== undefined) {
      const reader = options.adapters?.readOnchainObject;
      if (reader === undefined) throw new Error("Onchain manifest URI requires a readOnchainObject adapter.");
      const bytes = await reader(onchain, controller.signal);
      if (bytes.byteLength > maxBytes) throw new RangeError(`Manifest exceeds ${maxBytes} bytes.`);
      return parsedManifest(bytes, integrity, uri, options);
    }
    const fetcher = options.adapters?.fetch ?? defaultFetch();
    for (const location of uriLocations(uri, options)) {
      if (!remoteUrlAllowed(location, options.sourceAllowlist, options.allowPrivateNetworkSources)) {
        lastError = new Error(`Manifest source is not permitted: ${location}`);
        continue;
      }
      try {
        await options.adapters?.authorizeRemoteSource?.(location, controller.signal);
        const response = await fetcher(location, { signal: controller.signal, redirect: "error" });
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText} for ${location}.`);
        const sourceUrl = response.url || location;
        if (!remoteUrlAllowed(sourceUrl, options.sourceAllowlist, options.allowPrivateNetworkSources)) {
          throw new Error(`Manifest response location is not permitted: ${sourceUrl}`);
        }
        await options.adapters?.authorizeRemoteSource?.(sourceUrl, controller.signal);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > maxBytes) throw new RangeError(`Manifest exceeds ${maxBytes} bytes.`);
        return parsedManifest(bytes, integrity, sourceUrl, options);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("No manifest source could be loaded.");
  };

  try {
    return await Promise.race([load(), gate.promise]);
  } finally {
    clearTimeout(timeout);
    gate.dispose();
    unlink();
  }
}

/**
 * Resolve the active (or exact) KeelIndex presentation before fetching
 * the manifest. This produces the full chain: contract -> manifest digest ->
 * resource digest -> decoded bytes.
 */
export async function loadArtifactManifestFromRegistry(
  anchor: KeelIndexAnchor,
  options: ManifestLoadOptions = {},
): Promise<LoadedArtifactManifest> {
  const reader = options.adapters?.readArtifactPresentation;
  if (reader === undefined) throw new Error("Registry anchoring requires a readArtifactPresentation adapter.");

  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
  const controller = new AbortController();
  const unlink = linkAbortSignal(options.signal, controller);
  const timeout = setTimeout(() => controller.abort(new Error("KeelIndex read timed out.")), timeoutMs);
  try {
    const presentation = await reader(
      {
        chainId: anchor.chainId,
        registry: anchor.registry,
        collection: anchor.collection,
        tokenId: anchor.tokenId,
        ...(anchor.revision === undefined ? {} : { revision: anchor.revision }),
      },
      controller.signal,
    );
    validatePresentation(anchor, presentation);
    const loaded = await loadArtifactManifest(presentation.manifestURI, presentation.manifestDigest, {
      ...options,
      signal: controller.signal,
    });
    if (loaded.manifest.anchor === undefined) {
      throw new Error("Registry-trusted manifest does not declare its KeelIndex anchor.");
    }
    if (!sameAnchor(anchor, loaded.manifest.anchor)) {
      throw new Error("Manifest KeelIndex anchor does not match the contract request.");
    }
    if (loaded.manifest.revision.number !== presentation.revision) {
      throw new Error("Manifest revision does not match the KeelIndex revision.");
    }
    return {
      ...loaded,
      commitment: {
        ...loaded.commitment,
        registry: {
          anchor: loaded.manifest.anchor,
          driveAnchor: anchor,
          presentation,
          verified: true,
        },
      },
    };
  } finally {
    clearTimeout(timeout);
    unlink();
  }
}

export async function resolveArtifactFromManifestUri(
  uri: string,
  expected: Integrity | Hex,
  options: ResolveManifestOptions = {},
): Promise<ResolvedArtifact> {
  const loaded = await loadArtifactManifest(uri, expected, options);
  return resolveLoadedManifest(loaded, options);
}

export async function resolveArtifactFromRegistry(
  anchor: KeelIndexAnchor,
  options: ResolveManifestOptions = {},
): Promise<ResolvedArtifact> {
  const loaded = await loadArtifactManifestFromRegistry(anchor, options);
  return resolveLoadedManifest(loaded, options);
}

async function resolveLoadedManifest(
  loaded: LoadedArtifactManifest,
  options: ResolveManifestOptions,
): Promise<ResolvedArtifact> {
  const configured = options.resolver ?? {};
  const sharedAdapters = options.adapters;
  const resolverAdapters = {
    ...(sharedAdapters ?? {}),
    ...(configured.adapters ?? {}),
  };
  const sourceAllowlist = configured.sourceAllowlist ?? options.sourceAllowlist;
  const ipfsGateways = configured.ipfsGateways ?? options.ipfsGateways;
  const ipnsGateways = configured.ipnsGateways ?? options.ipnsGateways;
  const arweaveGateways = configured.arweaveGateways ?? options.arweaveGateways;
  const allowPrivateNetworkSources =
    configured.allowPrivateNetworkSources ?? options.allowPrivateNetworkSources;
  return resolveArtifact(loaded.manifest, {
    ...configured,
    adapters: resolverAdapters,
    baseUrl: loaded.baseUrl,
    commitment: loaded.commitment,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(sourceAllowlist === undefined ? {} : { sourceAllowlist }),
    ...(ipfsGateways === undefined ? {} : { ipfsGateways }),
    ...(ipnsGateways === undefined ? {} : { ipnsGateways }),
    ...(arweaveGateways === undefined ? {} : { arweaveGateways }),
    ...(allowPrivateNetworkSources === undefined ? {} : { allowPrivateNetworkSources }),
  });
}
