import {
  canonicalJson,
  createIntegrity,
  utf8ToBytes,
  verifyIntegrity,
  type Compression,
  type Hex,
  type Integrity,
} from "@keel/protocol";

export const CHUNK_STORE_MAX_SLUG_BYTES = 23_000 as const;
export const CHUNK_STORE_MAX_BATCH_SLUGS = 3 as const;
export const CHUNK_STORE_MAX_CHILDREN = 128 as const;
export const CHUNK_STORE_MAX_OBJECT_BYTES = 256 * 1024 * 1024;
export const CHUNK_STORE_MAX_DEPTH = 8 as const;
const MAX_OPERATIONS = 16_384;
const MAX_RESULT_BYTES = 256 * 1024;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const DIGEST = /^0x[0-9a-f]{64}$/u;
const DATA = /^0x(?:[0-9a-f]{2})*$/u;
const SAFE_FILE = /^(?!\/)(?!.*(?:^|\/)(?:\.|\.\.)$)[^\\\u0000-\u001f\u007f]+$/u;
const COMPRESSIONS = new Set<Compression>(["none", "gzip", "deflate", "brotli"]);
const MAX_PLAN_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_ENTRIES = 65_536;
const MAX_TOTAL_SOURCE_BYTES = CHUNK_STORE_MAX_OBJECT_BYTES;
const MAX_TOTAL_DECODED_BYTES = CHUNK_STORE_MAX_OBJECT_BYTES;

type Plan = FlatPlan | RecursivePlan;
type KeelHoldKind = "castSlugs" | "weldObject" | "weldComposite";

interface Chunk {
  readonly index: number;
  readonly offset: number;
  readonly byteLength: number;
  readonly integrity: Integrity;
  readonly file: string;
  readonly bytes: Uint8Array;
}

interface FlatPlan {
  readonly schema: "oca-upload-plan@2";
  readonly objectName: string;
  readonly mediaType: string;
  readonly originalByteLength: number;
  readonly storedByteLength: number;
  readonly compression: Compression;
  readonly integrity: Integrity;
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
  readonly storedByteLength: number;
}

interface RecursivePlan {
  readonly schema: "oca-recursive-upload-plan@2";
  readonly objectName: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly integrity: Integrity;
  readonly root: string;
  readonly treeDepth: number;
  readonly objects: readonly (Leaf | Composite)[];
}

export interface EthereumAdapterCodecs {
  readonly keccak256?: (bytes: Uint8Array) => Hex | Promise<Hex>;
  readonly encodeAbiParameters?: (types: readonly string[], values: readonly unknown[]) => Hex | Promise<Hex>;
  readonly encodeFunctionData?: (signature: string, args: readonly unknown[]) => Hex | Promise<Hex>;
  readonly validateFunctionData?: (signature: string, data: Hex, args: readonly unknown[]) => boolean | Promise<boolean>;
  readonly decompress?: (compression: Compression, bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>;
}

export interface EthereumKeelHoldInput {
  readonly plan: unknown;
  readonly chunks: Readonly<Record<string, Uint8Array>>;
  readonly target: { readonly family: "ethereum" | "tezos"; readonly chainId?: number; readonly address: string };
  readonly codecs?: EthereumAdapterCodecs;
}

export interface UnsignedKeelHoldCall {
  readonly operationId: string;
  readonly kind: KeelHoldKind;
  readonly chainId: number;
  readonly to: `0x${string}`;
  readonly valueWei: "0";
  readonly signature: string;
  readonly args: readonly unknown[];
  readonly data: Hex;
  readonly objectId?: Hex;
  readonly storedByteLength?: number;
}

export interface EthereumAdapterReady {
  readonly status: "ready-for-review";
  readonly family: "ethereum";
  readonly chainReady: false;
  readonly source: { readonly planIntegrity: Integrity; readonly contentIntegrity: Integrity };
  readonly operations: readonly UnsignedKeelHoldCall[];
  readonly signing: "not-performed";
  readonly submission: "not-performed";
  readonly caveat: "Unsigned calldata only; no RPC, simulation, signing, or submission was performed.";
}

export interface EthereumAdapterDeferred {
  readonly status: "deferred";
  readonly family: "ethereum" | "tezos";
  readonly chainReady: false;
  readonly code: "tezos-adapter-required" | "missing-keccak256" | "missing-abi-encoder" | "missing-decompressor" | "source-unavailable" | "source-mismatch" | "calldata-invalid" | "result-too-large";
  readonly issues: readonly string[];
  readonly source?: { readonly planIntegrity: Integrity; readonly contentIntegrity?: Integrity };
}

export type EthereumAdapterResult = EthereumAdapterReady | EthereumAdapterDeferred;

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) if (!keys.has(key)) throw new TypeError(`${label}.${key} is not supported.`);
}

function text(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}

function mediaType(value: unknown, label: string): string {
  const result = text(value, label, 128);
  if (new TextEncoder().encode(result).byteLength > 128) throw new TypeError(`${label} exceeds its UTF-8 byte limit.`);
  return result;
}

function objectName(value: unknown, label: string): string {
  const result = text(value, label, 128);
  if (result === "." || result === ".." || result.includes("/") || result.includes("\\")) throw new TypeError(`${label} must be metadata-safe.`);
  return result;
}

function positive(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new RangeError(`${label} must be a positive safe integer.`);
  return value;
}

function nonNegative(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw new RangeError(`${label} must be a non-negative safe integer.`);
  return value;
}

function integrity(value: unknown, label: string): Integrity {
  const input = object(value, label);
  exact(input, ["algorithm", "digest", "byteLength"], label);
  if (input.algorithm !== "sha256" || typeof input.digest !== "string" || !DIGEST.test(input.digest)) throw new TypeError(`${label} must be lower-case SHA-256.`);
  return { algorithm: "sha256", digest: input.digest as Hex, byteLength: positive(input.byteLength, `${label}.byteLength`, CHUNK_STORE_MAX_OBJECT_BYTES) };
}

function compression(value: unknown, label: string): Compression {
  if (typeof value !== "string" || !COMPRESSIONS.has(value as Compression)) throw new TypeError(`${label} is unsupported.`);
  return value as Compression;
}

function hex(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !DATA.test(value)) throw new TypeError(`${label} must be even-length lower-case hexadecimal.`);
  return value as Hex;
}

function hexBytes(bytes: Uint8Array): Hex {
  let value = "0x";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  return value as Hex;
}

function sameIntegrity(left: Integrity, right: Integrity): boolean {
  return left.algorithm === right.algorithm && left.digest === right.digest && left.byteLength === right.byteLength;
}

function concatenate(values: readonly Uint8Array[], label: string): Uint8Array {
  const length = values.reduce((total, value) => total + value.byteLength, 0);
  if (!Number.isSafeInteger(length) || length > CHUNK_STORE_MAX_OBJECT_BYTES) throw new RangeError(`${label} exceeds the KeelHold byte limit.`);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const value of values) { result.set(value, offset); offset += value.byteLength; }
  return result;
}

function validateSourceMap(value: Readonly<Record<string, Uint8Array>>): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("adapter chunks must be an object map.");
  const entries = Object.entries(value);
  if (entries.length > MAX_SOURCE_ENTRIES) throw new RangeError(`adapter chunks exceed the ${MAX_SOURCE_ENTRIES}-entry limit.`);
  let total = 0;
  for (const [file, bytes] of entries) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError(`adapter chunks.${file} must be a Uint8Array.`);
    total += bytes.byteLength;
    if (!Number.isSafeInteger(total) || total > MAX_TOTAL_SOURCE_BYTES) throw new RangeError(`adapter chunk bytes exceed the ${MAX_TOTAL_SOURCE_BYTES}-byte limit.`);
  }
}

function parseChunk(value: unknown, bytes: Readonly<Record<string, Uint8Array>>, label: string): Chunk {
  const input = object(value, label);
  exact(input, ["index", "offset", "byteLength", "integrity", "file"], label);
  const file = text(input.file, `${label}.file`, 512);
  if (!SAFE_FILE.test(file) || file.split("/").some((part) => part.length === 0 || part === "." || part === "..")) throw new TypeError(`${label}.file must be a safe relative path.`);
  const byteLength = positive(input.byteLength, `${label}.byteLength`, CHUNK_STORE_MAX_SLUG_BYTES);
  const valueBytes = bytes[file];
  if (!(valueBytes instanceof Uint8Array)) throw new Error(`${label}.file bytes are unavailable.`);
  if (valueBytes.byteLength !== byteLength) throw new Error(`${label}.file length does not match its plan.`);
  const committed = integrity(input.integrity, `${label}.integrity`);
  if (committed.byteLength !== byteLength) throw new TypeError(`${label}.integrity.byteLength does not match its plan.`);
  return { index: nonNegative(input.index, `${label}.index`, CHUNK_STORE_MAX_CHILDREN), offset: nonNegative(input.offset, `${label}.offset`, CHUNK_STORE_MAX_OBJECT_BYTES), byteLength, integrity: committed, file, bytes: valueBytes.slice() };
}

async function decode(compressionName: Compression, stored: Uint8Array, codecs: EthereumAdapterCodecs): Promise<Uint8Array> {
  if (compressionName === "none") return stored;
  if (codecs.decompress === undefined) throw new Error("A decompressor is required for compressed upload plans.");
  return new Uint8Array(await codecs.decompress(compressionName, stored));
}

async function verifyDecoded(compressionName: Compression, chunks: readonly Chunk[], committed: Integrity, codecs: EthereumAdapterCodecs, label: string, reserve?: (length: number, label: string) => void): Promise<Uint8Array> {
  for (const [index, chunk] of chunks.entries()) if (!await verifyIntegrity(chunk.bytes, chunk.integrity)) throw new Error(`${label}.chunks[${index}] SHA-256 does not match its bytes.`);
  const decoded = await decode(compressionName, concatenate(chunks.map((chunk) => chunk.bytes), `${label}.stored`), codecs);
  if (decoded.byteLength !== committed.byteLength || !await verifyIntegrity(decoded, committed)) throw new Error(`${label} decoded bytes do not match the committed SHA-256.`);
  reserve?.(decoded.byteLength, label);
  return decoded;
}

function validateChunkOrder(chunks: readonly Chunk[], label: string): void {
  if (chunks.length === 0 || chunks.length > CHUNK_STORE_MAX_CHILDREN) throw new RangeError(`${label} must contain 1 through ${CHUNK_STORE_MAX_CHILDREN} chunks.`);
  let offset = 0;
  chunks.forEach((chunk, index) => { if (chunk.index !== index || chunk.offset !== offset) throw new TypeError(`${label} chunks must be ordered and contiguous.`); offset += chunk.byteLength; });
}

async function parsePlan(value: unknown, bytes: Readonly<Record<string, Uint8Array>>, codecs: EthereumAdapterCodecs): Promise<{ readonly plan: Plan; readonly decoded: Uint8Array }> {
  let decodedBudget = 0;
  const reserveDecoded = (length: number, label: string): void => {
    decodedBudget += length;
    if (!Number.isSafeInteger(decodedBudget) || decodedBudget > MAX_TOTAL_DECODED_BYTES) throw new RangeError(`${label} exceeds the ${MAX_TOTAL_DECODED_BYTES}-byte decoded budget.`);
  };
  const input = object(value, "upload plan");
  if (input.schema === "oca-upload-plan@2") {
    exact(input, ["schema", "indexEncoding", "objectName", "mediaType", "originalByteLength", "storedByteLength", "compression", "integrity", "maxChildren", "chunks"], "upload plan");
    if (input.indexEncoding !== "oca-object-index@1" || input.maxChildren !== CHUNK_STORE_MAX_CHILDREN) throw new TypeError("upload plan limits are unsupported.");
    if (!Array.isArray(input.chunks)) throw new TypeError("upload plan.chunks must be an array.");
    const chunks = input.chunks.map((item, index) => parseChunk(item, bytes, `upload plan.chunks[${index}]`));
    validateChunkOrder(chunks, "upload plan.chunks");
    const committed = integrity(input.integrity, "upload plan.integrity");
    const originalByteLength = positive(input.originalByteLength, "upload plan.originalByteLength", CHUNK_STORE_MAX_OBJECT_BYTES);
    if (committed.byteLength !== originalByteLength) throw new TypeError("upload plan integrity does not match originalByteLength.");
    const selected = compression(input.compression, "upload plan.compression");
    const storedByteLength = positive(input.storedByteLength, "upload plan.storedByteLength", CHUNK_STORE_MAX_OBJECT_BYTES);
    if (chunks.reduce((total, chunk) => total + chunk.byteLength, 0) !== storedByteLength) throw new TypeError("upload plan chunks do not match storedByteLength.");
    const plan: FlatPlan = { schema: input.schema, objectName: objectName(input.objectName, "upload plan.objectName"), mediaType: mediaType(input.mediaType, "upload plan.mediaType"), originalByteLength, storedByteLength, compression: selected, integrity: committed, chunks };
    return { plan, decoded: await verifyDecoded(selected, chunks, committed, codecs, "upload plan", reserveDecoded) };
  }
  if (input.schema !== "oca-recursive-upload-plan@2") throw new TypeError("Unsupported upload plan schema.");
  exact(input, ["schema", "indexEncoding", "objectName", "mediaType", "byteLength", "integrity", "root", "treeDepth", "leafDecodedBytes", "maxChunkBytes", "maxPartsPerComposite", "maxChildren", "objects"], "recursive upload plan");
  if (input.indexEncoding !== "oca-object-index@1" || input.maxChildren !== CHUNK_STORE_MAX_CHILDREN) throw new TypeError("recursive upload plan limits are unsupported.");
  const leafDecodedBytes = positive(input.leafDecodedBytes, "recursive upload plan.leafDecodedBytes", CHUNK_STORE_MAX_OBJECT_BYTES);
  const maxChunkBytes = positive(input.maxChunkBytes, "recursive upload plan.maxChunkBytes", CHUNK_STORE_MAX_SLUG_BYTES);
  const maxPartsPerComposite = positive(input.maxPartsPerComposite, "recursive upload plan.maxPartsPerComposite", CHUNK_STORE_MAX_CHILDREN);
  if (maxPartsPerComposite < 2 || leafDecodedBytes > maxChunkBytes * CHUNK_STORE_MAX_CHILDREN) throw new RangeError("recursive upload plan leaf or composite limits are invalid.");
  if (!Array.isArray(input.objects) || input.objects.length === 0 || input.objects.length > 512) throw new RangeError("recursive upload plan objects exceed the adapter limit.");
  const objects: (Leaf | Composite)[] = [];
  const ids = new Set<string>();
  const media = mediaType(input.mediaType, "recursive upload plan.mediaType");
  for (const [index, value] of input.objects.entries()) {
    const item = object(value, `recursive upload plan.objects[${index}]`);
    if (item.kind === "leaf") {
      exact(item, ["id", "kind", "level", "byteOffset", "byteLength", "storedByteLength", "mediaType", "compression", "integrity", "chunks"], `recursive leaf ${index}`);
      if (item.level !== 0) throw new TypeError(`recursive leaf ${index}.level must be zero.`);
      if (!Array.isArray(item.chunks)) throw new TypeError(`recursive leaf ${index}.chunks must be an array.`);
      const chunks = item.chunks.map((chunkValue, chunkIndex) => parseChunk(chunkValue, bytes, `recursive leaf ${index}.chunks[${chunkIndex}]`));
      if (chunks.some((chunk) => chunk.byteLength > maxChunkBytes)) throw new RangeError(`recursive leaf ${index} exceeds maxChunkBytes.`);
      validateChunkOrder(chunks, `recursive leaf ${index}.chunks`);
      const committed = integrity(item.integrity, `recursive leaf ${index}.integrity`);
      const byteLength = positive(item.byteLength, `recursive leaf ${index}.byteLength`, CHUNK_STORE_MAX_OBJECT_BYTES);
      if (committed.byteLength !== byteLength) throw new TypeError(`recursive leaf ${index}.integrity.byteLength does not match byteLength.`);
      const storedByteLength = positive(item.storedByteLength, `recursive leaf ${index}.storedByteLength`, CHUNK_STORE_MAX_OBJECT_BYTES);
      if (chunks.reduce((total, chunk) => total + chunk.byteLength, 0) !== storedByteLength) throw new TypeError(`recursive leaf ${index} chunks do not match storedByteLength.`);
      const selected = compression(item.compression, `recursive leaf ${index}.compression`);
      if (item.mediaType !== media) throw new TypeError(`recursive leaf ${index}.mediaType does not match the plan.`);
      const decoded = await verifyDecoded(selected, chunks, committed, codecs, `recursive leaf ${index}`, reserveDecoded);
      if (decoded.byteLength !== byteLength) throw new TypeError(`recursive leaf ${index} decoded bytes do not match byteLength.`);
      if (decoded.byteLength > leafDecodedBytes) throw new RangeError(`recursive leaf ${index} exceeds leafDecodedBytes.`);
      const id = text(item.id, `recursive leaf ${index}.id`, 128);
      if (ids.has(id)) throw new TypeError(`Duplicate recursive object ${id}.`);
      ids.add(id);
      objects.push({ id, kind: "leaf", level: 0, byteOffset: nonNegative(item.byteOffset, `recursive leaf ${index}.byteOffset`, CHUNK_STORE_MAX_OBJECT_BYTES), byteLength, storedByteLength, mediaType: media, compression: selected, integrity: committed, chunks, decoded });
    } else if (item.kind === "composite") {
      exact(item, ["id", "kind", "level", "byteOffset", "byteLength", "mediaType", "integrity", "parts"], `recursive composite ${index}`);
      if (!Array.isArray(item.parts) || item.parts.length < 1 || item.parts.length > maxPartsPerComposite || item.parts.length > CHUNK_STORE_MAX_CHILDREN) throw new RangeError(`recursive composite ${index}.parts is invalid.`);
      const id = text(item.id, `recursive composite ${index}.id`, 128);
      if (ids.has(id)) throw new TypeError(`Duplicate recursive object ${id}.`);
      ids.add(id);
      const parts = item.parts.map((part, partIndex) => text(part, `recursive composite ${index}.parts[${partIndex}]`, 128));
      const committed = integrity(item.integrity, `recursive composite ${index}.integrity`);
      const byteLength = positive(item.byteLength, `recursive composite ${index}.byteLength`, CHUNK_STORE_MAX_OBJECT_BYTES);
      if (item.mediaType !== media) throw new TypeError(`recursive composite ${index}.mediaType does not match the plan.`);
      objects.push({ id, kind: "composite", level: positive(item.level, `recursive composite ${index}.level`, CHUNK_STORE_MAX_DEPTH), byteOffset: nonNegative(item.byteOffset, `recursive composite ${index}.byteOffset`, CHUNK_STORE_MAX_OBJECT_BYTES), byteLength, mediaType: media, integrity: committed, parts, storedByteLength: 0 });
    } else throw new TypeError(`recursive upload plan.objects[${index}].kind is unsupported.`);
  }
  const root = text(input.root, "recursive upload plan.root", 128);
  const objectMap = new Map(objects.map((item) => [item.id, item] as const));
  const resolved = new Map<string, Uint8Array>();
  const resolving = new Set<string>();
  const resolve = async (id: string): Promise<Uint8Array> => {
    const cached = resolved.get(id);
    if (cached !== undefined) return cached;
    if (resolving.has(id)) throw new TypeError(`recursive upload plan contains a cycle at ${id}.`);
    const current = objectMap.get(id);
    if (current === undefined) throw new TypeError(`recursive upload plan references unknown object ${id}.`);
    resolving.add(id);
    let result: Uint8Array;
    if (current.kind === "leaf") result = current.decoded;
    else {
      const children = current.parts.map((part) => objectMap.get(part));
      if (children.some((child) => child === undefined)) throw new TypeError(`recursive composite ${id} references an unknown part.`);
      let offset = current.byteOffset;
      const childBytes: Uint8Array[] = [];
      let storedByteLength = 0;
      for (const child of children as (Leaf | Composite)[]) {
        if (child.level >= current.level || child.byteOffset !== offset) throw new TypeError(`recursive composite ${id} has an invalid part graph.`);
        childBytes.push(await resolve(child.id));
        const resolvedChild = objectMap.get(child.id);
        if (resolvedChild === undefined) throw new TypeError(`recursive composite ${id} references an unavailable part.`);
        storedByteLength += resolvedChild.storedByteLength;
        offset += child.byteLength;
      }
      result = concatenate(childBytes, `recursive composite ${id}`);
      if (result.byteLength !== current.byteLength || !await verifyIntegrity(result, current.integrity)) throw new Error(`recursive composite ${id} does not match its committed SHA-256.`);
      reserveDecoded(result.byteLength, `recursive composite ${id}`);
      const index = objects.findIndex((item) => item.id === id);
      if (index >= 0) {
        const updated = { ...current, storedByteLength };
        objects[index] = updated;
        objectMap.set(id, updated);
      }
    }
    resolving.delete(id); resolved.set(id, result); return result;
  };
  const rootObject = objectMap.get(root);
  if (rootObject === undefined) throw new TypeError("recursive upload plan.root is unknown.");
  const decoded = await resolve(root);
  const committed = integrity(input.integrity, "recursive upload plan.integrity");
  const byteLength = positive(input.byteLength, "recursive upload plan.byteLength", CHUNK_STORE_MAX_OBJECT_BYTES);
  const treeDepth = nonNegative(input.treeDepth, "recursive upload plan.treeDepth", CHUNK_STORE_MAX_DEPTH);
  if (rootObject.level !== treeDepth || rootObject.byteOffset !== 0 || decoded.byteLength !== byteLength || committed.byteLength !== byteLength || !await verifyIntegrity(decoded, committed)) throw new TypeError("recursive upload plan root does not match its committed bytes.");
  if (resolved.size !== objects.length) throw new TypeError("recursive upload plan contains unreachable objects.");
  return { plan: { schema: input.schema, objectName: objectName(input.objectName, "recursive upload plan.objectName"), mediaType: media, byteLength, integrity: committed, root, treeDepth, objects }, decoded };
}

async function codecHex(value: Hex | Promise<Hex>, label: string): Promise<Hex> {
  const output = hex(await value, label);
  if (output.length !== 66) throw new TypeError(`${label} must be exactly 32 bytes.`);
  return output;
}

function compressionCode(value: Compression): number { return value === "none" ? 0 : value === "gzip" ? 1 : value === "deflate" ? 2 : 3; }

async function operationId(planDigest: Integrity, index: number): Promise<string> {
  return `op-${planDigest.digest.slice(2, 14)}-${String(index).padStart(5, "0")}`;
}

async function calldata(codec: EthereumAdapterCodecs, signature: string, args: readonly unknown[]): Promise<Hex> {
  if (codec.encodeFunctionData === undefined) throw new Error("An ABI function encoder is required for unsigned calldata.");
  const value = hex(await codec.encodeFunctionData(signature, args), "encoded calldata");
  if (value.length < 10) throw new TypeError("encoded calldata must include a four-byte function selector.");
  const selectors: Record<string, string> = {
    "castSlugs(bytes[])": "0x0d1ff9e2",
    "weldObject(bytes32[],bytes32,uint64,uint8,string)": "0xb17463a8",
    "weldComposite(bytes32[],bytes32,uint64,string)": "0x5f97a164",
  };
  if (value.slice(0, 10).toLowerCase() !== selectors[signature]) throw new TypeError(`${signature} encoded calldata has an unexpected KeelHold selector.`);
  if (codec.validateFunctionData === undefined) throw new Error("An ABI calldata validator is required for unsigned calldata.");
  if (!await codec.validateFunctionData(signature, value, args)) throw new TypeError(`${signature} encoded calldata does not match its ABI arguments.`);
  if (value.length > 2 + 2 * 512_000) throw new RangeError("Encoded calldata exceeds the adapter response limit.");
  return value;
}

async function deriveObjectId(codec: EthereumAdapterCodecs, kind: 0 | 1, digestValue: Integrity, byteLength: number, storedByteLength: number, compressionName: Compression, mediaType: string, childIds: readonly Hex[]): Promise<Hex> {
  if (codec.keccak256 === undefined || codec.encodeAbiParameters === undefined) throw new Error("Keccak and ABI parameter codecs are required to derive KeelHold object IDs.");
  const indexDigest = await codec.keccak256(concatenate(childIds.map((id) => hexBytesFromHex(id)), "KeelHold object index"));
  const mediaDigest = await codec.keccak256(utf8ToBytes(mediaType));
  const encoded = await codec.encodeAbiParameters(
    kind === 0
      ? ["bytes1", "bytes32", "bytes32", "uint64", "uint64", "uint8", "bytes32"]
      : ["bytes1", "bytes32", "bytes32", "uint64", "uint64", "bytes32"],
    kind === 0
      ? ["0x00", indexDigest, digestValue.digest, byteLength, storedByteLength, compressionCode(compressionName), mediaDigest]
      : ["0x01", indexDigest, digestValue.digest, byteLength, storedByteLength, mediaDigest],
  );
  const encodedHex = hex(encoded, "encoded object ID preimage");
  const preimage = hexBytesFromHex(encodedHex);
  const expectedLength = kind === 0 ? 224 : 192;
  if (preimage.byteLength !== expectedLength) throw new TypeError(`KeelHold object ID preimage must be ${expectedLength} ABI bytes.`);
  return codecHex(codec.keccak256(preimage), "KeelHold object ID");
}

function hexBytesFromHex(value: Hex): Uint8Array {
  const result = new Uint8Array((value.length - 2) / 2);
  for (let index = 0; index < result.length; index += 1) result[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
  return result;
}

async function slugIds(codec: EthereumAdapterCodecs, chunks: readonly Chunk[]): Promise<Hex[]> {
  if (codec.keccak256 === undefined) throw new Error("A Keccak-256 codec is required to derive chunk IDs.");
  return Promise.all(chunks.map((chunk) => codecHex(codec.keccak256!(chunk.bytes), "KeelHold chunk ID")));
}

function deferred(family: "ethereum" | "tezos", code: EthereumAdapterDeferred["code"], issue: string, source?: EthereumAdapterDeferred["source"]): EthereumAdapterDeferred {
  return { status: "deferred", family, chainReady: false, code, issues: [issue], ...(source === undefined ? {} : { source }) };
}

export async function prepareEthereumKeelHoldOperations(input: EthereumKeelHoldInput): Promise<EthereumAdapterResult> {
  const target = object(input.target, "adapter target");
  exact(target, ["family", "chainId", "address"], "adapter target");
  if (target.family === "tezos") return deferred("tezos", "tezos-adapter-required", "Tezos OnchFS requires a contract-specific Michelson adapter; Ethereum KeelHold calldata is not emitted.");
  const chainIdValue = target.chainId;
  const addressValue = target.address;
  if (target.family !== "ethereum" || typeof addressValue !== "string" || !ADDRESS.test(addressValue) || !Number.isSafeInteger(chainIdValue) || (chainIdValue as number) <= 0) throw new TypeError("Ethereum adapter target must contain a positive chainId and 20-byte address.");
  const chainId = chainIdValue as number;
  const address = addressValue;
  const codecs = input.codecs ?? {};
  let planDigest: Integrity;
  try {
    validateSourceMap(input.chunks);
    const canonicalPlan = utf8ToBytes(canonicalJson(input.plan));
    if (canonicalPlan.byteLength > MAX_PLAN_BYTES) return deferred("ethereum", "result-too-large", `Upload plan exceeds the ${MAX_PLAN_BYTES}-byte canonical input limit.`);
    planDigest = await createIntegrity(canonicalPlan);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /byte limit|entry limit|canonical input limit/iu.test(message) ? "result-too-large" : "source-mismatch";
    return deferred("ethereum", code, `Upload plan or source map is invalid: ${message}`);
  }
  let parsed: { readonly plan: Plan; readonly decoded: Uint8Array };
  try { parsed = await parsePlan(input.plan, input.chunks, codecs); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.includes("decompressor")
      ? "missing-decompressor"
      : message.includes("unavailable")
        ? "source-unavailable"
        : "source-mismatch";
    return deferred("ethereum", code, message, { planIntegrity: planDigest });
  }
  const source = { planIntegrity: planDigest, contentIntegrity: parsed.plan.integrity };
  if (codecs.keccak256 === undefined) return deferred("ethereum", "missing-keccak256", "Inject a Keccak-256 codec to derive KeelHold chunk IDs.", source);
  if (codecs.encodeAbiParameters === undefined) return deferred("ethereum", "missing-abi-encoder", "Inject an ABI parameter codec to derive KeelHold object IDs.", source);
  if (codecs.encodeFunctionData === undefined || codecs.validateFunctionData === undefined) return deferred("ethereum", "missing-abi-encoder", "Inject an ABI function encoder and calldata validator to produce verified unsigned calldata.", source);
  try {
    const operations: UnsignedKeelHoldCall[] = [];
    const objectIds = new Map<string, Hex>();
    const addLeaf = async (leaf: Leaf, index: number): Promise<void> => {
      const ids = await slugIds(codecs, leaf.chunks);
      for (let offset = 0; offset < ids.length; offset += CHUNK_STORE_MAX_BATCH_SLUGS) {
        const group = leaf.chunks.slice(offset, offset + CHUNK_STORE_MAX_BATCH_SLUGS);
        const groupIds = ids.slice(offset, offset + CHUNK_STORE_MAX_BATCH_SLUGS);
        operations.push({ operationId: await operationId(planDigest, operations.length), kind: "castSlugs", chainId, to: address.toLowerCase() as `0x${string}`, valueWei: "0", signature: "castSlugs(bytes[])", args: [group.map((chunk) => hexBytes(chunk.bytes))], data: await calldata(codecs, "castSlugs(bytes[])", [group.map((chunk) => hexBytes(chunk.bytes))]) });
        if (group.length !== groupIds.length) throw new Error(`leaf ${index} chunk ID count mismatch.`);
      }
      const objectId = await deriveObjectId(codecs, 0, leaf.integrity, leaf.byteLength, leaf.storedByteLength, leaf.compression, leaf.mediaType, ids);
      objectIds.set(leaf.id, objectId);
      const args = [ids, leaf.integrity.digest, leaf.byteLength, compressionCode(leaf.compression), leaf.mediaType] as const;
      operations.push({ operationId: await operationId(planDigest, operations.length), kind: "weldObject", chainId, to: address.toLowerCase() as `0x${string}`, valueWei: "0", signature: "weldObject(bytes32[],bytes32,uint64,uint8,string)", args, data: await calldata(codecs, "weldObject(bytes32[],bytes32,uint64,uint8,string)", args), ...(objectId === undefined ? {} : { objectId }), storedByteLength: leaf.storedByteLength });
    };
    if (parsed.plan.schema === "oca-upload-plan@2") await addLeaf({ id: "flat", kind: "leaf", level: 0, byteOffset: 0, byteLength: parsed.plan.originalByteLength, storedByteLength: parsed.plan.storedByteLength, mediaType: parsed.plan.mediaType, compression: parsed.plan.compression, integrity: parsed.plan.integrity, chunks: parsed.plan.chunks, decoded: parsed.decoded }, 0);
    else {
      for (const [index, item] of parsed.plan.objects.entries()) if (item.kind === "leaf") await addLeaf(item, index);
      const composites = new Map(parsed.plan.objects.filter((item): item is Composite => item.kind === "composite").map((item) => [item.id, item] as const));
      const emitting = new Set<string>();
      const emitted = new Set<string>();
      const addComposite = async (item: Composite): Promise<void> => {
        if (emitted.has(item.id)) return;
        if (emitting.has(item.id)) throw new Error(`Composite ${item.id} has a cyclic emission graph.`);
        emitting.add(item.id);
        for (const part of item.parts) {
          const child = composites.get(part);
          if (child !== undefined) await addComposite(child);
        }
        const ids = item.parts.map((part) => objectIds.get(part));
        if (ids.some((id) => id === undefined)) throw new Error(`Composite ${item.id} references an unavailable object ID.`);
        const childIds = ids as Hex[];
        const objectId = await deriveObjectId(codecs, 1, item.integrity, item.byteLength, item.storedByteLength, "none", item.mediaType, childIds);
        objectIds.set(item.id, objectId);
        const args = [childIds, item.integrity.digest, item.byteLength, item.mediaType] as const;
        operations.push({ operationId: await operationId(planDigest, operations.length), kind: "weldComposite", chainId, to: address.toLowerCase() as `0x${string}`, valueWei: "0", signature: "weldComposite(bytes32[],bytes32,uint64,string)", args, data: await calldata(codecs, "weldComposite(bytes32[],bytes32,uint64,string)", args), objectId, storedByteLength: item.storedByteLength });
        emitting.delete(item.id);
        emitted.add(item.id);
      };
      for (const item of parsed.plan.objects) if (item.kind === "composite") await addComposite(item);
    }
    if (operations.length === 0 || operations.length > MAX_OPERATIONS) throw new RangeError("KeelHold operation count exceeds the adapter limit.");
    const result: EthereumAdapterReady = { status: "ready-for-review", family: "ethereum", chainReady: false, source, operations, signing: "not-performed", submission: "not-performed", caveat: "Unsigned calldata only; no RPC, simulation, signing, or submission was performed." };
    if (new TextEncoder().encode(canonicalJson(result)).byteLength > MAX_RESULT_BYTES) return deferred("ethereum", "result-too-large", "Unsigned operation descriptors exceed the adapter response limit.", source);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return deferred("ethereum", message.includes("calldata") ? "calldata-invalid" : "source-mismatch", message, source);
  }
}
