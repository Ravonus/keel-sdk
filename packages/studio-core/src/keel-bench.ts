import { decompressBytes } from "@keel/builder";
import {
  bytesToUtf8,
  canonicalJson,
  chunkBytes as splitBytes,
  concatBytes,
  createIntegrity,
  decodeBase85,
  encodeBase85,
  equalBytes,
  packUint48Ids,
  utf8ToBytes,
  verifyIntegrity,
  type Integrity,
} from "@keel/protocol";

/** The historical ScriptStorage object size limit used by the Keel bench. */
export const KEEL_HISTORICAL_MAX_SLUG_BYTES = 23_000;

export type HistoricalKeelSourceEncoding = "raw" | "base85";
export type HistoricalKeelCompression = "none" | "brotli";
export type HistoricalKeelBase85Wrapper = "auto" | "bare-z85" | "legacy-b85-tag";
export type HistoricalKeelResolvedBase85Wrapper = Exclude<HistoricalKeelBase85Wrapper, "auto">;

export interface HistoricalKeelIngestInput {
  /** A local bench ID, constrained to the historical uint48 viewer-index format. */
  readonly id: bigint | number | string;
  readonly name: string;
  readonly mediaType: string;
  /** Preserved source bytes. These are decoded and inspected but never evaluated here. */
  readonly sourceBytes: Uint8Array;
  readonly encoding: HistoricalKeelSourceEncoding;
  readonly compression: HistoricalKeelCompression;
  readonly wrapper?: HistoricalKeelBase85Wrapper;
  readonly maxChunkBytes?: number;
}

export interface HistoricalKeelByteStage {
  readonly byteLength: number;
  readonly integrity: Integrity;
  readonly verified: boolean;
}

export interface HistoricalKeelChunkModel {
  readonly index: number;
  readonly offset: number;
  readonly byteLength: number;
  readonly integrity: Integrity;
  readonly verified: boolean;
}

/**
 * JSON-safe metadata intended for a Studio/Viewer UI. The content bytes remain
 * in the accompanying `IngestedHistoricalKeelObject` server-side record.
 */
export interface HistoricalKeelObjectModel {
  readonly schema: "keel-historical-object@1";
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly encoding: HistoricalKeelSourceEncoding;
  readonly compression: HistoricalKeelCompression;
  readonly wrapper?: HistoricalKeelResolvedBase85Wrapper;
  readonly stages: {
    readonly source: HistoricalKeelByteStage;
    readonly base85Payload?: HistoricalKeelByteStage;
    readonly stored: HistoricalKeelByteStage;
    readonly resolved: HistoricalKeelByteStage;
  };
  readonly base85?: {
    readonly canonicalReencode: boolean;
    readonly byteRoundTripVerified: boolean;
  };
  readonly chunks: readonly HistoricalKeelChunkModel[];
  readonly inspection: {
    readonly executed: false;
    /** Binary payloads remain valid ingest inputs and intentionally skip text decoding. */
    readonly utf8Validated: boolean;
    readonly contentKind: "text" | "binary";
    readonly note: string;
  };
}

/**
 * Server-side record. Pass `model` to UI clients; retain the bytes only while
 * building an in-process composition or inspection assembly.
 */
export interface IngestedHistoricalKeelObject {
  readonly model: HistoricalKeelObjectModel;
  readonly storedBytes: Uint8Array;
  readonly resolvedBytes: Uint8Array;
}

export interface HistoricalKeelViewerCompositionInput {
  readonly name: string;
  readonly objects: readonly IngestedHistoricalKeelObject[];
}

export interface HistoricalKeelViewerSlot {
  readonly slot: number;
  readonly objectId: string;
  readonly objectName: string;
  readonly storedIntegrity: Integrity;
  readonly resolvedIntegrity: Integrity;
  readonly slugDigests: readonly string[];
}

export interface HistoricalKeelPackedUint48Word {
  readonly word: number;
  /** Position in the legacy Viewer.objectIds array after its two metadata words. */
  readonly viewerWord: number;
  /** Decimal uint256; a string keeps the UI-ready model JSON-safe. */
  readonly value: string;
  readonly hex: `0x${string}`;
  /** Least-significant 48-bit lane first, matching historical packIds. */
  readonly objectIds: readonly string[];
}

/**
 * A faithful representation of the legacy uint48 packing convention, not a
 * claim that these local bench IDs are historical on-chain ScriptStorage IDs.
 */
export interface HistoricalKeelViewerComposition {
  readonly schema: "keel-historical-viewer-index@1";
  readonly name: string;
  readonly packing: {
    readonly laneBits: 48;
    readonly idsPerWord: 5;
    readonly firstId: "least-significant-bits";
    /** forgeHarness historically prepended packed viewer data and token range. */
    readonly legacyMetadataWordCount: 2;
    readonly objectIdWordOffset: 2;
  };
  readonly slots: readonly HistoricalKeelViewerSlot[];
  readonly packedUint48Words: readonly HistoricalKeelPackedUint48Word[];
  readonly integrity: Integrity;
  readonly verified: boolean;
  readonly provenance: {
    readonly historicalConvention: true;
    readonly onchainViewerClaimed: false;
    readonly note: string;
  };
}

export interface HistoricalKeelAssemblyInput {
  readonly composition: HistoricalKeelViewerComposition;
  readonly blockNumber: bigint | number | string;
  readonly timestamp: bigint | number | string;
}

export interface HistoricalKeelAssembly {
  readonly schema: "keel-historical-bench-assembly@1";
  readonly kind: "inspection-html";
  readonly execution: "not-executed";
  readonly compatibility: "bench-assembly-not-legacy-generateViewer";
  readonly blockNumber: string;
  readonly timestamp: string;
  /** Mirrors NFTComet's `data[0] = Strings.toString(block.timestamp)` convention. */
  readonly viewerData: readonly [string];
  readonly compositionIntegrity: Integrity;
  readonly integrity: Integrity;
  readonly byteLength: number;
  readonly verified: boolean;
  /**
   * An inspectable HTML assembly. This module does not load it into a browser
   * or execute its scripts; a caller must choose an isolated runtime.
   */
  readonly html: string;
}

export interface HistoricalKeelCommitmentChainInput {
  readonly composition: HistoricalKeelViewerComposition;
  readonly assembly: HistoricalKeelAssembly;
}

export interface HistoricalKeelCommitmentReport {
  readonly schema: "keel-historical-commitment-chain@1";
  readonly objectStages: readonly {
    readonly objectId: string;
    readonly name: string;
    readonly storedIntegrity: Integrity;
    readonly resolvedIntegrity: Integrity;
    readonly chunkCount: number;
    readonly verified: boolean;
  }[];
  readonly viewerIndex: {
    readonly integrity: Integrity;
    readonly verified: boolean;
  };
  readonly assembly: {
    readonly integrity: Integrity;
    readonly verified: boolean;
  };
  /** No registry assertion is made unless an external verifier adds one. */
  readonly registry: {
    readonly status: "not-published";
    readonly verified: false;
    readonly note: string;
  };
  /** Off-chain stage verification only; this is not a chain publication receipt. */
  readonly verified: boolean;
}

export interface HistoricalKeelDedupeInput {
  readonly tokenCompositions: readonly {
    readonly tokenId: string;
    readonly composition: HistoricalKeelViewerComposition;
  }[];
}

export interface HistoricalKeelDedupeMeasurement {
  readonly schema: "keel-historical-dedupe@1";
  readonly scope: "stored-content-chunks-only";
  readonly tokenCount: number;
  readonly referencedChunkCount: number;
  readonly uniqueChunkCount: number;
  readonly naiveReferencedChunkBytes: number;
  readonly uniqueChunkBytes: number;
  readonly bytesSaved: number;
  readonly savingsRatio: number;
  readonly note: string;
}

export interface KeelAuthorityTimelineInput {
  /** Caller-declared Ledger hardware-wallet EOA for the early-test phase. */
  readonly earlyTestLedgerEoa: string;
  /** An optional planned target; it does not make a handoff complete. */
  readonly multisig?: {
    readonly address?: string;
  };
  /**
   * Receipt from a separate on-chain role/ownership verifier. This helper does
   * not query RPC itself, so a handoff cannot become verified from a status
   * string or an address alone.
   */
  readonly verifiedOnchainHandoff?: KeelVerifiedOnchainHandoff;
}

export interface KeelVerifiedOnchainHandoff {
  readonly schema: "keel-onchain-handoff-verification@1";
  readonly verified: true;
  readonly chainId: number;
  readonly transactionHash: string;
  readonly blockNumber: bigint | number | string;
  readonly multisig: string;
  readonly authority: string;
  readonly verifier: string;
}

export interface KeelAuthorityTimeline {
  readonly schema: "keel-authority-timeline@1";
  readonly earlyTest: {
    readonly signer: {
      readonly kind: "hardware-wallet-eoa-declared";
      readonly address: string;
      readonly onchainCode: "not-checked";
      readonly description: "Caller-declared Ledger hardware-wallet EOA";
    };
    readonly authority: "early-test-controller";
  };
  readonly handoff: {
    readonly status: "planned" | "verified-onchain";
    readonly target: {
      readonly kind: "onchain-multisig";
      readonly address: string | null;
    };
    readonly verification?: {
      readonly schema: "keel-onchain-handoff-verification@1";
      readonly chainId: number;
      readonly transactionHash: string;
      readonly blockNumber: string;
      readonly authority: string;
      readonly verifier: string;
    };
    readonly note: string;
  };
}

const compositionSources = new WeakMap<HistoricalKeelViewerComposition, readonly IngestedHistoricalKeelObject[]>();

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`${field} must be non-empty.`);
  return normalized;
}

function normalizeUint48(value: bigint | number | string, field: string): bigint {
  let normalized: bigint;
  try {
    normalized = BigInt(value);
  } catch {
    throw new TypeError(`${field} must be an integer that fits uint48.`);
  }
  try {
    packUint48Ids([normalized]);
  } catch {
    throw new RangeError(`${field} must fit uint48.`);
  }
  if (normalized === 0n) throw new RangeError(`${field} must be a non-zero uint48.`);
  return normalized;
}

function normalizeUnsignedDecimal(value: bigint | number | string, field: string): string {
  let normalized: bigint;
  try {
    normalized = BigInt(value);
  } catch {
    throw new TypeError(`${field} must be a non-negative integer.`);
  }
  if (normalized < 0n) throw new RangeError(`${field} must be a non-negative integer.`);
  return normalized.toString();
}

function resolveChunkSize(value: number | undefined): number {
  const normalized = value ?? KEEL_HISTORICAL_MAX_SLUG_BYTES;
  if (!Number.isSafeInteger(normalized) || normalized <= 0 || normalized > KEEL_HISTORICAL_MAX_SLUG_BYTES) {
    throw new RangeError(`maxChunkBytes must be a positive integer no larger than ${KEEL_HISTORICAL_MAX_SLUG_BYTES}.`);
  }
  return normalized;
}

function isTextualMediaType(mediaType: string): boolean {
  const normalized = mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return normalized.startsWith("text/") || [
    "application/javascript",
    "application/ecmascript",
    "application/json",
    "application/ld+json",
    "application/xml",
    "application/xhtml+xml",
    "application/sql",
    "application/graphql",
    "image/svg+xml",
  ].includes(normalized);
}

function extractBase85Payload(
  source: string,
  requestedWrapper: HistoricalKeelBase85Wrapper,
): { readonly wrapper: HistoricalKeelResolvedBase85Wrapper; readonly payload: string } {
  const tagged = /^<b85>([\s\S]*)<\/b85>$/u.exec(source);
  const hasOneBoundary = source.startsWith("<b85>") !== source.endsWith("</b85>");
  if (hasOneBoundary) throw new Error("Historical B85 source has an incomplete <b85> wrapper.");

  if (requestedWrapper === "legacy-b85-tag") {
    if (tagged === null) throw new Error("Expected a complete historical <b85> wrapper.");
    return { wrapper: "legacy-b85-tag", payload: tagged[1] ?? "" };
  }
  if (requestedWrapper === "bare-z85") {
    if (tagged !== null) throw new Error("A bare Z85 source must not include a historical <b85> wrapper.");
    return { wrapper: "bare-z85", payload: source };
  }
  return tagged === null
    ? { wrapper: "bare-z85", payload: source }
    : { wrapper: "legacy-b85-tag", payload: tagged[1] ?? "" };
}

async function verifiedStage(bytes: Uint8Array): Promise<HistoricalKeelByteStage> {
  const integrity = await createIntegrity(bytes);
  const verified = await verifyIntegrity(bytes, integrity);
  if (!verified) throw new Error("Generated Keel integrity stage did not verify.");
  return { byteLength: bytes.byteLength, integrity, verified };
}

function requireCompositionSources(composition: HistoricalKeelViewerComposition): readonly IngestedHistoricalKeelObject[] {
  const sources = compositionSources.get(composition);
  if (sources === undefined) {
    throw new Error(
      "Historical Keel source bytes are unavailable for this composition. Compose and assemble in the same server process.",
    );
  }
  return sources;
}

function normalizeEvmAddress(value: string, field: string): string {
  const normalized = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/u.test(normalized)) throw new TypeError(`${field} must be an EVM address.`);
  return normalized.toLowerCase();
}

/**
 * Ingests raw bytes or preserved historical .b85 source into explicit,
 * independently verified stages. It validates resolved JavaScript as UTF-8 but
 * deliberately never evaluates it.
 */
export async function ingestHistoricalKeelObject(
  input: HistoricalKeelIngestInput,
): Promise<IngestedHistoricalKeelObject> {
  const id = normalizeUint48(input.id, "object ID");
  const name = requireNonEmpty(input.name, "object name");
  const mediaType = requireNonEmpty(input.mediaType, "mediaType");
  const sourceBytes = input.sourceBytes.slice();
  if (sourceBytes.byteLength === 0) throw new RangeError("Historical Keel sourceBytes must be non-empty.");
  const chunkSize = resolveChunkSize(input.maxChunkBytes);

  const source = await verifiedStage(sourceBytes);
  let storedBytes: Uint8Array;
  let payloadStage: HistoricalKeelByteStage | undefined;
  let wrapper: HistoricalKeelResolvedBase85Wrapper | undefined;
  let base85: HistoricalKeelObjectModel["base85"] | undefined;

  if (input.encoding === "base85") {
    const extracted = extractBase85Payload(bytesToUtf8(sourceBytes), input.wrapper ?? "auto");
    const payloadBytes = utf8ToBytes(extracted.payload);
    payloadStage = await verifiedStage(payloadBytes);
    storedBytes = decodeBase85(extracted.payload);
    const reencoded = encodeBase85(storedBytes);
    const canonicalReencode = reencoded === extracted.payload;
    const byteRoundTripVerified = equalBytes(decodeBase85(reencoded), storedBytes);
    if (!canonicalReencode || !byteRoundTripVerified) {
      throw new Error(`${name}: preserved Z85 source does not survive the required canonical round trip.`);
    }
    wrapper = extracted.wrapper;
    base85 = { canonicalReencode, byteRoundTripVerified };
  } else {
    if (input.wrapper !== undefined && input.wrapper !== "auto") {
      throw new TypeError("A raw historical Keel source cannot declare a Base85 wrapper.");
    }
    storedBytes = sourceBytes.slice();
  }

  const stored = await verifiedStage(storedBytes);
  const resolvedBytes = input.compression === "brotli"
    ? await decompressBytes("brotli", storedBytes)
    : storedBytes.slice();
  const textual = isTextualMediaType(mediaType);
  // The historical corpus consists of JavaScript, but raw ingest is also used
  // for binary assets. Decode only declared textual media; binary bytes remain
  // valid chunked input and are never coerced through a UTF-8 replacement path.
  if (textual) bytesToUtf8(resolvedBytes);
  const resolved = await verifiedStage(resolvedBytes);

  const chunks: HistoricalKeelChunkModel[] = [];
  for (const chunk of splitBytes(storedBytes, chunkSize)) {
    const integrity = await createIntegrity(chunk.bytes);
    const verified = await verifyIntegrity(chunk.bytes, integrity);
    if (!verified) throw new Error(`${name}: generated chunk ${chunk.index} did not verify.`);
    chunks.push({
      index: chunk.index,
      offset: chunk.offset,
      byteLength: chunk.length,
      integrity,
      verified,
    });
  }

  const model: HistoricalKeelObjectModel = {
    schema: "keel-historical-object@1",
    id: id.toString(),
    name,
    mediaType,
    encoding: input.encoding,
    compression: input.compression,
    ...(wrapper === undefined ? {} : { wrapper }),
    stages: {
      source,
      ...(payloadStage === undefined ? {} : { base85Payload: payloadStage }),
      stored,
      resolved,
    },
    ...(base85 === undefined ? {} : { base85 }),
    chunks,
    inspection: {
      executed: false,
      utf8Validated: textual,
      contentKind: textual ? "text" : "binary",
      note: textual
        ? "Decoded and decompressed for UTF-8 inspection; never evaluated by this bench."
        : "Binary bytes were decoded, decompressed, hashed, and chunked without text coercion or execution.",
    },
  };
  return { model, storedBytes, resolvedBytes };
}

/**
 * Builds a UI-safe description of legacy five-lane uint48 viewer packing.
 * Object bytes are retained only in a private in-process association for later
 * assembly and measurement; they are never included in the public model.
 */
export async function composeHistoricalKeelViewer(
  input: HistoricalKeelViewerCompositionInput,
): Promise<HistoricalKeelViewerComposition> {
  const name = requireNonEmpty(input.name, "viewer name");
  if (input.objects.length === 0) throw new RangeError("A historical Keel viewer composition requires at least one object.");

  const ids = input.objects.map((object) => normalizeUint48(object.model.id, `object ${object.model.name} ID`));
  const packedUint48Words = packUint48Ids(ids).map((word, index): HistoricalKeelPackedUint48Word => ({
    word: index,
    viewerWord: index + 2,
    value: word.value.toString(),
    hex: `0x${word.value.toString(16).padStart(64, "0")}`,
    objectIds: word.ids.map((id) => id.toString()),
  }));
  const slots: HistoricalKeelViewerSlot[] = input.objects.map((object, slot) => ({
    slot,
    objectId: object.model.id,
    objectName: object.model.name,
    storedIntegrity: object.model.stages.stored.integrity,
    resolvedIntegrity: object.model.stages.resolved.integrity,
    slugDigests: object.model.chunks.map((chunk) => chunk.integrity.digest),
  }));
  const descriptor = {
    schema: "keel-historical-viewer-index@1" as const,
    name,
    packing: {
      laneBits: 48 as const,
      idsPerWord: 5 as const,
      firstId: "least-significant-bits" as const,
      legacyMetadataWordCount: 2 as const,
      objectIdWordOffset: 2 as const,
    },
    slots,
    packedUint48Words,
  };
  const integrity = await createIntegrity(utf8ToBytes(canonicalJson(descriptor)));
  const verified = await verifyIntegrity(utf8ToBytes(canonicalJson(descriptor)), integrity);
  if (!verified) throw new Error("Generated historical Keel viewer index did not verify.");

  const composition: HistoricalKeelViewerComposition = {
    ...descriptor,
    integrity,
    verified,
    provenance: {
      historicalConvention: true,
      onchainViewerClaimed: false,
      note: "Uses historical uint48 packing only; local bench IDs are not asserted to be deployed ScriptStorage IDs.",
    },
  };
  compositionSources.set(composition, input.objects.slice());
  return composition;
}

/**
 * Creates an inspectable HTML source with a deterministic block/timestamp
 * injection. It is intentionally not byte-for-byte legacy `generateViewer`:
 * the preserved corpus does not include the original on-chain head/seed words.
 */
export async function assembleHistoricalKeelViewer(
  input: HistoricalKeelAssemblyInput,
): Promise<HistoricalKeelAssembly> {
  const sources = requireCompositionSources(input.composition);
  const binarySource = sources.find((source) => !source.model.inspection.utf8Validated);
  if (binarySource !== undefined) {
    throw new TypeError(
      `Historical Keel inspection HTML cannot assemble binary object ${binarySource.model.name}; use a textual viewer composition.`,
    );
  }
  const blockNumber = normalizeUnsignedDecimal(input.blockNumber, "blockNumber");
  const timestamp = normalizeUnsignedDecimal(input.timestamp, "timestamp");
  const viewerData = [timestamp] as const;
  const injected = canonicalJson({ blockNumber, timestamp, viewerData });
  const prefix = `<!doctype html><html><head><meta charset="utf-8"><title>Keel historical bench</title></head><body><script>\n` +
    `globalThis.__KEEL_CHAIN__=${injected};\n` +
    `globalThis.__KEEL_VIEWER_DATA__=${canonicalJson(viewerData)};\n`;
  const separator = "\n;\n";
  const suffix = "\n</script></body></html>\n";
  const pieces: Uint8Array[] = [utf8ToBytes(prefix)];
  sources.forEach((source, index) => {
    pieces.push(source.resolvedBytes);
    if (index < sources.length - 1) pieces.push(utf8ToBytes(separator));
  });
  pieces.push(utf8ToBytes(suffix));
  const bytes = concatBytes(pieces);
  const integrity = await createIntegrity(bytes);
  const verified = await verifyIntegrity(bytes, integrity);
  if (!verified) throw new Error("Generated historical Keel inspection assembly did not verify.");

  return {
    schema: "keel-historical-bench-assembly@1",
    kind: "inspection-html",
    execution: "not-executed",
    compatibility: "bench-assembly-not-legacy-generateViewer",
    blockNumber,
    timestamp,
    viewerData,
    compositionIntegrity: input.composition.integrity,
    integrity,
    byteLength: bytes.byteLength,
    verified,
    html: bytesToUtf8(bytes),
  };
}

/**
 * Reports every verified off-chain commitment stage. Registry state remains
 * explicitly unclaimed until a separate RPC/indexer verifier supplies evidence.
 */
export async function buildHistoricalKeelCommitmentChain(
  input: HistoricalKeelCommitmentChainInput,
): Promise<HistoricalKeelCommitmentReport> {
  if (input.assembly.compositionIntegrity.digest !== input.composition.integrity.digest) {
    throw new Error("Assembly does not commit to the supplied historical Keel viewer composition.");
  }
  const uniqueObjects = new Map<string, IngestedHistoricalKeelObject>();
  for (const object of requireCompositionSources(input.composition)) {
    const previous = uniqueObjects.get(object.model.id);
    if (
      previous !== undefined &&
      (previous.model.stages.stored.integrity.digest !== object.model.stages.stored.integrity.digest ||
        previous.model.stages.resolved.integrity.digest !== object.model.stages.resolved.integrity.digest)
    ) {
      throw new Error(`Object ID ${object.model.id} is associated with conflicting historical Keel content.`);
    }
    uniqueObjects.set(object.model.id, object);
  }
  const objectStages = [...uniqueObjects.values()].map((object) => ({
    objectId: object.model.id,
    name: object.model.name,
    storedIntegrity: object.model.stages.stored.integrity,
    resolvedIntegrity: object.model.stages.resolved.integrity,
    chunkCount: object.model.chunks.length,
    verified:
      object.model.stages.source.verified &&
      object.model.stages.stored.verified &&
      object.model.stages.resolved.verified &&
      object.model.chunks.every((chunk) => chunk.verified),
  }));
  const verified =
    objectStages.every((object) => object.verified) && input.composition.verified && input.assembly.verified;
  return {
    schema: "keel-historical-commitment-chain@1",
    objectStages,
    viewerIndex: { integrity: input.composition.integrity, verified: input.composition.verified },
    assembly: { integrity: input.assembly.integrity, verified: input.assembly.verified },
    registry: {
      status: "not-published",
      verified: false,
      note: "No KeelIndex or chain receipt was supplied; this report makes no publication claim.",
    },
    verified,
  };
}

/**
 * Measures only stored content-byte reuse. It deliberately excludes viewer
 * index words, token metadata, gas, and deployment costs.
 */
export function measureHistoricalKeelDedupe(
  input: HistoricalKeelDedupeInput,
): HistoricalKeelDedupeMeasurement {
  const uniqueChunks = new Map<string, number>();
  let referencedChunkCount = 0;
  let naiveReferencedChunkBytes = 0;

  for (const token of input.tokenCompositions) {
    requireNonEmpty(token.tokenId, "tokenId");
    for (const object of requireCompositionSources(token.composition)) {
      for (const chunk of object.model.chunks) {
        referencedChunkCount += 1;
        naiveReferencedChunkBytes += chunk.byteLength;
        const previousLength = uniqueChunks.get(chunk.integrity.digest);
        if (previousLength !== undefined && previousLength !== chunk.byteLength) {
          throw new Error(`Chunk digest ${chunk.integrity.digest} has inconsistent byte lengths.`);
        }
        uniqueChunks.set(chunk.integrity.digest, chunk.byteLength);
      }
    }
  }
  const uniqueChunkBytes = [...uniqueChunks.values()].reduce((sum, byteLength) => sum + byteLength, 0);
  const bytesSaved = naiveReferencedChunkBytes - uniqueChunkBytes;
  return {
    schema: "keel-historical-dedupe@1",
    scope: "stored-content-chunks-only",
    tokenCount: input.tokenCompositions.length,
    referencedChunkCount,
    uniqueChunkCount: uniqueChunks.size,
    naiveReferencedChunkBytes,
    uniqueChunkBytes,
    bytesSaved,
    savingsRatio: naiveReferencedChunkBytes === 0 ? 0 : bytesSaved / naiveReferencedChunkBytes,
    note: "Measures verified stored-content chunks only; it is not a gas or on-chain storage-cost estimate.",
  };
}

function normalizeTransactionHash(value: string): string {
  const normalized = value.trim();
  if (!/^0x[0-9a-fA-F]{64}$/u.test(normalized)) throw new TypeError("handoff transactionHash must be a bytes32 hash.");
  return normalized.toLowerCase();
}

function normalizeVerifiedHandoff(input: KeelVerifiedOnchainHandoff): NonNullable<KeelAuthorityTimeline["handoff"]["verification"]> & {
  readonly multisig: string;
} {
  if (input.schema !== "keel-onchain-handoff-verification@1" || input.verified !== true) {
    throw new TypeError("verifiedOnchainHandoff must be a separately verified on-chain handoff record.");
  }
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) {
    throw new RangeError("verifiedOnchainHandoff chainId must be a positive safe integer.");
  }
  return {
    schema: input.schema,
    chainId: input.chainId,
    transactionHash: normalizeTransactionHash(input.transactionHash),
    blockNumber: normalizeUnsignedDecimal(input.blockNumber, "verifiedOnchainHandoff blockNumber"),
    multisig: normalizeEvmAddress(input.multisig, "verifiedOnchainHandoff multisig"),
    authority: requireNonEmpty(input.authority, "verifiedOnchainHandoff authority"),
    verifier: requireNonEmpty(input.verifier, "verifiedOnchainHandoff verifier"),
  };
}

/**
 * Records a planned transition by default. It accepts a record from a separate
 * RPC/role verifier to represent a verified on-chain handoff, but never infers
 * that state from an address, status string, or unverified caller assertion.
 */
export function createKeelAuthorityTimeline(input: KeelAuthorityTimelineInput): KeelAuthorityTimeline {
  const earlyTestLedgerEoa = normalizeEvmAddress(input.earlyTestLedgerEoa, "earlyTestLedgerEoa");
  const plannedMultisigAddress = input.multisig?.address === undefined
    ? undefined
    : normalizeEvmAddress(input.multisig.address, "multisig address");
  const verification = input.verifiedOnchainHandoff === undefined
    ? undefined
    : normalizeVerifiedHandoff(input.verifiedOnchainHandoff);
  if (
    verification !== undefined &&
    plannedMultisigAddress !== undefined &&
    plannedMultisigAddress !== verification.multisig
  ) {
    throw new Error("Planned multisig address does not match the separately verified on-chain handoff record.");
  }
  const status = verification === undefined ? "planned" : "verified-onchain";
  const multisigAddress = verification?.multisig ?? plannedMultisigAddress;
  return {
    schema: "keel-authority-timeline@1",
    earlyTest: {
      signer: {
        kind: "hardware-wallet-eoa-declared",
        address: earlyTestLedgerEoa,
        onchainCode: "not-checked",
        description: "Caller-declared Ledger hardware-wallet EOA",
      },
      authority: "early-test-controller",
    },
    handoff: {
      status,
      target: { kind: "onchain-multisig", address: multisigAddress ?? null },
      ...(verification === undefined
        ? {}
        : {
            verification: {
              schema: verification.schema,
              chainId: verification.chainId,
              transactionHash: verification.transactionHash,
              blockNumber: verification.blockNumber,
              authority: verification.authority,
              verifier: verification.verifier,
            },
          }),
      note: verification === undefined
        ? "Multisig handoff is planned only; this helper has no separate on-chain handoff verification record."
        : "Handoff state comes from a separately verified on-chain record; this helper does not independently query RPC.",
    },
  };
}
