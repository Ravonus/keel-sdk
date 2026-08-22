import { verifyIntegrity, type Hex, type Integrity } from "@keel/protocol";
import { decompressBytes } from "@keel/builder";
import path from "node:path";
import type { Workspace } from "./types.js";

const MAX_PLAN_BYTES = 4 * 1024 * 1024;
const MAX_CONTENT_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_DECODED_BYTES = 256 * 1024 * 1024;
const MAX_SLUG_BYTES = 23_000;
const MAX_OBJECTS = 512;
const MAX_OPERATIONS = 16_384;
const MAX_DESCRIPTOR_RESPONSE_BYTES = 256 * 1024;

type Family = "ethereum" | "tezos";
type Compression = "none" | "gzip" | "deflate" | "brotli";

interface Chunk {
  readonly index: number;
  readonly offset: number;
  readonly byteLength: number;
  readonly integrity: Integrity;
  readonly file: string;
  readonly bytes: Uint8Array;
}

interface FlatPlan {
  readonly schema: "keel-upload-plan@2";
  readonly objectName: string;
  readonly mediaType: string;
  readonly originalByteLength: number;
  readonly storedByteLength: number;
  readonly compression: Compression;
  readonly integrity: Integrity;
  readonly maxChildren: number;
  readonly chunks: readonly Chunk[];
}

interface Leaf {
  readonly id: string;
  readonly kind: "leaf";
  readonly level: 0;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly storedByteLength: number;
  readonly mediaType: string;
  readonly compression: Compression;
  readonly integrity: Integrity;
  readonly chunks: readonly Chunk[];
  readonly decoded: Uint8Array;
}

interface Composite {
  readonly id: string;
  readonly kind: "composite";
  readonly level: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly integrity: Integrity;
  readonly parts: readonly string[];
}

interface RecursivePlan {
  readonly schema: "keel-recursive-upload-plan@2";
  readonly objectName: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly integrity: Integrity;
  readonly root: string;
  readonly treeDepth: number;
  readonly maxChildren: number;
  readonly objects: readonly (Leaf | Composite)[];
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const fields = new Set(allowed);
  for (const key of Object.keys(value)) if (!fields.has(key)) throw new TypeError(`${label}.${key} is not supported.`);
}

function text(value: unknown, label: string, max = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f\\]/u.test(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}

function objectName(value: unknown, label: string): string {
  const name = text(value, label, 128);
  if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) throw new TypeError(`${label} must be a metadata-safe name.`);
  return name;
}

function mediaType(value: unknown, label: string): string {
  const result = text(value, label, 128);
  if (new TextEncoder().encode(result).byteLength > 128) throw new TypeError(`${label} must be printable UTF-8 text no larger than 128 bytes.`);
  return result;
}

function positive(value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > max) throw new RangeError(`${label} must be a positive safe integer.`);
  return value;
}

function nonNegative(value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) throw new RangeError(`${label} must be a non-negative safe integer.`);
  return value;
}

function integrity(value: unknown, label: string): Integrity {
  const input = object(value, label);
  exact(input, ["algorithm", "digest", "byteLength"], label);
  if (input.algorithm !== "sha256" || typeof input.digest !== "string" || !/^0x[0-9a-f]{64}$/u.test(input.digest)) throw new TypeError(`${label} must be lower-case SHA-256.`);
  return { algorithm: "sha256", digest: input.digest as Hex, byteLength: positive(input.byteLength, `${label}.byteLength`) };
}

function compression(value: unknown, label: string): Compression {
  if (value !== "none" && value !== "gzip" && value !== "deflate" && value !== "brotli") throw new TypeError(`${label} is unsupported.`);
  return value;
}

function concatenate(chunks: readonly Uint8Array[], label: string): Uint8Array {
  const length = chunks.reduce((total, value) => total + value.byteLength, 0);
  if (!Number.isSafeInteger(length) || length > MAX_CONTENT_BYTES) throw new RangeError(`${label} exceeds the ${MAX_CONTENT_BYTES}-byte content cap.`);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function decodeChunks(chunks: readonly Chunk[], selectedCompression: Compression, label: string): Promise<Uint8Array> {
  const stored = concatenate(chunks.map((chunk) => chunk.bytes), `${label} stored bytes`);
  try {
    const decoded = await decompressBytes(selectedCompression, stored);
    if (decoded.byteLength > MAX_CONTENT_BYTES) throw new RangeError(`${label} decoded bytes exceed the ${MAX_CONTENT_BYTES}-byte content cap.`);
    return decoded;
  } catch (error) {
    throw new Error(`${label} cannot be decoded: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function assertCommittedBytes(bytes: Uint8Array, committed: Integrity, expectedLength: number, label: string): Promise<void> {
  if (bytes.byteLength !== expectedLength || committed.byteLength !== expectedLength || !await verifyIntegrity(bytes, committed)) {
    throw new Error(`${label} decoded bytes do not match the committed integrity and length.`);
  }
}

function planFilePath(planDirectory: string, file: string): string {
  return planDirectory === "." ? file : `${planDirectory}/${file}`;
}

async function chunk(workspace: Workspace, planDirectory: string, value: unknown, label: string): Promise<Chunk> {
  const input = object(value, label);
  exact(input, ["index", "offset", "byteLength", "integrity", "file"], label);
  const index = nonNegative(input.index, `${label}.index`, 1_000_000);
  const offset = nonNegative(input.offset, `${label}.offset`, Number.MAX_SAFE_INTEGER);
  const byteLength = positive(input.byteLength, `${label}.byteLength`, MAX_SLUG_BYTES);
  const file = text(input.file, `${label}.file`, 512);
  if (file.startsWith("/") || file.split("/").some((part) => part === "." || part === "..")) throw new TypeError(`${label}.file must be a safe relative path.`);
  const committed = integrity(input.integrity, `${label}.integrity`);
  if (committed.byteLength !== byteLength) throw new TypeError(`${label}.integrity.byteLength does not match the chunk byteLength.`);
  const loaded = await workspace.readFile(planFilePath(planDirectory, file), MAX_SLUG_BYTES);
  if (loaded.bytes.byteLength !== byteLength || !await verifyIntegrity(loaded.bytes, committed)) throw new Error(`${label}.file does not match its committed chunk integrity.`);
  return { index, offset, byteLength, integrity: committed, file, bytes: loaded.bytes };
}

function operationTarget(input: Record<string, unknown>): { readonly family: Family; readonly target: string; readonly network: number | string } {
  const family = input.family;
  if (family === "ethereum") {
    const chainId = positive(input.chainId, "chainId");
    if (typeof input.target !== "string" || !/^0x[0-9a-fA-F]{40}$/u.test(input.target)) throw new TypeError("Ethereum target must be a 20-byte address.");
    return { family, target: input.target.toLowerCase(), network: chainId };
  }
  if (family === "tezos") {
    const network = text(input.network, "network", 64);
    if (typeof input.target !== "string" || !/^(?:tz[1-3]|KT1)[1-9A-HJ-NP-Za-km-z]{33}$/u.test(input.target)) throw new TypeError("Tezos target must be a tz or KT1 address.");
    return { family, target: input.target, network };
  }
  throw new TypeError("family must be ethereum or tezos.");
}

function chunkGroups(chunks: readonly Chunk[]): readonly Chunk[][] {
  const groups: Chunk[][] = [];
  for (let index = 0; index < chunks.length; index += 3) groups.push([...chunks.slice(index, index + 3)]);
  return groups;
}

function putOperations(chunks: readonly Chunk[]): readonly Record<string, unknown>[] {
  return chunkGroups(chunks).map((group) => ({
    kind: "castSlugs",
    function: "castSlugs(bytes[])",
    payloadEncoding: "raw-bytes-from-files",
    chunkFiles: group.map((chunk) => chunk.file),
    chunkByteLengths: group.map((chunk) => chunk.byteLength),
    chunkIntegrities: group.map((chunk) => chunk.integrity),
    slugIds: "derived-keccak256-after-review",
  }));
}

function flatOperations(plan: FlatPlan): readonly Record<string, unknown>[] {
  return [
    ...putOperations(plan.chunks),
    {
      kind: "weldObject",
      function: "weldObject(bytes32[],bytes32,uint64,uint8,string)",
      slugIds: "from-preceding-castSlugs",
      digest: plan.integrity,
      byteLength: plan.originalByteLength,
      compression: plan.compression,
      mediaType: plan.mediaType,
    },
  ];
}

function recursiveOperations(plan: RecursivePlan): readonly Record<string, unknown>[] {
  const operations: Record<string, unknown>[] = [];
  const leaves = plan.objects.filter((item): item is Leaf => item.kind === "leaf").sort((left, right) => left.id < right.id ? -1 : 1);
  for (const leaf of leaves) {
    operations.push(...putOperations(leaf.chunks));
    operations.push({ kind: "weldObject", function: "weldObject(bytes32[],bytes32,uint64,uint8,string)", objectId: leaf.id, slugIds: "from-preceding-castSlugs", digest: leaf.integrity, byteLength: leaf.byteLength, compression: leaf.compression, mediaType: leaf.mediaType });
  }
  const composites = plan.objects.filter((item): item is Composite => item.kind === "composite").sort((left, right) => left.level - right.level || (left.id < right.id ? -1 : 1));
  for (const composite of composites) operations.push({ kind: "weldComposite", function: "weldComposite(bytes32[],bytes32,uint64,string)", objectId: composite.id, partObjectIds: composite.parts, digest: composite.integrity, byteLength: composite.byteLength, mediaType: composite.mediaType });
  return operations;
}

async function validatePlan(workspace: Workspace, planDirectory: string, value: unknown): Promise<FlatPlan | RecursivePlan> {
  const plan = object(value, "upload plan");
  const schema = plan.schema;
  if (schema === "keel-upload-plan@2") {
    exact(plan, ["schema", "indexEncoding", "objectName", "mediaType", "originalByteLength", "storedByteLength", "compression", "integrity", "maxChildren", "chunks"], "upload plan");
    if (plan.indexEncoding !== "keel-object-index@1" || plan.maxChildren !== 128) throw new TypeError("upload plan limits are unsupported.");
    const chunksValue = plan.chunks;
    if (!Array.isArray(chunksValue) || chunksValue.length === 0 || chunksValue.length > 128) throw new RangeError("flat upload plan chunks must contain 1 through 128 entries.");
    const chunks: Chunk[] = [];
    for (let index = 0; index < chunksValue.length; index += 1) chunks.push(await chunk(workspace, planDirectory, chunksValue[index], `upload plan.chunks[${index}]`));
    if (chunks.some((item, index) => item.index !== index)) throw new TypeError("upload plan chunks must be ordered and contiguous.");
    const storedByteLength = chunks.reduce((total, item) => total + item.byteLength, 0);
    if (storedByteLength !== plan.storedByteLength || chunks.some((item, index) => item.offset !== chunks.slice(0, index).reduce((total, current) => total + current.byteLength, 0))) throw new TypeError("upload plan chunk offsets are not contiguous.");
    const originalByteLength = positive(plan.originalByteLength, "upload plan.originalByteLength", MAX_CONTENT_BYTES);
    const committed = integrity(plan.integrity, "upload plan.integrity");
    if (committed.byteLength !== originalByteLength) throw new TypeError("upload plan integrity length does not match originalByteLength.");
    const selectedCompression = compression(plan.compression, "upload plan.compression");
    const decoded = await decodeChunks(chunks, selectedCompression, "upload plan");
    await assertCommittedBytes(decoded, committed, originalByteLength, "upload plan");
    return { schema, objectName: objectName(plan.objectName, "upload plan.objectName"), mediaType: mediaType(plan.mediaType, "upload plan.mediaType"), originalByteLength, storedByteLength, compression: selectedCompression, integrity: committed, maxChildren: 128, chunks };
  }
  if (schema !== "keel-recursive-upload-plan@2") throw new TypeError("Unsupported upload plan schema.");
  exact(plan, ["schema", "indexEncoding", "objectName", "mediaType", "byteLength", "integrity", "root", "treeDepth", "leafDecodedBytes", "maxChunkBytes", "maxPartsPerComposite", "maxChildren", "objects"], "recursive upload plan");
  if (plan.indexEncoding !== "keel-object-index@1" || plan.maxChildren !== 128) throw new TypeError("recursive upload plan limits are unsupported.");
  if (!Array.isArray(plan.objects) || plan.objects.length === 0 || plan.objects.length > MAX_OBJECTS) throw new RangeError(`recursive upload plan objects must contain 1 through ${MAX_OBJECTS} entries.`);
  const objects: (Leaf | Composite)[] = [];
  let decodedBudget = 0;
  const reserveDecoded = (length: number, label: string): void => {
    if (!Number.isSafeInteger(length) || length < 0 || decodedBudget > MAX_TOTAL_DECODED_BYTES - length) throw new RangeError(`${label} exceeds the ${MAX_TOTAL_DECODED_BYTES}-byte decoded content budget.`);
    decodedBudget += length;
  };
  const ids = new Set<string>();
  for (const [index, value] of plan.objects.entries()) {
    const input = object(value, `recursive upload plan.objects[${index}]`);
    if (input.kind === "leaf") {
      exact(input, ["id", "kind", "level", "byteOffset", "byteLength", "storedByteLength", "mediaType", "compression", "integrity", "chunks"], `recursive leaf ${index}`);
      if (input.level !== 0) throw new TypeError(`recursive leaf ${index}.level must be zero.`);
      const chunksValue = input.chunks;
      if (!Array.isArray(chunksValue) || chunksValue.length === 0 || chunksValue.length > 128) throw new RangeError(`recursive leaf ${index} chunks are invalid.`);
      const chunks: Chunk[] = [];
      for (let chunkIndex = 0; chunkIndex < chunksValue.length; chunkIndex += 1) chunks.push(await chunk(workspace, planDirectory, chunksValue[chunkIndex], `recursive leaf ${index}.chunks[${chunkIndex}]`));
      const byteLength = positive(input.byteLength, `recursive leaf ${index}.byteLength`, MAX_CONTENT_BYTES);
      const storedByteLength = positive(input.storedByteLength, `recursive leaf ${index}.storedByteLength`, MAX_CONTENT_BYTES);
      if (chunks.reduce((total, item) => total + item.byteLength, 0) !== storedByteLength || chunks.some((item, chunkIndex) => item.offset !== chunks.slice(0, chunkIndex).reduce((total, current) => total + current.byteLength, 0))) throw new TypeError(`recursive leaf ${index} chunk lengths or offsets are invalid.`);
      const selectedCompression = compression(input.compression, `recursive leaf ${index}.compression`);
      const committed = integrity(input.integrity, `recursive leaf ${index}.integrity`);
      if (committed.byteLength !== byteLength) throw new TypeError(`recursive leaf ${index}.integrity.byteLength does not match byteLength.`);
      const decoded = await decodeChunks(chunks, selectedCompression, `recursive leaf ${index}`);
      await assertCommittedBytes(decoded, committed, byteLength, `recursive leaf ${index}`);
      reserveDecoded(decoded.byteLength, `recursive leaf ${index}`);
      const leaf: Leaf = { id: text(input.id, `recursive leaf ${index}.id`), kind: "leaf", level: 0, byteOffset: nonNegative(input.byteOffset, `recursive leaf ${index}.byteOffset`), byteLength, storedByteLength, mediaType: mediaType(input.mediaType, `recursive leaf ${index}.mediaType`), compression: selectedCompression, integrity: committed, chunks, decoded };
      if (ids.has(leaf.id)) throw new TypeError(`Duplicate recursive object ${leaf.id}.`);
      ids.add(leaf.id); objects.push(leaf);
    } else if (input.kind === "composite") {
      exact(input, ["id", "kind", "level", "byteOffset", "byteLength", "mediaType", "integrity", "parts"], `recursive composite ${index}`);
      if (!Array.isArray(input.parts) || input.parts.length < 1 || input.parts.length > 128) throw new RangeError(`recursive composite ${index}.parts is invalid.`);
      const composite: Composite = { id: text(input.id, `recursive composite ${index}.id`), kind: "composite", level: positive(input.level, `recursive composite ${index}.level`), byteOffset: nonNegative(input.byteOffset, `recursive composite ${index}.byteOffset`), byteLength: positive(input.byteLength, `recursive composite ${index}.byteLength`), mediaType: mediaType(input.mediaType, `recursive composite ${index}.mediaType`), integrity: integrity(input.integrity, `recursive composite ${index}.integrity`), parts: input.parts.map((part, partIndex) => text(part, `recursive composite ${index}.parts[${partIndex}]`)) };
      if (ids.has(composite.id)) throw new TypeError(`Duplicate recursive object ${composite.id}.`);
      ids.add(composite.id); objects.push(composite);
    } else throw new TypeError(`recursive upload plan.objects[${index}].kind is unsupported.`);
  }
  const root = text(plan.root, "recursive upload plan.root");
  if (!ids.has(root)) throw new TypeError("recursive upload plan.root is unknown.");
  const planMediaType = mediaType(plan.mediaType, "recursive upload plan.mediaType");
  const leafDecodedBytes = positive(plan.leafDecodedBytes, "recursive upload plan.leafDecodedBytes", MAX_CONTENT_BYTES);
  const maxChunkBytes = positive(plan.maxChunkBytes, "recursive upload plan.maxChunkBytes", MAX_SLUG_BYTES);
  const maxPartsPerComposite = positive(plan.maxPartsPerComposite, "recursive upload plan.maxPartsPerComposite", 128);
  if (maxPartsPerComposite < 2 || leafDecodedBytes > maxChunkBytes * 128) throw new RangeError("recursive upload plan leaf and composite limits are invalid.");
  const objectMap = new Map(objects.map((item) => [item.id, item] as const));
  let maxLevel = 0;
  for (const item of objects) {
    maxLevel = Math.max(maxLevel, item.level);
    if (item.mediaType !== planMediaType) throw new TypeError(`recursive object ${item.id} mediaType does not match the plan.`);
    if (item.kind === "composite") {
      const parts = new Set<string>();
      for (const part of item.parts) {
        if (parts.has(part)) throw new TypeError(`recursive composite ${item.id} repeats a part.`);
        parts.add(part);
        const child = objectMap.get(part);
        if (child === undefined || child.id === item.id || child.level >= item.level) throw new TypeError(`recursive composite ${item.id} has an invalid graph edge.`);
      }
    }
  }
  const treeDepth = nonNegative(plan.treeDepth, "recursive upload plan.treeDepth", 8);
  if (treeDepth !== maxLevel) throw new TypeError("recursive upload plan treeDepth does not match object levels.");
  const byteLength = positive(plan.byteLength, "recursive upload plan.byteLength", MAX_CONTENT_BYTES);
  const committed = integrity(plan.integrity, "recursive upload plan.integrity");
  if (committed.byteLength !== byteLength) throw new TypeError("recursive upload plan integrity length does not match byteLength.");
  const rootObject = objectMap.get(root);
  if (rootObject === undefined || rootObject.level !== treeDepth) throw new TypeError("recursive upload plan root level does not match treeDepth.");
  const resolved = new Map<string, Uint8Array>();
  const visiting = new Set<string>();
  const resolveObject = async (id: string): Promise<Uint8Array> => {
    const cached = resolved.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) throw new TypeError(`recursive upload plan contains a cycle at ${id}.`);
    const current = objectMap.get(id);
    if (current === undefined) throw new TypeError(`recursive upload plan references unknown object ${id}.`);
    visiting.add(id);
    let bytes: Uint8Array;
    if (current.kind === "leaf") {
      bytes = current.decoded;
    } else {
      const children = current.parts.map((part) => objectMap.get(part));
      if (children.some((child) => child === undefined)) throw new TypeError(`recursive composite ${current.id} references an unknown part.`);
      const childObjects = children as (Leaf | Composite)[];
      const childBytes: Uint8Array[] = [];
      let expectedOffset = current.byteOffset;
      for (const child of childObjects) {
        if (child.mediaType !== current.mediaType || child.byteOffset !== expectedOffset) throw new TypeError(`recursive composite ${current.id} has non-contiguous parts.`);
        childBytes.push(await resolveObject(child.id));
        expectedOffset += child.byteLength;
      }
      reserveDecoded(childBytes.reduce((total, bytes) => total + bytes.byteLength, 0), `recursive composite ${current.id}`);
      bytes = concatenate(childBytes, `recursive composite ${current.id}`);
      await assertCommittedBytes(bytes, current.integrity, current.byteLength, `recursive composite ${current.id}`);
    }
    visiting.delete(id);
    resolved.set(id, bytes);
    return bytes;
  };
  const rootBytes = await resolveObject(root);
  if (rootObject.byteOffset !== 0 || rootBytes.byteLength !== byteLength) throw new TypeError("recursive upload plan root does not cover the committed byte length.");
  await assertCommittedBytes(rootBytes, committed, byteLength, "recursive upload plan");
  if (resolved.size !== objects.length) throw new TypeError("recursive upload plan contains unreachable objects.");
  return { schema, objectName: objectName(plan.objectName, "recursive upload plan.objectName"), mediaType: planMediaType, byteLength, integrity: committed, root, treeDepth, maxChildren: 128, objects };
}

export async function createChainOperationPlan(workspace: Workspace, value: unknown): Promise<unknown> {
  const input = object(value, "chain-plan arguments");
  exact(input, ["plan", "family", "chainId", "network", "target"], "chain-plan arguments");
  const target = operationTarget(input);
  if (target.family === "tezos") throw new Error("Tezos chain operation planning requires a contract-specific adapter and is not emitted by this offline planner.");
  const planPath = text(input.plan, "plan");
  const loaded = await workspace.readFile(planPath, MAX_PLAN_BYTES);
  const planDirectory = path.dirname(planPath);
  const plan = await validatePlan(workspace, planDirectory, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(loaded.bytes)) as unknown);
  const operations = plan.schema === "keel-upload-plan@2" ? flatOperations(plan) : recursiveOperations(plan);
  if (operations.length === 0 || operations.length > MAX_OPERATIONS) throw new RangeError(`chain operation plan exceeds ${MAX_OPERATIONS} operations.`);
  const result = {
    schema: "keel-chain-operation-plan@1",
    status: "review-only",
    materialized: true,
    descriptorMaterialized: true,
    chainReady: false,
    target: { family: target.family, network: target.network, address: target.target },
    sourcePlan: { path: planPath, schema: plan.schema, objectName: plan.objectName, mediaType: plan.mediaType, integrity: plan.integrity },
    operations,
    encoding: "deferred-contract-abi",
    walletApproval: "required",
    signing: "not-performed",
    submission: "not-performed",
    caveat: "Operation descriptors are verified against local chunk files; a wallet or chain adapter must encode, review, sign, and submit them.",
  };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_DESCRIPTOR_RESPONSE_BYTES) {
    throw new RangeError(`chain operation plan response exceeds the ${MAX_DESCRIPTOR_RESPONSE_BYTES}-byte MCP detail limit; use a smaller plan or a dedicated adapter.`);
  }
  return result;
}
