import { bytesToHex, equalBytes, hexToBytes, toBufferSource, utf8ToBytes } from "./bytes.js";
import { canonicalJson } from "./canonical.js";
import type { ArtifactManifest, DigestAlgorithm, Integrity } from "./types.js";

export type CustomDigest = (algorithm: Exclude<DigestAlgorithm, "none" | "sha256">, bytes: Uint8Array) => Promise<Uint8Array>;

export async function digestBytes(
  algorithm: DigestAlgorithm,
  bytes: Uint8Array,
  customDigest?: CustomDigest,
): Promise<Uint8Array> {
  if (algorithm === "none") return new Uint8Array();

  if (algorithm === "sha256") {
    const subtle = globalThis.crypto?.subtle;
    if (subtle === undefined) {
      throw new Error("Web Crypto is unavailable; supply a custom digest adapter.");
    }
    return new Uint8Array(await subtle.digest("SHA-256", toBufferSource(bytes)));
  }

  if (customDigest === undefined) {
    throw new Error(`Digest algorithm ${algorithm} requires a custom digest adapter.`);
  }
  return customDigest(algorithm, bytes);
}

export async function createIntegrity(
  bytes: Uint8Array,
  algorithm: DigestAlgorithm = "sha256",
  customDigest?: CustomDigest,
): Promise<Integrity> {
  const digest = await digestBytes(algorithm, bytes, customDigest);
  return {
    algorithm,
    digest: bytesToHex(digest),
    byteLength: bytes.byteLength,
  };
}

export async function verifyIntegrity(
  bytes: Uint8Array,
  integrity: Integrity,
  customDigest?: CustomDigest,
): Promise<boolean> {
  if (integrity.byteLength !== undefined && integrity.byteLength !== bytes.byteLength) return false;
  if (integrity.algorithm === "none") return integrity.digest === "0x";
  const actual = await digestBytes(integrity.algorithm, bytes, customDigest);
  return equalBytes(actual, hexToBytes(integrity.digest));
}

export async function sha256Hex(bytes: Uint8Array): Promise<`0x${string}`> {
  return bytesToHex(await digestBytes("sha256", bytes));
}

export async function manifestIntegrity(manifest: ArtifactManifest): Promise<Integrity> {
  return createIntegrity(utf8ToBytes(canonicalJson(manifest)), "sha256");
}
