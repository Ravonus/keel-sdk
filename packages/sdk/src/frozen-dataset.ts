import {
  KEEL_FROZEN_DATASET_CHUNK_PROTOCOL,
  KEEL_FROZEN_DATASET_PROTOCOL,
  canonicalJson,
  canonicalize,
  createIntegrity,
  sha256Hex,
  utf8ToBytes,
  type CanonicalValue,
  type Hex,
  type KeelDatasetFieldType,
  type KeelDatasetScalar,
  type KeelDatasetSourcePagination,
  type KeelFrozenDatasetChunk,
  type KeelFrozenDatasetChunkDescriptor,
  type KeelFrozenDatasetChunkIndex,
  type KeelFrozenDatasetField,
  type KeelFrozenDatasetManifest,
  type KeelFrozenDatasetSourceSpan,
} from "@keel/protocol";

export interface KeelFrozenDatasetSourceBatch {
  /** Complete response data selected for preservation, independent of the source query shape. */
  readonly rows: readonly unknown[];
  readonly page?: number;
  readonly cursorIn?: string;
  readonly cursorOut?: string;
}

export interface BuildKeelFrozenDatasetInput {
  readonly datasetId: string;
  readonly revision: number;
  readonly parentRevision?: number;
  readonly visibility?: "closed" | "public";
  readonly pagination?: KeelDatasetSourcePagination;
  readonly sourceManifestDigest?: Hex;
  readonly batches: Iterable<KeelFrozenDatasetSourceBatch> | AsyncIterable<KeelFrozenDatasetSourceBatch>;
  /** A chunk closes at either limit. One oversized row remains a valid one-row chunk. */
  readonly targetRows?: number;
  readonly targetBytes?: number;
  readonly maxDiscoveredFields?: number;
  readonly maxIndexValues?: number;
  readonly maxIndexTokens?: number;
  readonly locations?: (contentHash: Hex, ordinal: number) => readonly string[];
}

export interface BuiltKeelFrozenDatasetChunk {
  readonly descriptor: KeelFrozenDatasetChunkDescriptor;
  readonly value: KeelFrozenDatasetChunk;
  readonly bytes: Uint8Array;
}

export interface BuiltKeelFrozenDataset {
  readonly manifest: KeelFrozenDatasetManifest;
  readonly chunks: readonly BuiltKeelFrozenDatasetChunk[];
  readonly manifestBytes: Uint8Array;
  readonly manifestIntegrity: Awaited<ReturnType<typeof createIntegrity>>;
}

interface PendingRow {
  readonly value: CanonicalValue;
  readonly batch: number;
  readonly rowOffset: number;
  readonly page?: number;
  readonly cursorInDigest?: Hex;
  readonly cursorOutDigest?: Hex;
}

const DEFAULT_TARGET_ROWS = 250;
const DEFAULT_TARGET_BYTES = 256 * 1024;
const DEFAULT_MAX_FIELDS = 128;
const DEFAULT_MAX_INDEX_VALUES = 64;
const DEFAULT_MAX_INDEX_TOKENS = 256;

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw new RangeError(`${label} must be a positive safe integer.`);
  return result;
}

function pointerEscape(value: string): string {
  return value.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

function scalarType(value: KeelDatasetScalar): Exclude<KeelDatasetFieldType, "mixed"> {
  return value === null ? "null" : typeof value as "boolean" | "number" | "string";
}

function collectScalars(value: CanonicalValue, path: string, output: Map<string, KeelDatasetScalar>, limit: number): void {
  if (output.size >= limit) return;
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    if (path.length > 0) output.set(path, value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectScalars(item, `${path}/${index}`, output, limit));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    collectScalars(item, `${path}/${pointerEscape(key)}`, output, limit);
    if (output.size >= limit) return;
  }
}

function tokenSet(value: string): Set<string> {
  return new Set(value.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}_-]+/gu) ?? []);
}

function comparable(values: readonly KeelDatasetScalar[]): values is readonly (number | string)[] {
  return values.length > 0 && (values.every((value) => typeof value === "number") || values.every((value) => typeof value === "string"));
}

function compare(left: number | string, right: number | string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function buildIndexes(
  rows: readonly CanonicalValue[],
  fieldTypes: Map<string, KeelDatasetFieldType>,
  maxFields: number,
  maxValues: number,
  maxTokens: number,
): Readonly<Record<string, KeelFrozenDatasetChunkIndex>> {
  const columns = new Map<string, KeelDatasetScalar[]>();
  for (const row of rows) {
    const scalars = new Map<string, KeelDatasetScalar>();
    collectScalars(row, "", scalars, maxFields);
    for (const [path, value] of scalars) {
      if (!fieldTypes.has(path) && fieldTypes.size >= maxFields) continue;
      const values = columns.get(path) ?? [];
      values.push(value);
      columns.set(path, values);
      const current = fieldTypes.get(path);
      const next = scalarType(value);
      fieldTypes.set(path, current === undefined || current === next ? next : "mixed");
    }
  }
  const output: Record<string, KeelFrozenDatasetChunkIndex> = {};
  for (const [path, values] of [...columns.entries()].slice(0, maxFields)) {
    const unique = [...new Map(values.map((value) => [canonicalJson(value), value])).values()];
    const strings = values.filter((value): value is string => typeof value === "string");
    const tokens = [...new Set(strings.flatMap((value) => [...tokenSet(value)]))];
    const valuesComplete = unique.length <= maxValues;
    const tokensComplete = tokens.length <= maxTokens;
    const range = comparable(values) ? [...values].sort(compare) : undefined;
    output[path] = {
      type: fieldTypes.get(path) ?? "mixed",
      ...(range === undefined ? {} : { min: range[0], max: range[range.length - 1] }),
      ...(valuesComplete ? { values: unique } : {}),
      ...(strings.length > 0 && tokensComplete ? { tokens } : {}),
      complete: valuesComplete && (strings.length === 0 || tokensComplete),
    };
  }
  return output;
}

function sourceSpans(rows: readonly PendingRow[]): readonly KeelFrozenDatasetSourceSpan[] {
  const spans: KeelFrozenDatasetSourceSpan[] = [];
  for (const row of rows) {
    const prior = spans[spans.length - 1];
    if (
      prior !== undefined && prior.batch === row.batch && prior.rowOffset + prior.rowCount === row.rowOffset &&
      prior.page === row.page && prior.cursorInDigest === row.cursorInDigest && prior.cursorOutDigest === row.cursorOutDigest
    ) {
      spans[spans.length - 1] = { ...prior, rowCount: prior.rowCount + 1 };
    } else {
      spans.push({
        batch: row.batch,
        rowOffset: row.rowOffset,
        rowCount: 1,
        ...(row.page === undefined ? {} : { page: row.page }),
        ...(row.cursorInDigest === undefined ? {} : { cursorInDigest: row.cursorInDigest }),
        ...(row.cursorOutDigest === undefined ? {} : { cursorOutDigest: row.cursorOutDigest }),
      });
    }
  }
  return spans;
}

async function cursorDigest(value: string | undefined): Promise<Hex | undefined> {
  return value === undefined ? undefined : sha256Hex(utf8ToBytes(value));
}

/**
 * Stream page/cursor batches into immutable, independently verifiable chunks.
 * Source cursors describe lineage only; querying always operates on full rows.
 */
export async function buildKeelFrozenDataset(input: BuildKeelFrozenDatasetInput): Promise<BuiltKeelFrozenDataset> {
  if (input.datasetId.length === 0 || input.datasetId.length > 2048) throw new TypeError("datasetId is required.");
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new RangeError("revision must be a positive safe integer.");
  if (input.parentRevision !== undefined && (!Number.isSafeInteger(input.parentRevision) || input.parentRevision < 0 || input.parentRevision >= input.revision)) {
    throw new RangeError("parentRevision must be a safe integer before revision.");
  }
  const targetRows = positiveInteger(input.targetRows, DEFAULT_TARGET_ROWS, "targetRows");
  const targetBytes = positiveInteger(input.targetBytes, DEFAULT_TARGET_BYTES, "targetBytes");
  const maxFields = positiveInteger(input.maxDiscoveredFields, DEFAULT_MAX_FIELDS, "maxDiscoveredFields");
  const maxValues = positiveInteger(input.maxIndexValues, DEFAULT_MAX_INDEX_VALUES, "maxIndexValues");
  const maxTokens = positiveInteger(input.maxIndexTokens, DEFAULT_MAX_INDEX_TOKENS, "maxIndexTokens");
  const chunks: BuiltKeelFrozenDatasetChunk[] = [];
  const fieldTypes = new Map<string, KeelDatasetFieldType>();
  let pending: PendingRow[] = [];
  let rowStart = 0;
  let sawPage = false;
  let sawCursor = false;

  const closeChunk = async (): Promise<void> => {
    if (pending.length === 0) return;
    const ordinal = chunks.length;
    const values = pending.map((row) => row.value);
    const chunk: KeelFrozenDatasetChunk = {
      protocol: KEEL_FROZEN_DATASET_CHUNK_PROTOCOL,
      datasetId: input.datasetId,
      revision: input.revision,
      ordinal,
      rows: values,
    };
    const bytes = utf8ToBytes(canonicalJson(chunk));
    const checkedIntegrity = await createIntegrity(bytes, "sha256");
    const contentHash = checkedIntegrity.digest;
    const descriptor: KeelFrozenDatasetChunkDescriptor = {
      ordinal,
      contentHash,
      integrity: checkedIntegrity,
      rowStart,
      rowCount: values.length,
      sourceSpans: sourceSpans(pending),
      indexes: buildIndexes(values, fieldTypes, maxFields, maxValues, maxTokens),
      ...(input.locations === undefined ? {} : { locations: input.locations(contentHash, ordinal) }),
    };
    chunks.push({ descriptor, value: chunk, bytes });
    rowStart += values.length;
    pending = [];
  };

  let batchOrdinal = 0;
  for await (const batch of input.batches) {
    if (!Array.isArray(batch.rows)) throw new TypeError(`Batch ${batchOrdinal} rows must be an array.`);
    if (batch.page !== undefined && (!Number.isSafeInteger(batch.page) || batch.page < 0)) throw new RangeError(`Batch ${batchOrdinal} page is invalid.`);
    sawPage ||= batch.page !== undefined;
    sawCursor ||= batch.cursorIn !== undefined || batch.cursorOut !== undefined;
    const cursorInDigest = await cursorDigest(batch.cursorIn);
    const cursorOutDigest = await cursorDigest(batch.cursorOut);
    for (let rowOffset = 0; rowOffset < batch.rows.length; rowOffset += 1) {
      const value = canonicalize(batch.rows[rowOffset]);
      const candidate: PendingRow = {
        value,
        batch: batchOrdinal,
        rowOffset,
        ...(batch.page === undefined ? {} : { page: batch.page }),
        ...(cursorInDigest === undefined ? {} : { cursorInDigest }),
        ...(cursorOutDigest === undefined ? {} : { cursorOutDigest }),
      };
      if (pending.length > 0) {
        const candidateBytes = utf8ToBytes(canonicalJson({
          protocol: KEEL_FROZEN_DATASET_CHUNK_PROTOCOL,
          datasetId: input.datasetId,
          revision: input.revision,
          ordinal: chunks.length,
          rows: [...pending.map((row) => row.value), value],
        })).byteLength;
        if (pending.length >= targetRows || candidateBytes > targetBytes) await closeChunk();
      }
      pending.push(candidate);
    }
    batchOrdinal += 1;
  }
  await closeChunk();

  const fields: KeelFrozenDatasetField[] = [...fieldTypes.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en-US"))
    .map(([path, type]) => ({ path, type }));
  const detectedPagination: KeelDatasetSourcePagination = sawPage && sawCursor ? "mixed" : sawPage ? "page" : sawCursor ? "cursor" : "none";
  const manifest: KeelFrozenDatasetManifest = {
    protocol: KEEL_FROZEN_DATASET_PROTOCOL,
    datasetId: input.datasetId,
    revision: input.revision,
    ...(input.parentRevision === undefined ? {} : { parentRevision: input.parentRevision }),
    frozen: true,
    source: {
      visibility: input.visibility ?? "closed",
      pagination: input.pagination ?? detectedPagination,
      ...(input.sourceManifestDigest === undefined ? {} : { sourceManifestDigest: input.sourceManifestDigest }),
    },
    format: "canonical-json-rows",
    rowCount: rowStart,
    fields,
    chunks: chunks.map((chunk) => chunk.descriptor),
  };
  const manifestBytes = utf8ToBytes(canonicalJson(manifest));
  return { manifest, chunks, manifestBytes, manifestIntegrity: await createIntegrity(manifestBytes, "sha256") };
}
