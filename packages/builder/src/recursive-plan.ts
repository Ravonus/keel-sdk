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
import type {
  RecursiveCompositeObjectPlan,
  RecursiveLeafObjectPlan,
  RecursiveObjectPlan,
  RecursiveUploadPlan,
  StoredChunkPlan,
} from "./types.js";

export interface CreateRecursiveUploadPlanOptions {
  readonly objectName: string;
  readonly mediaType: string;
  readonly outputDirectory: string;
  readonly compression?: Compression | "auto";
  readonly maxChunkBytes?: number;
  readonly leafDecodedBytes?: number;
  readonly maxPartsPerComposite?: number;
}

interface PlannedRange {
  readonly id: string;
  readonly byteOffset: number;
  readonly byteLength: number;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive safe integer.`);
  return value;
}

export async function createRecursiveUploadPlan(
  sourceBytes: Uint8Array,
  options: CreateRecursiveUploadPlanOptions,
): Promise<RecursiveUploadPlan> {
  if (sourceBytes.byteLength === 0) throw new RangeError("Recursive object source cannot be empty.");
  const maxChunkBytes = positiveSafeInteger(options.maxChunkBytes ?? 23_000, "maxChunkBytes");
  if (maxChunkBytes > 23_000) throw new RangeError("maxChunkBytes cannot exceed the KeelHold limit of 23000.");
  const leafDecodedBytes = positiveSafeInteger(options.leafDecodedBytes ?? 512 * 1024, "leafDecodedBytes");
  const maxPartsPerComposite = positiveSafeInteger(options.maxPartsPerComposite ?? 64, "maxPartsPerComposite");
  if (maxPartsPerComposite < 2 || maxPartsPerComposite > KEEL_MAX_OBJECT_CHILDREN) {
    throw new RangeError(`maxPartsPerComposite must be from 2 through ${KEEL_MAX_OBJECT_CHILDREN}.`);
  }
  if (leafDecodedBytes > maxChunkBytes * KEEL_MAX_OBJECT_CHILDREN) {
    throw new RangeError(
      `leafDecodedBytes must fit within ${KEEL_MAX_OBJECT_CHILDREN} chunks (${maxChunkBytes * KEEL_MAX_OBJECT_CHILDREN} bytes at the current chunk size).`,
    );
  }

  const outputDirectory = path.resolve(options.outputDirectory);
  await mkdir(outputDirectory, { recursive: true });
  const objects: RecursiveObjectPlan[] = [];
  let currentLevel: PlannedRange[] = [];

  for (let offset = 0, leafIndex = 0; offset < sourceBytes.byteLength; offset += leafDecodedBytes, leafIndex += 1) {
    const decoded = sourceBytes.slice(offset, Math.min(offset + leafDecodedBytes, sourceBytes.byteLength));
    const selected =
      options.compression === undefined || options.compression === "auto"
        ? await chooseSmallestCompression(decoded)
        : { compression: options.compression, bytes: await compressBytes(options.compression, decoded) };
    const id = `leaf-${String(leafIndex).padStart(5, "0")}`;
    const leafDirectory = path.join(outputDirectory, "objects", id);
    await mkdir(path.join(leafDirectory, "chunks"), { recursive: true });
    const chunks: StoredChunkPlan[] = [];
    const byteChunks = chunkBytes(selected.bytes, maxChunkBytes);
    if (byteChunks.length > KEEL_MAX_OBJECT_CHILDREN) {
      throw new RangeError(
        `Leaf ${id} expands to ${byteChunks.length} stored chunks. Lower leafDecodedBytes or use automatic compression.`,
      );
    }

    for (const chunk of byteChunks) {
      const relativeFile = path.join("objects", id, "chunks", `${String(chunk.index).padStart(5, "0")}.bin`);
      await writeFile(path.join(outputDirectory, relativeFile), chunk.bytes);
      chunks.push({
        index: chunk.index,
        offset: chunk.offset,
        byteLength: chunk.length,
        integrity: await createIntegrity(chunk.bytes),
        file: relativeFile.replaceAll("\\", "/"),
      });
    }

    const leaf: RecursiveLeafObjectPlan = {
      id,
      kind: "leaf",
      level: 0,
      byteOffset: offset,
      byteLength: decoded.byteLength,
      storedByteLength: selected.bytes.byteLength,
      mediaType: options.mediaType,
      compression: selected.compression,
      integrity: await createIntegrity(decoded),
      chunks,
    };
    objects.push(leaf);
    currentLevel.push({ id, byteOffset: offset, byteLength: decoded.byteLength });
  }

  let treeDepth = 0;
  while (currentLevel.length > 1) {
    const nextLevel: PlannedRange[] = [];
    const nodeLevel = treeDepth + 1;
    for (let offset = 0, group = 0; offset < currentLevel.length; offset += maxPartsPerComposite, group += 1) {
      const parts = currentLevel.slice(offset, offset + maxPartsPerComposite);
      const first = parts[0];
      const last = parts[parts.length - 1];
      if (first === undefined || last === undefined) throw new Error("Internal recursive planner range error.");
      const byteOffset = first.byteOffset;
      const byteLength = last.byteOffset + last.byteLength - byteOffset;
      const id = `node-${String(nodeLevel).padStart(3, "0")}-${String(group).padStart(5, "0")}`;
      const composite: RecursiveCompositeObjectPlan = {
        id,
        kind: "composite",
        level: nodeLevel,
        byteOffset,
        byteLength,
        mediaType: options.mediaType,
        integrity: await createIntegrity(sourceBytes.slice(byteOffset, byteOffset + byteLength)),
        parts: parts.map((part) => part.id),
      };
      objects.push(composite);
      nextLevel.push({ id, byteOffset, byteLength });
    }
    currentLevel = nextLevel;
    treeDepth = nodeLevel;
  }

  const root = currentLevel[0];
  if (root === undefined) throw new Error("Recursive upload plan did not produce a root object.");
  const plan: RecursiveUploadPlan = {
    schema: "keel-recursive-upload-plan@2",
    indexEncoding: KEEL_OBJECT_INDEX_ENCODING,
    objectName: options.objectName,
    mediaType: options.mediaType,
    byteLength: sourceBytes.byteLength,
    integrity: await createIntegrity(sourceBytes),
    root: root.id,
    treeDepth,
    leafDecodedBytes,
    maxChunkBytes,
    maxPartsPerComposite,
    maxChildren: KEEL_MAX_OBJECT_CHILDREN,
    objects,
  };
  await writeFile(path.join(outputDirectory, "recursive-upload-plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  return plan;
}
