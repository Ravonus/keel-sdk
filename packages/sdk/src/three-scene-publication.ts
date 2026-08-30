import {
  KEEL_CANONICALIZATION,
  KEEL_CONTENT_GATEWAY_PROTOCOL,
  KEEL_MANIFEST_SCHEMA,
  KEEL_RUNTIME_PROTOCOL,
  KEEL_VIEWER_PROTOCOL,
  assertValidManifest,
  canonicalJson,
  createIntegrity,
  manifestIntegrity,
  toDataUrl,
  utf8ToBytes,
  type ArtifactManifest,
  type Compression,
  type Hex as ProtocolHex,
  type Integrity,
} from "@keel/protocol";
import {
  bytesToHex,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { keelHoldAbi } from "./abi.js";
import {
  buildKeelPublicationPlan,
  KEEL_NATIVE_CARRIER_V1,
  KEEL_NATIVE_CHUNK_BYTES,
  KEEL_NATIVE_CHUNKS_PER_TRANSACTION,
  mergeKeelPublicationRecovery,
  selectResumableKeelJobId,
  type KeelPublicationPlan,
  type KeelPublicationRecovery,
} from "./managed-publication.js";

/** Review-only protocol for one frozen Three.js scene and its native object. */
export const KEEL_THREE_SCENE_PUBLICATION_PROTOCOL = "keel-three-scene-publication@1" as const;
export const KEEL_THREE_SCENE_VIEWER_EXTENSION = "keel-immutable-scene@1" as const;
export const KEEL_THREE_SCENE_DEFAULT_MEDIA_TYPE = "text/html" as const;
export const KEEL_THREE_SCENE_DEFAULT_CREATED_AT = "2026-01-01T00:00:00.000Z" as const;

const ADDRESS = /^0x[0-9a-f]{40}$/iu;
const BYTES32 = /^0x[0-9a-f]{64}$/iu;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;

const WELD_OBJECT_SIGNATURES: string[] = keelHoldAbi.filter((entry) => entry.startsWith("function weldObject("));
const WELD_OBJECT_ABI = parseAbi(WELD_OBJECT_SIGNATURES);
const FACTORY_CAST_DIE_ABI = parseAbi([
  "function castDie((string name,string symbol,address admin,address royaltyReceiver,uint96 royaltyBps,uint256 maxSupply,address mintManager,address keelIndex) config) returns (address collection)",
]);
const INDEX_PUBLISH_COLLECTION_REVISION_ABI = parseAbi([
  "function publishCollectionRevision(address collection,string manifestURI,bytes32 manifestDigest,uint64 parentRevision,uint64 compatibilityMin,uint64 compatibilityMax,uint8 policy,uint64 activationTime) returns (uint64 revision)",
]);
const INDEX_ACTIVATE_COLLECTION_REVISION_ABI = parseAbi([
  "function activateCollectionRevision(address collection,uint64 revision)",
]);
const INDEX_FREEZE_COLLECTION_ABI = parseAbi([
  "function freezeCollection(address collection)",
]);
const CAST_SLUGS_ABI = parseAbi([
  "function castSlugs(bytes[] payloads) returns (bytes32[] slugIds,address[] pointers)",
]);
const KEEL721_STRIKE_FROM_MANAGER_ABI = parseAbi([
  "function strikeFromManager(address to,uint256 quantity,bytes data)",
]);

export interface KeelThreeSceneBundleModule {
  readonly id: string;
  readonly bytes: Uint8Array;
  readonly mediaType?: string;
}

export interface KeelThreeSceneTokenInput {
  /** Expected CREATE2 collection address from the factory's read-only quote. */
  readonly collection: Address;
  readonly factory: Address;
  readonly index: Address;
  /** PublicationJob must be the collection's mint manager for executor calls. */
  readonly publicationJob?: Address;
  readonly recipient?: Address;
  readonly name?: string;
  readonly symbol?: string;
  readonly manifestURI?: string;
  readonly previewImageURI?: string;
  readonly factoryNonce?: bigint;
  readonly mintData?: Hex;
  /** Read-only deployment evidence; false is a hard blocker, never a write. */
  readonly publicationJobDeployed?: boolean;
}

export interface KeelThreeSceneTokenOperation {
  readonly kind: "factory-collection" | "index-presentation-publish" | "index-presentation-activate" | "index-presentation-freeze" | "token-mint";
  readonly target: Address;
  readonly value: bigint;
  readonly data: Hex;
}

export interface KeelThreeSceneTokenPlan {
  readonly route: "direct-eip5792";
  readonly status: "review-only";
  /** Managed executor remains unavailable until this module is deployed/configured. */
  readonly managedBlocker?: "publication-job-not-deployed";
  readonly collection: Address;
  readonly tokenId: 1n;
  readonly maxSupply: 1n;
  readonly presentation: {
    readonly index: Address;
    readonly manifestURI: string;
    readonly manifestDigest: Hex;
    readonly revision: 1n;
    readonly policy: "immutable";
    readonly frozen: true;
  };
  readonly operations: readonly KeelThreeSceneTokenOperation[];
  readonly logicalOperationCount: 5;
  readonly walletApproval: "required";
  readonly signing: "not-performed";
  readonly submitted: false;
}

export interface KeelThreeSceneWalletCall {
  readonly to: Address;
  readonly data: Hex;
  readonly value: Hex;
}

export interface KeelThreeSceneWalletSendCalls {
  readonly method: "wallet_sendCalls";
  readonly params: readonly [{
    readonly version: "1.0";
    readonly chainId: `0x${string}`;
    readonly from: Address;
    readonly calls: readonly KeelThreeSceneWalletCall[];
  }];
}

export interface KeelThreeSceneWalletStatusRequest {
  readonly method: "wallet_getCallsStatus";
  /** Replace the placeholder with the id returned by wallet_sendCalls. */
  readonly params: readonly ["<wallet-send-calls-id>"];
}

/**
 * Bundle a browser entrypoint and its declared modules into one HTML object.
 * The resulting document has no `/content/` fetches: imports are rewritten to
 * data URLs containing the exact declared module bytes. This is intentionally
 * small and deterministic; it is not a general JavaScript bundler.
 */
export function bundleKeelThreeScene(input: {
  readonly html: string;
  readonly entrypointId: string;
  readonly entrypointSource: string;
  readonly modules: readonly KeelThreeSceneBundleModule[];
}): Uint8Array {
  if (!SAFE_ID.test(input.entrypointId)) throw new TypeError("entrypointId must be metadata-safe.");
  const modules = new Map<string, KeelThreeSceneBundleModule>();
  for (const module of input.modules) {
    if (!SAFE_ID.test(module.id) || modules.has(module.id)) throw new TypeError("Three.js bundle module IDs must be unique and metadata-safe.");
    modules.set(module.id, module);
  }
  const moduleUrl = (specifier: string): string => {
    const normalized = specifier.replace(/^\.\//u, "");
    const id = normalized.startsWith("/content/") ? normalized.slice("/content/".length) : normalized;
    const module = modules.get(id) ?? [...modules.values()].find((candidate) => candidate.id.endsWith(`/${id}`));
    if (module === undefined) throw new Error(`Three.js bundle import is not declared: ${specifier}`);
    const mediaType = module.mediaType ?? "text/javascript";
    return toDataUrl(mediaType, module.bytes);
  };
  const entrypoint = input.entrypointSource.replace(
    /^\s*import\s+(\*\s+as\s+[A-Za-z_$][\w$]*|\{[^}]+\}|[A-Za-z_$][\w$]*)\s+from\s+(["'])([^"']+)\2\s*;?\s*$/gmu,
    (_statement, binding: string, _quote: string, specifier: string) => {
      const url = JSON.stringify(moduleUrl(specifier));
      if (binding.startsWith("* as ")) return `const ${binding.slice(5)} = await import(${url});`;
      if (binding.startsWith("{")) return `const ${binding} = await import(${url});`;
      return `const ${binding} = (await import(${url})).default;`;
    },
  );
  if (/^\s*import\s/mu.test(entrypoint)) throw new Error("Three.js bundle contains an undeclared or unsupported static import.");
  const script = `<script type="module">${entrypoint}</script>`;
  // SAFE_ID only permits one regexp metacharacter (a dot), but use a literal
  // replacement so the emitted bundle cannot inherit a malformed escape regex.
  const escapedEntrypointId = input.entrypointId.replaceAll(".", "\\.");
  const scriptPattern = new RegExp(
    `<script\\b[^>]*\\bsrc=(['"])((?:/content/)?${escapedEntrypointId})\\1[^>]*><\\/script>`,
    "iu",
  );
  const bundledHtml = scriptPattern.test(input.html)
    ? input.html.replace(scriptPattern, script)
    : /<\/body>/iu.test(input.html)
      ? input.html.replace(/<\/body>/iu, `${script}</body>`)
      : `${input.html}${script}`;
  return utf8ToBytes(bundledHtml);
}

export interface KeelImmutableThreeSceneInput {
  readonly chainId: number;
  readonly owner: Address;
  readonly executor: Address;
  /** Native KeelHold store receiving the immutable scene carriers/object. */
  readonly hold: Address;
  readonly deadline: bigint;
  readonly scene: {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    readonly bytes: Uint8Array;
    readonly mediaType?: string;
    readonly createdAt?: string;
    readonly tokenId?: string;
    readonly seed?: Hex;
    readonly backgroundColor?: string;
    /** Pre-compressed carrier bytes selected by the SDK builder. */
    readonly storedBytes?: Uint8Array;
    /** Must describe storedBytes exactly; defaults to none. */
    readonly compression?: Compression;
    /** Exact module commitments embedded into the closed scene bundle. */
    readonly modules?: readonly KeelThreeSceneBundleModule[];
    /** Compatibility alias for callers that already bundle module evidence. */
    readonly bundledModules?: readonly KeelThreeSceneBundleModule[];
  };
  /** Defaults to the native Hold target; callers cannot add a second operation. */
  readonly operationTarget?: Address;
  readonly operationValue?: bigint;
  /** Optional, separate KEEL721/factory/index token operation plan. */
  readonly token?: KeelThreeSceneTokenInput;
}

export interface KeelThreeSceneViewerProof {
  readonly manifest: ArtifactManifest;
  readonly integrity: Integrity;
  readonly manifestObjectId: Hex;
  readonly manifestByteLength: number;
  readonly manifestURI: string;
  readonly manifestPublication: KeelPublicationPlan;
  readonly modules: readonly {
    readonly id: string;
    readonly mediaType: string;
    readonly integrity: Integrity;
  }[];
  readonly defaults: {
    readonly manifestTrust: "digest";
    readonly sandbox: "strict";
    readonly capabilities: Readonly<Record<string, never>>;
    readonly verification: "required";
  };
}

export interface KeelImmutableThreeScenePublicationPlan {
  readonly protocol: typeof KEEL_THREE_SCENE_PUBLICATION_PROTOCOL;
  readonly status: "review-only";
  readonly sceneId: string;
  readonly sceneDigest: Hex;
  readonly sceneObjectId: Hex;
  readonly sceneByteLength: number;
  readonly edition: { readonly size: 1; readonly serial: 1 };
  readonly immutable: true;
  readonly storageMode: typeof KEEL_NATIVE_CARRIER_V1;
  readonly viewer: KeelThreeSceneViewerProof;
  readonly publication: KeelPublicationPlan;
  /** Separate token/presentation calls; never counted as scene storage welds. */
  readonly token?: KeelThreeSceneTokenPlan;
  readonly walletSendCalls: KeelThreeSceneWalletSendCalls;
  readonly walletStatusRequest: KeelThreeSceneWalletStatusRequest;
  readonly logicalOperations: {
    readonly sceneStorage: 1;
    readonly manifestStorage: 1;
    readonly tokenPresentation: 0 | 5;
  };
  readonly walletApproval: "required";
  readonly signing: "not-performed";
  readonly submitted: false;
}

export interface KeelImmutableThreeSceneRecovery {
  readonly protocol: typeof KEEL_THREE_SCENE_PUBLICATION_PROTOCOL;
  readonly storageMode: typeof KEEL_NATIVE_CARRIER_V1;
  readonly planDigest: Hex;
  readonly jobId?: bigint;
  readonly recovery: KeelPublicationRecovery;
  /** Receipt reconciliation/resume never requests another owner signature. */
  readonly walletApproval: "not-requested";
}

function ensureAddress(value: Address, label: string): Address {
  if (!ADDRESS.test(value)) throw new TypeError(`${label} must be an Ethereum address.`);
  return value.toLowerCase() as Address;
}

function ensureBytes32(value: string, label: string): Hex {
  if (!BYTES32.test(value)) throw new TypeError(`${label} must be a bytes32 value.`);
  return value.toLowerCase() as Hex;
}

function ensurePositiveSafe(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive safe integer.`);
  return value;
}

function splitNativeScene(bytes: Uint8Array): readonly (readonly Hex[])[] {
  const chunks: Hex[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += KEEL_NATIVE_CHUNK_BYTES) {
    chunks.push(bytesToHex(bytes.subarray(offset, Math.min(offset + KEEL_NATIVE_CHUNK_BYTES, bytes.byteLength))));
  }
  const batches: Hex[][] = [];
  for (let index = 0; index < chunks.length; index += KEEL_NATIVE_CHUNKS_PER_TRANSACTION) {
    batches.push(chunks.slice(index, index + KEEL_NATIVE_CHUNKS_PER_TRANSACTION));
  }
  return Object.freeze(batches.map((batch) => Object.freeze(batch)));
}

function nativeObjectId(
  slugIds: readonly Hex[],
  digest: Hex,
  byteLength: number,
  storedByteLength: number,
  compression: number,
  mediaType: string,
): Hex {
  const indexBytes = new Uint8Array(slugIds.length * 32);
  slugIds.forEach((slugId, index) => {
    const bytes = Uint8Array.from(slugId.slice(2).match(/../gu) ?? [], (value) => Number.parseInt(value, 16));
    indexBytes.set(bytes, index * 32);
  });
  const indexDigest = keccak256(bytesToHex(indexBytes));
  const preimage = encodeAbiParameters(
    [
      { type: "bytes1" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint64" },
      { type: "uint64" },
      { type: "uint8" },
      { type: "bytes32" },
    ],
    ["0x00", indexDigest, digest, BigInt(byteLength), BigInt(storedByteLength), compression, keccak256(stringToHex(mediaType))],
  );
  return keccak256(preimage);
}

function validateClosedSceneBytes(bytes: Uint8Array): void {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const undeclared = [...source.matchAll(/(["'])(\/content\/[^"']+)\1/gu)]
    .map((match) => match[2])
    .filter((value): value is string => value !== undefined);
  if (undeclared.length > 0) {
    throw new Error(`Immutable Three.js scene must bundle every module; undeclared resource request: ${undeclared[0]}`);
  }
}

async function moduleCommitments(
  modules: readonly KeelThreeSceneBundleModule[] | undefined,
): Promise<readonly { readonly id: string; readonly mediaType: string; readonly integrity: Integrity }[]> {
  const seen = new Set<string>();
  const commitments = [] as { readonly id: string; readonly mediaType: string; readonly integrity: Integrity }[];
  for (const module of modules ?? []) {
    if (!SAFE_ID.test(module.id) || seen.has(module.id)) throw new TypeError("Three.js bundle module IDs must be unique and metadata-safe.");
    if (module.bytes.byteLength === 0) throw new RangeError(`Three.js bundle module ${module.id} cannot be empty.`);
    const mediaType = module.mediaType ?? "text/javascript";
    if (mediaType.length === 0 || mediaType.length > 127 || /[\u0000-\u001f\u007f]/u.test(mediaType)) throw new TypeError(`Three.js bundle module ${module.id} has an invalid media type.`);
    seen.add(module.id);
    commitments.push({ id: module.id, mediaType, integrity: await createIntegrity(module.bytes) });
  }
  return Object.freeze(commitments.map((commitment) => Object.freeze(commitment)));
}

function sceneManifest(input: {
  readonly chainId: number;
  readonly hold: Address;
  readonly scene: KeelImmutableThreeSceneInput["scene"];
  readonly sceneDigest: Hex;
  readonly sceneObjectId: Hex;
  readonly compression: Compression;
  readonly modules: readonly { readonly id: string; readonly mediaType: string; readonly integrity: Integrity }[];
}): ArtifactManifest {
  const mediaType = input.scene.mediaType ?? KEEL_THREE_SCENE_DEFAULT_MEDIA_TYPE;
  const sceneResource = {
    id: "scene",
    role: "entrypoint" as const,
    mediaType,
    executable: true,
    originalName: "scene.html",
    aliases: ["/content/scene"],
    sources: [{
      kind: "onchain" as const,
      chainId: input.chainId,
      store: input.hold,
      objectId: input.sceneObjectId,
      compression: input.compression,
      integrity: { algorithm: "sha256" as const, digest: input.sceneDigest, byteLength: input.scene.bytes.byteLength },
    }],
  };
  const maxResourceBytes = Math.max(input.scene.bytes.byteLength + 4_096, 64 * 1024);
  const maxTotalBytes = Math.max(input.scene.bytes.byteLength + 16 * 1024, 256 * 1024);
  const manifest: ArtifactManifest = {
    schema: KEEL_MANIFEST_SCHEMA,
    canonicalization: KEEL_CANONICALIZATION,
    id: input.scene.id,
    name: input.scene.name,
    ...(input.scene.description === undefined ? {} : { description: input.scene.description }),
    entrypoint: { resource: "scene", mode: "html" },
    resources: [sceneResource],
    fallback: { image: "scene", animation: "scene", backgroundColor: input.scene.backgroundColor ?? "#05060b" },
    runtime: {
      engine: { protocol: KEEL_RUNTIME_PROTOCOL, viewerProtocol: KEEL_VIEWER_PROTOCOL, renderer: "browser" },
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
      maxResourceBytes,
      maxTotalBytes,
      maxRecursionDepth: 8,
      maxResources: 8,
      timeoutMs: 30_000,
    },
    revision: { number: 1, compatibility: { min: 1, max: 1 }, policy: "immutable", frozen: true },
    provenance: {
      createdAt: input.scene.createdAt ?? KEEL_THREE_SCENE_DEFAULT_CREATED_AT,
      chainId: input.chainId,
      ...(input.scene.tokenId === undefined ? {} : { tokenId: input.scene.tokenId }),
    },
    extensions: {
      "keel:immutable-scene": {
        protocol: KEEL_THREE_SCENE_VIEWER_EXTENSION,
        runtime: "three.js",
        editionSize: 1,
        editionSerial: 1,
        storageMode: KEEL_NATIVE_CARRIER_V1,
        objectId: input.sceneObjectId,
        sceneDigest: input.sceneDigest,
        verification: {
          manifestTrust: "digest",
          sandbox: "strict",
          content: "verified-only",
          source: "native-keel",
        },
        modules: input.modules.map((module) => ({
          id: module.id,
          mediaType: module.mediaType,
          integrity: module.integrity,
        })),
        ...(input.scene.seed === undefined ? {} : { seed: ensureBytes32(input.scene.seed, "scene.seed") }),
      },
    },
  };
  assertValidManifest(manifest);
  return manifest;
}

function buildTokenPlan(input: {
  readonly token: KeelThreeSceneTokenInput;
  readonly owner: Address;
  readonly executor: Address;
  readonly manifestURI: string;
  readonly manifestDigest: Hex;
}): KeelThreeSceneTokenPlan {
  const token = input.token;
  const collection = ensureAddress(token.collection, "token.collection");
  const factory = ensureAddress(token.factory, "token.factory");
  const index = ensureAddress(token.index, "token.index");
  const recipient = ensureAddress(token.recipient ?? input.owner, "token.recipient");
  const name = (token.name ?? "Keel Three One").trim();
  const symbol = (token.symbol ?? "KEEL1").trim();
  if (name.length === 0 || name.length > 256 || symbol.length === 0 || symbol.length > 32) {
    throw new TypeError("token name and symbol must be bounded and non-empty.");
  }
  const manifestURI = token.manifestURI ?? input.manifestURI;
  const previewImageURI = token.previewImageURI ?? "";
  if (manifestURI.length === 0 || manifestURI.length > 2_048 || previewImageURI.length > 2_048) {
    throw new TypeError("token presentation URIs are outside the contract bounds.");
  }
  const mintData = token.mintData ?? "0x";
  const factoryData = encodeFunctionData({
    abi: FACTORY_CAST_DIE_ABI,
    functionName: "castDie",
    args: [{
      name,
      symbol,
      admin: input.owner,
      royaltyReceiver: input.owner,
      royaltyBps: 0n,
      maxSupply: 1n,
      // The direct EIP-5792 route executes every call as the owner, which is
      // the only authority that can publish/freeze the collection's index
      // binding after the factory returns the predicted CREATE2 address.
      mintManager: input.owner,
      keelIndex: index,
    }],
  });
  const publishData = encodeFunctionData({
    abi: INDEX_PUBLISH_COLLECTION_REVISION_ABI,
    functionName: "publishCollectionRevision",
    args: [collection, manifestURI, input.manifestDigest, 0n, 1n, 1n, 0, 0n],
  });
  const activateData = encodeFunctionData({
    abi: INDEX_ACTIVATE_COLLECTION_REVISION_ABI,
    functionName: "activateCollectionRevision",
    args: [collection, 1n],
  });
  const freezeData = encodeFunctionData({
    abi: INDEX_FREEZE_COLLECTION_ABI,
    functionName: "freezeCollection",
    args: [collection],
  });
  const mintDataEncoded = encodeFunctionData({
    abi: KEEL721_STRIKE_FROM_MANAGER_ABI,
    functionName: "strikeFromManager",
    args: [recipient, 1n, mintData],
  });
  const operations: KeelThreeSceneTokenOperation[] = [
    { kind: "factory-collection", target: factory, value: 0n, data: factoryData },
    { kind: "index-presentation-publish", target: index, value: 0n, data: publishData },
    { kind: "index-presentation-activate", target: index, value: 0n, data: activateData },
    { kind: "index-presentation-freeze", target: index, value: 0n, data: freezeData },
    { kind: "token-mint", target: collection, value: 0n, data: mintDataEncoded },
  ];
  return Object.freeze({
    route: "direct-eip5792",
    status: "review-only",
    ...(token.publicationJobDeployed === true ? {} : { managedBlocker: "publication-job-not-deployed" as const }),
    collection,
    tokenId: 1n,
    maxSupply: 1n,
    presentation: Object.freeze({
      index,
      manifestURI,
      manifestDigest: input.manifestDigest,
      revision: 1n,
      policy: "immutable" as const,
      frozen: true as const,
    }),
    operations: Object.freeze(operations.map((operation) => Object.freeze(operation))),
    logicalOperationCount: 5,
    walletApproval: "required",
    signing: "not-performed",
    submitted: false,
  });
}

/**
 * Build one unsigned, native-only publication for a single immutable Three.js
 * scene. The planner owns the Hold weld operation so callers cannot quietly
 * turn the one-of-one into a multi-operation or history-storage publication.
 */
export async function buildKeelImmutableThreeScenePublicationPlan(
  input: KeelImmutableThreeSceneInput,
): Promise<KeelImmutableThreeScenePublicationPlan> {
  const chainId = ensurePositiveSafe(input.chainId, "chainId");
  const owner = ensureAddress(input.owner, "owner");
  const executor = ensureAddress(input.executor, "executor");
  const hold = ensureAddress(input.hold, "hold");
  if (!SAFE_ID.test(input.scene.id)) throw new TypeError("scene.id must be a bounded metadata-safe identifier.");
  if (input.scene.name.trim().length === 0) throw new TypeError("scene.name is required.");
  if (input.scene.bytes.byteLength === 0) throw new RangeError("An immutable scene cannot be empty.");
  validateClosedSceneBytes(input.scene.bytes);
  const compression = input.scene.compression ?? "none";
  const compressionCode = ({ none: 0, gzip: 1, deflate: 2, brotli: 3 } as const)[compression];
  if (compressionCode === undefined) throw new TypeError("scene.compression is unsupported.");
  const storedBytes = input.scene.storedBytes ?? input.scene.bytes;
  if (storedBytes.byteLength === 0) throw new RangeError("Stored scene bytes cannot be empty.");
  if (compression === "none" && (
    storedBytes.byteLength !== input.scene.bytes.byteLength ||
    !input.scene.bytes.every((value, index) => storedBytes[index] === value)
  )) {
    throw new Error("Uncompressed stored scene bytes must equal the decoded scene bytes.");
  }
  if (compression !== "none" && input.scene.storedBytes === undefined) {
    throw new Error("Compressed scenes must provide exact storedBytes.");
  }
  const mediaType = input.scene.mediaType ?? KEEL_THREE_SCENE_DEFAULT_MEDIA_TYPE;
  if (mediaType.trim().length === 0 || mediaType.length > 127 || /[\u0000-\u001f\u007f]/u.test(mediaType)) throw new TypeError("scene.mediaType is invalid.");
  const modules = await moduleCommitments(input.scene.modules ?? input.scene.bundledModules);
  const sceneDigest = (await createIntegrity(input.scene.bytes)).digest as Hex;
  const storedDigest = (await createIntegrity(storedBytes)).digest as Hex;
  const batches = splitNativeScene(storedBytes);
  const slugIds = batches.flat().map((payload) => keccak256(payload));
  const sceneObjectId = nativeObjectId(slugIds, sceneDigest, input.scene.bytes.byteLength, storedBytes.byteLength, compressionCode, mediaType);
  const operationTarget = ensureAddress(input.operationTarget ?? hold, "operationTarget");
  const operationData = encodeFunctionData({
    abi: WELD_OBJECT_ABI,
    functionName: "weldObject",
    args: [slugIds, sceneDigest, BigInt(input.scene.bytes.byteLength), compressionCode, mediaType],
  });
  const publication = await buildKeelPublicationPlan({
    owner,
    executor,
    deadline: input.deadline,
    decodedDigest: sceneDigest,
    storedDigest,
    decodedByteLength: input.scene.bytes.byteLength,
    storedBytes,
    compression,
    mediaType,
    operations: [{
      target: operationTarget,
      ...(input.operationValue === undefined ? {} : { value: input.operationValue }),
      data: operationData,
    }],
    contentObjectCount: 1,
    logicalOperationCount: 1,
    includeExecutorControlGas: false,
  });
  if (publication.storageMode !== KEEL_NATIVE_CARRIER_V1 || publication.operations.length !== 1) {
    throw new Error("The immutable Three.js scene must remain one native publication with one logical operation.");
  }
  const manifest = sceneManifest({ chainId, hold, scene: input.scene, sceneDigest, sceneObjectId, compression, modules });
  const integrity = await manifestIntegrity(manifest);
  const manifestBytes = utf8ToBytes(canonicalJson(manifest));
  const manifestDigest = integrity.digest as Hex;
  const manifestBatches = splitNativeScene(manifestBytes);
  const manifestSlugIds = manifestBatches.flat().map((payload) => keccak256(payload));
  const manifestObjectId = nativeObjectId(manifestSlugIds, manifestDigest, manifestBytes.byteLength, manifestBytes.byteLength, 0, "application/json");
  const manifestOperationData = encodeFunctionData({
    abi: WELD_OBJECT_ABI,
    functionName: "weldObject",
    args: [manifestSlugIds, manifestDigest, BigInt(manifestBytes.byteLength), 0, "application/json"],
  });
  const manifestPublication = await buildKeelPublicationPlan({
    owner,
    executor,
    deadline: input.deadline,
    decodedDigest: manifestDigest,
    storedDigest: manifestDigest,
    decodedByteLength: manifestBytes.byteLength,
    storedBytes: manifestBytes,
    compression: "none",
    mediaType: "application/json",
    operations: [{ target: hold, data: manifestOperationData }],
    contentObjectCount: 1,
    logicalOperationCount: 1,
    includeExecutorControlGas: false,
  });
  if (manifestPublication.storageMode !== KEEL_NATIVE_CARRIER_V1 || manifestPublication.operations.length !== 1) {
    throw new Error("The canonical immutable manifest must remain a native publication with one logical weld operation.");
  }
  const manifestURI = `keel-onchain://${chainId}/${hold}/${manifestObjectId}`;
  const token = input.token === undefined
    ? undefined
    : buildTokenPlan({ token: input.token, owner, executor, manifestURI, manifestDigest });
  const walletCalls: KeelThreeSceneWalletCall[] = [];
  const addCarrierCalls = (plan: KeelPublicationPlan): void => {
    for (const batch of plan.nativeCarrierBatches ?? []) {
      walletCalls.push({
        to: hold,
        data: encodeFunctionData({ abi: CAST_SLUGS_ABI, functionName: "castSlugs", args: [batch] }),
        value: "0x0",
      });
    }
  };
  addCarrierCalls(publication);
  walletCalls.push({ to: hold, data: operationData, value: "0x0" });
  addCarrierCalls(manifestPublication);
  walletCalls.push({ to: hold, data: manifestOperationData, value: "0x0" });
  for (const operation of token?.operations ?? []) {
    walletCalls.push({ to: operation.target, data: operation.data, value: `0x${operation.value.toString(16)}` });
  }
  return Object.freeze({
    protocol: KEEL_THREE_SCENE_PUBLICATION_PROTOCOL,
    status: "review-only",
    sceneId: input.scene.id,
    sceneDigest,
    sceneObjectId,
    sceneByteLength: input.scene.bytes.byteLength,
    edition: Object.freeze({ size: 1 as const, serial: 1 as const }),
    immutable: true,
    storageMode: KEEL_NATIVE_CARRIER_V1,
    viewer: Object.freeze({
      manifest,
      integrity,
      manifestObjectId,
      manifestByteLength: manifestBytes.byteLength,
      manifestURI,
      manifestPublication,
      modules,
      defaults: Object.freeze({
        manifestTrust: "digest" as const,
        sandbox: "strict" as const,
        capabilities: Object.freeze({}) as Readonly<Record<string, never>>,
        verification: "required" as const,
      }),
    }),
    publication,
    ...(token === undefined ? {} : { token }),
    logicalOperations: Object.freeze({
      sceneStorage: 1 as const,
      manifestStorage: 1 as const,
      tokenPresentation: token === undefined ? 0 as const : 5 as const,
    }),
    walletSendCalls: Object.freeze({
      method: "wallet_sendCalls" as const,
      params: Object.freeze([Object.freeze({
        version: "1.0" as const,
        chainId: `0x${chainId.toString(16)}` as `0x${string}`,
        from: owner,
        calls: Object.freeze(walletCalls),
      })]) as unknown as readonly [{
        readonly version: "1.0";
        readonly chainId: `0x${string}`;
        readonly from: Address;
        readonly calls: readonly KeelThreeSceneWalletCall[];
      }],
    }),
    walletStatusRequest: Object.freeze({
      method: "wallet_getCallsStatus" as const,
      params: Object.freeze(["<wallet-send-calls-id>"]) as readonly ["<wallet-send-calls-id>"],
    }),
    walletApproval: "required",
    signing: "not-performed",
    submitted: false,
  });
}

/** Short alias for callers that do not need the immutable qualifier. */
export const buildKeelThreeScenePublicationPlan = buildKeelImmutableThreeScenePublicationPlan;

/**
 * Reconcile a saved journal and confirmed receipt IDs for the exact scene
 * plan. This is deliberately read-only: a receipt wins over a stale local ID,
 * ambiguity fails closed, and the returned approval state is never requested.
 */
export function recoverKeelImmutableThreeScenePublication(input: {
  readonly plan: KeelImmutableThreeScenePublicationPlan;
  readonly savedJobId?: string;
  readonly confirmedJobIds: readonly bigint[];
  readonly recovery: KeelPublicationRecovery;
}): KeelImmutableThreeSceneRecovery {
  const jobId = selectResumableKeelJobId({
    ...(input.savedJobId === undefined ? {} : { savedJobId: input.savedJobId }),
    confirmedJobIds: input.confirmedJobIds,
  });
  const recovery = mergeKeelPublicationRecovery(undefined, input.recovery);
  return Object.freeze({
    protocol: KEEL_THREE_SCENE_PUBLICATION_PROTOCOL,
    storageMode: KEEL_NATIVE_CARRIER_V1,
    planDigest: input.plan.publication.planDigest,
    ...(jobId === undefined ? {} : { jobId }),
    recovery,
    walletApproval: "not-requested",
  });
}

/** Canonical manifest bytes for callers that need to persist the viewer proof. */
export function canonicalKeelThreeSceneManifestBytes(manifest: ArtifactManifest): Uint8Array {
  assertValidManifest(manifest);
  return utf8ToBytes(canonicalJson(manifest));
}

// Keep the protocol Hex alias visible in generated declaration files without
// widening the public manifest digest to an arbitrary string.
export type KeelThreeSceneManifestDigest = ProtocolHex;
