import { bytesToHex, bytesToUtf8, concatBytes, hexToBytes, utf8ToBytes } from "./bytes.js";
import { sha256Hex } from "./integrity.js";

export const PORTABLE_OBJECT_DOMAIN = "keel.portable-object.v1";
export const PORTABLE_ANCHOR_DOMAIN = "keel.anchor.v1";
export const PORTABLE_CHUNK_LEAF_DOMAIN = "keel.portable-chunk-leaf.v1";
export const PORTABLE_CHUNK_NODE_DOMAIN = "keel.portable-chunk-node.v1";
export const PORTABLE_CHUNK_EMPTY_DOMAIN = "keel.portable-chunk-empty.v1";
export const PORTABLE_GRAPH_DOMAIN = "keel.portable-graph.v1";
export const ORDINALS_TARGET_DOMAIN = "keel.ord-target.v1";
export const ORDINALS_PORTABLE_MAGIC = "STRP";
export const PORTABLE_OBJECT_VERSION = 1;
export const ORDINALS_PORTABLE_VERSION = 1;
export const PORTABLE_CHUNK_BYTES = 16_384;
export const PORTABLE_MAX_DECODED_BYTES = 268_435_456;
export const PORTABLE_MAX_OBJECT_BYTES = 67_108_864;
export const PORTABLE_MAX_MANIFEST_BYTES = 65_536;
export const PORTABLE_MAX_CHUNKS = PORTABLE_MAX_DECODED_BYTES / PORTABLE_CHUNK_BYTES;
export const PORTABLE_MAX_GRAPH_ENTRIES = 4_096;
export const PORTABLE_MAX_GRAPH_OBJECTS = 4_096;
export const PORTABLE_MAX_GRAPH_BYTES = 4_194_304;
export const PORTABLE_MAX_GRAPH_DEPTH = 16;

export const PortableResourceKind = {
  Viewer: 0,
  Atlas: 1,
  Codex: 2,
  Sound: 3,
  Effect: 4,
  Manifest: 5,
  Metadata: 6,
  Character: 7,
  World: 8,
  Graph: 9,
} as const;

export const PortableCompression = {
  None: 0,
  Gzip: 1,
  Brotli: 2,
} as const;

export const PortableEditPolicy = {
  Immutable: 0,
  AppendOnly: 1,
  ControllerRevision: 2,
} as const;

export const PortableSourceFamily = {
  Ethereum: 1,
  Tezos: 2,
  Bitcoin: 3,
} as const;

export const PortableGraphRole = {
  Entrypoint: 0,
  Script: 1,
  Style: 2,
  Image: 3,
  Audio: 4,
  Data: 5,
  Font: 6,
  Other: 7,
} as const;

export type PortableResourceKind = (typeof PortableResourceKind)[keyof typeof PortableResourceKind];
export type PortableCompression = (typeof PortableCompression)[keyof typeof PortableCompression];
export type PortableEditPolicy = (typeof PortableEditPolicy)[keyof typeof PortableEditPolicy];
export type PortableSourceFamily = (typeof PortableSourceFamily)[keyof typeof PortableSourceFamily];
export type PortableGraphRole = (typeof PortableGraphRole)[keyof typeof PortableGraphRole];
export type Bytes32Hex = `0x${string}`;
export type Bytes16Hex = `0x${string}`;

export const PORTABLE_MEDIA_TYPES = [
  "application/javascript",
  "application/json",
  "application/octet-stream",
  "application/zip",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "image/png",
  "image/webp",
  "text/css",
  "text/html",
  "text/javascript",
] as const;

const mediaTypes = new Set<string>(PORTABLE_MEDIA_TYPES);
const resourceKinds = new Set<number>(Object.values(PortableResourceKind));
const compressions = new Set<number>(Object.values(PortableCompression));
const editPolicies = new Set<number>(Object.values(PortableEditPolicy));
const sourceFamilies = new Set<number>(Object.values(PortableSourceFamily));
const graphRoles = new Set<number>(Object.values(PortableGraphRole));
const MAX_U32 = 0xffff_ffff;
const MAX_U64 = 0xffff_ffff_ffff_ffffn;

export interface PortableManifestV1 {
  resourceKind: PortableResourceKind;
  compression: PortableCompression;
  mediaType: (typeof PORTABLE_MEDIA_TYPES)[number];
  decodedByteLength: bigint;
  decodedSha256: Bytes32Hex;
  metadataSha256: Bytes32Hex;
  chunkRoot: Bytes32Hex;
  lineageId: Bytes32Hex;
  revision: bigint;
  parentPortableRoot: Bytes32Hex;
  editPolicy: PortableEditPolicy;
  controllerId: Bytes32Hex;
  frozen: boolean;
}

export interface PortableAnchorV1 {
  portableRoot: Bytes32Hex;
  sourceFamily: PortableSourceFamily;
  sourceNetwork: number;
  sourceRegistry: Bytes32Hex;
  sourceObjectKey: Bytes32Hex;
  sourceRevision: bigint;
  sourceEventDigest: Bytes32Hex;
}

export interface OrdinalsPortableCommitmentV1 {
  flags: 0;
  envelopeIndex: number;
  revision: bigint;
  portableRoot: Bytes32Hex;
  targetDigest: Bytes16Hex;
}

export interface PortableGraphEntryV1 {
  path: string;
  portableRoot: Bytes32Hex;
  role: PortableGraphRole;
  executable: boolean;
}

export interface PortableGraphV1 {
  entrypoint: string;
  entries: PortableGraphEntryV1[];
}

export interface PortableContentCommitmentsV1 {
  decodedByteLength: bigint;
  decodedSha256: Bytes32Hex;
  chunkRoot: Bytes32Hex;
}

export interface PortableObjectLoaderV1 {
  loadManifest(portableRoot: Bytes32Hex): Promise<Uint8Array>;
  loadDecoded(portableRoot: Bytes32Hex, manifest: PortableManifestV1): Promise<Uint8Array>;
}

export interface PortableResolveLimitsV1 {
  maxDepth?: number;
  maxObjects?: number;
  maxGraphEntries?: number;
  maxManifestBytes?: number;
  maxObjectBytes?: number;
  maxTotalDecodedBytes?: number;
}

export interface PortableGraphVerificationReceiptV1 {
  root: Bytes32Hex;
  objectCount: number;
  graphCount: number;
  totalDecodedBytes: bigint;
  verifiedRoots: Bytes32Hex[];
}

function assertInteger(value: number, max: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${name} must be an unsigned integer no greater than ${max}.`);
  }
}

function assertU64(value: bigint, name: string): void {
  if (typeof value !== "bigint" || value < 0n || value > MAX_U64) {
    throw new RangeError(`${name} must be an unsigned 64-bit bigint.`);
  }
}

function fixedHex(value: string, length: number, name: string): Uint8Array {
  const bytes = hexToBytes(value);
  if (bytes.byteLength !== length) throw new TypeError(`${name} must be exactly ${length} bytes.`);
  return bytes;
}

function u8(value: number): Uint8Array {
  return Uint8Array.of(value);
}

function u16be(value: number): Uint8Array {
  assertInteger(value, 0xffff, "u16");
  return Uint8Array.of((value >>> 8) & 0xff, value & 0xff);
}

function u32be(value: number): Uint8Array {
  assertInteger(value, MAX_U32, "u32");
  return Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

export function ethereumPortableSourceNetworkV1(chainId: number | bigint): number {
  const value = typeof chainId === "bigint" ? chainId : BigInt(chainId);
  if (value < 0n || value > BigInt(MAX_U32)) {
    throw new RangeError(`Ethereum chain ID must fit portable sourceNetwork u32.`);
  }
  if (typeof chainId === "number" && !Number.isSafeInteger(chainId)) {
    throw new RangeError("Ethereum chain ID number must be a safe integer.");
  }
  return Number(value);
}

export function portableSourceNetworkFromBytesV1(networkBytes: Uint8Array): number {
  if (!(networkBytes instanceof Uint8Array) || networkBytes.byteLength !== 4) {
    throw new TypeError("Portable binary network ID must be exactly four bytes.");
  }
  return (
    ((networkBytes[0] ?? 0) * 0x1_000000)
    + ((networkBytes[1] ?? 0) << 16)
    + ((networkBytes[2] ?? 0) << 8)
    + (networkBytes[3] ?? 0)
  );
}

function u64be(value: bigint): Uint8Array {
  assertU64(value, "u64");
  const output = new Uint8Array(8);
  let cursor = value;
  for (let index = 7; index >= 0; index -= 1) {
    output[index] = Number(cursor & 0xffn);
    cursor >>= 8n;
  }
  return output;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
}

function portablePath(value: string, name: string): Uint8Array {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 1_024
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
    || value.endsWith("/")
    || value.includes("//")
    || value.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new TypeError(`${name} must be a canonical relative ASCII path.`);
  }
  const bytes = utf8ToBytes(value);
  if (bytes.byteLength > 0xffff) throw new RangeError(`${name} is too long.`);
  return bytes;
}

async function sha256Bytes(bytes: Uint8Array): Promise<Uint8Array> {
  return hexToBytes(await sha256Hex(bytes));
}

interface PortableTreeNode {
  readonly hash: Uint8Array;
  readonly start: number;
  readonly count: number;
}

class Reader {
  readonly bytes: Uint8Array;
  offset = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  take(length: number, name: string): Uint8Array {
    assertInteger(length, Number.MAX_SAFE_INTEGER, `${name} length`);
    if (this.offset + length > this.bytes.byteLength) throw new RangeError(`Truncated ${name}.`);
    const value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  u8(name: string): number {
    return this.take(1, name)[0] ?? 0;
  }

  u16(name: string): number {
    const value = this.take(2, name);
    return ((value[0] ?? 0) << 8) | (value[1] ?? 0);
  }

  u32(name: string): number {
    const value = this.take(4, name);
    return ((value[0] ?? 0) * 0x1_000000) + ((value[1] ?? 0) << 16) + ((value[2] ?? 0) << 8) + (value[3] ?? 0);
  }

  u64(name: string): bigint {
    let value = 0n;
    for (const byte of this.take(8, name)) value = (value << 8n) | BigInt(byte);
    return value;
  }

  finish(): void {
    if (this.offset !== this.bytes.byteLength) throw new RangeError("Trailing bytes are not canonical.");
  }
}

function expectFixed(actual: Uint8Array, expected: Uint8Array, name: string): void {
  if (actual.byteLength !== expected.byteLength || actual.some((byte, index) => byte !== expected[index])) {
    throw new TypeError(`Invalid ${name}.`);
  }
}

/**
 * Builds the chain-neutral recursive content tree for decoded resource bytes.
 * Carrier boundaries, compression frames, contract addresses, and inscription
 * envelopes never participate: every implementation chunks the decoded byte
 * stream into exact 16 KiB leaves before hashing this versioned tree.
 */
export async function portableChunkRootV1(decodedBytes: Uint8Array): Promise<Bytes32Hex> {
  if (!(decodedBytes instanceof Uint8Array)) throw new TypeError("decodedBytes must be a Uint8Array.");
  if (decodedBytes.byteLength > PORTABLE_MAX_DECODED_BYTES) {
    throw new RangeError(`decodedBytes exceeds ${PORTABLE_MAX_DECODED_BYTES} bytes.`);
  }
  if (decodedBytes.byteLength === 0) {
    return sha256Hex(concatBytes([
      utf8ToBytes(PORTABLE_CHUNK_EMPTY_DOMAIN),
      u32be(0),
      u64be(0n),
    ]));
  }

  const totalChunks = Math.ceil(decodedBytes.byteLength / PORTABLE_CHUNK_BYTES);
  assertInteger(totalChunks, PORTABLE_MAX_CHUNKS, "portable chunk count");
  let nodes: PortableTreeNode[] = [];
  for (let index = 0; index < totalChunks; index += 1) {
    const chunk = decodedBytes.subarray(
      index * PORTABLE_CHUNK_BYTES,
      Math.min(decodedBytes.byteLength, (index + 1) * PORTABLE_CHUNK_BYTES),
    );
    nodes.push({
      hash: await sha256Bytes(concatBytes([
        utf8ToBytes(PORTABLE_CHUNK_LEAF_DOMAIN),
        u32be(index),
        u32be(totalChunks),
        u32be(chunk.byteLength),
        chunk,
      ])),
      start: index,
      count: 1,
    });
  }

  let level = 0;
  const zero = new Uint8Array(32);
  while (nodes.length > 1) {
    const next: PortableTreeNode[] = [];
    for (let index = 0; index < nodes.length; index += 2) {
      const left = nodes[index]!;
      const right = nodes[index + 1];
      const count = left.count + (right?.count ?? 0);
      next.push({
        hash: await sha256Bytes(concatBytes([
          utf8ToBytes(PORTABLE_CHUNK_NODE_DOMAIN),
          u16be(level),
          u32be(left.start),
          u32be(count),
          left.hash,
          right?.hash ?? zero,
        ])),
        start: left.start,
        count,
      });
    }
    nodes = next;
    level += 1;
  }
  return bytesToHex(nodes[0]!.hash);
}

export async function portableContentCommitmentsV1(decodedBytes: Uint8Array): Promise<PortableContentCommitmentsV1> {
  if (!(decodedBytes instanceof Uint8Array)) throw new TypeError("decodedBytes must be a Uint8Array.");
  // Reject before SHA-256 sees the input. Besides avoiding wasted work, this
  // keeps hostile typed-array subclasses from reaching a large allocation in
  // the digest implementation before the protocol ceiling is applied.
  if (decodedBytes.byteLength > PORTABLE_MAX_DECODED_BYTES) {
    throw new RangeError(`decodedBytes exceeds ${PORTABLE_MAX_DECODED_BYTES} bytes.`);
  }
  return {
    decodedByteLength: BigInt(decodedBytes.byteLength),
    decodedSha256: await sha256Hex(decodedBytes),
    chunkRoot: await portableChunkRootV1(decodedBytes),
  };
}

export async function verifyPortableContentV1(manifest: PortableManifestV1, decodedBytes: Uint8Array): Promise<void> {
  validateManifest(manifest);
  if (!(decodedBytes instanceof Uint8Array)) throw new TypeError("decodedBytes must be a Uint8Array.");
  if (BigInt(decodedBytes.byteLength) !== manifest.decodedByteLength) {
    throw new Error("Portable decoded byte length does not match its manifest.");
  }
  const commitments = await portableContentCommitmentsV1(decodedBytes);
  if (commitments.decodedSha256.toLowerCase() !== manifest.decodedSha256.toLowerCase()) {
    throw new Error("Portable decoded SHA-256 does not match its manifest.");
  }
  if (commitments.chunkRoot.toLowerCase() !== manifest.chunkRoot.toLowerCase()) {
    throw new Error("Portable chunk root does not match its manifest.");
  }
}

function validateGraphEntry(entry: PortableGraphEntryV1, name: string): Uint8Array {
  const pathBytes = portablePath(entry.path, `${name}.path`);
  fixedHex(entry.portableRoot, 32, `${name}.portableRoot`);
  if (!graphRoles.has(entry.role)) throw new RangeError(`${name}.role is unsupported.`);
  if (typeof entry.executable !== "boolean") throw new TypeError(`${name}.executable must be boolean.`);
  return pathBytes;
}

/** Canonical address-neutral resource map whose children are portable roots. */
export function encodePortableGraphV1(graph: PortableGraphV1): Uint8Array {
  if (graph === null || typeof graph !== "object" || !Array.isArray(graph.entries) || graph.entries.length === 0) {
    throw new TypeError("portable graph must contain entries.");
  }
  assertInteger(graph.entries.length, PORTABLE_MAX_GRAPH_ENTRIES, "portable graph entry count");
  const entrypointBytes = portablePath(graph.entrypoint, "entrypoint");
  const sorted = graph.entries.map((entry, index) => ({ entry, pathBytes: validateGraphEntry(entry, `entries[${index}]`) }))
    .sort((left, right) => compareBytes(left.pathBytes, right.pathBytes));
  for (let index = 1; index < sorted.length; index += 1) {
    if (compareBytes(sorted[index - 1]!.pathBytes, sorted[index]!.pathBytes) === 0) {
      throw new TypeError(`Duplicate portable graph path ${sorted[index]!.entry.path}.`);
    }
  }
  const entrypoint = sorted.find(({ pathBytes }) => compareBytes(pathBytes, entrypointBytes) === 0)?.entry;
  if (entrypoint === undefined || !entrypoint.executable || entrypoint.role !== PortableGraphRole.Entrypoint) {
    throw new TypeError("portable graph entrypoint must reference an executable Entrypoint entry.");
  }
  const encoded = concatBytes([
    utf8ToBytes(PORTABLE_GRAPH_DOMAIN),
    u16be(entrypointBytes.byteLength),
    entrypointBytes,
    u32be(sorted.length),
    ...sorted.flatMap(({ entry, pathBytes }) => [
      u16be(pathBytes.byteLength),
      pathBytes,
      fixedHex(entry.portableRoot, 32, `${entry.path}.portableRoot`),
      u8(entry.role),
      u8(entry.executable ? 1 : 0),
    ]),
  ]);
  if (encoded.byteLength > PORTABLE_MAX_GRAPH_BYTES) {
    throw new RangeError(`portable graph exceeds ${PORTABLE_MAX_GRAPH_BYTES} bytes.`);
  }
  return encoded;
}

export function decodePortableGraphV1(bytes: Uint8Array): PortableGraphV1 {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("portable graph bytes must be a Uint8Array.");
  if (bytes.byteLength > PORTABLE_MAX_GRAPH_BYTES) {
    throw new RangeError(`portable graph exceeds ${PORTABLE_MAX_GRAPH_BYTES} bytes.`);
  }
  const reader = new Reader(bytes);
  expectFixed(
    reader.take(utf8ToBytes(PORTABLE_GRAPH_DOMAIN).byteLength, "portable graph domain"),
    utf8ToBytes(PORTABLE_GRAPH_DOMAIN),
    "portable graph domain",
  );
  const entrypoint = bytesToUtf8(reader.take(reader.u16("entrypointLength"), "entrypoint"));
  portablePath(entrypoint, "entrypoint");
  const count = reader.u32("entryCount");
  if (count === 0) throw new TypeError("portable graph must contain entries.");
  if (count > PORTABLE_MAX_GRAPH_ENTRIES) {
    throw new RangeError(`portable graph exceeds ${PORTABLE_MAX_GRAPH_ENTRIES} entries.`);
  }
  const entries: PortableGraphEntryV1[] = [];
  let priorPath: Uint8Array | undefined;
  for (let index = 0; index < count; index += 1) {
    const path = bytesToUtf8(reader.take(reader.u16(`entries[${index}].pathLength`), `entries[${index}].path`));
    const pathBytes = portablePath(path, `entries[${index}].path`);
    if (priorPath !== undefined && compareBytes(priorPath, pathBytes) >= 0) {
      throw new TypeError("portable graph paths must be uniquely sorted by UTF-8 bytes.");
    }
    priorPath = pathBytes;
    const portableRoot = bytesToHex(reader.take(32, `entries[${index}].portableRoot`));
    const role = reader.u8(`entries[${index}].role`);
    const executable = reader.u8(`entries[${index}].executable`);
    if (!graphRoles.has(role)) throw new RangeError(`entries[${index}].role is unsupported.`);
    if (executable > 1) throw new TypeError(`entries[${index}].executable must use canonical 0 or 1 encoding.`);
    entries.push({ path, portableRoot, role: role as PortableGraphRole, executable: executable === 1 });
  }
  reader.finish();
  const graph = { entrypoint, entries };
  encodePortableGraphV1(graph);
  return graph;
}

export async function portableGraphRootV1(graph: PortableGraphV1 | Uint8Array): Promise<Bytes32Hex> {
  if (graph instanceof Uint8Array) decodePortableGraphV1(graph);
  return sha256Hex(graph instanceof Uint8Array ? graph : encodePortableGraphV1(graph));
}

function boundedLimit(value: number | undefined, fallback: number, hardMaximum: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > hardMaximum) {
    throw new RangeError(`${name} must be an integer in 1..${hardMaximum}.`);
  }
  return resolved;
}

/**
 * Resolves a complete address-neutral graph through portable roots only. The
 * caller supplies chain/IPFS/Ord retrieval; this verifier supplies identity,
 * recursion, cycle, and resource-limit enforcement.
 */
export async function verifyPortableGraphTreeV1(
  root: Bytes32Hex,
  loader: PortableObjectLoaderV1,
  overrides: PortableResolveLimitsV1 = {},
): Promise<PortableGraphVerificationReceiptV1> {
  fixedHex(root, 32, "portable graph root");
  if (loader === null || typeof loader !== "object" || typeof loader.loadManifest !== "function" || typeof loader.loadDecoded !== "function") {
    throw new TypeError("portable graph loader must provide loadManifest and loadDecoded.");
  }
  const limits = {
    maxDepth: boundedLimit(overrides.maxDepth, PORTABLE_MAX_GRAPH_DEPTH, PORTABLE_MAX_GRAPH_DEPTH, "maxDepth"),
    maxObjects: boundedLimit(overrides.maxObjects, PORTABLE_MAX_GRAPH_OBJECTS, PORTABLE_MAX_GRAPH_OBJECTS, "maxObjects"),
    maxGraphEntries: boundedLimit(overrides.maxGraphEntries, PORTABLE_MAX_GRAPH_ENTRIES, PORTABLE_MAX_GRAPH_ENTRIES, "maxGraphEntries"),
    maxManifestBytes: boundedLimit(overrides.maxManifestBytes, PORTABLE_MAX_MANIFEST_BYTES, PORTABLE_MAX_MANIFEST_BYTES, "maxManifestBytes"),
    maxObjectBytes: boundedLimit(overrides.maxObjectBytes, PORTABLE_MAX_OBJECT_BYTES, PORTABLE_MAX_OBJECT_BYTES, "maxObjectBytes"),
    maxTotalDecodedBytes: boundedLimit(overrides.maxTotalDecodedBytes, PORTABLE_MAX_DECODED_BYTES, PORTABLE_MAX_DECODED_BYTES, "maxTotalDecodedBytes"),
  };
  const verified = new Map<string, PortableManifestV1>();
  const verifiedRoots: Bytes32Hex[] = [];
  let graphCount = 0;
  let totalDecodedBytes = 0n;

  const visit = async (portableRoot: Bytes32Hex, depth: number, ancestors: ReadonlySet<string>): Promise<PortableManifestV1> => {
    fixedHex(portableRoot, 32, "child portable root");
    const normalizedRoot = portableRoot.toLowerCase() as Bytes32Hex;
    if (ancestors.has(normalizedRoot)) throw new Error(`Portable graph cycle detected at ${normalizedRoot}.`);
    // Depth belongs to the current traversal path, not the cached object. A
    // node first verified shallowly must not bypass the limit on a deeper path.
    if (depth > limits.maxDepth) throw new RangeError(`Portable graph recursion exceeds ${limits.maxDepth}.`);
    const cached = verified.get(normalizedRoot);
    if (cached !== undefined) return cached;
    if (verified.size >= limits.maxObjects) throw new RangeError(`Portable graph exceeds ${limits.maxObjects} objects.`);

    const manifestBytes = await loader.loadManifest(normalizedRoot);
    if (!(manifestBytes instanceof Uint8Array)) throw new TypeError("portable manifest loader must return Uint8Array.");
    if (manifestBytes.byteLength > limits.maxManifestBytes) {
      throw new RangeError(`Portable manifest exceeds ${limits.maxManifestBytes} bytes.`);
    }
    const actualRoot = await portableRootV1(manifestBytes);
    if (actualRoot.toLowerCase() !== normalizedRoot) throw new Error("Portable manifest bytes do not match the requested root.");
    const manifest = decodePortableManifestV1(manifestBytes);
    if (manifest.decodedByteLength > BigInt(limits.maxObjectBytes)) {
      throw new RangeError(`Portable object exceeds ${limits.maxObjectBytes} decoded bytes.`);
    }
    if (totalDecodedBytes + manifest.decodedByteLength > BigInt(limits.maxTotalDecodedBytes)) {
      throw new RangeError(`Portable graph exceeds ${limits.maxTotalDecodedBytes} total decoded bytes.`);
    }
    const decodedBytes = await loader.loadDecoded(normalizedRoot, manifest);
    await verifyPortableContentV1(manifest, decodedBytes);
    totalDecodedBytes += manifest.decodedByteLength;
    verified.set(normalizedRoot, manifest);
    verifiedRoots.push(normalizedRoot);

    if (manifest.resourceKind === PortableResourceKind.Graph) {
      if (manifest.mediaType !== "application/octet-stream") {
        throw new TypeError("Portable graph objects must use application/octet-stream.");
      }
      const graph = decodePortableGraphV1(decodedBytes);
      if (graph.entries.length > limits.maxGraphEntries) {
        throw new RangeError(`Portable graph exceeds ${limits.maxGraphEntries} entries.`);
      }
      graphCount += 1;
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(normalizedRoot);
      for (const entry of graph.entries) await visit(entry.portableRoot, depth + 1, nextAncestors);
    }
    return manifest;
  };

  const rootManifest = await visit(root, 0, new Set());
  if (rootManifest.resourceKind !== PortableResourceKind.Graph) {
    throw new TypeError("Portable graph root must identify a Graph resource.");
  }
  return { root: root.toLowerCase() as Bytes32Hex, objectCount: verified.size, graphCount, totalDecodedBytes, verifiedRoots };
}

function validateManifest(manifest: PortableManifestV1): void {
  if (!resourceKinds.has(manifest.resourceKind)) throw new RangeError("Unsupported portable resource kind.");
  if (!compressions.has(manifest.compression)) throw new RangeError("Unsupported portable compression.");
  if (!mediaTypes.has(manifest.mediaType)) throw new TypeError("Unsupported portable media type.");
  assertU64(manifest.decodedByteLength, "decodedByteLength");
  assertU64(manifest.revision, "revision");
  fixedHex(manifest.decodedSha256, 32, "decodedSha256");
  fixedHex(manifest.metadataSha256, 32, "metadataSha256");
  fixedHex(manifest.chunkRoot, 32, "chunkRoot");
  fixedHex(manifest.lineageId, 32, "lineageId");
  fixedHex(manifest.parentPortableRoot, 32, "parentPortableRoot");
  if (!editPolicies.has(manifest.editPolicy)) throw new RangeError("Unsupported portable edit policy.");
  fixedHex(manifest.controllerId, 32, "controllerId");
  if (typeof manifest.frozen !== "boolean") throw new TypeError("frozen must be boolean.");
}

export function encodePortableManifestV1(manifest: PortableManifestV1): Uint8Array {
  validateManifest(manifest);
  const mediaType = utf8ToBytes(manifest.mediaType);
  return concatBytes([
    utf8ToBytes(PORTABLE_OBJECT_DOMAIN),
    u8(manifest.resourceKind),
    u8(manifest.compression),
    u16be(mediaType.byteLength),
    mediaType,
    u64be(manifest.decodedByteLength),
    fixedHex(manifest.decodedSha256, 32, "decodedSha256"),
    fixedHex(manifest.metadataSha256, 32, "metadataSha256"),
    fixedHex(manifest.chunkRoot, 32, "chunkRoot"),
    fixedHex(manifest.lineageId, 32, "lineageId"),
    u64be(manifest.revision),
    fixedHex(manifest.parentPortableRoot, 32, "parentPortableRoot"),
    u8(manifest.editPolicy),
    fixedHex(manifest.controllerId, 32, "controllerId"),
    u8(manifest.frozen ? 1 : 0),
  ]);
}

export function decodePortableManifestV1(bytes: Uint8Array): PortableManifestV1 {
  const reader = new Reader(bytes);
  expectFixed(reader.take(utf8ToBytes(PORTABLE_OBJECT_DOMAIN).byteLength, "portable domain"), utf8ToBytes(PORTABLE_OBJECT_DOMAIN), "portable domain");
  const resourceKind = reader.u8("resourceKind");
  const compression = reader.u8("compression");
  const mediaTypeLength = reader.u16("mediaTypeLength");
  const mediaType = bytesToUtf8(reader.take(mediaTypeLength, "mediaType"));
  const decodedByteLength = reader.u64("decodedByteLength");
  const decodedSha256 = bytesToHex(reader.take(32, "decodedSha256"));
  const metadataSha256 = bytesToHex(reader.take(32, "metadataSha256"));
  const chunkRoot = bytesToHex(reader.take(32, "chunkRoot"));
  const lineageId = bytesToHex(reader.take(32, "lineageId"));
  const revision = reader.u64("revision");
  const parentPortableRoot = bytesToHex(reader.take(32, "parentPortableRoot"));
  const editPolicy = reader.u8("editPolicy");
  const controllerId = bytesToHex(reader.take(32, "controllerId"));
  const frozenByte = reader.u8("frozen");
  reader.finish();
  if (frozenByte !== 0 && frozenByte !== 1) throw new TypeError("frozen must use canonical 0 or 1 encoding.");
  const manifest = {
    resourceKind,
    compression,
    mediaType,
    decodedByteLength,
    decodedSha256,
    metadataSha256,
    chunkRoot,
    lineageId,
    revision,
    parentPortableRoot,
    editPolicy,
    controllerId,
    frozen: frozenByte === 1,
  } as PortableManifestV1;
  validateManifest(manifest);
  return manifest;
}

export async function portableRootV1(manifest: PortableManifestV1 | Uint8Array): Promise<Bytes32Hex> {
  if (manifest instanceof Uint8Array) decodePortableManifestV1(manifest);
  return sha256Hex(manifest instanceof Uint8Array ? manifest : encodePortableManifestV1(manifest));
}

export function encodePortableAnchorV1(anchor: PortableAnchorV1): Uint8Array {
  if (!sourceFamilies.has(anchor.sourceFamily)) throw new RangeError("Unsupported portable source family.");
  assertInteger(anchor.sourceNetwork, MAX_U32, "sourceNetwork");
  assertU64(anchor.sourceRevision, "sourceRevision");
  return concatBytes([
    utf8ToBytes(PORTABLE_ANCHOR_DOMAIN),
    fixedHex(anchor.portableRoot, 32, "portableRoot"),
    u8(anchor.sourceFamily),
    u32be(anchor.sourceNetwork),
    fixedHex(anchor.sourceRegistry, 32, "sourceRegistry"),
    fixedHex(anchor.sourceObjectKey, 32, "sourceObjectKey"),
    u64be(anchor.sourceRevision),
    fixedHex(anchor.sourceEventDigest, 32, "sourceEventDigest"),
  ]);
}

export function decodePortableAnchorV1(bytes: Uint8Array): PortableAnchorV1 {
  const reader = new Reader(bytes);
  expectFixed(reader.take(utf8ToBytes(PORTABLE_ANCHOR_DOMAIN).byteLength, "anchor domain"), utf8ToBytes(PORTABLE_ANCHOR_DOMAIN), "anchor domain");
  const portableRoot = bytesToHex(reader.take(32, "portableRoot"));
  const sourceFamily = reader.u8("sourceFamily");
  const sourceNetwork = reader.u32("sourceNetwork");
  const sourceRegistry = bytesToHex(reader.take(32, "sourceRegistry"));
  const sourceObjectKey = bytesToHex(reader.take(32, "sourceObjectKey"));
  const sourceRevision = reader.u64("sourceRevision");
  const sourceEventDigest = bytesToHex(reader.take(32, "sourceEventDigest"));
  reader.finish();
  const anchor = {
    portableRoot,
    sourceFamily,
    sourceNetwork,
    sourceRegistry,
    sourceObjectKey,
    sourceRevision,
    sourceEventDigest,
  } as PortableAnchorV1;
  encodePortableAnchorV1(anchor);
  return anchor;
}

export async function portableAnchorRootV1(anchor: PortableAnchorV1): Promise<Bytes32Hex> {
  return sha256Hex(encodePortableAnchorV1(anchor));
}

export async function ordinalsTargetDigestV1(anchorRoot: Bytes32Hex): Promise<Bytes16Hex> {
  const root = fixedHex(anchorRoot, 32, "anchorRoot");
  const digest = hexToBytes(await sha256Hex(concatBytes([utf8ToBytes(ORDINALS_TARGET_DOMAIN), root])));
  return bytesToHex(digest.slice(0, 16)) as Bytes16Hex;
}

export function encodeOrdinalsPortableCommitmentV1(commitment: OrdinalsPortableCommitmentV1): Uint8Array {
  if (commitment.flags !== 0) throw new RangeError("Ordinals portable v1 reserves all flag bits; flags must be zero.");
  assertInteger(commitment.envelopeIndex, MAX_U32, "envelopeIndex");
  assertU64(commitment.revision, "revision");
  return concatBytes([
    utf8ToBytes(ORDINALS_PORTABLE_MAGIC),
    u8(ORDINALS_PORTABLE_VERSION),
    u8(commitment.flags),
    u32be(commitment.envelopeIndex),
    u64be(commitment.revision),
    fixedHex(commitment.portableRoot, 32, "portableRoot"),
    fixedHex(commitment.targetDigest, 16, "targetDigest"),
  ]);
}

export function decodeOrdinalsPortableCommitmentV1(bytes: Uint8Array): OrdinalsPortableCommitmentV1 {
  const reader = new Reader(bytes);
  expectFixed(reader.take(4, "STRP magic"), utf8ToBytes(ORDINALS_PORTABLE_MAGIC), "STRP magic");
  if (reader.u8("STRP version") !== ORDINALS_PORTABLE_VERSION) throw new RangeError("Unsupported STRP version.");
  const flags = reader.u8("STRP flags");
  const envelopeIndex = reader.u32("envelopeIndex");
  const revision = reader.u64("revision");
  const portableRoot = bytesToHex(reader.take(32, "portableRoot"));
  const targetDigest = bytesToHex(reader.take(16, "targetDigest"));
  reader.finish();
  const commitment = { flags, envelopeIndex, revision, portableRoot, targetDigest } as OrdinalsPortableCommitmentV1;
  encodeOrdinalsPortableCommitmentV1(commitment);
  return commitment;
}
