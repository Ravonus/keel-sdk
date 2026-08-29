import {
  KEEL_WAKE_STORAGE_MODE,
  KEEL_WAKE_URI_PREFIX,
  tryParseKeelWakeUri,
  verifyIntegrity,
  type KeelWakeUriParts,
} from "@keel/protocol";
import type { VerifiedWakeProvenance, WakeObjectReadResult } from "./types.js";

export { KEEL_WAKE_URI_PREFIX };
export type KeelWakeLocator = KeelWakeUriParts;

/** Strictly recognizes the shared KEEL Wake resolver grammar, not generic URI sources. */
export function parseKeelWakeUri(value: string): KeelWakeLocator | undefined {
  return tryParseKeelWakeUri(value);
}

/** Validates the adapter boundary before bytes enter manifest or resource resolution. */
export async function verifyKeelWakeObjectRead(
  locator: KeelWakeLocator,
  result: WakeObjectReadResult,
): Promise<VerifiedWakeProvenance> {
  if (locator.kind !== "object") {
    throw new Error("KEEL Wake chunk URIs are transport-only and cannot be read as executable objects.");
  }
  if (!(result.bytes instanceof Uint8Array)) throw new TypeError("KEEL Wake reader returned invalid bytes.");
  const provenance = result.provenance;
  if (provenance.protocol !== "keel-wake@1" || provenance.storageMode !== KEEL_WAKE_STORAGE_MODE || provenance.verified !== true) {
    throw new Error("KEEL Wake reader did not return a fully verified history-inscribed object.");
  }
  if (provenance.chainId !== locator.chainId
    || provenance.coordinator !== locator.coordinator
    || provenance.publicationId !== locator.publicationId) {
    throw new Error("KEEL Wake provenance does not match the requested canonical locator.");
  }
  if (!/^0x[0-9a-f]{40}$/u.test(provenance.coordinator)
    || !/^0x[0-9a-f]{64}$/u.test(provenance.storedDigest)
    || !/^0x[0-9a-f]{64}$/u.test(provenance.decodedDigest)) {
    throw new TypeError("KEEL Wake provenance contains an invalid chain commitment.");
  }
  if (!Number.isSafeInteger(provenance.decodedByteLength) || provenance.decodedByteLength < 0
    || provenance.decodedByteLength !== result.bytes.byteLength
    || !Number.isSafeInteger(provenance.storedByteLength) || provenance.storedByteLength < 0
    || !Number.isSafeInteger(provenance.batchCount) || provenance.batchCount < 0 || provenance.batchCount > 4096
    || !Number.isSafeInteger(provenance.chunkCount) || provenance.chunkCount < 0 || provenance.chunkCount > 4096) {
    throw new RangeError("KEEL Wake provenance contains invalid byte or batch lengths.");
  }
  if (!["none", "gzip", "deflate", "brotli"].includes(provenance.compression)
    || !["rpc-history", "archive", "cache"].includes(provenance.retrievalSource)) {
    throw new TypeError("KEEL Wake provenance contains an unsupported compression or retrieval source.");
  }
  if (!(await verifyIntegrity(result.bytes, { algorithm: "sha256", digest: provenance.decodedDigest }))) {
    throw new Error("KEEL Wake decoded bytes do not match the verified decoded digest.");
  }
  return provenance;
}
