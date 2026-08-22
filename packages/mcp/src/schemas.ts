import type { JsonSchema } from "./types.js";

const string = (description?: string, maxLength?: number): JsonSchema => ({ type: "string", ...(description === undefined ? {} : { description }), ...(maxLength === undefined ? {} : { maxLength }) });
const integer = (description?: string, minimum?: number, maximum?: number): JsonSchema => ({ type: "integer", ...(description === undefined ? {} : { description }), ...(minimum === undefined ? {} : { minimum }), ...(maximum === undefined ? {} : { maximum }) });
const boolean = (): JsonSchema => ({ type: "boolean" });
const object = (properties: Readonly<Record<string, JsonSchema>>, required: readonly string[] = []): JsonSchema => ({
  type: "object",
  properties,
  ...(required.length === 0 ? {} : { required }),
  additionalProperties: false,
});

const moduleSelector: JsonSchema = {
  anyOf: [
    object({ sha256: string(), byteLength: integer() }, ["sha256", "byteLength"]),
    object({
      name: string(),
      artist: string(),
      tags: { type: "array", items: string(), minItems: 1, maxItems: 16 },
    }, ["name"]),
    object({ artist: string(), tags: { type: "array", items: string(), minItems: 1, maxItems: 16 } }, ["artist"]),
    object({ artist: string(), tags: { type: "array", items: string(), minItems: 1, maxItems: 16 } }, ["tags"]),
  ],
};

const walletRequest: JsonSchema = {
  oneOf: [
    object({
      protocol: string(), requestId: string(), label: string(), transport: string(), family: { type: "string", enum: ["ethereum"] },
      chainId: integer(), to: string(), data: string(), valueWei: string(),
    }, ["protocol", "requestId", "label", "family", "chainId", "to", "data", "valueWei"]),
    object({
      protocol: string(), requestId: string(), label: string(), transport: string(), family: { type: "string", enum: ["tezos"] },
      network: string(), destination: string(), amountMutez: string(), entrypoint: string(), parameters: string(),
    }, ["protocol", "requestId", "label", "family", "network", "destination", "amountMutez"]),
  ],
};

const walletLinkTarget: JsonSchema = object({
  chainId: integer("Ethereum chain ID.", 1),
  factoryAddress: string("KeelFactory address."),
  factoryVersion: string("Pinned KeelFactory FACTORY_VERSION bytes32."),
  creationCodeHash: string("Pinned KEEL721 creation-code hash bytes32."),
  operation: { type: "string", enum: ["keelFactory.castDie"] },
  configDigest: string("KeelFactory.dieConfigDigest(config) bytes32."),
  configEncoding: { type: "string", enum: ["keel-factory-config-keccak@1"] },
  authorizationNonce: string("Creator's current KeelFactory nonce."),
}, ["chainId", "factoryAddress", "factoryVersion", "creationCodeHash", "operation", "configDigest", "configEncoding", "authorizationNonce"]);
const collectionConfig: JsonSchema = object({
  name: string("Collection name.", 256),
  symbol: string("Collection symbol.", 256),
  admin: string("Initial collection admin address."),
  royaltyReceiver: string("ERC-2981 royalty receiver address."),
  royaltyBps: string("Canonical uint96 royalty basis points."),
  maxSupply: string("Canonical uint256 maximum supply."),
  mintManager: string("Initial mint manager address; zero is allowed."),
  keelIndex: string("Artifact registry address; zero is allowed."),
}, ["name", "symbol", "admin", "royaltyReceiver", "royaltyBps", "maxSupply", "mintManager", "keelIndex"]);
const walletLink: JsonSchema = object({
  family: { type: "string", enum: ["ethereum", "tezos"] },
  accountAddress: string("Account/creator wallet address."),
  agentAddress: string("Agent wallet address."),
  target: walletLinkTarget,
  scopes: { type: "array", items: { type: "string", enum: ["read", "analyze", "prepare", "request", "create-collection"] }, minItems: 1, maxItems: 5 },
  issuedAt: integer("Unix seconds.", 0),
  expiresAt: integer("Unix seconds; at most 30 days after issuedAt.", 1),
  nonce: string("Link nonce.", 96),
  transport: { type: "string", enum: ["injected", "walletconnect-qr", "ledger", "tezconnect", "local-encrypted"] },
  revocation: object({ status: { type: "string", enum: ["active", "revoked"] }, nonce: string(undefined, 128), revokedAt: integer(undefined, 0) }, ["status", "nonce"]),
  rotation: object({ sequence: integer(undefined, 0), previousLinkDigest: string() }, ["sequence"]),
  collectionConfig,
}, ["family", "accountAddress", "agentAddress", "target", "scopes", "issuedAt", "expiresAt", "nonce"]);

const moduleSpec: JsonSchema = object({
  moduleId: string("Module id bytes32."),
  moduleVersion: integer("Module version uint64.", 0),
  format: { type: "string", enum: ["es-module", "classic-script", "umd", "commonjs", "wasm"] },
  graphId: string("Backing KeelGraphRegistry graph id bytes32."),
  graphVersion: integer("Graph version uint64.", 0),
  manifestDigest: string("Committed manifest digest bytes32."),
  resourceGraphDigest: string("Committed resource-graph digest bytes32."),
  metadataDigest: string("Committed metadata digest bytes32."),
}, ["moduleId", "moduleVersion", "format", "graphId", "graphVersion", "manifestDigest", "resourceGraphDigest", "metadataDigest"]);
const moduleReview: JsonSchema = object({
  chainId: integer("EVM chain id.", 1),
  registry: string("Deployed KeelModuleReviewRegistry address."),
  action: { type: "string", enum: ["submit", "sanction", "deprecate", "revoke"] },
  spec: moduleSpec,
  specDigest: string("Target spec digest for sanction/deprecate/revoke."),
  reviewDigest: string("Review receipt digest for sanction."),
  reasonDigest: string("Reason digest for deprecate/revoke."),
  replacementSpecDigest: string("Optional replacement spec digest."),
  validUntil: integer("Optional expiry unix seconds; 0 means no expiry.", 0),
}, ["chainId", "registry", "action"]);

const integrity: JsonSchema = object({ algorithm: string(), digest: string(), byteLength: integer(undefined, 1) }, ["algorithm", "digest", "byteLength"]);
const chainTarget: JsonSchema = object({ family: { type: "string", enum: ["ethereum"] }, network: integer(undefined, 1), address: string() }, ["family", "network", "address"]);
const chainSource: JsonSchema = object({ path: string(), schema: string(), objectName: string(), mediaType: string(), integrity }, ["schema", "objectName", "mediaType", "integrity"]);
const castSlugsOperation: JsonSchema = object({
  kind: { type: "string", enum: ["castSlugs"] }, function: string(), payloadEncoding: string(),
  chunkFiles: { type: "array", items: string(), minItems: 1, maxItems: 3 },
  chunkByteLengths: { type: "array", items: integer(undefined, 1, 23000), minItems: 1, maxItems: 3 },
  chunkIntegrities: { type: "array", items: integrity, minItems: 1, maxItems: 3 }, slugIds: string(),
}, ["kind", "function", "payloadEncoding", "chunkFiles", "chunkByteLengths", "chunkIntegrities", "slugIds"]);
const createObjectOperation: JsonSchema = object({
  kind: { type: "string", enum: ["weldObject"] }, function: string(), objectId: string(), slugIds: string(), digest: integrity,
  byteLength: integer(undefined, 1, 268435456), compression: { type: "string", enum: ["none", "gzip", "deflate", "brotli"] }, mediaType: string(),
}, ["kind", "function", "slugIds", "digest", "byteLength", "compression", "mediaType"]);
const compositeOperation: JsonSchema = object({
  kind: { type: "string", enum: ["weldComposite"] }, function: string(), objectId: string(),
  partObjectIds: { type: "array", items: string(), minItems: 1, maxItems: 128 }, digest: integrity,
  byteLength: integer(undefined, 1, 268435456), mediaType: string(),
}, ["kind", "function", "objectId", "partObjectIds", "digest", "byteLength", "mediaType"]);
const chainOperationPlan: JsonSchema = object({
  schema: string(), status: string(), materialized: boolean(), descriptorMaterialized: boolean(), chainReady: boolean(),
  target: chainTarget,
  sourcePlan: chainSource,
  operations: { type: "array", items: { oneOf: [castSlugsOperation, createObjectOperation, compositeOperation] }, minItems: 1, maxItems: 16384 },
  encoding: string(), walletApproval: string(), signing: string(), submission: string(), caveat: string(),
}, ["schema", "status", "materialized", "descriptorMaterialized", "chainReady", "target", "sourcePlan", "operations", "encoding", "walletApproval", "signing", "submission", "caveat"]);

const frayAuctionIntake: JsonSchema = object({
  sourcePath: string("Optional workspace-relative artwork path.", 1024),
  title: string("Artwork title.", 160),
  description: string("Artwork description.", 2000),
  useDefaultDescription: boolean(),
  auctionPreset: integer("Choose exactly 1, 2, or 3.", 1, 3),
  family: { type: "string", enum: ["ethereum", "tezos"] },
  network: string("Supported testnet name, such as sepolia or shadownet.", 64),
  reuseQuery: string("Optional Keel Library/module search query.", 160),
});
const previewCapture: JsonSchema = object({
  still: object({
    mode: { type: "string", enum: ["hook", "timestamp", "settle"] },
    atMs: integer("Still timestamp in milliseconds; used with timestamp mode.", 0, 86400000),
  }, ["mode"]),
  video: object({
    enabled: boolean(),
    mode: { type: "string", enum: ["hook", "timestamp", "settle"] },
    atMs: integer("Video start timestamp in milliseconds; used with timestamp mode.", 0, 86400000),
    durationMs: integer("Preview video duration in milliseconds.", 1000, 30000),
    fps: integer("Preview video frames per second.", 1, 30),
  }, ["enabled", "mode", "durationMs", "fps"]),
}, ["still", "video"]);
const frayStageProject: JsonSchema = object({
  studioUrl: string("Optional Fray Studio HTTPS URL; FRAY_STUDIO_URL is used otherwise.", 512),
  sourcePath: string("Workspace-relative source path.", 1024),
  title: string("Artwork title.", 120),
  description: string("Collector-facing description.", 2000),
  family: { type: "string", enum: ["ethereum", "tezos"] },
  network: string("Supported testnet, such as sepolia or shadownet.", 64),
  auctionPreset: integer("Choose exactly 1, 2, or 3.", 1, 3),
  metadataMode: { type: "string", enum: ["IPFS", "Onchain"] },
  releaseOutcome: { type: "string", enum: ["bidder", "patrons"] },
  mediaType: string("Optional printable media type.", 128),
  previewExecution: { type: "string", enum: ["none", "doom-wasm-sandbox", "html-sandbox"] },
  viewerModules: { type: "array", items: string(), minItems: 0, maxItems: 32 },
  previewCapture,
}, ["sourcePath", "title", "description", "family", "network", "auctionPreset"]);
const chainGuide: JsonSchema = object({
  family: { type: "string", enum: ["ethereum", "tezos"] },
  network: string("Optional network name or chain ID.", 64),
});
const keelLibrarySearch: JsonSchema = object({
  studioUrl: string("Optional HTTPS Keel Studio URL; KEEL_STUDIO_URL is used otherwise.", 512),
  query: string("Module or library search text.", 160),
  limit: integer("Maximum candidates to return.", 1, 100),
}, ["query"]);
const studioCapabilities: JsonSchema = object({
  studioUrl: string("Optional HTTPS Studio URL; KEEL_STUDIO_URL is used otherwise.", 512),
});

export const TOOL_SCHEMAS = {
  analyze: object({ input: string("Workspace-relative media path."), mediaType: string() }, ["input"]),
  build: object({
    input: string(), outputDirectory: string(), createdAt: string(), name: string(), description: string(), id: string(),
    creator: string(), sourceRepository: string(), viewerBaseUrl: string(), webpQuality: integer(), preserveOriginal: boolean(),
    sourceMode: { type: "string", enum: ["files", "inline"] },
  }, ["input", "outputDirectory", "createdAt"]),
  verify: object({ directory: string(), manifestName: string() }, ["directory"]),
  cost: object({
    input: string(), mediaType: string(), compression: { type: "string", enum: ["auto", "none", "brotli", "gzip", "deflate"] },
    maxChunkBytes: integer(), leafDecodedBytes: integer(), maxPartsPerComposite: integer(), maxTreeDepth: integer(),
  }, ["input"]),
  uploadPlan: object({
    input: string("Workspace-relative source file."), objectName: string(undefined, 128), mediaType: string(undefined, 128),
    strategy: { type: "string", enum: ["flat", "recursive"] },
    compression: { type: "string", enum: ["auto", "none", "brotli", "gzip", "deflate"] },
    maxChunkBytes: integer(undefined, 1, 23000), leafDecodedBytes: integer(undefined, 4096), maxPartsPerComposite: integer(undefined, 2, 128),
  }, ["input", "objectName", "mediaType"]),
  chainPlan: object({
    plan: string("Workspace-relative materialized upload-plan JSON."),
    family: { type: "string", enum: ["ethereum"] },
    chainId: integer(undefined, 1), target: string(),
  }, ["plan", "family", "chainId", "target"]),
  ethereumEncode: object({
    plan: string("Workspace-relative materialized upload-plan JSON."),
    family: { type: "string", enum: ["ethereum"] },
    chainId: integer(undefined, 1), target: string(), qr: boolean(),
  }, ["plan", "family", "chainId", "target"]),
  publishPlan: object({
    chainPlan: { ...chainOperationPlan, description: "The structured result returned by chain-plan." },
  }, ["chainPlan"]),
  moduleResolve: object({ snapshot: string(), selector: moduleSelector }, ["snapshot", "selector"]),
  moduleLock: object({ snapshot: string(), out: string(), selector: moduleSelector }, ["snapshot", "out", "selector"]),
  walletRequestPrepare: object({ request: walletRequest, qr: boolean() }, ["request"]),
  walletLink: object({ link: walletLink }, ["link"]),
  moduleReview: object({ review: moduleReview }, ["review"]),
  frayAuctionIntake,
  frayStageProject,
  chainGuide,
  keelLibrarySearch,
  studioCapabilities,
} as const;
