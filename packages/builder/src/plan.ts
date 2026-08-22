import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  KEEL_MAX_OBJECT_CHILDREN,
  KEEL_OBJECT_INDEX_ENCODING,
  chunkBytes,
  createIntegrity,
  type Compression,
} from "@keel/protocol";
import { chooseSmallestCompression, compressBytes } from "./compress.js";
import type { ObjectUploadPlan } from "./types.js";

export interface CreateUploadPlanOptions {
  readonly objectName: string;
  readonly mediaType: string;
  readonly outputDirectory: string;
  readonly compression?: Compression | "auto";
  readonly maxChunkBytes?: number;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive safe integer.`);
  return value;
}

export async function createUploadPlan(
  sourceBytes: Uint8Array,
  options: CreateUploadPlanOptions,
): Promise<ObjectUploadPlan> {
  if (sourceBytes.byteLength === 0) throw new RangeError("Object source cannot be empty.");
  const maxChunkBytes = positiveSafeInteger(options.maxChunkBytes ?? 23_000, "maxChunkBytes");
  if (maxChunkBytes > 23_000) throw new RangeError("maxChunkBytes cannot exceed the KeelHold limit of 23000.");

  const selected =
    options.compression === undefined || options.compression === "auto"
      ? await chooseSmallestCompression(sourceBytes)
      : { compression: options.compression, bytes: await compressBytes(options.compression, sourceBytes) };
  const chunks = chunkBytes(selected.bytes, maxChunkBytes);
  if (chunks.length > KEEL_MAX_OBJECT_CHILDREN) {
    throw new RangeError(
      `Flat object needs ${chunks.length} chunks, above the ${KEEL_MAX_OBJECT_CHILDREN}-child object limit. Use createRecursiveUploadPlan().`,
    );
  }

  const outputDirectory = path.resolve(options.outputDirectory);
  const chunkDirectory = path.join(outputDirectory, "chunks");
  await mkdir(chunkDirectory, { recursive: true });
  const plannedChunks = [];

  for (const chunk of chunks) {
    const file = `chunks/${String(chunk.index).padStart(5, "0")}.bin`;
    await writeFile(path.join(outputDirectory, file), chunk.bytes);
    plannedChunks.push({
      index: chunk.index,
      offset: chunk.offset,
      byteLength: chunk.length,
      integrity: await createIntegrity(chunk.bytes),
      file,
    });
  }

  const plan: ObjectUploadPlan = {
    schema: "oca-upload-plan@2",
    indexEncoding: KEEL_OBJECT_INDEX_ENCODING,
    objectName: options.objectName,
    mediaType: options.mediaType,
    originalByteLength: sourceBytes.byteLength,
    storedByteLength: selected.bytes.byteLength,
    compression: selected.compression,
    integrity: await createIntegrity(sourceBytes),
    maxChildren: KEEL_MAX_OBJECT_CHILDREN,
    chunks: plannedChunks,
  };
  await writeFile(path.join(outputDirectory, "upload-plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  return plan;
}
