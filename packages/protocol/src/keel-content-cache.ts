import { utf8ToBytes } from "./bytes.js";
import { sha256Hex, verifyIntegrity, type CustomDigest } from "./integrity.js";
import type { Hex, Integrity } from "./types.js";

export const KEEL_CONTENT_CACHE_PROTOCOL = "keel-content-cache@1" as const;

/**
 * Stable identity for a byte-exact Keel resource. `version` must change
 * whenever the authoritative source can return different bytes.
 */
export interface KeelContentIdentity {
  readonly namespace: string;
  readonly chainId: number;
  readonly source: string;
  readonly objectKey: string;
  readonly revision: string;
  readonly version: string;
  readonly variant?: string;
}

export interface KeelContentRecord {
  readonly protocol: typeof KEEL_CONTENT_CACHE_PROTOCOL;
  readonly key: string;
  readonly identity: KeelContentIdentity;
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  readonly sha256: Hex;
  readonly mediaType: string;
  readonly sourceUriSha256?: Hex;
  readonly provenance?: Readonly<Record<string, string>>;
  readonly cachedAt: string;
}

export interface KeelContentCache {
  get(key: string): Promise<KeelContentRecord | undefined>;
  put(record: KeelContentRecord): Promise<void>;
}

export interface LoadedKeelContent {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly sourceUri?: string;
  readonly provenance?: Readonly<Record<string, string>>;
}

export interface ResolveKeelContentInput {
  readonly identity: KeelContentIdentity;
  readonly cache?: KeelContentCache;
  readonly expectedIntegrity?: Integrity;
  readonly customDigest?: CustomDigest;
  readonly allowedMediaTypes?: readonly string[];
  readonly load: () => Promise<LoadedKeelContent>;
  readonly now?: () => Date;
}

export interface ResolvedKeelContent extends KeelContentRecord {
  readonly cacheStatus: "hit" | "miss";
  readonly etag: string;
}

function component(value: string): string {
  return encodeURIComponent(value.trim().toLowerCase());
}

export function keelContentCacheKey(identity: KeelContentIdentity): string {
  if (!Number.isSafeInteger(identity.chainId) || identity.chainId < 0) {
    throw new RangeError("Keel cache chainId must be a non-negative safe integer.");
  }
  const values = [identity.namespace, identity.source, identity.objectKey, identity.revision, identity.version];
  if (values.some((value) => value.trim().length === 0)) {
    throw new TypeError("Keel cache identity fields cannot be empty.");
  }
  return [
    KEEL_CONTENT_CACHE_PROTOCOL,
    String(identity.chainId),
    ...values.map(component),
    component(identity.variant ?? "default"),
  ].join(":");
}

export function decodeKeelDataUri(uri: string, expectedMediaType?: string): LoadedKeelContent {
  const match = /^data:([^;,]+)(?:;charset=[^;,]+)?(;base64)?,([\s\S]*)$/u.exec(uri);
  if (!match) throw new TypeError("Expected an inline data URI.");
  const mediaType = (match[1] ?? "text/plain").toLowerCase();
  if (expectedMediaType !== undefined && mediaType !== expectedMediaType.toLowerCase()) {
    throw new TypeError(`Expected ${expectedMediaType}; received ${mediaType}.`);
  }
  const payload = match[3] ?? "";
  const bytes = match[2]
    ? Uint8Array.from(globalThis.atob(payload), (character) => character.charCodeAt(0))
    : utf8ToBytes(decodeURIComponent(payload));
  return { bytes, mediaType, sourceUri: uri };
}

async function validRecord(
  record: KeelContentRecord,
  key: string,
  expectedIntegrity: Integrity | undefined,
  customDigest: CustomDigest | undefined,
  allowedMediaTypes: readonly string[] | undefined,
): Promise<boolean> {
  if (record.protocol !== KEEL_CONTENT_CACHE_PROTOCOL || record.key !== key) return false;
  if (record.byteLength !== record.bytes.byteLength) return false;
  if ((await sha256Hex(record.bytes)) !== record.sha256.toLowerCase()) return false;
  if (allowedMediaTypes !== undefined && !allowedMediaTypes.includes(record.mediaType.toLowerCase())) return false;
  return expectedIntegrity === undefined || verifyIntegrity(record.bytes, expectedIntegrity, customDigest);
}

function etag(sha256: Hex): string {
  return `"keel-${sha256.slice(2).toLowerCase()}"`;
}

export async function resolveKeelContent(input: ResolveKeelContentInput): Promise<ResolvedKeelContent> {
  const key = keelContentCacheKey(input.identity);
  const cached = await input.cache?.get(key);
  if (
    cached !== undefined &&
    (await validRecord(cached, key, input.expectedIntegrity, input.customDigest, input.allowedMediaTypes))
  ) {
    return { ...cached, bytes: cached.bytes.slice(), cacheStatus: "hit", etag: etag(cached.sha256) };
  }

  const loaded = await input.load();
  const mediaType = loaded.mediaType.toLowerCase();
  if (input.allowedMediaTypes !== undefined && !input.allowedMediaTypes.includes(mediaType)) {
    throw new TypeError(`Keel content type ${mediaType} is not allowed.`);
  }
  if (
    input.expectedIntegrity !== undefined &&
    !(await verifyIntegrity(loaded.bytes, input.expectedIntegrity, input.customDigest))
  ) {
    throw new Error("Keel content failed its authoritative integrity check.");
  }
  const sha256 = await sha256Hex(loaded.bytes);
  const record: KeelContentRecord = {
    protocol: KEEL_CONTENT_CACHE_PROTOCOL,
    key,
    identity: input.identity,
    bytes: loaded.bytes.slice(),
    byteLength: loaded.bytes.byteLength,
    sha256,
    mediaType,
    ...(loaded.sourceUri === undefined ? {} : { sourceUriSha256: await sha256Hex(utf8ToBytes(loaded.sourceUri)) }),
    ...(loaded.provenance === undefined ? {} : { provenance: loaded.provenance }),
    cachedAt: (input.now?.() ?? new Date()).toISOString(),
  };
  await input.cache?.put(record);
  return { ...record, bytes: record.bytes.slice(), cacheStatus: "miss", etag: etag(sha256) };
}

export function createMemoryKeelContentCache(): KeelContentCache {
  const records = new Map<string, KeelContentRecord>();
  return {
    async get(key) {
      const record = records.get(key);
      return record === undefined ? undefined : { ...record, bytes: record.bytes.slice() };
    },
    async put(record) {
      records.set(record.key, { ...record, bytes: record.bytes.slice() });
    },
  };
}
