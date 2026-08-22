import { canonicalJson, createIntegrity, utf8ToBytes, type Integrity } from "@keel/protocol";
import type { KeelWalletTransport } from "./wallet-request.js";

export const KEEL_WALLET_LINK_PROTOCOL = "keel-wallet-link@1" as const;

const DIGEST = /^0x[0-9a-f]{64}$/u;
const ETHEREUM_ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const TEZOS_ADDRESS = /^(?:tz[1-3]|KT1)[1-9A-HJ-NP-Za-km-z]{33}$/u;
const ZERO_ETHEREUM_ADDRESS = "0x0000000000000000000000000000000000000000";
const NONCE = /^[A-Za-z0-9._:-]{1,96}$/u;
const REVOCATION_NONCE = /^[A-Za-z0-9._:-]{1,128}$/u;
const SCOPES = new Set<KeelWalletLinkScope>(["read", "analyze", "prepare", "request", "create-collection"]);
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_LINK_LIFETIME = 30 * 24 * 60 * 60;
const CONFIG_ENCODING = "keel-factory-config-keccak@1" as const;

export type KeelWalletLinkScope = "read" | "analyze" | "prepare" | "request" | "create-collection";
export type KeelWalletLinkRevocationStatus = "active" | "revoked";

export interface KeelWalletLinkInput {
  readonly family: "ethereum" | "tezos";
  readonly accountAddress: string;
  readonly agentAddress: string;
  readonly target: { readonly chainId: number; readonly factoryAddress: string; readonly factoryVersion: `0x${string}`; readonly creationCodeHash: `0x${string}`; readonly operation: "keelFactory.castDie"; readonly configDigest: `0x${string}`; readonly configEncoding: typeof CONFIG_ENCODING; readonly authorizationNonce: string };
  readonly scopes: readonly KeelWalletLinkScope[];
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly nonce: string;
  readonly transport?: KeelWalletTransport;
  readonly revocation?: { readonly status: KeelWalletLinkRevocationStatus; readonly nonce: string; readonly revokedAt?: number };
  readonly rotation?: { readonly sequence: number; readonly previousLinkDigest?: `0x${string}` };
}

export interface KeelWalletLinkEnvelope {
  readonly protocol: typeof KEEL_WALLET_LINK_PROTOCOL;
  readonly status: "review-only";
  readonly chainReady: false;
  readonly family: "ethereum";
  readonly accountAddress: string;
  readonly agentAddress: string;
  readonly target: { readonly chainId: number; readonly factoryAddress: `0x${string}`; readonly factoryVersion: `0x${string}`; readonly creationCodeHash: `0x${string}`; readonly operation: "keelFactory.castDie"; readonly configDigest: `0x${string}`; readonly configEncoding: typeof CONFIG_ENCODING; readonly authorizationNonce: string };
  readonly scopes: readonly KeelWalletLinkScope[];
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly nonce: string;
  readonly transport?: KeelWalletTransport;
  readonly revocation: { readonly status: KeelWalletLinkRevocationStatus; readonly nonce: string; readonly revokedAt?: number };
  readonly rotation: { readonly sequence: number; readonly previousLinkDigest?: `0x${string}` };
  readonly integrity: Integrity;
  readonly walletApproval: "required";
  readonly approval: "not-granted";
  readonly signing: "not-performed";
  readonly submission: "not-performed";
  readonly caveat: "A wallet link records explicit scopes only; it never transfers custody or approves signing or submission.";
}

export interface KeelWalletLinkVerification {
  readonly valid: boolean;
  readonly expired: boolean;
  readonly revoked: boolean;
  readonly notYetValid: boolean;
  readonly timeChecked: boolean;
  readonly integrity?: Integrity;
  readonly issues: readonly string[];
}

export interface KeelWalletLinkDeferred {
  readonly status: "deferred";
  readonly family: "tezos";
  readonly code: "tezos-adapter-required" | "transport-mismatch";
  readonly issues: readonly string[];
  readonly signing: "not-performed";
  readonly submission: "not-performed";
}

export type KeelWalletLinkResult = KeelWalletLinkEnvelope | KeelWalletLinkDeferred;

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const fields = new Set(allowed);
  for (const key of Object.keys(value)) if (!fields.has(key)) throw new TypeError(`${label}.${key} is not supported.`);
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be text.`);
  const result = value.normalize("NFKC").trim();
  if (result.length === 0 || result.length > maximum || /[\u0000-\u001f\u007f]/u.test(result)) throw new TypeError(`${label} is invalid.`);
  return result;
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 4_102_444_800) throw new TypeError(`${label} must be a safe Unix-second timestamp.`);
  return value;
}

function digest(value: unknown, label: string): `0x${string}` {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new TypeError(`${label} must be lower-case bytes32.`);
  return value as `0x${string}`;
}

function uint256Text(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value) || value.length > 78 || BigInt(value) > ((1n << 256n) - 1n)) throw new TypeError(`${label} must be a canonical uint256 decimal.`);
  return value;
}

function parseIntegrity(value: unknown): Integrity {
  const input = object(value, "wallet link integrity");
  exact(input, ["algorithm", "digest", "byteLength"], "wallet link integrity");
  if (input.algorithm !== "sha256") throw new TypeError("wallet link integrity algorithm must be sha256.");
  if (typeof input.byteLength !== "number" || !Number.isSafeInteger(input.byteLength) || input.byteLength <= 0 || input.byteLength > MAX_SOURCE_BYTES) throw new TypeError("wallet link integrity.byteLength is invalid.");
  const normalizedDigest = digest(input.digest, "wallet link integrity.digest");
  if (normalizedDigest === `0x${"00".repeat(32)}`) throw new TypeError("wallet link integrity.digest cannot be zero.");
  return { algorithm: "sha256", digest: normalizedDigest, byteLength: input.byteLength };
}

function address(value: unknown, family: "ethereum" | "tezos", label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be an address.`);
  const pattern = family === "ethereum" ? ETHEREUM_ADDRESS : TEZOS_ADDRESS;
  if (!pattern.test(value)) throw new TypeError(`${label} is invalid for ${family}.`);
  const normalized = family === "ethereum" ? value.toLowerCase() : value;
  if (family === "ethereum" && normalized === ZERO_ETHEREUM_ADDRESS) throw new TypeError(`${label} cannot be the zero address.`);
  return normalized;
}

function transport(value: unknown, family: "ethereum" | "tezos"): KeelWalletTransport | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError("wallet link.transport is invalid.");
  const allowed: readonly string[] = family === "ethereum" ? ["injected", "walletconnect-qr", "ledger", "local-encrypted"] : ["walletconnect-qr", "ledger", "tezconnect", "local-encrypted"];
  if (!allowed.includes(value)) throw new TypeError(`wallet link.transport is incompatible with ${family}.`);
  return value as KeelWalletTransport;
}

function target(value: unknown): KeelWalletLinkEnvelope["target"] {
  const input = object(value, "wallet link.target");
  exact(input, ["chainId", "factoryAddress", "factoryVersion", "creationCodeHash", "operation", "configDigest", "configEncoding", "authorizationNonce"], "wallet link.target");
  if (typeof input.chainId !== "number" || !Number.isSafeInteger(input.chainId) || input.chainId <= 0) throw new TypeError("wallet link.target.chainId is invalid.");
  if (typeof input.factoryAddress !== "string" || !ETHEREUM_ADDRESS.test(input.factoryAddress) || input.factoryAddress.toLowerCase() === ZERO_ETHEREUM_ADDRESS) throw new TypeError("wallet link.target.factoryAddress is invalid.");
  const factoryVersion = digest(input.factoryVersion, "wallet link.target.factoryVersion");
  const creationCodeHash = digest(input.creationCodeHash, "wallet link.target.creationCodeHash");
  if (input.operation !== "keelFactory.castDie") throw new TypeError("wallet link.target.operation is unsupported.");
  const configDigest = digest(input.configDigest, "wallet link.target.configDigest");
  if (factoryVersion === `0x${"00".repeat(32)}` || creationCodeHash === `0x${"00".repeat(32)}` || configDigest === `0x${"00".repeat(32)}`) throw new TypeError("wallet link target commitments cannot be zero.");
  if (input.configEncoding !== CONFIG_ENCODING) throw new TypeError("wallet link.target.configEncoding is unsupported.");
  const authorizationNonce = uint256Text(input.authorizationNonce, "wallet link.target.authorizationNonce");
  return { chainId: input.chainId, factoryAddress: input.factoryAddress.toLowerCase() as `0x${string}`, factoryVersion, creationCodeHash, operation: "keelFactory.castDie", configDigest, configEncoding: CONFIG_ENCODING, authorizationNonce };
}

function normalize(value: unknown): { readonly body: Omit<KeelWalletLinkEnvelope, "integrity">; readonly integrity: Integrity } {
  const input = object(value, "wallet link");
  exact(input, ["protocol", "status", "chainReady", "family", "accountAddress", "agentAddress", "target", "scopes", "issuedAt", "expiresAt", "nonce", "transport", "revocation", "rotation", "integrity", "walletApproval", "approval", "signing", "submission", "caveat"], "wallet link");
  if (input.protocol !== KEEL_WALLET_LINK_PROTOCOL || input.status !== "review-only" || input.chainReady !== false || input.walletApproval !== "required" || input.approval !== "not-granted" || input.signing !== "not-performed" || input.submission !== "not-performed" || input.caveat !== "A wallet link records explicit scopes only; it never transfers custody or approves signing or submission.") throw new TypeError("wallet link review flags are invalid.");
  if (input.family !== "ethereum") throw new TypeError("Only Ethereum KeelFactory links are supported in this protocol version.");
  const family = "ethereum" as const;
  const accountAddress = address(input.accountAddress, family, "wallet link.accountAddress");
  const agentAddress = address(input.agentAddress, family, "wallet link.agentAddress");
  if (accountAddress === agentAddress) throw new TypeError("wallet link account and agent addresses must be distinct.");
  const targetValue = target(input.target);
  if (!Array.isArray(input.scopes) || input.scopes.length === 0 || input.scopes.length > SCOPES.size) throw new TypeError("wallet link.scopes must contain one through five scopes.");
  const scopes = [...new Set(input.scopes)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (scopes.length !== input.scopes.length || scopes.some((scope) => !SCOPES.has(scope))) throw new TypeError("wallet link.scopes must be unique supported values.");
  if (!scopes.includes("create-collection")) throw new TypeError("KeelFactory links require the create-collection scope.");
  const issuedAt = timestamp(input.issuedAt, "wallet link.issuedAt");
  const expiresAt = timestamp(input.expiresAt, "wallet link.expiresAt");
  if (expiresAt <= issuedAt) throw new RangeError("wallet link.expiresAt must be after issuedAt.");
  if (expiresAt - issuedAt > MAX_LINK_LIFETIME) throw new RangeError("wallet link lifetime cannot exceed 30 days.");
  const nonce = text(input.nonce, "wallet link.nonce", 128);
  if (!NONCE.test(nonce)) throw new TypeError("wallet link.nonce has unsupported characters.");
  const selectedTransport = transport(input.transport, family);
  const revocationInput = object(input.revocation, "wallet link.revocation");
  exact(revocationInput, ["status", "nonce", "revokedAt"], "wallet link.revocation");
  if (revocationInput.status !== "active" && revocationInput.status !== "revoked") throw new TypeError("wallet link.revocation.status is invalid.");
  const revocationNonce = text(revocationInput.nonce, "wallet link.revocation.nonce", 128);
  if (!REVOCATION_NONCE.test(revocationNonce)) throw new TypeError("wallet link.revocation.nonce has unsupported characters.");
  const revokedAt = revocationInput.revokedAt === undefined ? undefined : timestamp(revocationInput.revokedAt, "wallet link.revocation.revokedAt");
  if (revocationInput.status === "revoked" && revokedAt === undefined) throw new TypeError("revoked wallet links require revokedAt.");
  if (revocationInput.status === "active" && revokedAt !== undefined) throw new TypeError("active wallet links cannot include revokedAt.");
  if (revokedAt !== undefined && (revokedAt < issuedAt || revokedAt > expiresAt)) throw new RangeError("wallet link.revocation.revokedAt must be within the link lifetime.");
  const rotationInput = object(input.rotation, "wallet link.rotation");
  exact(rotationInput, ["sequence", "previousLinkDigest"], "wallet link.rotation");
  if (typeof rotationInput.sequence !== "number" || !Number.isSafeInteger(rotationInput.sequence) || rotationInput.sequence < 0 || rotationInput.sequence > 1_000_000) throw new TypeError("wallet link.rotation.sequence is invalid.");
  const previousLinkDigest = rotationInput.previousLinkDigest === undefined ? undefined : digest(rotationInput.previousLinkDigest, "wallet link.rotation.previousLinkDigest");
  if (previousLinkDigest === `0x${"00".repeat(32)}`) throw new TypeError("wallet link.rotation.previousLinkDigest cannot be zero.");
  if ((rotationInput.sequence === 0) !== (previousLinkDigest === undefined)) throw new TypeError("wallet link.rotation requires a previous digest exactly when sequence is non-zero.");
  const suppliedIntegrity = parseIntegrity(input.integrity);
  const body: Omit<KeelWalletLinkEnvelope, "integrity"> = {
    protocol: KEEL_WALLET_LINK_PROTOCOL,
    status: "review-only" as const,
    chainReady: false as const,
    family,
    accountAddress,
    agentAddress,
    target: targetValue,
    scopes,
    issuedAt,
    expiresAt,
    nonce,
    ...(selectedTransport === undefined ? {} : { transport: selectedTransport }),
    revocation: { status: revocationInput.status as KeelWalletLinkRevocationStatus, nonce: revocationNonce, ...(revokedAt === undefined ? {} : { revokedAt }) },
    rotation: { sequence: rotationInput.sequence, ...(previousLinkDigest === undefined ? {} : { previousLinkDigest }) },
    approval: "not-granted" as const,
    walletApproval: "required" as const,
    signing: "not-performed" as const,
    submission: "not-performed" as const,
    caveat: "A wallet link records explicit scopes only; it never transfers custody or approves signing or submission." as const,
  };
  return { body, integrity: suppliedIntegrity };
}

export async function createKeelWalletLink(input: KeelWalletLinkInput): Promise<KeelWalletLinkResult> {
  const value = object(input, "wallet link input");
  exact(value, ["family", "accountAddress", "agentAddress", "target", "scopes", "issuedAt", "expiresAt", "nonce", "transport", "revocation", "rotation"], "wallet link input");
  if (value.family !== "ethereum" && value.family !== "tezos") throw new TypeError("wallet link.family is invalid.");
  if (value.family === "tezos") return { status: "deferred", family: "tezos", code: value.transport !== undefined && value.transport !== "tezconnect" ? "transport-mismatch" : "tezos-adapter-required", issues: [value.transport !== undefined && value.transport !== "tezconnect" ? "Ethereum KeelFactory authorization cannot use a Tezos transport." : "A Tezos contract-specific delegation adapter is required."], signing: "not-performed", submission: "not-performed" };
  const family = value.family;
  const accountAddress = address(value.accountAddress, family, "wallet link.accountAddress");
  const agentAddress = address(value.agentAddress, family, "wallet link.agentAddress");
  if (!Array.isArray(value.scopes) || value.scopes.length === 0 || value.scopes.length > SCOPES.size || new Set(value.scopes).size !== value.scopes.length || value.scopes.some((scope) => !SCOPES.has(scope))) throw new TypeError("wallet link.scopes must be unique supported values.");
  const issuedAt = timestamp(value.issuedAt, "wallet link.issuedAt");
  const expiresAt = timestamp(value.expiresAt, "wallet link.expiresAt");
  if (expiresAt <= issuedAt) throw new RangeError("wallet link.expiresAt must be after issuedAt.");
  if (expiresAt - issuedAt > MAX_LINK_LIFETIME) throw new RangeError("wallet link lifetime cannot exceed 30 days.");
  const nonce = text(value.nonce, "wallet link.nonce", 128);
  if (!NONCE.test(nonce)) throw new TypeError("wallet link.nonce has unsupported characters.");
  const selectedTransport = transport(value.transport, family);
  const revocationInput = object(value.revocation ?? { status: "active", nonce: `${nonce}:revocation` }, "wallet link.revocation");
  const rotationInput = object(value.rotation ?? { sequence: 0 }, "wallet link.rotation");
  const body = normalize({ protocol: KEEL_WALLET_LINK_PROTOCOL, status: "review-only", chainReady: false, family, accountAddress, agentAddress, target: value.target, scopes: value.scopes, issuedAt, expiresAt, nonce, ...(selectedTransport === undefined ? {} : { transport: selectedTransport }), revocation: revocationInput, rotation: rotationInput, integrity: { algorithm: "sha256", digest: `0x${"ff".repeat(32)}`, byteLength: 1 }, walletApproval: "required", approval: "not-granted", signing: "not-performed", submission: "not-performed", caveat: "A wallet link records explicit scopes only; it never transfers custody or approves signing or submission." }).body;
  const integrityValue = await createIntegrity(utf8ToBytes(canonicalJson(body)));
  return { ...body, integrity: integrityValue };
}

export function parseKeelWalletLink(value: unknown): KeelWalletLinkEnvelope {
  const normalized = normalize(value);
  return { ...normalized.body, integrity: normalized.integrity };
}

export async function verifyKeelWalletLink(value: unknown, options: { readonly nowSeconds?: number } = {}): Promise<KeelWalletLinkVerification> {
  try {
    const normalized = normalize(value);
    const actual = await createIntegrity(utf8ToBytes(canonicalJson(normalized.body)));
    const issues: string[] = [];
    if (actual.algorithm !== normalized.integrity.algorithm || actual.digest !== normalized.integrity.digest || actual.byteLength !== normalized.integrity.byteLength) issues.push("wallet link integrity does not match canonical envelope bytes");
    const now = options.nowSeconds === undefined ? undefined : timestamp(options.nowSeconds, "wallet link verification.nowSeconds");
    const timeChecked = now !== undefined;
    const expired = now !== undefined && now >= normalized.body.expiresAt;
    const notYetValid = now !== undefined && now < normalized.body.issuedAt;
    const revoked = normalized.body.revocation.status === "revoked";
    if (expired) issues.push("wallet link has expired");
    if (notYetValid) issues.push("wallet link is not yet valid");
    if (revoked) issues.push("wallet link has been revoked");
    if (!timeChecked) issues.push("wallet link validity window was not checked; provide nowSeconds.");
    return { valid: issues.length === 0, expired, revoked, notYetValid, timeChecked, integrity: actual, issues };
  } catch (error) {
    return { valid: false, expired: false, revoked: false, notYetValid: false, timeChecked: false, issues: [error instanceof Error ? error.message : String(error)] };
  }
}
