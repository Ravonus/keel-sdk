import {
  concatBytes,
  toBufferSource,
  verifyIntegrity,
  type Compression,
  type DigestAlgorithm,
  type Hex,
} from "@keel/protocol";
import type { OnchainObjectRequest, ResolverAdapters } from "./types.js";

export interface KeelHoldObjectRecord {
  readonly digest: Hex;
  readonly descriptorPointer?: Hex;
  readonly byteLength: bigint | number;
  readonly storedByteLength: bigint | number;
  readonly chunkCount: bigint | number;
  readonly compression: bigint | number;
  readonly composite: boolean;
}

export interface KeelHoldReadClient {
  getObject(request: OnchainObjectRequest, signal: AbortSignal): Promise<KeelHoldObjectRecord>;
  getObjectSlugPointers(
    request: OnchainObjectRequest & { readonly offset: number; readonly limit: number },
    signal: AbortSignal,
  ): Promise<readonly Hex[]>;
  getObjectPartIds(
    request: OnchainObjectRequest & { readonly offset: number; readonly limit: number },
    signal: AbortSignal,
  ): Promise<readonly Hex[]>;
  getCode(
    request: { readonly chainId: number; readonly address: Hex },
    signal: AbortSignal,
  ): Promise<Uint8Array>;
}

export interface RecursiveChunkReaderOptions {
  readonly pageSize?: number;
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly maxDecodedBytes?: number;
  readonly maxStoredBytes?: number;
  readonly maxConcurrentReads?: number;
  readonly digestAlgorithm?: Exclude<DigestAlgorithm, "none">;
  /**
   * Verify each KeelHold record's decoded digest while walking the object
   * graph. Disable this only when a higher-level descriptor supplies the
   * algorithm and the caller verifies the fully assembled root bytes. Older
   * KeelHold records commit digest bytes but do not store the algorithm, so
   * mixed or non-SHA graphs cannot be verified record-by-record.
   */
  readonly verifyObjectDigests?: boolean;
  readonly customDigest?: ResolverAdapters["customDigest"];
  readonly decompress?: ResolverAdapters["decompress"];
}

interface ReadContext {
  readonly signal: AbortSignal;
  readonly client: KeelHoldReadClient;
  readonly options: Required<
    Pick<RecursiveChunkReaderOptions, "pageSize" | "maxDepth" | "maxNodes" | "maxDecodedBytes" | "maxStoredBytes" | "maxConcurrentReads">
  > &
    Omit<
      RecursiveChunkReaderOptions,
      "pageSize" | "maxDepth" | "maxNodes" | "maxDecodedBytes" | "maxStoredBytes" | "maxConcurrentReads"
    >;
  readonly cache: Map<string, Promise<Uint8Array>>;
  readonly active: Set<string>;
  nodes: number;
  decodedBytes: number;
}

function safeNumber(value: bigint | number, label: string): number {
  const normalized = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(normalized) || normalized < 0) throw new RangeError(`${label} exceeds safe client limits.`);
  return normalized;
}

function compressionFromCode(value: bigint | number): Compression {
  const code = safeNumber(value, "compression");
  switch (code) {
    case 0:
      return "none";
    case 1:
      return "gzip";
    case 2:
      return "deflate";
    case 3:
      return "brotli";
    default:
      throw new TypeError(`Unknown KeelHold compression code ${code}.`);
  }
}

async function readStreamWithLimit(
  stream: ReadableStream<Uint8Array>,
  maximum: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason ?? new Error("KeelHold read aborted.");
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximum) throw new RangeError(`Decompressed object exceeds ${maximum} bytes.`);
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return concatBytes(chunks);
}

async function defaultDecompress(
  compression: Exclude<Compression, "none">,
  bytes: Uint8Array,
  maximum: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (compression === "brotli") throw new Error("Brotli requires a decompress adapter.");
  if (typeof globalThis.DecompressionStream !== "function") throw new Error("DecompressionStream is unavailable.");
  const stream = new Blob([toBufferSource(bytes)]).stream().pipeThrough(new DecompressionStream(compression));
  return readStreamWithLimit(stream, maximum, signal);
}

async function decompress(
  compression: Compression,
  bytes: Uint8Array,
  options: RecursiveChunkReaderOptions,
  maximum: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (compression === "none") return bytes;
  return options.decompress?.(compression, bytes) ?? defaultDecompress(compression, bytes, maximum, signal);
}

function objectKey(request: OnchainObjectRequest): string {
  return `${request.chainId}:${request.store.toLowerCase()}:${request.objectId.toLowerCase()}`;
}

function readBigEndian(bytes: Uint8Array, offset: number, length: number): bigint {
  let value = 0n;
  for (let index = offset; index < offset + length; index += 1) {
    const byte = bytes[index];
    if (byte === undefined) throw new Error("Truncated KeelHold descriptor.");
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

function bytesHex(bytes: Uint8Array): Hex {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function descriptorReferences(
  context: ReadContext,
  request: OnchainObjectRequest,
  record: KeelHoldObjectRecord,
): Promise<readonly Hex[]> {
  const pointer = record.descriptorPointer;
  if (pointer === undefined) throw new Error("KeelHold does not expose descriptor fallback data.");
  const code = await context.client.getCode({ chainId: request.chainId, address: pointer }, context.signal);
  if (code.byteLength < 94 || code[0] !== 0) throw new Error(`Invalid KeelHold descriptor bytecode at ${pointer}.`);
  const descriptor = code.subarray(1);
  // OCA3 is the original deployed v1 descriptor magic; STR3 renamed the same
  // immutable wire layout. Both must remain readable or existing KEEL objects
  // would be orphaned by the SDK migration.
  const magic = bytesHex(descriptor.subarray(0, 4));
  if ((magic !== "0x4f434133" && magic !== "0x53545233") || descriptor[4] !== 1) {
    throw new Error(`Unsupported KeelHold descriptor format at ${pointer}.`);
  }
  const composite = descriptor[5] === 1;
  const count = safeNumber(record.chunkCount, "object child count");
  if ((descriptor[5] !== 0 && descriptor[5] !== 1)
    || composite !== record.composite
    || descriptor[6] !== safeNumber(record.compression, "compression")
    || readBigEndian(descriptor, 8, 4) !== BigInt(count)
    || readBigEndian(descriptor, 12, 8) !== BigInt(safeNumber(record.byteLength, "object byteLength"))
    || readBigEndian(descriptor, 20, 8) !== BigInt(safeNumber(record.storedByteLength, "object storedByteLength"))
    || bytesHex(descriptor.subarray(28, 60)).toLowerCase() !== record.digest.toLowerCase()) {
    throw new Error(`KeelHold descriptor metadata mismatch at ${pointer}.`);
  }
  const mediaLength = descriptor[92];
  if (mediaLength === undefined) throw new Error(`Truncated KeelHold descriptor at ${pointer}.`);
  const width = composite ? 32 : 20;
  const referencesOffset = 93 + mediaLength;
  if (descriptor.byteLength !== referencesOffset + (count * width)) {
    throw new Error(`KeelHold descriptor length mismatch at ${pointer}.`);
  }
  return Array.from({ length: count }, (_, index) => (
    bytesHex(descriptor.subarray(referencesOffset + (index * width), referencesOffset + ((index + 1) * width)))
  ));
}

async function pageIds(
  context: ReadContext,
  request: OnchainObjectRequest,
  count: number,
  record: KeelHoldObjectRecord,
): Promise<readonly Hex[]> {
  try {
    const result: Hex[] = [];
    for (let offset = 0; offset < count; offset += context.options.pageSize) {
      if (context.signal.aborted) throw context.signal.reason;
      const limit = Math.min(context.options.pageSize, count - offset);
      const pageRequest = { ...request, offset, limit };
      const page = await context.client.getObjectPartIds(pageRequest, context.signal);
      if (page.length === 0 && limit !== 0) throw new Error(`KeelHold returned an empty page at offset ${offset}.`);
      result.push(...page);
    }
    if (result.length !== count) throw new Error(`KeelHold returned ${result.length} IDs; expected ${count}.`);
    return result;
  } catch (error) {
    if (record.descriptorPointer === undefined) throw error;
    return descriptorReferences(context, request, record);
  }
}

async function pagePointers(
  context: ReadContext,
  request: OnchainObjectRequest,
  count: number,
  record: KeelHoldObjectRecord,
): Promise<readonly Hex[]> {
  try {
    const result: Hex[] = [];
    for (let offset = 0; offset < count; offset += context.options.pageSize) {
      if (context.signal.aborted) throw context.signal.reason;
      const limit = Math.min(context.options.pageSize, count - offset);
      const page = await context.client.getObjectSlugPointers({ ...request, offset, limit }, context.signal);
      if (page.length === 0 && limit !== 0) throw new Error(`KeelHold returned an empty pointer page at offset ${offset}.`);
      result.push(...page);
    }
    if (result.length !== count) throw new Error(`KeelHold returned ${result.length} pointers; expected ${count}.`);
    return result;
  } catch (error) {
    if (record.descriptorPointer === undefined) throw error;
    return descriptorReferences(context, request, record);
  }
}

async function readCarriers(
  context: ReadContext,
  request: OnchainObjectRequest,
  pointers: readonly Hex[],
): Promise<readonly Uint8Array[]> {
  const result = new Array<Uint8Array>(pointers.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= pointers.length) return;
      if (context.signal.aborted) throw context.signal.reason;
      const pointer = pointers[index];
      if (pointer === undefined) throw new Error(`Missing KeelHold carrier pointer ${index}.`);
      const code = await context.client.getCode({ chainId: request.chainId, address: pointer }, context.signal);
      if (code.byteLength <= 1 || code[0] !== 0) throw new Error(`Invalid immutable carrier bytecode at ${pointer}.`);
      result[index] = code.slice(1);
    }
  };
  const workers = Math.min(context.options.maxConcurrentReads, Math.max(1, pointers.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return result;
}

async function haulObjectUncached(
  context: ReadContext,
  request: OnchainObjectRequest,
  depth: number,
): Promise<Uint8Array> {
  if (context.signal.aborted) throw context.signal.reason;
  if (depth > context.options.maxDepth) throw new RangeError(`KeelHold recursion exceeds ${context.options.maxDepth}.`);
  if (++context.nodes > context.options.maxNodes) throw new RangeError(`KeelHold node count exceeds ${context.options.maxNodes}.`);

  const key = objectKey(request);
  if (context.active.has(key)) throw new Error(`KeelHold object cycle at ${request.objectId}.`);
  context.active.add(key);
  try {
    const record = await context.client.getObject(request, context.signal);
    const expectedBytes = safeNumber(record.byteLength, "object byteLength");
    const storedBytes = safeNumber(record.storedByteLength, "object storedByteLength");
    const count = safeNumber(record.chunkCount, "object child count");
    if (expectedBytes > context.options.maxDecodedBytes) {
      throw new RangeError(`KeelHold object exceeds decoded-byte limit ${context.options.maxDecodedBytes}.`);
    }
    if (storedBytes > context.options.maxStoredBytes) {
      throw new RangeError(`KeelHold object exceeds stored-byte limit ${context.options.maxStoredBytes}.`);
    }

    let decoded: Uint8Array;
    if (record.composite) {
      const partIds = await pageIds(context, request, count, record);
      const parts: Uint8Array[] = [];
      for (const objectId of partIds) {
        parts.push(await haulObject(context, { chainId: request.chainId, store: request.store, objectId }, depth + 1));
      }
      decoded = concatBytes(parts);
    } else {
      const pointers = await pagePointers(context, request, count, record);
      const chunks = await readCarriers(context, request, pointers);
      const stored = concatBytes(chunks);
      if (stored.byteLength !== storedBytes) throw new Error(`Stored length mismatch for ${request.objectId}.`);
      decoded = await decompress(
        compressionFromCode(record.compression),
        stored,
        context.options,
        expectedBytes,
        context.signal,
      );
    }

    if (decoded.byteLength !== expectedBytes) throw new Error(`Decoded length mismatch for ${request.objectId}.`);
    if (context.decodedBytes + decoded.byteLength > context.options.maxDecodedBytes) {
      throw new RangeError(`KeelHold traversal exceeds ${context.options.maxDecodedBytes} decoded bytes.`);
    }
    context.decodedBytes += decoded.byteLength;
    if (context.options.verifyObjectDigests ?? true) {
      const verified = await verifyIntegrity(
        decoded,
        {
          algorithm: context.options.digestAlgorithm ?? "sha256",
          digest: record.digest,
          byteLength: expectedBytes,
        },
        context.options.customDigest,
      );
      if (!verified) throw new Error(`Object digest mismatch for ${request.objectId}.`);
    }
    return decoded;
  } finally {
    context.active.delete(key);
  }
}

function haulObject(context: ReadContext, request: OnchainObjectRequest, depth: number): Promise<Uint8Array> {
  const key = objectKey(request);
  const cached = context.cache.get(key);
  if (cached !== undefined) return cached;
  const pending = haulObjectUncached(context, request, depth);
  context.cache.set(key, pending);
  return pending;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive safe integer.`);
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative safe integer.`);
  return value;
}

export function createKeelHoldObjectReader(
  client: KeelHoldReadClient,
  options: RecursiveChunkReaderOptions = {},
): NonNullable<ResolverAdapters["readOnchainObject"]> {
  const pageSize = positiveInteger(options.pageSize ?? 128, "pageSize");
  if (pageSize > 1_024) throw new RangeError("pageSize cannot exceed 1024.");
  const maxDepth = nonNegativeInteger(options.maxDepth ?? 32, "maxDepth");
  const maxNodes = positiveInteger(options.maxNodes ?? 4_096, "maxNodes");
  const maxDecodedBytes = positiveInteger(options.maxDecodedBytes ?? 256 * 1024 * 1024, "maxDecodedBytes");
  const maxStoredBytes = positiveInteger(options.maxStoredBytes ?? 256 * 1024 * 1024, "maxStoredBytes");
  const maxConcurrentReads = positiveInteger(options.maxConcurrentReads ?? 12, "maxConcurrentReads");
  if (maxConcurrentReads > 64) throw new RangeError("maxConcurrentReads cannot exceed 64.");

  return async (request, signal) => {
    const context: ReadContext = {
      signal,
      client,
      options: {
        pageSize,
        maxDepth,
        maxNodes,
        maxDecodedBytes,
        maxStoredBytes,
        maxConcurrentReads,
        ...(options.digestAlgorithm === undefined ? {} : { digestAlgorithm: options.digestAlgorithm }),
        ...(options.verifyObjectDigests === undefined ? {} : { verifyObjectDigests: options.verifyObjectDigests }),
        ...(options.customDigest === undefined ? {} : { customDigest: options.customDigest }),
        ...(options.decompress === undefined ? {} : { decompress: options.decompress }),
      },
      cache: new Map(),
      active: new Set(),
      nodes: 0,
      decodedBytes: 0,
    };
    return haulObject(context, request, 0);
  };
}
