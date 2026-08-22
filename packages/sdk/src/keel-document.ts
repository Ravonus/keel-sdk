import {
  chunkBytes,
  createIntegrity,
  type Integrity,
} from "@keel/protocol";
import type { Address, Hex, KeelViewerSlots } from "./types.js";
import { validateKeelViewerSlots } from "./keel.js";

/** A network-scoped document is resolved once and then consumed by every viewer. */
export const KEEL_NETWORK_DOCUMENT_PROTOCOL = "keel-network-document@1" as const;
export const KEEL_VIEWER_COMPOSITION_PROTOCOL = "keel-viewer-composition@1" as const;
export const KEEL_CHUNK_PLAN_PROTOCOL = "keel-chunk-plan@1" as const;

export type KeelNetworkFamily = "ethereum" | "tezos";

export interface KeelNetworkTarget {
  readonly alias: string;
  readonly family: KeelNetworkFamily;
  readonly network: string;
  readonly caip2: string;
  readonly chainId?: number;
  readonly version: number;
}

/** Built-in route names. Deployments may add a custom target, for example local Anvil. */
export const KEEL_NETWORKS: Readonly<Record<string, KeelNetworkTarget>> = Object.freeze({
  eth: { alias: "eth", family: "ethereum", network: "mainnet", caip2: "eip155:1", chainId: 1, version: 1 },
  "sepolia-eth": {
    alias: "sepolia-eth",
    family: "ethereum",
    network: "sepolia",
    caip2: "eip155:11155111",
    chainId: 11155111,
    version: 1,
  },
  base: { alias: "base", family: "ethereum", network: "mainnet", caip2: "eip155:8453", chainId: 8453, version: 1 },
  "base-sepolia": {
    alias: "base-sepolia",
    family: "ethereum",
    network: "sepolia",
    caip2: "eip155:84532",
    chainId: 84532,
    version: 1,
  },
  tez: { alias: "tez", family: "tezos", network: "mainnet", caip2: "tezos:NetXdQprcVkpaWU", version: 1 },
  "ghostnet-tez": {
    alias: "ghostnet-tez",
    family: "tezos",
    network: "ghostnet",
    caip2: "tezos:NetXjD3HPJJjmcd",
    version: 1,
  },
});

const NETWORK_ALIAS = /^[a-z][a-z0-9-]{0,63}$/u;
const VERSION_SEGMENT = /^v([1-9][0-9]*)$/u;

function positiveVersion(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive safe integer.`);
  return value;
}

function safeAlias(value: string, label: string): string {
  if (!NETWORK_ALIAS.test(value)) throw new TypeError(`${label} must be a lower-case network alias.`);
  return value;
}

function safePath(value: string, label: string, allowEmpty = false): string {
  const normalized = value.replace(/^\/+|\/+$/gu, "");
  if (!allowEmpty && normalized.length === 0) throw new TypeError(`${label} cannot be empty.`);
  if (normalized.length > 512 || normalized.includes("\\") || normalized.includes("?") || normalized.includes("#")) {
    throw new TypeError(`${label} is not a safe Keel path.`);
  }
  const parts = normalized.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new TypeError(`${label} contains an unsafe path segment.`);
  }
  return normalized;
}

export function normalizeKeelNetwork(
  input: string | KeelNetworkTarget,
): KeelNetworkTarget {
  const target = typeof input === "string" ? KEEL_NETWORKS[input] : input;
  if (target === undefined) throw new Error(`Unknown Keel network target ${String(input)}.`);
  const alias = safeAlias(target.alias, "network.alias");
  const version = positiveVersion(target.version, "network.version");
  if (target.family !== "ethereum" && target.family !== "tezos") {
    throw new TypeError("network.family must be ethereum or tezos.");
  }
  if (target.network.length === 0 || target.caip2.length === 0) throw new TypeError("network identity is required.");
  if (target.family === "ethereum" && (!Number.isSafeInteger(target.chainId) || (target.chainId ?? 0) <= 0)) {
    throw new TypeError("Ethereum network targets require a positive chainId.");
  }
  return {
    ...target,
    alias,
    version,
    ...(target.chainId === undefined ? {} : { chainId: target.chainId }),
  };
}

export interface KeelNetworkDocument {
  readonly protocol: typeof KEEL_NETWORK_DOCUMENT_PROTOCOL;
  readonly defaultNetwork: string;
  readonly defaultVersion: number;
  readonly family: KeelNetworkFamily;
  readonly caip2: string;
  readonly chainId?: number;
  readonly routePrefix: string;
}

export function createKeelNetworkDocument(
  input: string | KeelNetworkTarget,
  version = typeof input === "string" ? normalizeKeelNetwork(input).version : input.version,
): KeelNetworkDocument {
  const target = normalizeKeelNetwork(input);
  const defaultVersion = positiveVersion(version, "document.defaultVersion");
  return {
    protocol: KEEL_NETWORK_DOCUMENT_PROTOCOL,
    defaultNetwork: target.alias,
    defaultVersion,
    family: target.family,
    caip2: target.caip2,
    ...(target.chainId === undefined ? {} : { chainId: target.chainId }),
    routePrefix: `/${target.alias}/v${defaultVersion}`,
  };
}

export interface ResolvedKeelPath {
  readonly target: KeelNetworkTarget;
  readonly version: number;
  readonly path: string;
  readonly explicitNetwork: boolean;
}

/** Resolve /sepolia-eth/..., /eth/..., /tez/..., or a document-relative path. */
export function resolveKeelNetworkPath(
  input: string,
  document: KeelNetworkDocument,
): ResolvedKeelPath {
  if (typeof input !== "string" || input.length === 0) throw new TypeError("Keel path is required.");
  const raw = input.replace(/^\/+|\/+$/gu, "");
  const parts = raw.length === 0 ? [] : raw.split("/");
  const explicitTarget = parts[0] === undefined ? undefined : KEEL_NETWORKS[parts[0]];
  const target = explicitTarget ?? normalizeKeelNetwork(document.defaultNetwork);
  const explicitNetwork = explicitTarget !== undefined;
  let cursor = explicitNetwork ? 1 : 0;
  let version = document.defaultVersion;
  const versionPart = parts[cursor];
  if (versionPart !== undefined && VERSION_SEGMENT.test(versionPart)) {
    version = positiveVersion(Number(versionPart.slice(1)), "path.version");
    cursor += 1;
  }
  return {
    target: { ...target, version },
    version,
    path: safePath(parts.slice(cursor).join("/"), "path", true),
    explicitNetwork,
  };
}

export function keelNetworkPath(
  targetInput: string | KeelNetworkTarget,
  resourcePath: string,
  version?: number,
): string {
  const target = normalizeKeelNetwork(targetInput);
  const resolvedVersion = positiveVersion(version ?? target.version, "path.version");
  return `/${target.alias}/v${resolvedVersion}/${safePath(resourcePath, "resourcePath")}`;
}

/** Canonical source aliases. The unscoped form is resolved by the document. */
export function keelResourceUri(
  kind: string,
  name: string,
  network?: string | KeelNetworkTarget,
  version?: number,
): string {
  const safeKind = safePath(kind, "alias.kind");
  const safeName = safePath(name, "alias.name");
  if (network === undefined) return `keel://${safeKind}/${safeName}`;
  const target = normalizeKeelNetwork(network);
  const resolvedVersion = positiveVersion(version ?? target.version, "alias.version");
  return `keel://${target.alias}/v${resolvedVersion}/${safeKind}/${safeName}`;
}

export interface KeelPresentationStateBinding {
  readonly registry: Address;
  readonly policyId: Hex;
  readonly resource: string;
  readonly mediaType?: string;
}

/** Contract-owned Seasonal Grove state. The viewer bytes carry only this pointer. */
export interface KeelSeasonalGroveStateBinding {
  readonly contract: Address;
  readonly collection: Address;
  readonly tokenId: string;
  readonly resource: string;
}

export interface KeelViewerCompositionSlot {
  readonly resource: string;
  readonly objectId: Hex;
  readonly objectRevision: bigint | number;
  readonly aliases?: readonly string[];
}

export interface KeelViewerCompositionInput {
  readonly network: string | KeelNetworkTarget;
  readonly slots: readonly KeelViewerCompositionSlot[];
  readonly state?: KeelPresentationStateBinding;
  readonly seasonalGroveState?: KeelSeasonalGroveStateBinding;
}

export interface KeelViewerComposition {
  readonly protocol: typeof KEEL_VIEWER_COMPOSITION_PROTOCOL;
  readonly network: KeelNetworkDocument;
  readonly slots: KeelViewerSlots;
  readonly slotResources: readonly string[];
  readonly aliases: ReadonlyMap<string, string>;
  readonly state?: KeelPresentationStateBinding;
  readonly seasonalGroveState?: KeelSeasonalGroveStateBinding;
}

export function createKeelViewerComposition(
  input: KeelViewerCompositionInput,
): KeelViewerComposition {
  if (input.slots.length === 0) throw new RangeError("A Keel viewer needs at least one object slot.");
  const resources = input.slots.map((slot) => slot.resource);
  if (resources.some((resource) => resource.length === 0) || new Set(resources).size !== resources.length) {
    throw new TypeError("Viewer slot resource IDs must be non-empty and unique.");
  }
  const slots = validateKeelViewerSlots({
    objectIds: input.slots.map((slot) => slot.objectId),
    objectRevisions: input.slots.map((slot) => slot.objectRevision),
  });
  const aliases = new Map<string, string>();
  for (const slot of input.slots) {
    for (const alias of slot.aliases ?? []) {
      if (alias.length === 0) throw new TypeError("Viewer aliases cannot be empty.");
      const prior = aliases.get(alias);
      if (prior !== undefined && prior !== slot.resource) throw new Error(`Viewer alias collision at ${alias}.`);
      aliases.set(alias, slot.resource);
    }
  }
  if (input.state !== undefined && !resources.includes(input.state.resource)) {
    throw new Error(`Presentation state resource ${input.state.resource} is not a viewer slot.`);
  }
  return {
    protocol: KEEL_VIEWER_COMPOSITION_PROTOCOL,
    network: createKeelNetworkDocument(input.network),
    slots,
    slotResources: resources,
    aliases,
    ...(input.state === undefined ? {} : { state: input.state }),
    ...(input.seasonalGroveState === undefined ? {} : { seasonalGroveState: input.seasonalGroveState }),
  };
}

export interface KeelRuntimeExtensionInput {
  readonly chainId: number;
  readonly artifactRegistry: Address;
  readonly harnessRegistry: Address;
  readonly viewerId: Hex;
  readonly tokenId: string;
  readonly slotResources: readonly string[];
  readonly mode?: "live" | "exact";
  readonly linkRegistry?: Address;
  readonly seedRegistry?: Address;
  readonly state?: KeelPresentationStateBinding;
  readonly seasonalGroveState?: KeelSeasonalGroveStateBinding;
}

/** Build the exact extension consumed by @keel/viewer from the same slot plan. */
export function createKeelRuntimeExtension(input: KeelRuntimeExtensionInput): Record<string, unknown> {
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) throw new RangeError("chainId must be positive.");
  if (input.slotResources.length === 0) throw new RangeError("slotResources cannot be empty.");
  return {
    protocol: "keel-runtime@1",
    chainId: input.chainId,
    mode: input.mode ?? "live",
    artifactRegistry: input.artifactRegistry,
    harnessRegistry: input.harnessRegistry,
    viewerId: input.viewerId,
    tokenId: input.tokenId,
    slotResources: [...input.slotResources],
    ...(input.linkRegistry === undefined ? {} : { linkRegistry: input.linkRegistry }),
    ...(input.seedRegistry === undefined ? {} : { seedRegistry: input.seedRegistry }),
    ...(input.state === undefined ? {} : { state: input.state }),
    ...(input.seasonalGroveState === undefined ? {} : { seasonalGroveState: input.seasonalGroveState }),
  };
}

export interface KeelChunk {
  readonly index: number;
  readonly offset: number;
  readonly byteLength: number;
  readonly integrity: Integrity;
  readonly bytes: Uint8Array;
  readonly slugId?: Hex;
}

export interface KeelChunkPlan {
  readonly protocol: typeof KEEL_CHUNK_PLAN_PROTOCOL;
  readonly objectName: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly integrity: Integrity;
  readonly maxChunkBytes: number;
  readonly chunks: readonly KeelChunk[];
}

/** Browser-safe canonical chunking. The returned chunks are ready for KeelHold castSlugs. */
export async function createKeelChunkPlan(
  bytes: Uint8Array,
  options: {
    readonly objectName: string;
    readonly mediaType: string;
    readonly maxChunkBytes?: number;
    readonly keccak256?: (chunk: Uint8Array) => Hex | Promise<Hex>;
  },
): Promise<KeelChunkPlan> {
  if (bytes.byteLength === 0) throw new RangeError("Keel objects cannot be empty.");
  const maxChunkBytes = options.maxChunkBytes ?? 23_000;
  if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes <= 0 || maxChunkBytes > 23_000) {
    throw new RangeError("maxChunkBytes must be between 1 and 23000.");
  }
  const rawChunks = chunkBytes(bytes, maxChunkBytes);
  const chunks = await Promise.all(rawChunks.map(async (chunk) => ({
    index: chunk.index,
    offset: chunk.offset,
    byteLength: chunk.length,
    integrity: await createIntegrity(chunk.bytes),
    bytes: chunk.bytes,
    ...(options.keccak256 === undefined ? {} : { slugId: await options.keccak256(chunk.bytes) }),
  })));
  return {
    protocol: KEEL_CHUNK_PLAN_PROTOCOL,
    objectName: options.objectName,
    mediaType: options.mediaType,
    byteLength: bytes.byteLength,
    integrity: await createIntegrity(bytes),
    maxChunkBytes,
    chunks,
  };
}
