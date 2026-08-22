import { OCA_MAX_OBJECT_CHILDREN, type Compression } from "@keel/protocol";
import { compressBytes } from "./compress.js";

export const KEEL_COST_ANALYSIS_PROTOCOL = "keel-cost-analysis@1" as const;
export const KEEL_COST_ANALYSIS_CAVEAT = "modeled-estimate-not-gas-quote" as const;

const MAX_SLUG_BYTES = 23_000;
const CHUNK_BATCH_SIZE = 3;
const DEFAULT_LEAF_DECODED_BYTES = 512 * 1024;
const DEFAULT_MAX_PARTS_PER_COMPOSITE = 64;
const DEFAULT_MAX_TREE_DEPTH = 8;
const COMPRESSION_ORDER: readonly Compression[] = ["none", "brotli", "gzip", "deflate"];
const COMPRESSION_SET = new Set<Compression>(COMPRESSION_ORDER);

export interface CostAnalysisOptions {
  readonly compression?: Compression | "auto";
  readonly maxChunkBytes?: number;
  readonly leafDecodedBytes?: number;
  readonly maxPartsPerComposite?: number;
  /** Direct Keel object readers accept depth through 8 by default. */
  readonly maxTreeDepth?: number;
  readonly mediaType?: string;
}

export interface CostAnalysisModel {
  readonly chunkBatchSize: typeof CHUNK_BATCH_SIZE;
  readonly maxChunkBytes: number;
  readonly maxChildren: typeof OCA_MAX_OBJECT_CHILDREN;
  readonly maxTreeDepth: number;
  readonly mediaType: string;
  readonly mediaTypeByteLength: number;
  readonly calldataEncoding: "ABI-sized modeled bytes";
  readonly caveat: typeof KEEL_COST_ANALYSIS_CAVEAT;
}

export interface CostPlanEstimate {
  readonly feasible: boolean;
  readonly storedByteLength: number;
  readonly chunkCount: number;
  readonly payloadBytes: number;
  readonly calldataBytes: number;
  readonly chunkUploadTransactions: number;
  readonly objectTransactions: number;
  readonly compositeTransactions: number;
  readonly transactionCount: number;
}

export interface FlatCostEstimate extends CostPlanEstimate {
  readonly maxChildren: typeof OCA_MAX_OBJECT_CHILDREN;
}

export interface RecursiveCostEstimate extends CostPlanEstimate {
  readonly leafDecodedBytes: number;
  readonly leafCount: number;
  readonly leafChunkCount: number;
  readonly leafChunkCounts: readonly number[];
  readonly maxLeafChunkCount: number;
  readonly compositeCount: number;
  readonly compositeNodeCounts: readonly number[];
  readonly treeDepth: number;
  readonly maxPartsPerComposite: number;
  readonly maxTreeDepth: number;
}

export interface CostCompressionCandidate {
  readonly compression: Compression;
  readonly storedByteLength: number;
  readonly flat: FlatCostEstimate;
  readonly recursive: RecursiveCostEstimate;
}

export interface CostAnalysisRecommendation {
  readonly compression: Compression;
  readonly strategy: "flat" | "recursive" | "infeasible";
  readonly transactionCount: number;
  readonly calldataBytes: number;
}

export interface CostAnalysis {
  readonly schema: typeof KEEL_COST_ANALYSIS_PROTOCOL;
  readonly inputByteLength: number;
  readonly requestedCompression: Compression | "auto";
  readonly selectedCompression: Compression;
  readonly model: CostAnalysisModel;
  readonly candidates: readonly CostCompressionCandidate[];
  readonly recommendation: CostAnalysisRecommendation;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive safe integer.`);
  return value;
}

function paddedBytes(byteLength: number): number {
  return Math.ceil(byteLength / 32) * 32;
}

function chunkLengths(bytes: Uint8Array, maxChunkBytes: number): readonly number[] {
  const lengths: number[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += maxChunkBytes) {
    lengths.push(Math.min(maxChunkBytes, bytes.byteLength - offset));
  }
  return lengths;
}

function chunkUploadCalldataBytes(lengths: readonly number[]): number {
  let calldataBytes = 0;
  for (let offset = 0; offset < lengths.length; offset += CHUNK_BATCH_SIZE) {
    const batch = lengths.slice(offset, offset + CHUNK_BATCH_SIZE);
    calldataBytes += 68 + (batch.length * 32) + batch.reduce((total, length) => total + 32 + paddedBytes(length), 0);
  }
  return calldataBytes;
}

function chunkUploadTransactions(chunkCount: number): number {
  return Math.ceil(chunkCount / CHUNK_BATCH_SIZE);
}

function createObjectCalldataBytes(chunkCount: number, mediaTypeByteLength: number): number {
  return 228 + (chunkCount * 32) + paddedBytes(mediaTypeByteLength);
}

function createCompositeCalldataBytes(partCount: number, mediaTypeByteLength: number): number {
  return 196 + (partCount * 32) + paddedBytes(mediaTypeByteLength);
}

function validateOptions(options: CostAnalysisOptions): {
  readonly requestedCompression: Compression | "auto";
  readonly maxChunkBytes: number;
  readonly leafDecodedBytes: number;
  readonly maxPartsPerComposite: number;
  readonly maxTreeDepth: number;
  readonly mediaType: string;
  readonly mediaTypeByteLength: number;
} {
  const requestedCompression = options.compression ?? "auto";
  if (requestedCompression !== "auto" && !COMPRESSION_SET.has(requestedCompression)) {
    throw new TypeError(`Unsupported compression: ${String(requestedCompression)}.`);
  }
  const maxChunkBytes = positiveSafeInteger(options.maxChunkBytes ?? MAX_SLUG_BYTES, "maxChunkBytes");
  if (maxChunkBytes > MAX_SLUG_BYTES) throw new RangeError(`maxChunkBytes cannot exceed ${MAX_SLUG_BYTES}.`);
  const leafDecodedBytes = positiveSafeInteger(
    options.leafDecodedBytes ?? Math.min(DEFAULT_LEAF_DECODED_BYTES, maxChunkBytes * OCA_MAX_OBJECT_CHILDREN),
    "leafDecodedBytes",
  );
  if (leafDecodedBytes > maxChunkBytes * OCA_MAX_OBJECT_CHILDREN) {
    throw new RangeError(`leafDecodedBytes cannot exceed ${maxChunkBytes * OCA_MAX_OBJECT_CHILDREN} bytes.`);
  }
  const maxPartsPerComposite = positiveSafeInteger(
    options.maxPartsPerComposite ?? DEFAULT_MAX_PARTS_PER_COMPOSITE,
    "maxPartsPerComposite",
  );
  if (maxPartsPerComposite < 2 || maxPartsPerComposite > OCA_MAX_OBJECT_CHILDREN) {
    throw new RangeError(`maxPartsPerComposite must be from 2 through ${OCA_MAX_OBJECT_CHILDREN}.`);
  }
  const maxTreeDepth = positiveSafeInteger(options.maxTreeDepth ?? DEFAULT_MAX_TREE_DEPTH, "maxTreeDepth");
  const mediaTypeValue = options.mediaType;
  if (mediaTypeValue !== undefined && typeof mediaTypeValue !== "string") throw new TypeError("mediaType must be printable UTF-8 text from 1 through 128 bytes.");
  const mediaType = mediaTypeValue ?? "application/octet-stream";
  const mediaTypeByteLength = new TextEncoder().encode(mediaType).byteLength;
  if (mediaType.length === 0 || mediaType.length > 255 || mediaTypeByteLength > 128 || /[\u0000-\u001f\u007f]/u.test(mediaType)) {
    throw new TypeError("mediaType must be printable UTF-8 text from 1 through 128 bytes.");
  }
  return { requestedCompression, maxChunkBytes, leafDecodedBytes, maxPartsPerComposite, maxTreeDepth, mediaType, mediaTypeByteLength };
}

function flatEstimate(
  stored: Uint8Array,
  maxChunkBytes: number,
  mediaTypeByteLength: number,
): FlatCostEstimate {
  const lengths = chunkLengths(stored, maxChunkBytes);
  const chunkCount = lengths.length;
  const chunkUploadTransactionsValue = chunkUploadTransactions(chunkCount);
  const objectTransactions = 1;
  const calldataBytes = chunkUploadCalldataBytes(lengths) + createObjectCalldataBytes(chunkCount, mediaTypeByteLength);
  return {
    feasible: chunkCount <= OCA_MAX_OBJECT_CHILDREN,
    maxChildren: OCA_MAX_OBJECT_CHILDREN,
    storedByteLength: stored.byteLength,
    chunkCount,
    payloadBytes: stored.byteLength,
    calldataBytes,
    chunkUploadTransactions: chunkUploadTransactionsValue,
    objectTransactions,
    compositeTransactions: 0,
    transactionCount: chunkUploadTransactionsValue + objectTransactions,
  };
}

function recursiveEstimate(
  source: Uint8Array,
  compression: Compression,
  maxChunkBytes: number,
  leafDecodedBytes: number,
  maxPartsPerComposite: number,
  maxTreeDepth: number,
  mediaTypeByteLength: number,
): Promise<RecursiveCostEstimate> {
  return (async () => {
    const leafChunkLengths: number[][] = [];
    let storedByteLength = 0;
    for (let offset = 0; offset < source.byteLength; offset += leafDecodedBytes) {
      const decodedLeaf = source.slice(offset, Math.min(offset + leafDecodedBytes, source.byteLength));
      const storedLeaf = await compressBytes(compression, decodedLeaf);
      const lengths = [...chunkLengths(storedLeaf, maxChunkBytes)];
      leafChunkLengths.push(lengths);
      storedByteLength += storedLeaf.byteLength;
    }

    const leafChunkCounts = leafChunkLengths.map((lengths) => lengths.length);
    const leafChunkCount = leafChunkCounts.reduce((total, count) => total + count, 0);
    const leafCount = leafChunkLengths.length;
    const maxLeafChunkCount = Math.max(...leafChunkCounts);
    const allChunkLengths = leafChunkLengths.flat();
    const chunkUploadTransactionsValue = chunkUploadTransactions(leafChunkCount);
    const leafCalldataBytes = leafChunkCounts.reduce(
      (total, count) => total + createObjectCalldataBytes(count, mediaTypeByteLength),
      0,
    );
    const compositeNodeCounts: number[] = [];
    let compositeCalldataBytes = 0;
    let currentCount = leafCount;
    while (currentCount > 1) {
      const nextCount = Math.ceil(currentCount / maxPartsPerComposite);
      compositeNodeCounts.push(nextCount);
      for (let offset = 0; offset < currentCount; offset += maxPartsPerComposite) {
        compositeCalldataBytes += createCompositeCalldataBytes(
          Math.min(maxPartsPerComposite, currentCount - offset),
          mediaTypeByteLength,
        );
      }
      currentCount = nextCount;
    }
    const compositeCount = compositeNodeCounts.reduce((total, count) => total + count, 0);
    const objectTransactions = leafCount;
    const calldataBytes = chunkUploadCalldataBytes(allChunkLengths) + leafCalldataBytes + compositeCalldataBytes;
    return {
      feasible: maxLeafChunkCount <= OCA_MAX_OBJECT_CHILDREN && compositeNodeCounts.length <= maxTreeDepth,
      storedByteLength,
      chunkCount: leafChunkCount,
      payloadBytes: storedByteLength,
      calldataBytes,
      chunkUploadTransactions: chunkUploadTransactionsValue,
      objectTransactions,
      compositeTransactions: compositeCount,
      transactionCount: chunkUploadTransactionsValue + objectTransactions + compositeCount,
      leafDecodedBytes,
      leafCount,
      leafChunkCount,
      leafChunkCounts,
      maxLeafChunkCount,
      compositeCount,
      compositeNodeCounts,
      treeDepth: compositeNodeCounts.length,
      maxPartsPerComposite,
      maxTreeDepth,
    };
  })();
}

function selectCompression(candidates: readonly CostCompressionCandidate[]): Compression {
  let selected = candidates[0];
  if (selected === undefined) throw new Error("Cost analysis produced no compression candidates.");
  for (const candidate of candidates.slice(1)) {
    if (candidate.storedByteLength < selected.storedByteLength) selected = candidate;
  }
  return selected.compression;
}

export async function analyzeCost(sourceBytes: Uint8Array, options: CostAnalysisOptions = {}): Promise<CostAnalysis> {
  if (!(sourceBytes instanceof Uint8Array)) throw new TypeError("sourceBytes must be a Uint8Array.");
  if (sourceBytes.byteLength === 0) throw new RangeError("Cost analysis requires a non-empty source.");
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Cost analysis options must be an object.");
  }
  const validated = validateOptions(options);
  const compressions = validated.requestedCompression === "auto"
    ? COMPRESSION_ORDER
    : [validated.requestedCompression];
  const candidates: CostCompressionCandidate[] = [];
  for (const compression of compressions) {
    const stored = await compressBytes(compression, sourceBytes);
    candidates.push({
      compression,
      storedByteLength: stored.byteLength,
      flat: flatEstimate(stored, validated.maxChunkBytes, validated.mediaTypeByteLength),
      recursive: await recursiveEstimate(
        sourceBytes,
        compression,
        validated.maxChunkBytes,
        validated.leafDecodedBytes,
        validated.maxPartsPerComposite,
        validated.maxTreeDepth,
        validated.mediaTypeByteLength,
      ),
    });
  }
  const selectedCompression = selectCompression(candidates);
  const selected = candidates.find((candidate) => candidate.compression === selectedCompression);
  if (selected === undefined) throw new Error("Selected compression candidate is missing.");
  const strategy = selected.flat.feasible ? "flat" : selected.recursive.feasible ? "recursive" : "infeasible";
  const recommendation = strategy === "flat"
    ? selected.flat
    : strategy === "recursive"
      ? selected.recursive
      : selected.flat;
  return {
    schema: KEEL_COST_ANALYSIS_PROTOCOL,
    inputByteLength: sourceBytes.byteLength,
    requestedCompression: validated.requestedCompression,
    selectedCompression,
    model: {
      chunkBatchSize: CHUNK_BATCH_SIZE,
      maxChunkBytes: validated.maxChunkBytes,
      maxChildren: OCA_MAX_OBJECT_CHILDREN,
      maxTreeDepth: validated.maxTreeDepth,
      mediaType: validated.mediaType,
      mediaTypeByteLength: validated.mediaTypeByteLength,
      calldataEncoding: "ABI-sized modeled bytes",
      caveat: KEEL_COST_ANALYSIS_CAVEAT,
    },
    candidates,
    recommendation: {
      compression: selectedCompression,
      strategy,
      transactionCount: recommendation.transactionCount,
      calldataBytes: recommendation.calldataBytes,
    },
  };
}
