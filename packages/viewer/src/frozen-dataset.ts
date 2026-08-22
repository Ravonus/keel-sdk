import {
  KEEL_FROZEN_DATASET_CHUNK_PROTOCOL,
  canonicalJson,
  parseKeelFrozenDatasetManifest,
  utf8ToBytes,
  verifyIntegrity,
  type CanonicalValue,
  type CustomDigest,
  type Integrity,
  type KeelDatasetScalar,
  type KeelFrozenDatasetChunkDescriptor,
  type KeelFrozenDatasetManifest,
} from "@keel/protocol";

/** Retrieval ceilings for an untrusted frozen-dataset manifest (DoS bounds). */
export interface KeelFrozenDatasetLimits {
  readonly maxChunks?: number;
  readonly maxChunkBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxRows?: number;
}

export const DEFAULT_KEEL_FROZEN_DATASET_LIMITS = {
  maxChunks: 4_096,
  maxChunkBytes: 4_194_304, // 4 MiB
  maxTotalBytes: 268_435_456, // 256 MiB
  maxRows: 1_000_000,
} as const satisfies Required<KeelFrozenDatasetLimits>;

/**
 * Bound an untrusted manifest before any chunk is fetched: cap chunk count,
 * per-chunk declared byte length, aggregate declared bytes, and total rows. A
 * hostile manifest cannot force an unbounded number of requests or a huge
 * allocation, because each chunk's declared `integrity.byteLength` is checked
 * against the ceiling up front (and `verifyIntegrity` later rejects any chunk
 * whose actual bytes disagree with that declared length).
 */
export function assertKeelFrozenDatasetWithinLimits(
  manifest: KeelFrozenDatasetManifest,
  limits: KeelFrozenDatasetLimits = {},
): void {
  const bounds = { ...DEFAULT_KEEL_FROZEN_DATASET_LIMITS, ...limits };
  if (manifest.chunks.length > bounds.maxChunks) {
    throw new RangeError(`Frozen dataset declares ${manifest.chunks.length} chunks, exceeding maxChunks ${bounds.maxChunks}.`);
  }
  if (manifest.rowCount > bounds.maxRows) {
    throw new RangeError(`Frozen dataset declares ${manifest.rowCount} rows, exceeding maxRows ${bounds.maxRows}.`);
  }
  let totalBytes = 0;
  for (const chunk of manifest.chunks) {
    const byteLength = chunk.integrity.byteLength;
    if (byteLength === undefined) {
      throw new RangeError(`Frozen dataset chunk ${chunk.ordinal} is missing a declared byteLength.`);
    }
    if (byteLength > bounds.maxChunkBytes) {
      throw new RangeError(`Frozen dataset chunk ${chunk.ordinal} declares ${byteLength} bytes, exceeding maxChunkBytes ${bounds.maxChunkBytes}.`);
    }
    totalBytes += byteLength;
    if (totalBytes > bounds.maxTotalBytes) {
      throw new RangeError(`Frozen dataset aggregate bytes exceed maxTotalBytes ${bounds.maxTotalBytes}.`);
    }
  }
}

export type KeelDatasetFilter =
  | { readonly path: string; readonly op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains"; readonly value: KeelDatasetScalar }
  | { readonly path: string; readonly op: "in"; readonly value: readonly KeelDatasetScalar[] };

export interface KeelDatasetQuery {
  readonly where?: readonly KeelDatasetFilter[];
  /** Case-insensitive search across every string value in a row. */
  readonly search?: string;
  readonly select?: readonly string[];
  readonly sort?: readonly { readonly path: string; readonly direction?: "asc" | "desc" }[];
  readonly offset?: number;
  readonly limit?: number;
}

export interface KeelFrozenDatasetCacheRecord {
  readonly key: string;
  readonly bytes: Uint8Array;
}

export interface KeelFrozenDatasetCache {
  /** Implementations clear older revision namespaces here before reads begin. */
  activate(datasetId: string, revision: number): Promise<void>;
  get(key: string): Promise<KeelFrozenDatasetCacheRecord | undefined>;
  put(record: KeelFrozenDatasetCacheRecord): Promise<void>;
}

export interface QueryKeelFrozenDatasetOptions {
  readonly cache?: KeelFrozenDatasetCache;
  readonly signal?: AbortSignal;
  readonly customDigest?: CustomDigest;
  readonly loadChunk: (descriptor: KeelFrozenDatasetChunkDescriptor, signal?: AbortSignal) => Promise<Uint8Array>;
  /** Retrieval ceilings for the untrusted manifest. Defaults applied when omitted. */
  readonly limits?: KeelFrozenDatasetLimits;
  /**
   * Optional committed manifest digest. When present, the manifest is verified
   * (`sha256(canonicalJson(manifest))`) against it before any chunk descriptor is
   * trusted — binding the whole dataset to an anchored digest instead of trusting
   * whatever manifest object the caller passed in.
   */
  readonly expectedManifestIntegrity?: Integrity;
}

async function verifyManifestAnchor(
  manifestInput: unknown,
  options: QueryKeelFrozenDatasetOptions,
): Promise<void> {
  if (options.expectedManifestIntegrity === undefined) return;
  // Hash the exact input the caller passed, matching how the builder committed
  // the digest (sha256 over canonicalJson of the manifest), and verify BEFORE
  // parsing/trusting it. Re-hashing a re-parsed object would risk a
  // representation mismatch on an otherwise-valid manifest.
  const bytes = utf8ToBytes(canonicalJson(manifestInput as never));
  if (!(await verifyIntegrity(bytes, options.expectedManifestIntegrity, options.customDigest))) {
    throw new Error("Frozen dataset manifest failed integrity verification against the committed digest.");
  }
}

export interface KeelFrozenDatasetQueryResult {
  readonly rows: readonly CanonicalValue[];
  readonly totalMatched: number;
  readonly loadedChunkHashes: readonly string[];
  readonly skippedChunkHashes: readonly string[];
  readonly revision: number;
}

function nonNegativeInteger(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0) throw new RangeError(`${label} must be a non-negative safe integer.`);
  return result;
}

function cacheKey(manifest: KeelFrozenDatasetManifest, chunk: KeelFrozenDatasetChunkDescriptor): string {
  return ["keel-frozen-dataset-cache@1", encodeURIComponent(manifest.datasetId), manifest.revision, chunk.ordinal, chunk.contentHash].join(":");
}

function decodePointerSegment(value: string): string {
  if (/~(?:[^01]|$)/u.test(value)) throw new TypeError("Dataset query path contains an invalid JSON Pointer escape.");
  return value.replace(/~1/gu, "/").replace(/~0/gu, "~");
}

export function keelDatasetValueAt(row: CanonicalValue, path: string): CanonicalValue | undefined {
  if (path === "") return row;
  if (!path.startsWith("/")) throw new TypeError("Dataset query paths must be JSON Pointers such as /weather/temperature.");
  let value: CanonicalValue | undefined = row;
  for (const raw of path.slice(1).split("/")) {
    const key = decodePointerSegment(raw);
    if (Array.isArray(value)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(key)) return undefined;
      value = value[Number(key)];
    } else if (value !== null && typeof value === "object") {
      value = (value as { readonly [key: string]: CanonicalValue })[key];
    } else {
      return undefined;
    }
  }
  return value;
}

function equal(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return canonicalJson(left) === canonicalJson(right);
}

function compare(left: unknown, right: unknown): number | undefined {
  if (typeof left !== typeof right || (typeof left !== "number" && typeof left !== "string")) return undefined;
  if (typeof left === "number" && typeof right === "number") return left < right ? -1 : left > right ? 1 : 0;
  if (typeof left === "string" && typeof right === "string") return left < right ? -1 : left > right ? 1 : 0;
  return undefined;
}

function matchesFilter(row: CanonicalValue, filter: KeelDatasetFilter): boolean {
  const value = keelDatasetValueAt(row, filter.path);
  if (filter.op === "eq") return equal(value, filter.value);
  if (filter.op === "neq") return !equal(value, filter.value);
  if (filter.op === "in") return filter.value.some((candidate) => equal(value, candidate));
  if (filter.op === "contains") return typeof value === "string" && typeof filter.value === "string" && value.toLocaleLowerCase("en-US").includes(filter.value.toLocaleLowerCase("en-US"));
  const order = compare(value, filter.value);
  if (order === undefined) return false;
  if (filter.op === "gt") return order > 0;
  if (filter.op === "gte") return order >= 0;
  if (filter.op === "lt") return order < 0;
  return order <= 0;
}

function strings(value: CanonicalValue): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  return Array.isArray(value) ? value.flatMap(strings) : Object.values(value).flatMap(strings);
}

function rowMatches(row: CanonicalValue, query: KeelDatasetQuery): boolean {
  if (!(query.where ?? []).every((filter) => matchesFilter(row, filter))) return false;
  const search = query.search?.trim().toLocaleLowerCase("en-US");
  return search === undefined || search.length === 0 || strings(row).some((value) => value.toLocaleLowerCase("en-US").includes(search));
}

function scalarSummaryContains(values: readonly KeelDatasetScalar[], target: KeelDatasetScalar): boolean {
  return values.some((value) => equal(value, target));
}

/** Return true only when a committed summary proves that no row can match. */
function filterExcludesChunk(chunk: KeelFrozenDatasetChunkDescriptor, filter: KeelDatasetFilter): boolean {
  const summary = chunk.indexes?.[filter.path];
  if (summary === undefined) return false;
  if (filter.op === "eq" && summary.complete === true && summary.values !== undefined) return !scalarSummaryContains(summary.values, filter.value);
  if (filter.op === "in" && summary.complete === true && summary.values !== undefined) {
    return !filter.value.some((candidate) => scalarSummaryContains(summary.values!, candidate));
  }
  const againstMin = summary.min === undefined ? undefined : compare(summary.min, filter.value);
  const againstMax = summary.max === undefined ? undefined : compare(summary.max, filter.value);
  if (filter.op === "gt") return againstMax !== undefined && againstMax <= 0;
  if (filter.op === "gte") return againstMax !== undefined && againstMax < 0;
  if (filter.op === "lt") return againstMin !== undefined && againstMin >= 0;
  if (filter.op === "lte") return againstMin !== undefined && againstMin > 0;
  return false;
}

export function planKeelFrozenDatasetQuery(
  manifestInput: KeelFrozenDatasetManifest | unknown,
  query: KeelDatasetQuery,
  limits?: KeelFrozenDatasetLimits,
): { readonly load: readonly KeelFrozenDatasetChunkDescriptor[]; readonly skip: readonly KeelFrozenDatasetChunkDescriptor[] } {
  const manifest = parseKeelFrozenDatasetManifest(manifestInput);
  assertKeelFrozenDatasetWithinLimits(manifest, limits);
  const load: KeelFrozenDatasetChunkDescriptor[] = [];
  const skip: KeelFrozenDatasetChunkDescriptor[] = [];
  for (const chunk of manifest.chunks) {
    ((query.where ?? []).some((filter) => filterExcludesChunk(chunk, filter)) ? skip : load).push(chunk);
  }
  return { load, skip };
}

async function loadVerifiedChunk(
  manifest: KeelFrozenDatasetManifest,
  descriptor: KeelFrozenDatasetChunkDescriptor,
  options: QueryKeelFrozenDatasetOptions,
): Promise<readonly CanonicalValue[]> {
  const key = cacheKey(manifest, descriptor);
  let bytes = (await options.cache?.get(key))?.bytes;
  if (bytes === undefined || !(await verifyIntegrity(bytes, descriptor.integrity, options.customDigest))) {
    bytes = await options.loadChunk(descriptor, options.signal);
    if (!(await verifyIntegrity(bytes, descriptor.integrity, options.customDigest))) throw new Error(`Frozen dataset chunk ${descriptor.ordinal} failed SHA-256 verification.`);
    await options.cache?.put({ key, bytes: bytes.slice() });
  }
  const value = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  if (
    value.protocol !== KEEL_FROZEN_DATASET_CHUNK_PROTOCOL || value.datasetId !== manifest.datasetId ||
    value.revision !== manifest.revision || value.ordinal !== descriptor.ordinal || !Array.isArray(value.rows) ||
    value.rows.length !== descriptor.rowCount
  ) {
    throw new Error(`Frozen dataset chunk ${descriptor.ordinal} does not match its manifest slot.`);
  }
  if (canonicalJson(value) !== new TextDecoder().decode(bytes)) throw new Error(`Frozen dataset chunk ${descriptor.ordinal} is not canonical JSON.`);
  return value.rows as readonly CanonicalValue[];
}

function project(row: CanonicalValue, select: readonly string[] | undefined): CanonicalValue {
  if (select === undefined) return row;
  const output: Record<string, CanonicalValue> = {};
  for (const path of select) {
    const value = keelDatasetValueAt(row, path);
    if (value !== undefined) output[path] = value;
  }
  return output;
}

function sortRows(rows: CanonicalValue[], sort: KeelDatasetQuery["sort"]): void {
  if (sort === undefined || sort.length === 0) return;
  rows.sort((left, right) => {
    for (const rule of sort) {
      const a = keelDatasetValueAt(left, rule.path);
      const b = keelDatasetValueAt(right, rule.path);
      const order = compare(a, b) ?? canonicalJson(a ?? null).localeCompare(canonicalJson(b ?? null), "en-US");
      if (order !== 0) return rule.direction === "desc" ? -order : order;
    }
    return 0;
  });
}

/** Verify, query, sort, and project a revision without exposing pagination/chunk mechanics to the caller. */
export async function queryKeelFrozenDataset(
  manifestInput: KeelFrozenDatasetManifest | unknown,
  query: KeelDatasetQuery,
  options: QueryKeelFrozenDatasetOptions,
): Promise<KeelFrozenDatasetQueryResult> {
  await verifyManifestAnchor(manifestInput, options);
  const manifest = parseKeelFrozenDatasetManifest(manifestInput);
  assertKeelFrozenDatasetWithinLimits(manifest, options.limits);
  await options.cache?.activate(manifest.datasetId, manifest.revision);
  const plan = planKeelFrozenDatasetQuery(manifest, query, options.limits);
  const matched: CanonicalValue[] = [];
  for (const chunk of plan.load) {
    if (options.signal?.aborted === true) throw options.signal.reason ?? new Error("Frozen dataset query aborted.");
    const rows = await loadVerifiedChunk(manifest, chunk, options);
    matched.push(...rows.filter((row) => rowMatches(row, query)));
  }
  sortRows(matched, query.sort);
  const offset = nonNegativeInteger(query.offset, 0, "query.offset");
  const limit = query.limit === undefined ? matched.length : nonNegativeInteger(query.limit, 0, "query.limit");
  return {
    rows: matched.slice(offset, offset + limit).map((row) => project(row, query.select)),
    totalMatched: matched.length,
    loadedChunkHashes: plan.load.map((chunk) => chunk.contentHash),
    skippedChunkHashes: plan.skip.map((chunk) => chunk.contentHash),
    revision: manifest.revision,
  };
}

/** In-memory reference cache; browser adapters can use Cache Storage or IndexedDB with the same contract. */
export function createMemoryKeelFrozenDatasetCache(): KeelFrozenDatasetCache {
  const records = new Map<string, Uint8Array>();
  const active = new Map<string, number>();
  return {
    async activate(datasetId, revision) {
      const prior = active.get(datasetId);
      if (prior !== undefined && prior !== revision) {
        const prefix = `keel-frozen-dataset-cache@1:${encodeURIComponent(datasetId)}:`;
        for (const key of records.keys()) if (key.startsWith(prefix)) records.delete(key);
      }
      active.set(datasetId, revision);
    },
    async get(key) {
      const bytes = records.get(key);
      return bytes === undefined ? undefined : { key, bytes: bytes.slice() };
    },
    async put(record) {
      records.set(record.key, record.bytes.slice());
    },
  };
}

/** Content-addressed HTTP helpers should serve chunks with this exact policy. */
export const KEEL_FROZEN_CHUNK_CACHE_CONTROL = "public, max-age=31536000, immutable" as const;
export const KEEL_FROZEN_MANIFEST_CACHE_CONTROL = "no-cache" as const;
