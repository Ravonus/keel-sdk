import type { EthereumAddress } from "./types.js";

/** Canonical product locator for history-inscribed KEEL objects. */
export const KEEL_WAKE_URI_PREFIX = "keel://wake/eip155" as const;
export const KEEL_WAKE_STORAGE_MODE = "history-inscription-v1" as const;
export const KEEL_WAKE_PRODUCT_NAME = "KEEL Wake" as const;
export const KEEL_ORD_URI_PREFIX = "ord://" as const;

export type KeelWakeUriKind = "object" | "chunk";

/** Ethereum identity and optional transport-chunk identity in a KEEL Wake URI. */
export interface KeelWakeUriParts {
  readonly kind: KeelWakeUriKind;
  readonly chainId: number;
  readonly coordinator: EthereumAddress;
  readonly publicationId: bigint;
  /** Stored transport chunk index; present only for a chunk URI. */
  readonly chunkIndex?: bigint;
}

/** Backward-compatible object formatter input; chunk URIs must be explicit. */
export type KeelWakeUriInput =
  | {
    readonly kind?: "object";
    readonly chainId: number;
    readonly coordinator: EthereumAddress;
    readonly publicationId: bigint;
    readonly chunkIndex?: undefined;
  }
  | {
    readonly kind: "chunk";
    readonly chainId: number;
    readonly coordinator: EthereumAddress;
    readonly publicationId: bigint;
    readonly chunkIndex: bigint;
  };

const WAKE_URI = /^keel:\/\/wake\/eip155\/([1-9][0-9]*)\/(0x[0-9a-f]{40})\/(0|[1-9][0-9]*)(?:\/chunk\/(0|[1-9][0-9]*))?$/u;
const ADDRESS = /^0x[0-9a-f]{40}$/u;
const KEEL_WAKE_NAMESPACE_PREFIX = "keel://wake/";

function validateParts(input: KeelWakeUriInput | KeelWakeUriParts): void {
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) {
    throw new RangeError("KEEL Wake chain ID must be a positive safe integer.");
  }
  if (!ADDRESS.test(input.coordinator)) {
    throw new TypeError("KEEL Wake coordinator must be a lowercase Ethereum address.");
  }
  if (typeof input.publicationId !== "bigint" || input.publicationId < 0n) {
    throw new RangeError("KEEL Wake publication ID must be a non-negative integer.");
  }
  const kind = input.kind ?? "object";
  if (kind === "chunk") {
    if (typeof input.chunkIndex !== "bigint" || input.chunkIndex < 0n) {
      throw new RangeError("KEEL Wake chunk index must be a non-negative integer.");
    }
  } else if (input.chunkIndex !== undefined) {
    throw new TypeError("KEEL Wake object URIs cannot contain a chunk index.");
  }
}

/** Formats a canonical whole-object or explicitly transport-chunk URI. */
export function formatKeelWakeUri(input: KeelWakeUriInput | KeelWakeUriParts): string {
  validateParts(input);
  const kind = input.kind ?? "object";
  const base = `${KEEL_WAKE_URI_PREFIX}/${input.chainId}/${input.coordinator}/${input.publicationId}`;
  return kind === "chunk" ? `${base}/chunk/${input.chunkIndex}` : base;
}

/** Compatibility name for callers that use builders rather than formatters. */
export const buildKeelWakeUri = formatKeelWakeUri;

/** Parses only the canonical KEEL Wake URI and distinguishes object/chunk transport. */
export function parseKeelWakeUri(value: string): KeelWakeUriParts {
  const match = WAKE_URI.exec(value);
  if (match === null) throw new TypeError("Invalid KEEL Wake URI.");
  const chainText = match[1];
  const coordinatorText = match[2];
  const publicationText = match[3];
  const chunkText = match[4];
  if (chainText === undefined || coordinatorText === undefined || publicationText === undefined) {
    throw new TypeError("Invalid KEEL Wake URI.");
  }
  const chainId = Number(chainText);
  const coordinator = coordinatorText as EthereumAddress;
  const publicationId = BigInt(publicationText);
  const kind: KeelWakeUriKind = chunkText === undefined ? "object" : "chunk";
  const parsed: KeelWakeUriParts = chunkText === undefined
    ? { kind, chainId, coordinator, publicationId }
    : { kind, chainId, coordinator, publicationId, chunkIndex: BigInt(chunkText) };
  validateParts(parsed);
  if (formatKeelWakeUri(parsed) !== value) throw new TypeError("KEEL Wake URI is not canonical.");
  return Object.freeze(parsed);
}

/** Returns undefined for unrelated URI schemes; malformed Wake prefixes still fail closed. */
export function tryParseKeelWakeUri(value: string): KeelWakeUriParts | undefined {
  if (!value.startsWith(KEEL_WAKE_NAMESPACE_PREFIX)) return undefined;
  return parseKeelWakeUri(value);
}

export function isKeelWakeUri(value: string): boolean {
  try {
    parseKeelWakeUri(value);
    return true;
  } catch {
    return false;
  }
}

/** Manifest/resource locators may use whole objects only; chunk URIs stay transport-only. */
export function isKeelWakeObjectUri(value: string): boolean {
  try {
    return parseKeelWakeUri(value).kind === "object";
  } catch {
    return false;
  }
}

/** Bitcoin inscriptions retain their separate ord:// identity. */
export function isOrdinalUri(value: string): boolean {
  return value.startsWith(KEEL_ORD_URI_PREFIX);
}
