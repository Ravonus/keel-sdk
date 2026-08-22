import { canonicalJson, createIntegrity, utf8ToBytes, type Hex, type Integrity } from "@keel/protocol";

export const KEEL_PUBLISH_PLAN_PROTOCOL = "keel-publish-plan@1" as const;
/** Backward-compatible name for callers that used the review-plan wording. */
export const KEEL_PUBLISH_REVIEW_PLAN_PROTOCOL = KEEL_PUBLISH_PLAN_PROTOCOL;

const ADDRESS = /^0x[0-9a-f]{40}$/u;
const DIGEST = /^0x[0-9a-f]{64}$/u;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)(?:\.|\.\.)$)[^\\\u0000-\u001f\u007f]+$/u;
const LOGICAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_OPERATIONS = 16_384;
const MAX_REVIEW_PLAN_BYTES = 256 * 1024;
const MAX_CHUNKS_PER_BATCH = 3;
const MAX_SLUG_BYTES = 23_000;
const MAX_OBJECT_BYTES = 268_435_456;
const MAX_MEDIA_TYPE_BYTES = 128;
const MAX_TEXT = 256;

export type KeelPublishReviewFamily = "ethereum" | "tezos";

export interface KeelPublishReviewSource {
  readonly schema: string;
  readonly integrity: Integrity;
  readonly byteLength: number;
  readonly objectName: string;
  readonly mediaType: string;
}

export interface KeelPublishReviewTarget {
  readonly family: "ethereum";
  readonly chainId: number;
  readonly address: `0x${string}`;
}

export interface KeelPublishReviewOperation {
  readonly kind: "castSlugs" | "weldObject" | "weldComposite";
  readonly descriptor: Readonly<Record<string, unknown>>;
}

export interface KeelPublishReviewPlan {
  readonly protocol: typeof KEEL_PUBLISH_REVIEW_PLAN_PROTOCOL;
  readonly status: "review-only";
  readonly chainReady: false;
  readonly target: KeelPublishReviewTarget;
  readonly source: KeelPublishReviewSource;
  readonly operationCount: number;
  readonly operations: readonly KeelPublishReviewOperation[];
  readonly encoding: "deferred-contract-abi";
  readonly identifierSemantics: "logical-builder-ids-not-chain-ids";
  readonly walletApproval: "required";
  readonly signing: "not-performed";
  readonly submission: "not-performed";
  readonly caveat: "This is a canonical review plan only; a verified chain adapter must encode, simulate, sign, and submit it.";
}

export interface KeelPublishReviewPlanEnvelope {
  readonly plan: KeelPublishReviewPlan;
  readonly integrity: Integrity;
}

export interface KeelPublishReviewPlanVerification {
  readonly valid: boolean;
  readonly integrity?: Integrity;
  readonly issues: readonly string[];
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const fields = new Set(allowed);
  for (const key of Object.keys(value)) if (!fields.has(key)) throw new TypeError(`${label}.${key} is not supported.`);
}

function text(value: unknown, label: string, maximum = MAX_TEXT): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`${label} is invalid.`);
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError(`${label} contains an invalid Unicode scalar.`);
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new TypeError(`${label} contains an invalid Unicode scalar.`);
  }
  return value;
}

function positive(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new RangeError(`${label} must be a positive safe integer.`);
  return value;
}

function digest(value: unknown, label: string): Integrity & { readonly byteLength: number } {
  const input = object(value, label);
  exact(input, ["algorithm", "digest", "byteLength"], label);
  if (input.algorithm !== "sha256" || typeof input.digest !== "string" || !DIGEST.test(input.digest)) throw new TypeError(`${label} must be lower-case SHA-256.`);
  return { algorithm: "sha256", digest: input.digest as Hex, byteLength: positive(input.byteLength, `${label}.byteLength`, MAX_OBJECT_BYTES) };
}

function mediaType(value: unknown, label: string): string {
  const result = text(value, label, MAX_MEDIA_TYPE_BYTES);
  if (new TextEncoder().encode(result).byteLength > MAX_MEDIA_TYPE_BYTES) throw new TypeError(`${label} exceeds its UTF-8 byte limit.`);
  return result;
}

function safeFile(value: unknown, label: string): string {
  const result = text(value, label, 512);
  if (!SAFE_PATH.test(result) || result.split("/").some((part) => part.length === 0 || part === "." || part === "..")) throw new TypeError(`${label} must be a safe relative path.`);
  return result;
}

function logicalId(value: unknown, label: string): string {
  const result = text(value, label, 128);
  if (!LOGICAL_ID.test(result)) throw new TypeError(`${label} must be a bounded logical builder identifier.`);
  return result;
}

function target(value: unknown): KeelPublishReviewTarget {
  const input = object(value, "chain operation target");
  exact(input, ["family", "network", "chainId", "address"], "chain operation target");
  if (input.family !== "ethereum") throw new TypeError("Tezos publish review plans require a contract-specific adapter; generic chain descriptors are rejected.");
  if (input.network !== undefined && input.chainId !== undefined && input.network !== input.chainId) throw new TypeError("chain operation target.network and chainId disagree.");
  const chainId = positive(input.network ?? input.chainId, "chain operation target.chainId");
  if (typeof input.address !== "string" || !ADDRESS.test(input.address)) throw new TypeError("chain operation target.address must be a 20-byte Ethereum address.");
  return { family: "ethereum", chainId, address: input.address.toLowerCase() as `0x${string}` };
}

function source(value: unknown): KeelPublishReviewSource {
  const input = object(value, "sourcePlan");
  exact(input, ["schema", "objectName", "mediaType", "integrity", "byteLength", "path"], "sourcePlan");
  const schema = text(input.schema, "sourcePlan.schema", 128);
  if (schema !== "keel-upload-plan@2" && schema !== "keel-recursive-upload-plan@2") throw new TypeError("sourcePlan.schema is unsupported.");
  const objectName = text(input.objectName, "sourcePlan.objectName", 128);
  if (objectName === "." || objectName === ".." || objectName.includes("/") || objectName.includes("\\")) throw new TypeError("sourcePlan.objectName must be metadata-safe.");
  const media = mediaType(input.mediaType, "sourcePlan.mediaType");
  const committed = digest(input.integrity, "sourcePlan.integrity");
  if (input.path !== undefined) safeFile(input.path, "sourcePlan.path");
  if (input.byteLength !== undefined && input.byteLength !== committed.byteLength) throw new TypeError("sourcePlan.byteLength does not match its integrity.");
  return { schema, integrity: committed, byteLength: committed.byteLength, objectName, mediaType: media };
}

function operation(value: unknown, index: number): KeelPublishReviewOperation {
  const input = object(value, `chain operation ${index}`);
  const kind = input.kind;
  if (kind === "castSlugs") {
    exact(input, ["kind", "function", "payloadEncoding", "chunkFiles", "chunkCount", "chunkByteLengths", "chunkIntegrities", "slugIds"], `chain operation ${index}`);
    if (input.function !== "castSlugs(bytes[])") throw new TypeError(`chain operation ${index}.function is unsupported.`);
    if (input.payloadEncoding !== "raw-bytes-from-files" || input.slugIds !== "derived-keccak256-after-review") throw new TypeError(`chain operation ${index} is not a deferred chunk upload.`);
    const hasFiles = input.chunkFiles !== undefined;
    if (hasFiles && !Array.isArray(input.chunkFiles)) throw new TypeError(`chain operation ${index}.chunkFiles must be an array when provided.`);
    const files = hasFiles ? input.chunkFiles as unknown[] : undefined;
    const chunkCount = files === undefined ? positive(input.chunkCount, `chain operation ${index}.chunkCount`, MAX_CHUNKS_PER_BATCH) : files.length;
    if (files !== undefined && input.chunkCount !== undefined && positive(input.chunkCount, `chain operation ${index}.chunkCount`, MAX_CHUNKS_PER_BATCH) !== chunkCount) throw new TypeError(`chain operation ${index}.chunkCount does not match chunkFiles.`);
    if (!Array.isArray(input.chunkByteLengths) || !Array.isArray(input.chunkIntegrities) || chunkCount < 1 || chunkCount > MAX_CHUNKS_PER_BATCH || input.chunkByteLengths.length !== chunkCount || input.chunkIntegrities.length !== chunkCount) throw new RangeError(`chain operation ${index} chunk batch is invalid.`);
    files?.forEach((file, chunkIndex) => safeFile(file, `chain operation ${index}.chunkFiles[${chunkIndex}]`));
    const chunkByteLengths = input.chunkByteLengths.map((length, chunkIndex) => positive(length, `chain operation ${index}.chunkByteLengths[${chunkIndex}]`, MAX_SLUG_BYTES));
    const chunkIntegrities = input.chunkIntegrities.map((value, chunkIndex) => digest(value, `chain operation ${index}.chunkIntegrities[${chunkIndex}]`));
    chunkIntegrities.forEach((value, chunkIndex) => { if (value.byteLength !== chunkByteLengths[chunkIndex]) throw new TypeError(`chain operation ${index}.chunkIntegrities[${chunkIndex}] does not match its chunk length.`); });
    return { kind, descriptor: { kind, function: input.function, payloadEncoding: input.payloadEncoding, chunkCount, chunkByteLengths, chunkIntegrities, slugIds: input.slugIds } };
  }
  if (kind === "weldObject") {
    exact(input, ["kind", "function", "objectId", "slugIds", "digest", "byteLength", "compression", "mediaType"], `chain operation ${index}`);
    if (input.function !== "weldObject(bytes32[],bytes32,uint64,uint8,string)" || input.slugIds !== "from-preceding-castSlugs") throw new TypeError(`chain operation ${index} is not a deferred object creation.`);
    const objectId = input.objectId === undefined ? undefined : logicalId(input.objectId, `chain operation ${index}.objectId`);
    const committed = digest(input.digest, `chain operation ${index}.digest`);
    const byteLength = positive(input.byteLength, `chain operation ${index}.byteLength`, MAX_OBJECT_BYTES);
    if (committed.byteLength !== byteLength) throw new TypeError(`chain operation ${index}.digest does not match byteLength.`);
    if (input.compression !== "none" && input.compression !== "gzip" && input.compression !== "deflate" && input.compression !== "brotli") throw new TypeError(`chain operation ${index}.compression is unsupported.`);
    const media = mediaType(input.mediaType, `chain operation ${index}.mediaType`);
    return { kind, descriptor: { kind, function: input.function, ...(objectId === undefined ? {} : { objectId }), slugIds: input.slugIds, digest: committed, byteLength, compression: input.compression, mediaType: media } };
  }
  if (kind === "weldComposite") {
    exact(input, ["kind", "function", "objectId", "partObjectIds", "digest", "byteLength", "mediaType"], `chain operation ${index}`);
    if (input.function !== "weldComposite(bytes32[],bytes32,uint64,string)") throw new TypeError(`chain operation ${index}.function is unsupported.`);
    const objectId = logicalId(input.objectId, `chain operation ${index}.objectId`);
    if (!Array.isArray(input.partObjectIds) || input.partObjectIds.length < 1 || input.partObjectIds.length > 128) throw new RangeError(`chain operation ${index}.partObjectIds is invalid.`);
    const partObjectIds = input.partObjectIds.map((part, partIndex) => logicalId(part, `chain operation ${index}.partObjectIds[${partIndex}]`));
    if (new Set(partObjectIds).size !== partObjectIds.length || partObjectIds.includes(objectId)) throw new TypeError(`chain operation ${index}.partObjectIds must be unique and cannot self-reference.`);
    const committed = digest(input.digest, `chain operation ${index}.digest`);
    const byteLength = positive(input.byteLength, `chain operation ${index}.byteLength`, MAX_OBJECT_BYTES);
    if (committed.byteLength !== byteLength) throw new TypeError(`chain operation ${index}.digest does not match byteLength.`);
    const media = mediaType(input.mediaType, `chain operation ${index}.mediaType`);
    return { kind, descriptor: { kind, function: input.function, objectId, partObjectIds, digest: committed, byteLength, mediaType: media } };
  }
  throw new TypeError(`chain operation ${index}.kind is unsupported.`);
}

function normalize(value: unknown): KeelPublishReviewPlan {
  const input = object(value, "chain operation plan");
  exact(input, ["schema", "status", "materialized", "descriptorMaterialized", "chainReady", "target", "sourcePlan", "operations", "encoding", "walletApproval", "signing", "submission", "caveat"], "chain operation plan");
  if (input.schema !== "keel-chain-operation-plan@1" || input.status !== "review-only" || input.chainReady !== false || input.encoding !== "deferred-contract-abi" || input.walletApproval !== "required" || input.signing !== "not-performed" || input.submission !== "not-performed") throw new TypeError("Only deferred, unsigned Keel chain operation plans can become review plans.");
  if (input.materialized !== true || input.descriptorMaterialized !== true) throw new TypeError("Chain operation descriptors must be materialized and verified before review wrapping.");
  text(input.caveat, "chain operation plan.caveat", 512);
  if (!Array.isArray(input.operations) || input.operations.length === 0 || input.operations.length > MAX_OPERATIONS) throw new RangeError(`chain operation plan operations must contain 1 through ${MAX_OPERATIONS} entries.`);
  const normalizedOperations = input.operations.map((value, index) => operation(value, index));
  const normalizedSource = source(input.sourcePlan);
  const normalizedTarget = target(input.target);
  validateOperationGraph(normalizedSource, normalizedOperations);
  const result: KeelPublishReviewPlan = {
    protocol: KEEL_PUBLISH_REVIEW_PLAN_PROTOCOL,
    status: "review-only",
    chainReady: false,
    target: normalizedTarget,
    source: normalizedSource,
    operationCount: normalizedOperations.length,
    operations: normalizedOperations,
    encoding: "deferred-contract-abi",
    identifierSemantics: "logical-builder-ids-not-chain-ids",
    walletApproval: "required",
    signing: "not-performed",
    submission: "not-performed",
    caveat: "This is a canonical review plan only; a verified chain adapter must encode, simulate, sign, and submit it.",
  };
  canonicalPlanBytes(result);
  return result;
}

function validateOperationGraph(sourcePlan: KeelPublishReviewSource, operations: readonly KeelPublishReviewOperation[]): void {
  const descriptors = operations.map((entry) => entry.descriptor);
  let sawChunkBatch = false;
  let pendingChunks = false;
  let pendingStoredBytes = 0;
  let sawComposite = false;
  let finalObject: Readonly<Record<string, unknown>> | undefined;
  for (const [index, descriptor] of descriptors.entries()) {
    const kind = descriptor.kind;
    const media = descriptor.mediaType;
    if (media !== undefined && media !== sourcePlan.mediaType) throw new TypeError(`chain operation ${index}.mediaType does not match sourcePlan.mediaType.`);
    if (kind === "castSlugs") {
      if (sawComposite) throw new TypeError("castSlugs cannot follow a composite object operation.");
      sawChunkBatch = true;
      pendingChunks = true;
      const lengths = descriptor.chunkByteLengths;
      if (!Array.isArray(lengths)) throw new TypeError(`chain operation ${index}.chunkByteLengths is invalid.`);
      pendingStoredBytes += lengths.reduce((total, length) => total + (typeof length === "number" ? length : 0), 0);
      continue;
    }
    if (kind === "weldObject") {
      if (sawComposite || !pendingChunks) throw new TypeError(`chain operation ${index} must follow a castSlugs batch.`);
      if (descriptor.compression === "none" && pendingStoredBytes !== descriptor.byteLength) throw new TypeError(`chain operation ${index} stored chunk lengths do not match its uncompressed byteLength.`);
      pendingChunks = false;
      pendingStoredBytes = 0;
      finalObject = descriptor;
      continue;
    }
    if (kind === "weldComposite") {
      if (pendingChunks) throw new TypeError(`chain operation ${index} cannot create a composite while a chunk batch is pending.`);
      sawComposite = true;
      finalObject = descriptor;
      continue;
    }
    throw new TypeError(`chain operation ${index}.kind is unsupported.`);
  }
  if (!sawChunkBatch || pendingChunks || finalObject === undefined) throw new TypeError("chain operation plan must contain complete castSlugs and object creation operations.");
  const finalDigest = finalObject.digest;
  const finalLength = finalObject.byteLength;
  if (finalDigest === undefined || finalLength !== sourcePlan.byteLength || !sameIntegrity(finalDigest as Integrity, sourcePlan.integrity)) throw new TypeError("final chain object does not match sourcePlan integrity and byteLength.");
  if (sourcePlan.schema === "keel-upload-plan@2") {
    if (descriptors.some((descriptor) => descriptor.kind === "weldComposite") || descriptors.filter((descriptor) => descriptor.kind === "weldObject").length !== 1) throw new TypeError("flat source plans require one direct weldObject and no composites.");
    if (finalObject.objectId !== undefined) throw new TypeError("flat source plans cannot carry a logical objectId.");
  } else {
    const ids = new Set<string>();
    const referenced = new Set<string>();
    for (const [index, descriptor] of descriptors.entries()) {
      if (descriptor.kind === "weldObject") {
        if (typeof descriptor.objectId !== "string") throw new TypeError(`recursive chain operation ${index} requires a logical leaf objectId.`);
        if (ids.has(descriptor.objectId)) throw new TypeError(`recursive chain operation ${index} repeats logical objectId ${descriptor.objectId}.`);
        ids.add(descriptor.objectId);
      } else if (descriptor.kind === "weldComposite") {
        if (typeof descriptor.objectId !== "string" || ids.has(descriptor.objectId)) throw new TypeError(`recursive chain operation ${index} repeats or omits a logical composite objectId.`);
        ids.add(descriptor.objectId);
        const parts = descriptor.partObjectIds;
        if (!Array.isArray(parts)) throw new TypeError(`recursive chain operation ${index}.partObjectIds is invalid.`);
        for (const part of parts) {
          if (typeof part !== "string" || !ids.has(part)) throw new TypeError(`recursive chain operation ${index} references an unknown or forward logical part ${String(part)}.`);
          referenced.add(part);
        }
      }
    }
    if (typeof finalObject.objectId !== "string") throw new TypeError("recursive source plans require a logical root objectId.");
    if (referenced.has(finalObject.objectId)) throw new TypeError("recursive chain operation root must not be referenced by another object.");
    for (const id of ids) if (id !== finalObject.objectId && !referenced.has(id)) throw new TypeError(`recursive chain operation object ${id} is unreachable from the final root.`);
  }
}

async function planIntegrity(plan: KeelPublishReviewPlan): Promise<Integrity> {
  return createIntegrity(canonicalPlanBytes(plan));
}

function canonicalPlanBytes(plan: KeelPublishReviewPlan): Uint8Array {
  const bytes = utf8ToBytes(canonicalJson(plan));
  if (bytes.byteLength > MAX_REVIEW_PLAN_BYTES) throw new RangeError(`Publish review plan exceeds the ${MAX_REVIEW_PLAN_BYTES}-byte detail limit.`);
  return bytes;
}

function sameIntegrity(left: Integrity, right: Integrity): boolean {
  return left.algorithm === right.algorithm && left.digest === right.digest && left.byteLength === right.byteLength;
}

export function parseKeelPublishReviewPlan(value: unknown): KeelPublishReviewPlan {
  const input = object(value, "publish review plan");
  exact(input, ["protocol", "status", "chainReady", "target", "source", "operationCount", "operations", "encoding", "identifierSemantics", "walletApproval", "signing", "submission", "caveat"], "publish review plan");
  if (input.protocol !== KEEL_PUBLISH_REVIEW_PLAN_PROTOCOL) throw new TypeError("Unsupported Keel publish review plan protocol.");
  if (input.identifierSemantics !== "logical-builder-ids-not-chain-ids") throw new TypeError("Publish review plan identifiers are not chain IDs.");
  if (!Array.isArray(input.operations)) throw new TypeError("publish review plan.operations must be an array.");
  const rawOperations = input.operations.map((value, index) => {
    const entry = object(value, `publish review plan.operations[${index}]`);
    exact(entry, ["kind", "descriptor"], `publish review plan.operations[${index}]`);
    if (entry.kind !== object(entry.descriptor, `publish review plan.operations[${index}].descriptor`).kind) throw new TypeError(`publish review plan.operations[${index}] kind does not match its descriptor.`);
    return entry.descriptor;
  });
  const normalized = normalize({
    schema: "keel-chain-operation-plan@1",
    status: input.status,
    materialized: true,
    descriptorMaterialized: true,
    chainReady: input.chainReady,
    target: input.target,
    sourcePlan: input.source,
    operations: rawOperations,
    encoding: input.encoding,
    walletApproval: input.walletApproval,
    signing: input.signing,
    submission: input.submission,
    caveat: "ignored",
  });
  if (input.operationCount !== normalized.operationCount || input.caveat !== normalized.caveat) throw new TypeError("Publish review plan fields are not canonical.");
  return normalized;
}

export async function createKeelPublishReviewPlan(value: unknown): Promise<KeelPublishReviewPlanEnvelope> {
  const plan = normalize(value);
  return { plan, integrity: await planIntegrity(plan) };
}

export async function verifyKeelPublishReviewPlan(value: unknown): Promise<KeelPublishReviewPlanVerification> {
  try {
    const envelope = object(value, "publish review plan envelope");
    exact(envelope, ["plan", "integrity"], "publish review plan envelope");
    const plan = parseKeelPublishReviewPlan(envelope.plan);
    const supplied = digest(envelope.integrity, "publish review plan envelope.integrity");
    const actual = await planIntegrity(plan);
    const issues: string[] = [];
    if (!sameIntegrity(actual, supplied)) issues.push("publish review plan integrity does not match canonical plan bytes.");
    return { valid: issues.length === 0, integrity: actual, issues };
  } catch (error) {
    return { valid: false, issues: [error instanceof Error ? error.message : String(error)] };
  }
}

export type KeelPublishPlan = KeelPublishReviewPlan;
export type KeelPublishPlanEnvelope = KeelPublishReviewPlanEnvelope;
export type KeelPublishPlanVerification = KeelPublishReviewPlanVerification;
export const createKeelPublishPlan = createKeelPublishReviewPlan;
export const parseKeelPublishPlan = parseKeelPublishReviewPlan;
export const verifyKeelPublishPlan = verifyKeelPublishReviewPlan;
