import {
  bytesToUtf8,
  canonicalJson,
  parseArtifactManifest,
  sha256Hex,
  utf8ToBytes,
  verifyIntegrity,
  type ArtifactManifest,
  type CustomDigest,
  type Hex,
  type Integrity,
  type KeelContractPluginDescriptor,
  type KeelGraphAnchor,
  type KeelPinnedPluginResource,
  type KeelPluginReference,
  type KeelPluginWalletIntent,
} from "@keel/protocol";
import { resolveArtifact } from "./resolver.js";
import type { ResolveOptions, ResolvedArtifact, ResolvedResource } from "./types.js";

export const KEEL_CONTRACT_PLUGIN_PROTOCOL_HASH =
  "0x0e0eb5162ca8df7c079e8d31eaf2f514a536c16bf86ea734ab562928f4dac159" as const;

const ADDRESS = /^0x[0-9a-f]{40}$/u;
const ADDRESS_ANY_CASE = /^0x[0-9a-fA-F]{40}$/u;
const BYTES32 = /^0x[0-9a-f]{64}$/u;
const BYTES4 = /^0x[0-9a-f]{8}$/u;
const ZERO_ADDRESS = `0x${"00".repeat(20)}` as Hex;
const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;

export type KeelPluginContractFunction =
  | "bindingsMatch"
  | "graphRegistry"
  | "pluginId"
  | "pluginProtocol"
  | "pluginVersion"
  | "review"
  | "submission"
  | "supportsInterface"
  | "versionOf"
  | "walletAuthorized";

export interface KeelPluginContractReadRequest {
  readonly chainId: number;
  readonly address: Hex;
  readonly functionName: KeelPluginContractFunction;
  readonly args: readonly unknown[];
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly signal: AbortSignal;
}

export interface KeelPluginCodeReadRequest {
  readonly chainId: number;
  readonly address: Hex;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly signal: AbortSignal;
}

export type KeelPluginContractRead = (request: KeelPluginContractReadRequest) => Promise<unknown>;
export type KeelPluginCodeRead = (request: KeelPluginCodeReadRequest) => Promise<Uint8Array>;

/**
 * The host never executes creator-selected wallet code. These bytes identify
 * the audited ABI, declarative adapter, and wallet-library build installed by
 * the host. Each must match the recursively verified audit copy byte-for-byte.
 */
export interface InstalledKeelPluginRuntime {
  readonly abi: Uint8Array;
  readonly adapter: Uint8Array;
  readonly walletLibrary: Uint8Array;
}

export interface ResolveKeelPluginOptions {
  readonly readContract: KeelPluginContractRead;
  readonly readCode: KeelPluginCodeRead;
  readonly installedRuntime: InstalledKeelPluginRuntime;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly customDigest: CustomDigest;
  readonly resolver?: Omit<ResolveOptions, "commitment" | "signal">;
  readonly signal?: AbortSignal;
}

export interface KeelPluginGraphVerification {
  readonly manifestDigest: Hex;
  readonly resourceGraphDigest: Hex;
  readonly metadataDigest: Hex;
  readonly storageTier: KeelGraphAnchor["storageTier"];
  readonly active: boolean;
  readonly frozen: boolean;
}

export interface KeelPluginTrustVerification {
  readonly status: "sanctioned" | "deprecated";
  readonly reviewDigest: Hex;
  readonly reasonDigest: Hex;
  readonly replacementSpecDigest: Hex;
  readonly walletValidUntil: number;
  readonly reviewer: Hex;
  readonly warning?: string;
}

export interface VerifiedKeelContractPlugin {
  readonly referenceId: string;
  readonly reference: KeelPluginReference;
  readonly manifest: ArtifactManifest;
  readonly artifact: ResolvedArtifact;
  readonly descriptor: KeelContractPluginDescriptor;
  readonly graph: KeelPluginGraphVerification;
  readonly trust: KeelPluginTrustVerification;
  readonly runtime: {
    readonly abi: ResolvedResource;
    readonly adapter: ResolvedResource;
    readonly walletLibrary: ResolvedResource;
  };
  readonly intents: ReadonlyMap<string, KeelPluginWalletIntent>;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly walletAuthorized: true;
}

interface ParsedPluginSpec {
  readonly pluginId: Hex;
  readonly pluginVersion: number;
  readonly kind: number;
  readonly target: Hex;
  readonly targetRuntimeCodeHash: Hex;
  readonly requiredInterfaceId: Hex;
  readonly graphId: Hex;
  readonly graphVersion: number;
  readonly pluginManifestDigest: Hex;
  readonly abiDigest: Hex;
  readonly walletRuntimeDigest: Hex;
  readonly adapterDigest: Hex;
  readonly permissionsDigest: Hex;
  readonly legacyTarget: Hex;
  readonly legacyRuntimeCodeHash: Hex;
}

function tupleValue(value: unknown, key: string, index: number): unknown {
  let tuple = value;
  if (Array.isArray(tuple) && tuple.length === 1 && tuple[0] !== null && typeof tuple[0] === "object") {
    tuple = tuple[0];
  }
  if (Array.isArray(tuple)) return tuple[index];
  if (tuple !== null && typeof tuple === "object") {
    const record = tuple as Record<string | number, unknown>;
    return record[key] ?? record[index];
  }
  return undefined;
}

function scalar(value: unknown): unknown {
  return Array.isArray(value) && value.length === 1 ? value[0] : value;
}

function safeNumber(value: unknown, label: string, minimum = 0): number {
  const result = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(result) || (result as number) < minimum) {
    throw new RangeError(`${label} exceeds safe client limits.`);
  }
  return result as number;
}

function boolean(value: unknown, label: string): boolean {
  const result = scalar(value);
  if (typeof result !== "boolean") throw new TypeError(`${label} must be boolean.`);
  return result;
}

function bytes32(value: unknown, label: string, allowZero = false): Hex {
  const result = scalar(value);
  if (typeof result !== "string" || !BYTES32.test(result) || (!allowZero && result === ZERO_BYTES32)) {
    throw new TypeError(`${label} must be ${allowZero ? "a" : "a nonzero"} lower-case bytes32.`);
  }
  return result as Hex;
}

function bytes4(value: unknown, label: string): Hex {
  const result = scalar(value);
  if (typeof result !== "string" || !BYTES4.test(result)) throw new TypeError(`${label} must be lower-case bytes4.`);
  return result as Hex;
}

function contractAddress(value: unknown, label: string, allowZero = false): Hex {
  const result = scalar(value);
  if (typeof result !== "string" || !ADDRESS_ANY_CASE.test(result)) throw new TypeError(`${label} must be an EVM address.`);
  const normalized = result.toLowerCase() as Hex;
  if (!allowZero && normalized === ZERO_ADDRESS) throw new TypeError(`${label} cannot be zero.`);
  return normalized;
}

function sameGraph(left: KeelGraphAnchor, right: KeelGraphAnchor): boolean {
  return (
    left.protocol === right.protocol &&
    left.chainId === right.chainId &&
    left.registry === right.registry &&
    left.graphId === right.graphId &&
    left.version === right.version &&
    left.storageTier === right.storageTier
  );
}

function sameIntegrity(left: Integrity, right: Integrity): boolean {
  return left.algorithm === right.algorithm && left.digest === right.digest && left.byteLength === right.byteLength;
}

function storageTier(value: unknown, label: string): KeelGraphAnchor["storageTier"] {
  const tier = safeNumber(value, label);
  const resolved = ["remote-pinned", "content-addressed", "onchain"][tier];
  if (resolved === undefined) throw new TypeError(`${label} is not a supported storage tier.`);
  return resolved as KeelGraphAnchor["storageTier"];
}

function parseSpec(value: unknown): ParsedPluginSpec {
  return {
    pluginId: bytes32(tupleValue(value, "pluginId", 0), "submission.spec.pluginId"),
    pluginVersion: safeNumber(tupleValue(value, "pluginVersion", 1), "submission.spec.pluginVersion", 1),
    kind: safeNumber(tupleValue(value, "kind", 2), "submission.spec.kind"),
    target: contractAddress(tupleValue(value, "target", 3), "submission.spec.target"),
    targetRuntimeCodeHash: bytes32(
      tupleValue(value, "targetRuntimeCodeHash", 4),
      "submission.spec.targetRuntimeCodeHash",
    ),
    requiredInterfaceId: bytes4(tupleValue(value, "requiredInterfaceId", 5), "submission.spec.requiredInterfaceId"),
    graphId: bytes32(tupleValue(value, "graphId", 6), "submission.spec.graphId"),
    graphVersion: safeNumber(tupleValue(value, "graphVersion", 7), "submission.spec.graphVersion", 1),
    pluginManifestDigest: bytes32(
      tupleValue(value, "pluginManifestDigest", 8),
      "submission.spec.pluginManifestDigest",
    ),
    abiDigest: bytes32(tupleValue(value, "abiDigest", 9), "submission.spec.abiDigest"),
    walletRuntimeDigest: bytes32(
      tupleValue(value, "walletRuntimeDigest", 10),
      "submission.spec.walletRuntimeDigest",
    ),
    adapterDigest: bytes32(tupleValue(value, "adapterDigest", 11), "submission.spec.adapterDigest"),
    permissionsDigest: bytes32(
      tupleValue(value, "permissionsDigest", 12),
      "submission.spec.permissionsDigest",
    ),
    legacyTarget: contractAddress(tupleValue(value, "legacyTarget", 13), "submission.spec.legacyTarget", true),
    legacyRuntimeCodeHash: bytes32(
      tupleValue(value, "legacyRuntimeCodeHash", 14),
      "submission.spec.legacyRuntimeCodeHash",
      true,
    ),
  };
}

function containsDelegation(runtime: Uint8Array): boolean {
  if (runtime.byteLength >= 2 && runtime[0] === 0xef && runtime[1] === 0x01) return true;
  for (let cursor = 0; cursor < runtime.byteLength; cursor += 1) {
    const opcode = runtime[cursor];
    if (opcode === 0xf2 || opcode === 0xf4) return true;
    if (opcode !== undefined && opcode >= 0x60 && opcode <= 0x7f) cursor += opcode - 0x5f;
  }
  return false;
}

async function requireIntegrity(
  bytes: Uint8Array,
  integrity: Integrity,
  customDigest: CustomDigest,
  label: string,
): Promise<void> {
  if (!(await verifyIntegrity(bytes, integrity, customDigest))) throw new Error(`${label} does not match its exact digest.`);
}

function pinnedResource(
  artifact: ResolvedArtifact,
  pinned: KeelPinnedPluginResource,
  label: string,
): ResolvedResource {
  const resource = artifact.resources.get(pinned.resource);
  if (resource === undefined) throw new Error(`${label} resource ${pinned.resource} was not resolved.`);
  if (!sameIntegrity(resource.source.integrity, pinned.integrity)) {
    throw new Error(`${label} resolved through bytes outside its exact pinned integrity.`);
  }
  return resource;
}

function requireAddress(value: Hex, label: string): void {
  if (!ADDRESS.test(value)) throw new TypeError(`${label} must be a canonical lower-case EVM address.`);
}

/**
 * Resolve and verify one exact recursive plugin graph. This is the wallet gate:
 * `walletAuthorized()` alone is never sufficient. The graph, nested manifest,
 * every privileged runtime byte, installed host runtime, live target code, and
 * every immutable PluginSpec field are checked at one hash-pinned block.
 */
export async function resolveKeelContractPlugin(
  outer: ResolvedArtifact,
  referenceId: string,
  options: ResolveKeelPluginOptions,
): Promise<VerifiedKeelContractPlugin> {
  if (options.blockNumber < 0n) throw new RangeError("Plugin verification blockNumber cannot be negative.");
  if (!BYTES32.test(options.blockHash)) throw new TypeError("Plugin verification blockHash must be lower-case bytes32.");
  if (outer.commitment?.digestVerified !== true) throw new Error("Plugin wallets require a verified outer manifest digest.");
  const bindings = outer.manifest.plugins;
  if (bindings === undefined) throw new Error("Artifact manifest does not bind any contract plugins.");
  const reference = bindings.plugins.find((candidate) => candidate.id === referenceId);
  if (reference === undefined) throw new Error(`Artifact does not bind plugin ${referenceId}.`);
  requireAddress(reference.graph.registry, "plugin.graph.registry");
  requireAddress(reference.trust.registry, "plugin.trust.registry");

  const manifestResource = outer.resources.get(reference.manifestResource);
  if (manifestResource === undefined) throw new Error("Nested plugin manifest resource was not resolved.");
  await requireIntegrity(manifestResource.bytes, reference.manifestIntegrity, options.customDigest, "Nested plugin manifest");
  const parsed = parseArtifactManifest(JSON.parse(bytesToUtf8(manifestResource.bytes)) as unknown);
  const canonicalBytes = utf8ToBytes(canonicalJson(parsed));
  await requireIntegrity(canonicalBytes, reference.manifestIntegrity, options.customDigest, "Canonical nested plugin manifest");
  const descriptor = parsed.contractPlugin;
  if (descriptor === undefined) throw new Error("Nested manifest is not a Keel contract plugin.");
  if (!sameGraph(reference.graph, descriptor.graph)) {
    throw new Error("Nested plugin manifest does not bind back to the exact outer graph record.");
  }

  const nested = await resolveArtifact(parsed, {
    ...(options.resolver ?? {}),
    adapters: {
      ...(options.resolver?.adapters ?? {}),
      customDigest: options.customDigest,
    },
    commitment: {
      integrity: reference.manifestIntegrity,
      digestVerified: true,
      ...(manifestResource.location === undefined ? {} : { sourceUrl: manifestResource.location }),
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const abi = pinnedResource(nested, descriptor.runtime.abi, "Plugin ABI");
  const adapter = pinnedResource(nested, descriptor.runtime.adapter, "Plugin adapter");
  const walletLibrary = pinnedResource(nested, descriptor.runtime.walletLibrary, "Plugin wallet library");
  await Promise.all([
    requireIntegrity(options.installedRuntime.abi, descriptor.runtime.abi.integrity, options.customDigest, "Installed ABI"),
    requireIntegrity(
      options.installedRuntime.adapter,
      descriptor.runtime.adapter.integrity,
      options.customDigest,
      "Installed adapter",
    ),
    requireIntegrity(
      options.installedRuntime.walletLibrary,
      descriptor.runtime.walletLibrary.integrity,
      options.customDigest,
      "Installed wallet library",
    ),
  ]);

  const permissionsDigest = await sha256Hex(
    utf8ToBytes(
      canonicalJson({ protocol: descriptor.permissions.protocol, intents: descriptor.permissions.intents }),
    ),
  );
  if (permissionsDigest !== descriptor.permissions.digest) {
    throw new Error("Plugin permission table does not match its declared digest.");
  }
  const resourceGraphDigest = await sha256Hex(utf8ToBytes(canonicalJson(parsed.resources)));

  const signal = options.signal ?? new AbortController().signal;
  const read = (address: Hex, functionName: KeelPluginContractFunction, args: readonly unknown[] = []): Promise<unknown> =>
    options.readContract({
      chainId: reference.graph.chainId,
      address,
      functionName,
      args,
      blockNumber: options.blockNumber,
      blockHash: options.blockHash,
      signal,
    });

  const [graphRegistryValue, graphValue, submissionValue, reviewValue, authorizedValue, bindingsValue, runtimeCode] =
    await Promise.all([
      read(reference.trust.registry, "graphRegistry"),
      read(reference.graph.registry, "versionOf", [reference.graph.graphId, BigInt(reference.graph.version)]),
      read(reference.trust.registry, "submission", [reference.trust.specDigest]),
      read(reference.trust.registry, "review", [reference.trust.specDigest]),
      read(reference.trust.registry, "walletAuthorized", [reference.trust.specDigest]),
      read(reference.trust.registry, "bindingsMatch", [reference.trust.specDigest]),
      options.readCode({
        chainId: reference.graph.chainId,
        address: descriptor.contract.address,
        blockNumber: options.blockNumber,
        blockHash: options.blockHash,
        signal,
      }),
    ]);

  if (contractAddress(graphRegistryValue, "pluginRegistry.graphRegistry") !== reference.graph.registry) {
    throw new Error("PluginRegistry is not bound to the declared GraphRegistry.");
  }
  const graphManifestDigest = bytes32(tupleValue(graphValue, "manifestDigest", 1), "graph.manifestDigest");
  const graphResourceDigest = bytes32(tupleValue(graphValue, "resourceGraphDigest", 2), "graph.resourceGraphDigest");
  const graphMetadataDigest = bytes32(tupleValue(graphValue, "metadataDigest", 3), "graph.metadataDigest", true);
  const graphNumber = safeNumber(tupleValue(graphValue, "number", 4), "graph.number", 1);
  const graphTier = storageTier(tupleValue(graphValue, "storageTier", 7), "graph.storageTier");
  const graphActive = boolean(tupleValue(graphValue, "active", 8), "graph.active");
  const graphFrozen = boolean(tupleValue(graphValue, "graphFrozen", 9), "graph.graphFrozen");
  if (graphManifestDigest !== reference.manifestIntegrity.digest) {
    throw new Error("GraphRegistry version does not commit the exact nested manifest digest.");
  }
  if (graphNumber !== reference.graph.version || graphTier !== reference.graph.storageTier) {
    throw new Error("GraphRegistry version or storage tier does not match the manifest anchor.");
  }
  if (graphResourceDigest !== resourceGraphDigest) {
    throw new Error("GraphRegistry resource graph digest does not match the nested manifest resources.");
  }

  const submission = tupleValue(submissionValue, "spec", 0);
  const spec = parseSpec(submission);
  const submissionExists = boolean(tupleValue(submissionValue, "exists", 3), "submission.exists");
  if (!submissionExists) throw new Error("PluginRegistry submission is missing.");
  if (spec.kind !== 0 || spec.legacyTarget !== ZERO_ADDRESS || spec.legacyRuntimeCodeHash !== ZERO_BYTES32) {
    throw new Error("This wallet host supports only direct, non-upgradeable native plugins in v1.");
  }
  if (
    spec.pluginId !== descriptor.pluginId ||
    spec.pluginVersion !== descriptor.version ||
    spec.target !== descriptor.contract.address ||
    spec.targetRuntimeCodeHash !== descriptor.contract.runtimeCodeHash ||
    spec.requiredInterfaceId !== descriptor.contract.requiredInterfaceId ||
    spec.graphId !== descriptor.graph.graphId ||
    spec.graphVersion !== descriptor.graph.version ||
    spec.pluginManifestDigest !== reference.manifestIntegrity.digest ||
    spec.abiDigest !== descriptor.runtime.abi.integrity.digest ||
    spec.walletRuntimeDigest !== descriptor.runtime.walletLibrary.integrity.digest ||
    spec.adapterDigest !== descriptor.runtime.adapter.integrity.digest ||
    spec.permissionsDigest !== descriptor.permissions.digest
  ) {
    throw new Error("PluginRegistry immutable spec does not match the recursively verified plugin manifest.");
  }

  if (runtimeCode.byteLength === 0 || containsDelegation(runtimeCode)) {
    throw new Error("Plugin target is empty, delegated, or proxy-like and cannot receive wallet authority.");
  }
  await requireIntegrity(
    runtimeCode,
    { algorithm: "keccak256", digest: descriptor.contract.runtimeCodeHash, byteLength: runtimeCode.byteLength },
    options.customDigest,
    "Live plugin runtime code",
  );

  const [protocolValue, pluginIdValue, pluginVersionValue, interfaceValue] = await Promise.all([
    read(descriptor.contract.address, "pluginProtocol"),
    read(descriptor.contract.address, "pluginId"),
    read(descriptor.contract.address, "pluginVersion"),
    read(descriptor.contract.address, "supportsInterface", [descriptor.contract.requiredInterfaceId]),
  ]);
  if (
    bytes32(protocolValue, "plugin.pluginProtocol") !== KEEL_CONTRACT_PLUGIN_PROTOCOL_HASH ||
    bytes32(pluginIdValue, "plugin.pluginId") !== descriptor.pluginId ||
    safeNumber(scalar(pluginVersionValue), "plugin.pluginVersion", 1) !== descriptor.version ||
    !boolean(interfaceValue, "plugin.supportsInterface")
  ) {
    throw new Error("Live plugin contract constants or required interface do not match the manifest.");
  }
  if (!boolean(bindingsValue, "pluginRegistry.bindingsMatch") || !boolean(authorizedValue, "pluginRegistry.walletAuthorized")) {
    throw new Error("PluginRegistry does not currently authorize wallet access for this exact spec.");
  }

  const statusValue = safeNumber(tupleValue(reviewValue, "status", 0), "review.status");
  if (statusValue !== 2 && statusValue !== 3) throw new Error("Plugin trust status is not sanctioned or deprecated.");
  const trustStatus = statusValue === 2 ? "sanctioned" : "deprecated";
  const walletValidUntil = safeNumber(tupleValue(reviewValue, "walletValidUntil", 4), "review.walletValidUntil");
  const trust: KeelPluginTrustVerification = {
    status: trustStatus,
    reviewDigest: bytes32(tupleValue(reviewValue, "reviewDigest", 1), "review.reviewDigest"),
    reasonDigest: bytes32(tupleValue(reviewValue, "reasonDigest", 2), "review.reasonDigest", true),
    replacementSpecDigest: bytes32(
      tupleValue(reviewValue, "replacementSpecDigest", 3),
      "review.replacementSpecDigest",
      true,
    ),
    walletValidUntil,
    reviewer: contractAddress(tupleValue(reviewValue, "reviewer", 6), "review.reviewer"),
    ...(trustStatus === "deprecated"
      ? { warning: "This exact plugin version is deprecated. It remains pinned and never redirects to a replacement." }
      : {}),
  };

  const intents = new Map(descriptor.permissions.intents.map((intent) => [intent.id, intent] as const));
  return {
    referenceId,
    reference,
    manifest: parsed,
    artifact: nested,
    descriptor,
    graph: {
      manifestDigest: graphManifestDigest,
      resourceGraphDigest: graphResourceDigest,
      metadataDigest: graphMetadataDigest,
      storageTier: graphTier,
      active: graphActive,
      frozen: graphFrozen,
    },
    trust,
    runtime: { abi, adapter, walletLibrary },
    intents,
    blockNumber: options.blockNumber,
    blockHash: options.blockHash,
    walletAuthorized: true,
  };
}
