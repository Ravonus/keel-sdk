import { canonicalJson, createIntegrity, utf8ToBytes, type Hex, type Integrity } from "@keel/protocol";
import {
  bytesToHex,
  encodeAbiParameters,
  hexToBytes,
  keccak256,
  stringToHex,
  type Address,
} from "viem";

/**
 * Canonical, review-only descriptor for publishing one prepared artifact to
 * the native EVM Library graph. This module deliberately does not encode
 * calldata, create a wallet client, sign, or submit anything.
 */
export const KEEL_LIBRARY_PUBLICATION_PLAN_PROTOCOL = "keel-library-publication-plan@1" as const;

const ADDRESS = /^0x[0-9a-f]{40}$/u;
const DIGEST = /^0x[0-9a-f]{64}$/u;
const SALT = DIGEST;
const ZERO = `0x${"0".repeat(64)}` as Hex;
const MAX_UINT64 = (2n ** 64n) - 1n;
const MAX_UINT128 = (2n ** 128n) - 1n;
const MAX_TAGS = 32;
const MAX_TAG_BYTES = 64;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_CHUNK_BYTES = 23_000;
/** KeelHold rejects a castSlugs payload with more than three leaf chunks. */
export const KEEL_LIBRARY_MAX_CAST_BATCH_SLUGS = 3 as const;
/**
 * A flat KeelHold object is deliberately bounded to 128 leaf chunks.  The
 * composite-object path is a separate protocol and is not guessed here.
 */
export const KEEL_LIBRARY_MAX_LEAF_SLUGS = 128 as const;
const GRAPH_ID_DOMAIN = keccak256(stringToHex("keel.graph.v1"));
const ASSET_ID_DOMAIN = keccak256(stringToHex("keel.library.asset.v1"));
const POLICY_COMMITMENT_DOMAIN = keccak256(stringToHex("keel.library.policy.v1"));

export const KEEL_LIBRARY_GRAPH_KIND = 2 as const;
export const KEEL_LIBRARY_STORAGE_TIER_ONCHAIN = 2 as const;
export const KEEL_LIBRARY_COMPRESSION_NONE = 0 as const;

export const KEEL_LIBRARY_NATIVE_ACCESS_MODES = [
  "closed",
  "open",
  "paid",
  "address-allowlist",
  "token-gate",
  "submission-only",
] as const;
export type KeelLibraryNativeAccessMode = (typeof KEEL_LIBRARY_NATIVE_ACCESS_MODES)[number];

export type KeelLibraryAssetKind = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Exact KeelLibraryRegistry.AssetKind mapping; unknown declared types fail to Other explicitly. */
export function keelLibraryAssetKindForType(assetType: string): KeelLibraryAssetKind {
  const value = assetType.trim().toLowerCase().replaceAll(/[_\s]+/gu, "-");
  if (value === "script" || value === "javascript" || value === "js" || value === "module" || value === "script-library" || value === "es-module") return 0;
  if (value === "sprite" || value === "sprite-atlas" || value === "atlas") return 1;
  if (value === "audio" || value === "sound") return 2;
  if (value === "model" || value === "3d" || value === "model-3d" || value === "3d-graphics") return 3;
  if (value === "material" || value === "style" || value === "shader") return 4;
  if (value === "dataset" || value === "data") return 5;
  if (value === "creation-module" || value === "creation" || value === "generator") return 7;
  return 6;
}

export type KeelLibraryAddress = `0x${string}`;

export interface KeelLibraryPublicationContracts {
  readonly hold: KeelLibraryAddress;
  readonly objectRegistry: KeelLibraryAddress;
  readonly linkRegistry: KeelLibraryAddress;
  readonly graphRegistry: KeelLibraryAddress;
  readonly libraryRegistry: KeelLibraryAddress;
  readonly tagRegistry?: KeelLibraryAddress;
}

export interface KeelLibraryPublicationResource {
  readonly path: string;
  readonly resourceId: string;
  readonly digest: Hex;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly compression: "none" | "gzip" | "deflate" | "brotli";
  /** Hold content object containing the exact decoded bytes. */
  readonly contentStore: KeelLibraryAddress;
  readonly contentObjectId: Hex;
  /** ObjectRegistry logical record which binds the content object to the artifact. */
  readonly logicalObjectId: Hex;
  readonly objectRegistry: KeelLibraryAddress;
  readonly objectRevision: number;
  readonly linkRegistry: KeelLibraryAddress;
}

export interface KeelLibrarySourceVerification {
  readonly protocol: "keel-source-receipt@1";
  readonly source: Integrity;
  readonly output: Integrity;
  readonly report: Readonly<Record<string, unknown>>;
  readonly reportDigest: Hex;
  readonly disposition: "queued" | "exact-source-output" | "reproducible-build";
  readonly repository?: Readonly<{ readonly url: string; readonly revision: string; readonly path: string }>;
  readonly buildRecipeDigest?: Hex;
}

export interface KeelLibraryPublicationArtifact {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly description: string;
  readonly assetType: string;
  readonly license: string;
  readonly controller: KeelLibraryAddress;
  readonly anchor: {
    readonly chainId: number;
    readonly registry: KeelLibraryAddress;
    readonly collection: KeelLibraryAddress;
    readonly tokenId: string;
  };
  readonly resource: KeelLibraryPublicationResource;
  readonly sourceVerification: KeelLibrarySourceVerification;
}

export interface KeelLibraryPublicationPolicyInput {
  readonly mode: KeelLibraryNativeAccessMode;
  readonly payout?: KeelLibraryAddress;
  readonly priceWei?: string | number | bigint;
  readonly grantDurationSeconds?: string | number | bigint;
  readonly availableFrom?: string | number | bigint;
  readonly availableUntil?: string | number | bigint;
  readonly allowlistRoot?: Hex;
  readonly gateToken?: KeelLibraryAddress;
  readonly minimumTokenBalance?: string | number | bigint;
  readonly statement?: string;
}

export interface KeelLibraryPublicationInput {
  readonly chain: { readonly family: "ethereum"; readonly chainId: number };
  readonly controller: KeelLibraryAddress;
  readonly contracts: KeelLibraryPublicationContracts;
  readonly salts: { readonly graph: Hex; readonly asset: Hex };
  readonly artifact: KeelLibraryPublicationArtifact;
  readonly policy: KeelLibraryPublicationPolicyInput;
  readonly tags?: readonly string[];
  /** A pre-compressed manifest is not accepted until a decompressor proof is supplied. */
  readonly manifestStorage?: {
    readonly compression: "none";
    /** Optional exact bytes. If absent, canonical manifest bytes are used. */
    readonly storedBytesHex?: Hex;
  };
  readonly live?: {
    readonly holdObjectExists?: boolean;
    readonly holdObjectMatches?: boolean;
    readonly logicalObjectExists?: boolean;
    readonly contractsCompatible?: boolean;
    readonly staleReason?: string;
  };
}

export interface KeelLibraryPolicy {
  readonly mode: KeelLibraryNativeAccessMode;
  readonly modeCode: 0 | 1 | 2 | 3 | 4 | 5;
  readonly payout: KeelLibraryAddress;
  readonly priceWei: string;
  readonly grantDurationSeconds: string;
  readonly availableFrom: string;
  readonly availableUntil: string;
  readonly allowlistRoot: Hex;
  readonly gateToken: KeelLibraryAddress;
  readonly minimumTokenBalance: string;
  readonly termsDigest: Hex;
}

export interface KeelLibraryPublicationOperation {
  readonly order: number;
  readonly kind: "logical-object" | "manifest-storage" | "graph-create" | "library-index" | "canonical-tags";
  readonly target?: KeelLibraryAddress;
  readonly execution: "deferred";
  readonly function?: string;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly predicted?: Hex;
  readonly blocker?: string;
}

export interface KeelLibraryPublicationPlan {
  readonly protocol: typeof KEEL_LIBRARY_PUBLICATION_PLAN_PROTOCOL;
  readonly status: "review-only";
  readonly chain: { readonly family: "ethereum"; readonly chainId: number };
  readonly controller: KeelLibraryAddress;
  readonly contracts: KeelLibraryPublicationContracts;
  readonly artifact: {
    readonly id: string;
    readonly revision: number;
    readonly anchor: KeelLibraryPublicationArtifact["anchor"];
    readonly resource: KeelLibraryPublicationResource;
  };
  readonly manifest: {
    readonly protocol: "keel-library-manifest@1";
    readonly canonicalBytesHex: Hex;
    readonly digest: Hex;
    readonly byteLength: number;
    readonly storageCompression: "none";
    readonly storageObjectId?: Hex;
    readonly storageUri?: string;
    readonly resourceGraphDigest: Hex;
    readonly catalogMetadataDigest: Hex;
    readonly termsDigest: Hex;
  };
  readonly predicted: {
    readonly graphId: Hex;
    readonly assetId: Hex;
    readonly policyCommitment?: Hex;
  };
  readonly assetKind: KeelLibraryAssetKind;
  readonly policy: KeelLibraryPolicy;
  readonly tags: readonly string[];
  readonly operations: readonly KeelLibraryPublicationOperation[];
  readonly blockers: readonly string[];
  readonly readiness: "ready" | "blocked";
  readonly walletApproval: "required";
  readonly signing: "not-performed";
  readonly submitted: false;
  readonly recurringSubscription: false;
  readonly encoding: "deferred-contract-abi";
  readonly caveat: "This is a canonical review plan only; a verified wallet adapter must re-read, simulate, request approval, sign, and submit it.";
  readonly planDigest: Hex;
}

export interface KeelLibraryPublicationPlanEnvelope {
  readonly plan: KeelLibraryPublicationPlan;
  readonly integrity: Integrity;
}

const MODE_CODE: Readonly<Record<KeelLibraryNativeAccessMode, 0 | 1 | 2 | 3 | 4 | 5>> = {
  closed: 0,
  open: 1,
  "address-allowlist": 2,
  "token-gate": 3,
  paid: 4,
  "submission-only": 5,
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function address(value: unknown, label: string): KeelLibraryAddress {
  if (typeof value !== "string" || !ADDRESS.test(value)) throw new TypeError(`${label} must be a 20-byte lowercase EVM address.`);
  return value.toLowerCase() as KeelLibraryAddress;
}

function digest(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new TypeError(`${label} must be a lower-case SHA-256/bytes32 digest.`);
  return value.toLowerCase() as Hex;
}

function nonEmptyText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value.trim();
}

function safeUint(value: unknown, label: string, maximum = MAX_UINT64): string {
  let parsed: bigint;
  try {
    if (typeof value === "number" && Number.isSafeInteger(value)) parsed = BigInt(value);
    else if (typeof value === "bigint") parsed = value;
    else if (typeof value === "string" && /^[0-9]+$/u.test(value)) parsed = BigInt(value);
    else throw new Error();
  } catch {
    throw new TypeError(`${label} must be an unsigned integer.`);
  }
  if (parsed < 0n || parsed > maximum) throw new RangeError(`${label} is outside its contract range.`);
  return parsed.toString();
}

function positiveInt(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new RangeError(`${label} must be a positive safe integer.`);
  return value;
}

function normalTags(values: readonly string[] | undefined): readonly string[] {
  if (values === undefined) return [];
  if (values.length > MAX_TAGS) throw new RangeError(`At most ${MAX_TAGS} canonical tags may be declared.`);
  const tags = new Set<string>();
  for (const raw of values) {
    const tag = nonEmptyText(raw, "tag", MAX_TAG_BYTES).toLowerCase();
    if (!/^[a-z0-9][a-z0-9._/-]*$/u.test(tag)) throw new TypeError(`Tag ${tag} contains unsupported characters.`);
    if (new TextEncoder().encode(tag).byteLength > MAX_TAG_BYTES) throw new RangeError("Tag exceeds its UTF-8 byte limit.");
    tags.add(tag);
  }
  return [...tags].sort((left, right) => left.localeCompare(right));
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function compressionCode(value: KeelLibraryPublicationResource["compression"]): number {
  if (value === "none") return 0;
  if (value === "gzip") return 1;
  if (value === "deflate") return 2;
  return 3;
}

function packedBytes32(values: readonly Hex[]): Hex {
  const bytes = new Uint8Array(values.length * 32);
  values.forEach((value, index) => bytes.set(hexToBytes(value), index * 32));
  return bytesToHex(bytes);
}

function predictGraphId(controller: Address, salt: Hex): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "address" }, { type: "bytes32" }],
    [GRAPH_ID_DOMAIN, controller, salt],
  ));
}

function predictAssetId(chainId: number, libraryRegistry: Address, controller: Address, salt: Hex): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "bytes32" }],
    [ASSET_ID_DOMAIN, BigInt(chainId), libraryRegistry, controller, salt],
  ));
}

function predictObjectId(slugIds: readonly Hex[], digestValue: Hex, byteLength: number, mediaType: string): Hex {
  const indexDigest = keccak256(packedBytes32(slugIds));
  return keccak256(encodeAbiParameters(
    [
      { type: "bytes1" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint64" },
      { type: "uint64" },
      { type: "uint8" },
      { type: "bytes32" },
    ],
    ["0x00", indexDigest, digestValue, BigInt(byteLength), BigInt(byteLength), 0, keccak256(stringToHex(mediaType))],
  ));
}

function policyInput(input: KeelLibraryPublicationPolicyInput): {
  readonly mode: KeelLibraryNativeAccessMode;
  readonly payout: KeelLibraryAddress;
  readonly priceWei: string;
  readonly grantDurationSeconds: string;
  readonly availableFrom: string;
  readonly availableUntil: string;
  readonly allowlistRoot: Hex;
  readonly gateToken: KeelLibraryAddress;
  readonly minimumTokenBalance: string;
  readonly statement: string;
} {
  const mode = input.mode;
  if (!KEEL_LIBRARY_NATIVE_ACCESS_MODES.includes(mode)) {
    throw new TypeError("Library publication accepts only the six native access modes; subscription, special, license, and ambiguous request modes are rejected.");
  }
  const payout = input.payout === undefined ? "0x0000000000000000000000000000000000000000" as KeelLibraryAddress : address(input.payout, "policy.payout");
  const gateToken = input.gateToken === undefined ? "0x0000000000000000000000000000000000000000" as KeelLibraryAddress : address(input.gateToken, "policy.gateToken");
  const priceWei = safeUint(input.priceWei ?? 0n, "policy.priceWei", MAX_UINT128);
  const grantDurationSeconds = safeUint(input.grantDurationSeconds ?? 0n, "policy.grantDurationSeconds");
  const availableFrom = safeUint(input.availableFrom ?? 0n, "policy.availableFrom");
  const availableUntil = safeUint(input.availableUntil ?? 0n, "policy.availableUntil");
  const allowlistRoot = input.allowlistRoot === undefined ? ZERO : digest(input.allowlistRoot, "policy.allowlistRoot");
  const minimumTokenBalance = safeUint(input.minimumTokenBalance ?? 0n, "policy.minimumTokenBalance", MAX_UINT128);
  if (BigInt(availableUntil) !== 0n && BigInt(availableUntil) <= BigInt(availableFrom)) throw new RangeError("policy.availableUntil must be after availableFrom.");
  const noExtra = mode === "closed" || mode === "open";
  if (noExtra && (priceWei !== "0" || payout !== "0x0000000000000000000000000000000000000000" || grantDurationSeconds !== "0" || allowlistRoot !== ZERO || gateToken !== "0x0000000000000000000000000000000000000000" || minimumTokenBalance !== "0")) throw new TypeError(`${mode} cannot carry paid, timed, allowlist, or token-gate terms.`);
  if (mode === "paid" && (BigInt(priceWei) === 0n || payout === "0x0000000000000000000000000000000000000000" || allowlistRoot !== ZERO || gateToken !== "0x0000000000000000000000000000000000000000" || minimumTokenBalance !== "0")) throw new TypeError("Paid mode requires a payout and non-zero price, and cannot carry allowlist or token-gate fields.");
  if (mode === "address-allowlist" && (allowlistRoot === ZERO || priceWei !== "0" || payout !== "0x0000000000000000000000000000000000000000" || gateToken !== "0x0000000000000000000000000000000000000000" || minimumTokenBalance !== "0")) throw new TypeError("AddressAllowlist requires a root and cannot carry paid or token-gate fields.");
  if (mode === "token-gate" && (gateToken === "0x0000000000000000000000000000000000000000" || minimumTokenBalance === "0" || priceWei !== "0" || payout !== "0x0000000000000000000000000000000000000000" || allowlistRoot !== ZERO || grantDurationSeconds !== "0")) throw new TypeError("TokenGate requires a token and minimum balance and cannot carry paid, allowlist, or timed-grant fields.");
  if ((mode === "submission-only") && (priceWei !== "0" || payout !== "0x0000000000000000000000000000000000000000" || allowlistRoot !== ZERO || gateToken !== "0x0000000000000000000000000000000000000000" || minimumTokenBalance !== "0")) throw new TypeError("SubmissionOnly cannot carry paid, allowlist, or token-gate fields.");
  return {
    mode,
    payout,
    priceWei,
    grantDurationSeconds,
    availableFrom,
    availableUntil,
    allowlistRoot,
    gateToken,
    minimumTokenBalance,
    statement: nonEmptyText(input.statement ?? "Contract access records this exact native policy and policy-version entitlement; public on-chain bytes remain inspectable.", "policy.statement", 512),
  };
}

async function validateReceipt(receipt: KeelLibrarySourceVerification, resource: KeelLibraryPublicationResource): Promise<void> {
  if (receipt.protocol !== "keel-source-receipt@1") throw new TypeError("artifact.sourceVerification.protocol is unsupported.");
  if (receipt.output.algorithm !== "sha256" || receipt.output.digest.toLowerCase() !== resource.digest.toLowerCase() || receipt.output.byteLength !== resource.byteLength) throw new TypeError("Source receipt output does not match the exact declared resource.");
  if (receipt.source.algorithm !== "sha256" || !DIGEST.test(receipt.source.digest) || receipt.source.byteLength === undefined || !Number.isSafeInteger(receipt.source.byteLength) || receipt.source.byteLength < 0) throw new TypeError("Source receipt source integrity is incomplete.");
  const reportIntegrity = await createIntegrity(utf8ToBytes(canonicalJson(receipt.report)));
  if (receipt.reportDigest.toLowerCase() !== reportIntegrity.digest.toLowerCase()) throw new TypeError("Source receipt reportDigest does not match canonical report bytes.");
  if (receipt.repository !== undefined) {
    let url: URL;
    try { url = new URL(receipt.repository.url); } catch { throw new TypeError("Source receipt repository URL is invalid."); }
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || receipt.repository.revision.trim() === "" || receipt.repository.path.trim() === "" || receipt.repository.path.startsWith("/") || receipt.repository.path.includes("\\")) throw new TypeError("Source receipt repository provenance is invalid.");
  }
  if (receipt.disposition !== "queued" && receipt.disposition !== "exact-source-output" && receipt.disposition !== "reproducible-build") throw new TypeError("Source receipt disposition is not accepted by the Library indexer.");
  if (receipt.disposition === "queued" && receipt.buildRecipeDigest === undefined) throw new TypeError("Queued source receipts require a buildRecipeDigest.");
}

function operationDigestInput(operation: KeelLibraryPublicationOperation): Readonly<Record<string, unknown>> {
  return {
    order: operation.order,
    kind: operation.kind,
    ...(operation.target === undefined ? {} : { target: operation.target }),
    execution: operation.execution,
    ...(operation.function === undefined ? {} : { function: operation.function }),
    ...(operation.args === undefined ? {} : { args: operation.args }),
    ...(operation.predicted === undefined ? {} : { predicted: operation.predicted }),
    ...(operation.blocker === undefined ? {} : { blocker: operation.blocker }),
  };
}

/** Build a deterministic, unsigned EVM Library publication review plan. */
export async function buildKeelLibraryPublicationPlan(input: KeelLibraryPublicationInput): Promise<KeelLibraryPublicationPlanEnvelope> {
  if (input.chain.family !== "ethereum") throw new TypeError("Only the EVM Library publication adapter is supported.");
  const chainId = positiveInt(input.chain.chainId, "chain.chainId");
  const controller = address(input.controller, "controller");
  const contracts: KeelLibraryPublicationContracts = {
    hold: address(input.contracts.hold, "contracts.hold"),
    objectRegistry: address(input.contracts.objectRegistry, "contracts.objectRegistry"),
    linkRegistry: address(input.contracts.linkRegistry, "contracts.linkRegistry"),
    graphRegistry: address(input.contracts.graphRegistry, "contracts.graphRegistry"),
    libraryRegistry: address(input.contracts.libraryRegistry, "contracts.libraryRegistry"),
    ...(input.contracts.tagRegistry === undefined ? {} : { tagRegistry: address(input.contracts.tagRegistry, "contracts.tagRegistry") }),
  };
  const graphSalt = digest(input.salts.graph, "salts.graph");
  const assetSalt = digest(input.salts.asset, "salts.asset");
  const artifact = input.artifact;
  const artifactId = nonEmptyText(artifact.id, "artifact.id", 128);
  const revision = positiveInt(artifact.revision, "artifact.revision");
  const artifactController = address(artifact.controller, "artifact.controller");
  if (!sameAddress(controller, artifactController)) throw new TypeError("controller does not match the prepared artifact controller.");
  if (artifact.anchor.chainId !== chainId) throw new TypeError("artifact.anchor.chainId does not match the publication chain.");
  address(artifact.anchor.registry, "artifact.anchor.registry");
  address(artifact.anchor.collection, "artifact.anchor.collection");
  nonEmptyText(artifact.anchor.tokenId, "artifact.anchor.tokenId", 128);
  const resource = artifact.resource;
  const path = nonEmptyText(resource.path, "artifact.resource.path", 512);
  if (path.startsWith("/") || path.split("/").some((part) => part === "" || part === "." || part === "..")) throw new TypeError("artifact.resource.path must be a safe relative path.");
  const resourceId = nonEmptyText(resource.resourceId, "artifact.resourceId", 256);
  const resourceDigest = digest(resource.digest, "artifact.resource.digest");
  const byteLength = positiveInt(resource.byteLength, "artifact.resource.byteLength", Number.MAX_SAFE_INTEGER);
  if (resource.compression !== "none" && resource.compression !== "gzip" && resource.compression !== "deflate" && resource.compression !== "brotli") throw new TypeError("artifact.resource.compression is unsupported.");
  const mediaType = nonEmptyText(resource.mediaType, "artifact.resource.mediaType", 128);
  const normalizedResource: KeelLibraryPublicationResource = {
    path,
    resourceId,
    digest: resourceDigest,
    byteLength,
    mediaType,
    compression: resource.compression,
    contentStore: address(resource.contentStore, "artifact.resource.contentStore"),
    contentObjectId: digest(resource.contentObjectId, "artifact.resource.contentObjectId"),
    logicalObjectId: digest(resource.logicalObjectId, "artifact.resource.logicalObjectId"),
    objectRegistry: address(resource.objectRegistry, "artifact.resource.objectRegistry"),
    objectRevision: positiveInt(resource.objectRevision, "artifact.resource.objectRevision"),
    linkRegistry: address(resource.linkRegistry, "artifact.resource.linkRegistry"),
  };
  if (!sameAddress(normalizedResource.contentStore, contracts.hold) || !sameAddress(normalizedResource.objectRegistry, contracts.objectRegistry) || !sameAddress(normalizedResource.linkRegistry, contracts.linkRegistry)) throw new TypeError("The prepared resource does not use the configured Hold/Object/Link graph.");
  await validateReceipt(artifact.sourceVerification, normalizedResource);
  const tags = normalTags(input.tags);
  if (tags.length > 0 && contracts.tagRegistry === undefined) throw new TypeError("Canonical tags require an enabled TagRegistry contract.");
  const policyInputValue = policyInput(input.policy);
  const graphId = predictGraphId(controller, graphSalt);
  const assetId = predictAssetId(chainId, contracts.libraryRegistry, controller, assetSalt);
  const assetKind = keelLibraryAssetKindForType(artifact.assetType);
  const terms = {
    protocol: "keel-library-terms@1",
    assetId,
    mode: policyInputValue.mode,
    license: nonEmptyText(artifact.license, "artifact.license", 256),
    priceWei: policyInputValue.priceWei,
    // Keep uint64 terms as decimal strings.  Converting to Number here would
    // silently round valid contract values above 2^53 and change the terms
    // digest that the LibraryRegistry verifies.
    grantDurationSeconds: policyInputValue.grantDurationSeconds,
    statement: policyInputValue.statement,
  } as const;
  const termsIntegrity = await createIntegrity(utf8ToBytes(canonicalJson(terms)));
  const metadata = {
    protocol: "keel-library-catalog-metadata@1",
    id: artifactId,
    name: nonEmptyText(artifact.name, "artifact.name", 256),
    description: nonEmptyText(artifact.description || "Prepared reusable artifact.", "artifact.description", 4_096),
    kind: nonEmptyText(artifact.assetType, "artifact.assetType", 128),
    tags,
    license: terms.license,
    defaults: { label: artifact.name, role: "asset", format: "asset" },
    maintainedBy: controller,
    sourceVerification: artifact.sourceVerification,
    upstream: { artifactId, revision },
  } as const;
  const metadataIntegrity = await createIntegrity(utf8ToBytes(canonicalJson(metadata)));
  const resourceGraph = {
    protocol: "keel-resource-graph@1",
    resources: [{
      id: "primary",
      mediaType,
      byteLength,
      storedByteLength: byteLength,
      compression: normalizedResource.compression,
      integrity: { algorithm: "sha256", digest: resourceDigest },
      logicalObject: { registry: normalizedResource.objectRegistry, objectId: normalizedResource.logicalObjectId, revision: normalizedResource.objectRevision, linkRegistry: normalizedResource.linkRegistry },
      deliveryProfiles: { onchain: { kind: "onchain", chainId, store: normalizedResource.contentStore, objectId: normalizedResource.contentObjectId } },
    }],
  } as const;
  const resourceGraphIntegrity = await createIntegrity(utf8ToBytes(canonicalJson(resourceGraph)));
  const manifest = {
    protocol: "keel-library-manifest@1",
    revision: 1,
    graph: { registry: contracts.graphRegistry, graphId, version: 1 },
    catalogue: { registry: contracts.libraryRegistry, assetId, policyVersion: 1 },
    metadata,
    access: terms,
    resourceGraph,
  } as const;
  const canonicalManifestBytes = utf8ToBytes(canonicalJson(manifest));
  if (canonicalManifestBytes.byteLength === 0 || canonicalManifestBytes.byteLength > MAX_MANIFEST_BYTES) throw new RangeError("Canonical Library manifest is outside its bounded size.");
  const manifestIntegrity = await createIntegrity(canonicalManifestBytes);
  const suppliedManifestBytes = input.manifestStorage?.storedBytesHex === undefined ? undefined : hexToBytes(input.manifestStorage.storedBytesHex);
  const manifestBytes = suppliedManifestBytes === undefined ? canonicalManifestBytes : suppliedManifestBytes;
  if (suppliedManifestBytes !== undefined && bytesToHex(suppliedManifestBytes) !== bytesToHex(canonicalManifestBytes)) throw new TypeError("manifestStorage.storedBytesHex must equal the canonical manifest bytes for the proven uncompressed path.");
  const chunkByteLengths: number[] = [];
  const slugIds: Hex[] = [];
  for (let offset = 0; offset < manifestBytes.byteLength; offset += MAX_CHUNK_BYTES) {
    const chunk = manifestBytes.slice(offset, Math.min(offset + MAX_CHUNK_BYTES, manifestBytes.byteLength));
    chunkByteLengths.push(chunk.byteLength);
    slugIds.push(keccak256(bytesToHex(chunk)));
  }
  if (slugIds.length > KEEL_LIBRARY_MAX_LEAF_SLUGS) {
    throw new RangeError(`The manifest requires ${slugIds.length} leaf chunks; flat KeelHold objects support at most ${KEEL_LIBRARY_MAX_LEAF_SLUGS}. Composite objects are not available in this publication plan.`);
  }
  const manifestObjectId = predictObjectId(slugIds, manifestIntegrity.digest as Hex, canonicalManifestBytes.byteLength, "application/vnd.keel.library+json");
  const manifestUri = `oca-onchain://${chainId}/${contracts.hold}/${manifestObjectId}`;
  const policyTuple = {
    mode: MODE_CODE[policyInputValue.mode],
    payout: policyInputValue.payout,
    price: policyInputValue.priceWei,
    grantDuration: policyInputValue.grantDurationSeconds,
    availableFrom: policyInputValue.availableFrom,
    availableUntil: policyInputValue.availableUntil,
    allowlistRoot: policyInputValue.allowlistRoot,
    gateToken: policyInputValue.gateToken,
    minimumTokenBalance: policyInputValue.minimumTokenBalance,
    termsDigest: termsIntegrity.digest,
  } as const;
  const policyAbiTuple = {
    mode: policyTuple.mode,
    payout: policyTuple.payout,
    price: BigInt(policyTuple.price),
    grantDuration: BigInt(policyTuple.grantDuration),
    availableFrom: BigInt(policyTuple.availableFrom),
    availableUntil: BigInt(policyTuple.availableUntil),
    allowlistRoot: policyTuple.allowlistRoot,
    gateToken: policyTuple.gateToken,
    minimumTokenBalance: BigInt(policyTuple.minimumTokenBalance),
    termsDigest: policyTuple.termsDigest,
  } as const;
  const policyCommitment = keccak256(encodeAbiParameters(
    [
      { type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" },
      { type: "uint64" }, { type: "uint64" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint8" }, { type: "bytes32" },
      { type: "tuple", components: [
        { name: "mode", type: "uint8" }, { name: "payout", type: "address" }, { name: "price", type: "uint128" },
        { name: "grantDuration", type: "uint64" }, { name: "availableFrom", type: "uint64" }, { name: "availableUntil", type: "uint64" },
        { name: "allowlistRoot", type: "bytes32" }, { name: "gateToken", type: "address" }, { name: "minimumTokenBalance", type: "uint128" }, { name: "termsDigest", type: "bytes32" },
      ] },
    ] as const,
    [POLICY_COMMITMENT_DOMAIN, BigInt(chainId), contracts.libraryRegistry, contracts.graphRegistry, assetId, graphId, 1n, 1n, manifestIntegrity.digest, resourceGraphIntegrity.digest, KEEL_LIBRARY_STORAGE_TIER_ONCHAIN, metadataIntegrity.digest, policyAbiTuple] as const,
  ));
  const blockers: string[] = [];
  if (input.live?.holdObjectExists === true && input.live.holdObjectMatches !== true) blockers.push("manifest-object-exists-but-live-readback-does-not-match");
  if (input.live?.logicalObjectExists === false) blockers.push("logical-object-anchor-is-not-live");
  if (input.live?.contractsCompatible === false) blockers.push("live-contract-compatibility-read-failed");
  if (input.live?.staleReason !== undefined) blockers.push(`stale-live-read:${nonEmptyText(input.live.staleReason, "live.staleReason", 512)}`);
  const manifestOperations: KeelLibraryPublicationOperation[] = [];
  const batchCount = Math.ceil(slugIds.length / KEEL_LIBRARY_MAX_CAST_BATCH_SLUGS);
  for (let offset = 0; offset < slugIds.length; offset += KEEL_LIBRARY_MAX_CAST_BATCH_SLUGS) {
    const batchIndex = Math.floor(offset / KEEL_LIBRARY_MAX_CAST_BATCH_SLUGS);
    const batchSlugIds = slugIds.slice(offset, offset + KEEL_LIBRARY_MAX_CAST_BATCH_SLUGS);
    manifestOperations.push({
      order: 1 + manifestOperations.length,
      kind: "manifest-storage",
      target: contracts.hold,
      execution: "deferred",
      function: "castSlugs(bytes[])",
      args: {
        payloadEncoding: "canonical-manifest-chunks",
        batchIndex,
        batchCount,
        chunkCount: batchSlugIds.length,
        chunkByteLengths: chunkByteLengths.slice(offset, offset + KEEL_LIBRARY_MAX_CAST_BATCH_SLUGS),
        slugIds: batchSlugIds,
        payloads: "derived-from-canonical-manifest-bytes-after-review",
      },
    });
  }
  manifestOperations.push({
    order: 1 + manifestOperations.length,
    kind: "manifest-storage",
    target: contracts.hold,
    execution: "deferred",
    function: "weldObject(bytes32[],bytes32,uint64,uint8,string)",
    args: {
      slugIds,
      digest: manifestIntegrity.digest,
      byteLength: canonicalManifestBytes.byteLength,
      compression: KEEL_LIBRARY_COMPRESSION_NONE,
      mediaType: "application/vnd.keel.library+json",
      objectId: manifestObjectId,
      manifestUri,
    },
    predicted: manifestObjectId,
  });
  const operations: KeelLibraryPublicationOperation[] = [
    {
      order: 0,
      kind: "logical-object",
      target: contracts.objectRegistry,
      execution: "deferred",
      function: "reuse-existing-logical-object",
      args: { logicalObjectId: normalizedResource.logicalObjectId, contentObjectId: normalizedResource.contentObjectId, revision: normalizedResource.objectRevision, resourceId },
      predicted: normalizedResource.logicalObjectId,
      ...(input.live?.logicalObjectExists === false ? { blocker: "logical-object-anchor-is-not-live" } : {}),
    },
    ...manifestOperations.map((operation, index) => ({
      ...operation,
      order: index + 1,
      ...(operation.function === "weldObject(bytes32[],bytes32,uint64,uint8,string)" && input.live?.holdObjectExists === true && input.live.holdObjectMatches !== true
        ? { blocker: "manifest-object-exists-but-live-readback-does-not-match" }
        : {}),
    })),
    {
      order: manifestOperations.length + 1,
      kind: "graph-create",
      target: contracts.graphRegistry,
      execution: "deferred",
      function: "createGraph(bytes32,uint8,string,bytes32,bytes32,bytes32,uint8)",
      args: { salt: graphSalt, kind: KEEL_LIBRARY_GRAPH_KIND, manifestURI: manifestUri, manifestDigest: manifestIntegrity.digest, resourceGraphDigest: resourceGraphIntegrity.digest, metadataDigest: policyCommitment, storageTier: KEEL_LIBRARY_STORAGE_TIER_ONCHAIN },
      predicted: graphId,
    },
    {
      order: manifestOperations.length + 2,
      kind: "library-index",
      target: contracts.libraryRegistry,
      execution: "deferred",
      function: "indexAsset(bytes32,bytes32,uint64,uint8,bytes32,(uint8,address,uint128,uint64,uint64,uint64,bytes32,address,uint128,bytes32))",
      args: { salt: assetSalt, graphId, graphVersion: 1, kind: assetKind, catalogMetadataDigest: metadataIntegrity.digest, initialPolicy: policyTuple },
      predicted: assetId,
    },
    ...(tags.length === 0 ? [] : [{
      order: manifestOperations.length + 3,
      kind: "canonical-tags" as const,
      ...(contracts.tagRegistry === undefined ? {} : { target: contracts.tagRegistry }),
      execution: "deferred" as const,
      function: "setCanonicalTagsByLabel(bytes32,string[],bool)",
      args: { assetId, labels: tags, enabled: true },
    }]),
  ];
  const policy: KeelLibraryPolicy = { mode: policyInputValue.mode, modeCode: MODE_CODE[policyInputValue.mode], payout: policyInputValue.payout, priceWei: policyInputValue.priceWei, grantDurationSeconds: policyInputValue.grantDurationSeconds, availableFrom: policyInputValue.availableFrom, availableUntil: policyInputValue.availableUntil, allowlistRoot: policyInputValue.allowlistRoot, gateToken: policyInputValue.gateToken, minimumTokenBalance: policyInputValue.minimumTokenBalance, termsDigest: termsIntegrity.digest as Hex };
  const partial = {
    protocol: KEEL_LIBRARY_PUBLICATION_PLAN_PROTOCOL,
    status: "review-only" as const,
    chain: { family: "ethereum" as const, chainId },
    controller,
    contracts,
    artifact: { id: artifactId, revision, anchor: artifact.anchor, resource: normalizedResource },
    manifest: { protocol: "keel-library-manifest@1" as const, canonicalBytesHex: bytesToHex(canonicalManifestBytes), digest: manifestIntegrity.digest as Hex, byteLength: canonicalManifestBytes.byteLength, storageCompression: "none" as const, storageObjectId: manifestObjectId, storageUri: manifestUri, resourceGraphDigest: resourceGraphIntegrity.digest as Hex, catalogMetadataDigest: metadataIntegrity.digest as Hex, termsDigest: termsIntegrity.digest as Hex },
    predicted: { graphId, assetId, policyCommitment },
    assetKind,
    policy,
    tags,
    operations,
    blockers: [...new Set(blockers)].sort(),
    readiness: blockers.length === 0 ? "ready" as const : "blocked" as const,
    walletApproval: "required" as const,
    signing: "not-performed" as const,
    submitted: false as const,
    recurringSubscription: false as const,
    encoding: "deferred-contract-abi" as const,
    caveat: "This is a canonical review plan only; a verified wallet adapter must re-read, simulate, request approval, sign, and submit it." as const,
  };
  const planDigest = (await createIntegrity(utf8ToBytes(canonicalJson(partial)))).digest as Hex;
  const plan: KeelLibraryPublicationPlan = { ...partial, operations, planDigest };
  const integrity = await createIntegrity(utf8ToBytes(canonicalJson(plan)));
  return { plan, integrity };
}

/** Verify the envelope without performing any chain or wallet action. */
export async function verifyKeelLibraryPublicationPlanEnvelope(value: unknown): Promise<{ readonly valid: boolean; readonly issues: readonly string[] }> {
  const issues: string[] = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { valid: false, issues: ["envelope must be an object"] };
  const envelope = value as Record<string, unknown>;
  const plan = envelope.plan;
  const integrity = envelope.integrity;
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) return { valid: false, issues: ["plan must be an object"] };
  if (integrity === null || typeof integrity !== "object" || Array.isArray(integrity)) return { valid: false, issues: ["integrity must be an object"] };
  const committed = integrity as Record<string, unknown>;
  if (
    committed.algorithm !== "sha256"
    || typeof committed.digest !== "string"
    || !DIGEST.test(committed.digest)
    || typeof committed.byteLength !== "number"
    || !Number.isSafeInteger(committed.byteLength)
    || committed.byteLength <= 0
  ) {
    issues.push("integrity descriptor is malformed");
  } else {
    // Recompute over the exact UTF-8 canonical bytes.  JS string length is
    // not a byte length for non-ASCII plan fields and must never be trusted.
    const actual = await createIntegrity(utf8ToBytes(canonicalJson(plan)));
    if (actual.digest !== committed.digest || actual.byteLength !== committed.byteLength) issues.push("plan integrity does not match canonical bytes");
  }
  const typedPlan = plan as Record<string, unknown>;
  if (typedPlan.protocol !== KEEL_LIBRARY_PUBLICATION_PLAN_PROTOCOL || typedPlan.status !== "review-only" || typedPlan.signing !== "not-performed" || typedPlan.submitted !== false || typedPlan.recurringSubscription !== false) issues.push("plan is not an unsigned review-only descriptor");
  return { valid: issues.length === 0, issues };
}
