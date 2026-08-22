import type { CanonicalValue } from "./canonical.js";
import type { Hex, Integrity } from "./types.js";

export const KEEL_FROZEN_DATASET_PROTOCOL = "keel-frozen-dataset@1" as const;
export const KEEL_FROZEN_DATASET_CHUNK_PROTOCOL = "keel-frozen-dataset-chunk@1" as const;

export type KeelDatasetScalar = null | boolean | number | string;
export type KeelDatasetFieldType = "null" | "boolean" | "number" | "string" | "mixed";
export type KeelDatasetSourcePagination = "page" | "cursor" | "mixed" | "none";

export interface KeelFrozenDatasetField {
  readonly path: string;
  readonly type: KeelDatasetFieldType;
}

/** A safe-to-prune summary. `complete` means no distinct value/token was omitted. */
export interface KeelFrozenDatasetChunkIndex {
  readonly type: KeelDatasetFieldType;
  readonly min?: KeelDatasetScalar;
  readonly max?: KeelDatasetScalar;
  readonly values?: readonly KeelDatasetScalar[];
  readonly tokens?: readonly string[];
  readonly complete?: boolean;
}

/** Pagination metadata is provenance only. Raw cursors are never required in a public manifest. */
export interface KeelFrozenDatasetSourceSpan {
  readonly batch: number;
  readonly rowOffset: number;
  readonly rowCount: number;
  readonly page?: number;
  readonly cursorInDigest?: Hex;
  readonly cursorOutDigest?: Hex;
}

export interface KeelFrozenDatasetChunkDescriptor {
  readonly ordinal: number;
  readonly contentHash: Hex;
  readonly integrity: Integrity;
  readonly rowStart: number;
  readonly rowCount: number;
  readonly sourceSpans: readonly KeelFrozenDatasetSourceSpan[];
  readonly indexes?: Readonly<Record<string, KeelFrozenDatasetChunkIndex>>;
  /** Immutable mirrors or Keel object routes. Consumers still verify `integrity`. */
  readonly locations?: readonly string[];
}

export interface KeelFrozenDatasetManifest {
  readonly protocol: typeof KEEL_FROZEN_DATASET_PROTOCOL;
  readonly datasetId: string;
  readonly revision: number;
  readonly parentRevision?: number;
  readonly frozen: true;
  readonly source: {
    readonly visibility: "closed" | "public";
    readonly pagination: KeelDatasetSourcePagination;
    readonly sourceManifestDigest?: Hex;
  };
  readonly format: "canonical-json-rows";
  readonly rowCount: number;
  readonly fields: readonly KeelFrozenDatasetField[];
  readonly chunks: readonly KeelFrozenDatasetChunkDescriptor[];
}

export interface KeelFrozenDatasetChunk {
  readonly protocol: typeof KEEL_FROZEN_DATASET_CHUNK_PROTOCOL;
  readonly datasetId: string;
  readonly revision: number;
  readonly ordinal: number;
  readonly rows: readonly CanonicalValue[];
}

const HEX32 = /^0x[0-9a-f]{64}$/u;

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) throw new TypeError(`${label} must be non-empty text.`);
  return value;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new TypeError(`${label} must be a safe integer >= ${minimum}.`);
  return value as number;
}

function hex32(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !HEX32.test(value)) throw new TypeError(`${label} must be lower-case SHA-256 bytes32 hex.`);
  return value as Hex;
}

function scalar(value: unknown, label: string): KeelDatasetScalar {
  if (value === null || typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) return value;
  throw new TypeError(`${label} must be a JSON scalar.`);
}

function fieldType(value: unknown, label: string): KeelDatasetFieldType {
  if (value === "null" || value === "boolean" || value === "number" || value === "string" || value === "mixed") return value;
  throw new TypeError(`${label} has an unsupported field type.`);
}

function integrity(value: unknown, label: string): Integrity {
  const data = record(value, label);
  if (data.algorithm !== "sha256") throw new TypeError(`${label}.algorithm must be sha256.`);
  const digest = hex32(data.digest, `${label}.digest`);
  const byteLength = integer(data.byteLength, `${label}.byteLength`);
  return { algorithm: "sha256", digest, byteLength };
}

function chunkIndex(value: unknown, label: string): KeelFrozenDatasetChunkIndex {
  const data = record(value, label);
  const type = fieldType(data.type, `${label}.type`);
  const values = data.values === undefined ? undefined : (data.values as unknown[]).map((item, index) => scalar(item, `${label}.values[${index}]`));
  const tokens = data.tokens === undefined ? undefined : (data.tokens as unknown[]).map((item, index) => text(item, `${label}.tokens[${index}]`));
  if (data.values !== undefined && !Array.isArray(data.values)) throw new TypeError(`${label}.values must be an array.`);
  if (data.tokens !== undefined && !Array.isArray(data.tokens)) throw new TypeError(`${label}.tokens must be an array.`);
  if (data.complete !== undefined && typeof data.complete !== "boolean") throw new TypeError(`${label}.complete must be boolean.`);
  return {
    type,
    ...(data.min === undefined ? {} : { min: scalar(data.min, `${label}.min`) }),
    ...(data.max === undefined ? {} : { max: scalar(data.max, `${label}.max`) }),
    ...(values === undefined ? {} : { values }),
    ...(tokens === undefined ? {} : { tokens }),
    ...(data.complete === undefined ? {} : { complete: data.complete }),
  };
}

/** Strictly parse the portable frozen-dataset contract before any chunk is fetched. */
export function parseKeelFrozenDatasetManifest(value: unknown): KeelFrozenDatasetManifest {
  const data = record(value, "dataset manifest");
  if (data.protocol !== KEEL_FROZEN_DATASET_PROTOCOL) throw new TypeError(`Expected ${KEEL_FROZEN_DATASET_PROTOCOL}.`);
  if (data.frozen !== true || data.format !== "canonical-json-rows") throw new TypeError("Dataset must be frozen canonical JSON rows.");
  const datasetId = text(data.datasetId, "datasetId");
  const revision = integer(data.revision, "revision", 1);
  const parentRevision = data.parentRevision === undefined ? undefined : integer(data.parentRevision, "parentRevision");
  if (parentRevision !== undefined && parentRevision >= revision) throw new TypeError("parentRevision must precede revision.");
  const source = record(data.source, "source");
  if (source.visibility !== "closed" && source.visibility !== "public") throw new TypeError("source.visibility must be closed or public.");
  if (source.pagination !== "page" && source.pagination !== "cursor" && source.pagination !== "mixed" && source.pagination !== "none") {
    throw new TypeError("source.pagination is invalid.");
  }
  if (!Array.isArray(data.fields) || !Array.isArray(data.chunks)) throw new TypeError("Dataset fields and chunks must be arrays.");
  const fields = data.fields.map((item, index) => {
    const entry = record(item, `fields[${index}]`);
    return { path: text(entry.path, `fields[${index}].path`), type: fieldType(entry.type, `fields[${index}].type`) };
  });
  if (new Set(fields.map((item) => item.path)).size !== fields.length) throw new TypeError("Dataset field paths must be unique.");
  const chunks = data.chunks.map((item, index): KeelFrozenDatasetChunkDescriptor => {
    const entry = record(item, `chunks[${index}]`);
    const ordinal = integer(entry.ordinal, `chunks[${index}].ordinal`);
    if (ordinal !== index) throw new TypeError("Dataset chunk ordinals must be contiguous and ordered.");
    const contentHash = hex32(entry.contentHash, `chunks[${index}].contentHash`);
    const checkedIntegrity = integrity(entry.integrity, `chunks[${index}].integrity`);
    if (contentHash !== checkedIntegrity.digest) throw new TypeError("Chunk contentHash must equal its SHA-256 integrity digest.");
    if (!Array.isArray(entry.sourceSpans)) throw new TypeError(`chunks[${index}].sourceSpans must be an array.`);
    const sourceSpans = entry.sourceSpans.map((span, spanIndex) => {
      const sourceSpan = record(span, `chunks[${index}].sourceSpans[${spanIndex}]`);
      return {
        batch: integer(sourceSpan.batch, "source span batch"),
        rowOffset: integer(sourceSpan.rowOffset, "source span rowOffset"),
        rowCount: integer(sourceSpan.rowCount, "source span rowCount", 1),
        ...(sourceSpan.page === undefined ? {} : { page: integer(sourceSpan.page, "source span page") }),
        ...(sourceSpan.cursorInDigest === undefined ? {} : { cursorInDigest: hex32(sourceSpan.cursorInDigest, "source span cursorInDigest") }),
        ...(sourceSpan.cursorOutDigest === undefined ? {} : { cursorOutDigest: hex32(sourceSpan.cursorOutDigest, "source span cursorOutDigest") }),
      };
    });
    const indexes = entry.indexes === undefined ? undefined : Object.fromEntries(
      Object.entries(record(entry.indexes, `chunks[${index}].indexes`)).map(([path, summary]) => [path, chunkIndex(summary, `chunks[${index}].indexes.${path}`)]),
    );
    const locations = entry.locations === undefined ? undefined : (entry.locations as unknown[]).map((location, locationIndex) => text(location, `chunks[${index}].locations[${locationIndex}]`));
    if (entry.locations !== undefined && !Array.isArray(entry.locations)) throw new TypeError(`chunks[${index}].locations must be an array.`);
    return {
      ordinal,
      contentHash,
      integrity: checkedIntegrity,
      rowStart: integer(entry.rowStart, `chunks[${index}].rowStart`),
      rowCount: integer(entry.rowCount, `chunks[${index}].rowCount`, 1),
      sourceSpans,
      ...(indexes === undefined ? {} : { indexes }),
      ...(locations === undefined ? {} : { locations }),
    };
  });
  let expectedRowStart = 0;
  for (const chunk of chunks) {
    if (chunk.rowStart !== expectedRowStart) throw new TypeError("Dataset chunk row ranges must be contiguous and ordered.");
    expectedRowStart += chunk.rowCount;
  }
  const rowCount = integer(data.rowCount, "rowCount");
  if (expectedRowStart !== rowCount) throw new TypeError("Dataset rowCount does not equal its chunk row ranges.");
  return {
    protocol: KEEL_FROZEN_DATASET_PROTOCOL,
    datasetId,
    revision,
    ...(parentRevision === undefined ? {} : { parentRevision }),
    frozen: true,
    source: {
      visibility: source.visibility,
      pagination: source.pagination,
      ...(source.sourceManifestDigest === undefined ? {} : { sourceManifestDigest: hex32(source.sourceManifestDigest, "source.sourceManifestDigest") }),
    },
    format: "canonical-json-rows",
    rowCount,
    fields,
    chunks,
  };
}
