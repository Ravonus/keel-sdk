import { canonicalJson, createIntegrity, utf8ToBytes, type Integrity } from "@keel/protocol";
import { encodeAbiParameters, keccak256, stringToHex } from "viem";

import { ZERO_ADDRESS, ZERO_BYTES32, type Address, type Hex } from "./types.js";
import { normalizedAddress, normalizedBytes32 } from "./validation.js";

export const KEEL_PROTECTION_SHELL_NAME = "keel.shell.protection@1" as const;
export const KEEL_PROTECTION_SHELL_ID = keccak256(stringToHex(KEEL_PROTECTION_SHELL_NAME));
export const KEEL_INLINE_PROTECTION_SHELL_NAME = "keel.shell.inline-protection@1" as const;
export const KEEL_INLINE_PROTECTION_SHELL_ID = keccak256(stringToHex(KEEL_INLINE_PROTECTION_SHELL_NAME));
export const KEEL_CREATOR_SHELL_ID_DOMAIN = keccak256(stringToHex("keel.shell.creator.v1"));
export const KEEL_SHELL_MANIFEST_PROTOCOL = "keel-shell-manifest@1" as const;

export type KeelShellPayloadMode = "sandboxed-html" | "gzip-base64" | "pre-encoded-graph";

const MAX_SHELL_NAME_BYTES = 128;
const MAX_CONTEXT_BYTES = 4_096;

export interface KeelShellRegistrationInput {
  readonly builderAddress: Address;
  readonly shellId: Hex;
  readonly prefixObjectId: Hex;
  readonly suffixObjectId: Hex;
  readonly metadataObjectId: Hex;
  readonly payloadMode?: KeelShellPayloadMode;
}

export interface KeelShellDataURIInput {
  readonly builderAddress: Address;
  readonly artifactObjectId: Hex;
  readonly artifactDigest: Hex;
  /** Omit to select the canonical protection shell. */
  readonly shellId?: Hex;
  readonly contextJSON?: string;
}

export interface KeelRegisteredPreEncodedTokenURIInput {
  readonly builderAddress: Address;
  readonly shellId?: Hex;
  readonly objectId: Hex;
  readonly expectedDigest: Hex;
  readonly rawPrefix: string;
  readonly rawSuffix: string;
}

export interface KeelShellManifest {
  readonly protocol: typeof KEEL_SHELL_MANIFEST_PROTOCOL;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly creator: Address;
  readonly tags: readonly string[];
}

export interface CreateKeelShellManifestInput {
  readonly name: string;
  readonly description?: string;
  readonly version: string;
  readonly creator: Address;
  readonly tags?: readonly string[];
}

export interface KeelCreatorShellRegistrationInput {
  readonly builderAddress: Address;
  readonly salt: Hex;
  readonly prefixObjectId: Hex;
  readonly suffixObjectId: Hex;
  readonly metadataObjectId: Hex;
  readonly payloadMode?: KeelShellPayloadMode;
}

export interface KeelIndexedShell {
  readonly chainId: number;
  readonly builder: Address;
  readonly shellId: Hex;
  readonly creator: Address;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly tags: readonly string[];
  readonly payloadMode: KeelShellPayloadMode;
  readonly topObjectId: Hex;
  readonly bottomObjectId: Hex;
  readonly metadataObjectId: Hex;
  readonly metadataDigest: Hex;
}

/** Stable registry ID shared by contracts, SDKs, and publication records. */
export function keelShellId(name: string): Hex {
  const normalized = name.trim();
  const byteLength = new TextEncoder().encode(normalized).byteLength;
  if (byteLength === 0 || byteLength > MAX_SHELL_NAME_BYTES) {
    throw new RangeError(`shell name must be 1-${MAX_SHELL_NAME_BYTES.toString()} UTF-8 bytes.`);
  }
  return keccak256(stringToHex(normalized));
}

/** Creator-scoped immutable ID matching KeelHarnessBuilder.predictShellId. */
export function keelCreatorShellId(creator: Address, salt: Hex): Hex {
  const normalizedCreator = normalizedAddress(creator, ZERO_ADDRESS, "creator");
  const normalizedSalt = normalizedBytes32(salt, ZERO_BYTES32, "salt");
  if (normalizedCreator === ZERO_ADDRESS) throw new TypeError("creator cannot be zero.");
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "address" }, { type: "bytes32" }],
    [KEEL_CREATOR_SHELL_ID_DOMAIN, normalizedCreator, normalizedSalt],
  ));
}

function cleanShellText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError(`${label} must be 1-${maximum.toString()} printable characters.`);
  }
  return normalized;
}

function normalizedShellManifest(value: unknown): KeelShellManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("shell manifest must be a JSON object.");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set(["protocol", "name", "description", "version", "creator", "tags"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new TypeError("shell manifest contains unsupported fields.");
  if (input.protocol !== KEEL_SHELL_MANIFEST_PROTOCOL) throw new TypeError(`shell manifest protocol must be ${KEEL_SHELL_MANIFEST_PROTOCOL}.`);
  if (typeof input.name !== "string" || typeof input.description !== "string" || typeof input.version !== "string") {
    throw new TypeError("shell manifest name, description, and version must be text.");
  }
  if (typeof input.creator !== "string") throw new TypeError("shell manifest creator must be an address.");
  if (!Array.isArray(input.tags) || input.tags.some((tag) => typeof tag !== "string")) {
    throw new TypeError("shell manifest tags must be text values.");
  }
  const inputTags = input.tags as string[];
  const creator = normalizedAddress(input.creator as Address, ZERO_ADDRESS, "creator");
  if (creator === ZERO_ADDRESS) throw new TypeError("creator cannot be zero.");
  const tags = [...new Set(inputTags.map((tag) => tag.trim().toLowerCase()))].sort();
  if (
    tags.length !== inputTags.length
    || tags.length > 16
    || tags.some((tag, index) => tag !== inputTags[index] || !/^[a-z0-9][a-z0-9-]{0,31}$/u.test(tag))
  ) {
    throw new TypeError("shell tags must be sorted unique lowercase kebab-case values, at most 16 entries.");
  }
  const description = input.description === "" ? "" : cleanShellText(input.description, "description", 512);
  return Object.freeze({
    protocol: KEEL_SHELL_MANIFEST_PROTOCOL,
    name: cleanShellText(input.name, "name", 96),
    description,
    version: cleanShellText(input.version, "version", 32),
    creator,
    tags: Object.freeze(tags),
  });
}

/** Strict committed manifest parser used by indexers before exposing search results. */
export function parseKeelShellManifest(input: string | Uint8Array): KeelShellManifest {
  const json = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
  const value = normalizedShellManifest(JSON.parse(json));
  if (canonicalJson(value) !== json) throw new TypeError("shell manifest must use canonical KEEL JSON bytes.");
  return value;
}

/** Bounded metadata-only discovery from Studio's read-back-verified shell index. */
export async function searchKeelShells(input: {
  readonly studioUrl: string | URL;
  readonly query?: string;
  readonly creator?: Address;
  readonly fetchImplementation?: typeof fetch;
}): Promise<readonly KeelIndexedShell[]> {
  const endpoint = new URL("/api/shells", input.studioUrl);
  const query = input.query?.trim();
  if (query !== undefined && (query.length === 0 || query.length > 120)) throw new TypeError("shell search query must be 1-120 characters.");
  if (query !== undefined) endpoint.searchParams.set("q", query);
  if (input.creator !== undefined) endpoint.searchParams.set("creator", normalizedAddress(input.creator, ZERO_ADDRESS, "creator"));
  const response = await (input.fetchImplementation ?? fetch)(endpoint, { headers: { accept: "application/json" } });
  const text = await response.text();
  if (!response.ok) throw new Error(`KEEL shell search returned HTTP ${response.status.toString()}.`);
  if (text.length > 256 * 1024) throw new RangeError("KEEL shell search response exceeds 256 KiB.");
  const decoded = JSON.parse(text) as { readonly shells?: unknown };
  if (!Array.isArray(decoded.shells) || decoded.shells.length > 100) throw new TypeError("KEEL shell search returned an invalid result list.");
  return Object.freeze(decoded.shells.map((candidate): KeelIndexedShell => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) throw new TypeError("KEEL shell search returned an invalid record.");
    const value = candidate as Record<string, unknown>;
    if (
      typeof value.chainId !== "number" || !Number.isSafeInteger(value.chainId) || value.chainId <= 0
      || typeof value.builder !== "string" || typeof value.shellId !== "string" || typeof value.creator !== "string"
      || typeof value.name !== "string" || typeof value.description !== "string" || typeof value.version !== "string"
      || !Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string")
      || (value.payloadMode !== "sandboxed-html" && value.payloadMode !== "gzip-base64" && value.payloadMode !== "pre-encoded-graph")
      || typeof value.topObjectId !== "string" || typeof value.bottomObjectId !== "string"
      || typeof value.metadataObjectId !== "string" || typeof value.metadataDigest !== "string"
    ) throw new TypeError("KEEL shell search returned an invalid record.");
    return Object.freeze({
      chainId: value.chainId,
      builder: normalizedAddress(value.builder as Address, ZERO_ADDRESS, "builder"),
      shellId: normalizedBytes32(value.shellId as Hex, ZERO_BYTES32, "shellId"),
      creator: normalizedAddress(value.creator as Address, ZERO_ADDRESS, "creator"),
      name: cleanShellText(value.name, "name", 96),
      description: value.description === "" ? "" : cleanShellText(value.description, "description", 512),
      version: cleanShellText(value.version, "version", 32),
      tags: Object.freeze(value.tags as string[]),
      payloadMode: value.payloadMode,
      topObjectId: normalizedBytes32(value.topObjectId as Hex, ZERO_BYTES32, "topObjectId"),
      bottomObjectId: normalizedBytes32(value.bottomObjectId as Hex, ZERO_BYTES32, "bottomObjectId"),
      metadataObjectId: normalizedBytes32(value.metadataObjectId as Hex, ZERO_BYTES32, "metadataObjectId"),
      metadataDigest: normalizedBytes32(value.metadataDigest as Hex, ZERO_BYTES32, "metadataDigest"),
    });
  }));
}

/** Canonical committed metadata used by Studio/indexers for creator and tag search. */
export async function createKeelShellManifest(input: CreateKeelShellManifestInput): Promise<{
  readonly value: KeelShellManifest;
  readonly json: string;
  readonly bytes: Uint8Array;
  readonly integrity: Integrity;
}> {
  const tags = [...new Set((input.tags ?? []).map((tag) => tag.trim().toLowerCase()))].sort();
  if (tags.length > 16 || tags.some((tag) => !/^[a-z0-9][a-z0-9-]{0,31}$/u.test(tag))) {
    throw new TypeError("shell tags must be unique lowercase kebab-case values, at most 16 entries.");
  }
  const value = normalizedShellManifest({
    protocol: KEEL_SHELL_MANIFEST_PROTOCOL,
    name: cleanShellText(input.name, "name", 96),
    description: input.description === undefined ? "" : cleanShellText(input.description, "description", 512),
    version: cleanShellText(input.version, "version", 32),
    creator: input.creator,
    tags,
  });
  const json = canonicalJson(value);
  const bytes = utf8ToBytes(json);
  return Object.freeze({ value, json, bytes, integrity: await createIntegrity(bytes) });
}

function shellPayloadModeCode(payloadMode: KeelShellPayloadMode): 0 | 1 | 2 {
  if (payloadMode === "sandboxed-html") return 0;
  if (payloadMode === "gzip-base64") return 1;
  if (payloadMode === "pre-encoded-graph") return 2;
  throw new TypeError("payloadMode must be sandboxed-html, gzip-base64, or pre-encoded-graph.");
}

/** Review-only creator registration; the connected creator remains msg.sender. */
export function buildKeelCreatorShellRegistrationCall(input: KeelCreatorShellRegistrationInput) {
  const builderAddress = normalizedAddress(input.builderAddress, ZERO_ADDRESS, "builderAddress");
  const salt = normalizedBytes32(input.salt, ZERO_BYTES32, "salt");
  const prefixObjectId = normalizedBytes32(input.prefixObjectId, ZERO_BYTES32, "prefixObjectId");
  const suffixObjectId = normalizedBytes32(input.suffixObjectId, ZERO_BYTES32, "suffixObjectId");
  const metadataObjectId = normalizedBytes32(input.metadataObjectId, ZERO_BYTES32, "metadataObjectId");
  const payloadMode = input.payloadMode ?? "pre-encoded-graph";
  if (builderAddress === ZERO_ADDRESS) throw new TypeError("builderAddress cannot be zero.");
  if ([salt, prefixObjectId, suffixObjectId, metadataObjectId].some((value) => value === ZERO_BYTES32)) {
    throw new TypeError("salt, prefixObjectId, suffixObjectId, and metadataObjectId cannot be zero.");
  }
  const payloadModeCode = shellPayloadModeCode(payloadMode);
  return Object.freeze({
    schema: "keel.creator-shell-registration-call@1" as const,
    status: "review-only" as const,
    to: builderAddress,
    valueWei: "0" as const,
    functionName: "registerShell" as const,
    functionSignature: "registerShell(bytes32,bytes32,bytes32,uint8,bytes32)" as const,
    arguments: [salt, prefixObjectId, suffixObjectId, payloadModeCode, metadataObjectId] as const,
    payloadMode,
    walletApproval: "required" as const,
    signing: "not-performed" as const,
    submission: "not-performed" as const,
  });
}

/**
 * Prepare a review-only registry mutation. This does not encode calldata,
 * request a signature, or submit a transaction.
 */
export function buildKeelShellRegistrationCall(input: KeelShellRegistrationInput) {
  const builderAddress = normalizedAddress(input.builderAddress, ZERO_ADDRESS, "builderAddress");
  const shellId = normalizedBytes32(input.shellId, ZERO_BYTES32, "shellId");
  const prefixObjectId = normalizedBytes32(input.prefixObjectId, ZERO_BYTES32, "prefixObjectId");
  const suffixObjectId = normalizedBytes32(input.suffixObjectId, ZERO_BYTES32, "suffixObjectId");
  const metadataObjectId = normalizedBytes32(input.metadataObjectId, ZERO_BYTES32, "metadataObjectId");
  const payloadMode = input.payloadMode ?? "pre-encoded-graph";
  const payloadModeCode = shellPayloadModeCode(payloadMode);
  if (builderAddress === ZERO_ADDRESS) throw new TypeError("builderAddress cannot be zero.");
  if (shellId === ZERO_BYTES32) throw new TypeError("shellId cannot be zero.");
  if (prefixObjectId === ZERO_BYTES32 || suffixObjectId === ZERO_BYTES32 || metadataObjectId === ZERO_BYTES32) {
    throw new TypeError("prefixObjectId, suffixObjectId, and metadataObjectId cannot be zero when registering a shell.");
  }

  return Object.freeze({
    schema: "keel.shell-registration-call@1" as const,
    status: "review-only" as const,
    to: builderAddress,
    valueWei: "0" as const,
    functionName: "setShell" as const,
    functionSignature: "setShell(bytes32,bytes32,bytes32,uint8,bytes32)" as const,
    arguments: [shellId, prefixObjectId, suffixObjectId, payloadModeCode, metadataObjectId] as const,
    payloadMode,
    walletApproval: "required" as const,
    signing: "not-performed" as const,
    submission: "not-performed" as const,
  });
}

/**
 * Prepare the exact read that assembles a registered top + graph + bottom.
 * The canonical default is the KEEL Inline protection shell; no HTML wrapper
 * is manufactured by the caller.
 */
export function buildKeelRegisteredPreEncodedTokenURICall(input: KeelRegisteredPreEncodedTokenURIInput) {
  const builderAddress = normalizedAddress(input.builderAddress, ZERO_ADDRESS, "builderAddress");
  const shellId = normalizedBytes32(input.shellId ?? KEEL_INLINE_PROTECTION_SHELL_ID, ZERO_BYTES32, "shellId");
  const objectId = normalizedBytes32(input.objectId, ZERO_BYTES32, "objectId");
  const expectedDigest = normalizedBytes32(input.expectedDigest, ZERO_BYTES32, "expectedDigest");
  if (builderAddress === ZERO_ADDRESS) throw new TypeError("builderAddress cannot be zero.");
  if (shellId === ZERO_BYTES32 || objectId === ZERO_BYTES32 || expectedDigest === ZERO_BYTES32) {
    throw new TypeError("shellId, objectId, and expectedDigest cannot be zero.");
  }
  const rawPrefix = stringToHex(input.rawPrefix);
  const rawSuffix = stringToHex(input.rawSuffix);
  if ((rawPrefix.length - 2) / 2 % 3 !== 0) throw new TypeError("rawPrefix must be aligned to a three-byte Base64 boundary.");
  return Object.freeze({
    schema: "keel.registered-pre-encoded-token-uri-call@1" as const,
    mode: shellId === KEEL_INLINE_PROTECTION_SHELL_ID ? "default-inline-protection" as const : "explicit-shell" as const,
    to: builderAddress,
    functionName: "registeredPreEncodedTokenURI" as const,
    functionSignature: "registeredPreEncodedTokenURI(bytes32,bytes32,bytes32,bytes,bytes)" as const,
    arguments: [shellId, objectId, expectedDigest, rawPrefix, rawSuffix] as const,
  });
}

/** Prepare the exact read call for an explicit shell or the protection default. */
export function buildKeelShellDataURICall(input: KeelShellDataURIInput) {
  const builderAddress = normalizedAddress(input.builderAddress, ZERO_ADDRESS, "builderAddress");
  const artifactObjectId = normalizedBytes32(input.artifactObjectId, ZERO_BYTES32, "artifactObjectId");
  const artifactDigest = normalizedBytes32(input.artifactDigest, ZERO_BYTES32, "artifactDigest");
  if (builderAddress === ZERO_ADDRESS) throw new TypeError("builderAddress cannot be zero.");
  if (artifactObjectId === ZERO_BYTES32) throw new TypeError("artifactObjectId cannot be zero.");
  if (artifactDigest === ZERO_BYTES32) throw new TypeError("artifactDigest cannot be zero.");
  const contextJSON = input.contextJSON ?? "{}";
  const contextBytes = new TextEncoder().encode(contextJSON);
  if (contextBytes.byteLength > MAX_CONTEXT_BYTES) {
    throw new RangeError(`contextJSON cannot exceed ${MAX_CONTEXT_BYTES.toString()} UTF-8 bytes.`);
  }
  JSON.parse(contextJSON);
  const contextHex = stringToHex(contextJSON);

  if (input.shellId === undefined) {
    return Object.freeze({
      schema: "keel.shell-data-uri-call@1" as const,
      mode: "default-protection" as const,
      to: builderAddress,
      functionName: "shellDataURI" as const,
      functionSignature: "shellDataURI(bytes32,bytes32,bytes)" as const,
      arguments: [artifactObjectId, artifactDigest, contextHex] as const,
    });
  }

  const shellId = normalizedBytes32(input.shellId, ZERO_BYTES32, "shellId");
  if (shellId === ZERO_BYTES32) throw new TypeError("shellId cannot be zero.");
  return Object.freeze({
    schema: "keel.shell-data-uri-call@1" as const,
    mode: shellId === KEEL_PROTECTION_SHELL_ID ? "explicit-protection" as const : "explicit-shell" as const,
    to: builderAddress,
    functionName: "shellDataURI" as const,
    functionSignature: "shellDataURI(bytes32,bytes32,bytes32,bytes)" as const,
    arguments: [shellId, artifactObjectId, artifactDigest, contextHex] as const,
  });
}
