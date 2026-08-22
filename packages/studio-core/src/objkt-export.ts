import { canonicalJson, createIntegrity, utf8ToBytes, type Hex, type Integrity } from "@keel/protocol";

import type { PreparedStudioArtifact, PreparedStudioResource } from "./types.js";

export const OBJKT_INTERACTIVE_ARCHIVE_MAX_BYTES = 250_000_000;
export const KEEL_OBJKT_EXPORT_PROTOCOL = "keel-objkt-export@1" as const;

export type KeelMarketplaceExportMode = "packed" | "hybrid" | "onchfs" | "recursive";

export interface KeelObjktExportFile {
  readonly path: string;
  readonly integrity: Integrity;
  readonly sourceResourceId?: string;
}

export interface KeelObjktExport {
  readonly protocol: typeof KEEL_OBJKT_EXPORT_PROTOCOL;
  readonly mode: "packed" | "hybrid";
  readonly archive: Uint8Array;
  readonly archiveIntegrity: Integrity;
  readonly root: "index.html";
  readonly sourceManifestDigest: Hex;
  readonly files: readonly KeelObjktExportFile[];
}

interface ZipInput {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly sourceResourceId?: string;
}

const encoder = new TextEncoder();
const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTable[index] = value >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = (crcTable[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function u16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function safeArchivePath(input: string): string {
  const value = input.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (
    value.length === 0 || value.startsWith("/") || value.endsWith("/") || value.includes("//") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) throw new TypeError(`OBJKT export path is unsafe: ${input}`);
  return value;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function rootDocument(entrypointPath: string): Uint8Array {
  return utf8ToBytes(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Keel interactive artifact</title><style>html,body,iframe{width:100%;height:100%;margin:0;border:0;overflow:hidden;background:#05060b}</style></head><body><iframe title="Keel interactive artifact" src="./${escapeAttribute(entrypointPath)}" sandbox="allow-scripts allow-downloads allow-pointer-lock allow-same-origin"></iframe></body></html>`);
}

/** Build a deterministic STORE-only ZIP. Compression already happens in Keel;
 * repeating DEFLATE here would make the compatibility artifact non-reproducible
 * across runtimes without reducing already-compressed libraries and assets. */
function deterministicZip(inputs: readonly ZipInput[]): Uint8Array {
  if (inputs.length === 0 || inputs.length > 0xffff) throw new RangeError("OBJKT ZIP must contain from 1 through 65535 files.");
  const seen = new Set<string>();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  for (const input of inputs) {
    const path = safeArchivePath(input.path);
    if (seen.has(path)) throw new TypeError(`OBJKT ZIP contains duplicate path ${path}.`);
    seen.add(path);
    if (input.bytes.byteLength > 0xffffffff) throw new RangeError(`OBJKT ZIP file ${path} exceeds ZIP32 limits.`);
    const name = encoder.encode(path);
    const checksum = crc32(input.bytes);
    const common = [u16(0x0800), u16(0), u16(0), u16(0x0021), u32(checksum), u32(input.bytes.byteLength), u32(input.bytes.byteLength), u16(name.byteLength), u16(0)] as const;
    const local = concat([u32(0x04034b50), u16(20), ...common, name, input.bytes]);
    localParts.push(local);
    centralParts.push(concat([
      u32(0x02014b50), u16(20), u16(20), ...common,
      u16(0), u16(0), u16(0), u32(0), u32(offset), name,
    ]));
    offset += local.byteLength;
  }
  const central = concat(centralParts);
  const end = concat([u32(0x06054b50), u16(0), u16(0), u16(inputs.length), u16(inputs.length), u32(central.byteLength), u32(offset), u16(0)]);
  const archive = concat([...localParts, central, end]);
  if (archive.byteLength > OBJKT_INTERACTIVE_ARCHIVE_MAX_BYTES) {
    throw new RangeError(`OBJKT ZIP is ${archive.byteLength} bytes; the marketplace limit is ${OBJKT_INTERACTIVE_ARCHIVE_MAX_BYTES}.`);
  }
  return archive;
}

function entrypointResource(prepared: PreparedStudioArtifact): PreparedStudioResource {
  const entrypoint = prepared.resources.find((item) => item.resource.id === prepared.manifest.entrypoint.resource);
  if (entrypoint === undefined || entrypoint.resource.mediaType !== "text/html") {
    throw new TypeError("OBJKT interactive export requires a committed HTML entrypoint.");
  }
  return entrypoint;
}

async function exportFiles(prepared: PreparedStudioArtifact, mode: "packed" | "hybrid"): Promise<readonly ZipInput[]> {
  const entrypoint = entrypointResource(prepared);
  if (mode === "hybrid") {
    const source = new TextDecoder().decode(entrypoint.decodedBytes);
    if (!source.includes(KEEL_OBJKT_EXPORT_PROTOCOL.replace("objkt-export", "standalone-viewer")) || !source.includes("keel-verification-envelope")) {
      throw new TypeError("Hybrid OBJKT export requires the self-verifying Keel standalone entrypoint; raw HTML with omitted dependencies is rejected.");
    }
  }
  const resources = mode === "packed" ? prepared.resources : [entrypoint];
  const files: ZipInput[] = resources.map((item) => ({
    path: safeArchivePath(item.fileName),
    bytes: item.decodedBytes,
    sourceResourceId: item.resource.id,
  }));
  const entrypointPath = safeArchivePath(entrypoint.fileName);
  if (entrypointPath !== "index.html") files.unshift({ path: "index.html", bytes: rootDocument(entrypointPath) });
  const receipt = {
    protocol: KEEL_OBJKT_EXPORT_PROTOCOL,
    mode,
    sourceManifest: prepared.manifestIntegrity,
    entrypoint: { resourceId: entrypoint.resource.id, path: entrypointPath },
    resources: resources.map((item) => ({ id: item.resource.id, path: safeArchivePath(item.fileName), integrity: item.decodedIntegrity })),
    zip: { root: "index.html", method: "store", timestamp: "1980-01-01T00:00:00.000Z" },
  } as const;
  files.push({ path: "keel-export.json", bytes: utf8ToBytes(canonicalJson(receipt)) });
  return files;
}

/**
 * Materialize an OBJKT compatibility ZIP from one canonical Keel artifact.
 *
 * `packed` copies every already-resolved Keel resource into the archive.
 * `hybrid` packages only the self-verifying HTML entrypoint; that entrypoint is
 * responsible for retrieving committed URL/on-chain sources and failing closed.
 * `recursive` deliberately has no OBJKT ZIP and should use the native Keel
 * resolver instead.
 */
export async function buildKeelObjktExport(
  prepared: PreparedStudioArtifact,
  mode: "packed" | "hybrid",
): Promise<KeelObjktExport> {
  const inputs = await exportFiles(prepared, mode);
  if (!inputs.some((input) => input.path === "index.html")) throw new Error("OBJKT ZIP root index.html is missing.");
  const archive = deterministicZip(inputs);
  const [archiveIntegrity, ...integrities] = await Promise.all([
    createIntegrity(archive),
    ...inputs.map((input) => createIntegrity(input.bytes)),
  ]);
  return {
    protocol: KEEL_OBJKT_EXPORT_PROTOCOL,
    mode,
    archive,
    archiveIntegrity,
    root: "index.html",
    sourceManifestDigest: prepared.manifestIntegrity.digest,
    files: inputs.map((input, index) => ({
      path: input.path,
      integrity: integrities[index] as Integrity,
      ...(input.sourceResourceId === undefined ? {} : { sourceResourceId: input.sourceResourceId }),
    })),
  };
}
