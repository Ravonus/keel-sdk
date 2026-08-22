import { canonicalJson, createIntegrity, utf8ToBytes, type Integrity } from "@keel/protocol";

export const KEEL_WALLET_REQUEST_PROTOCOL = "keel-wallet-request@1" as const;
export const KEEL_WALLET_QR_SCHEME = "keel-wallet-request:" as const;

const DIGEST = /^0x[0-9a-f]{64}$/u;
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/u;
const ADDRESS = /^0x[0-9a-f]{40}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const TEZOS_ADDRESS = /^(?:tz[1-3]|KT1)[1-9A-HJ-NP-Za-km-z]{33}$/u;
const ENTRYPOINT = /^[A-Za-z][A-Za-z0-9_.%@+-]{0,30}$/u;
const TRANSPORTS = new Set<KeelWalletTransport>(["injected", "walletconnect-qr", "ledger", "tezconnect", "local-encrypted"]);
const MAX_QR_BYTES = 24 * 1024;

export type KeelWalletTransport = "injected" | "walletconnect-qr" | "ledger" | "tezconnect" | "local-encrypted";

interface WalletRequestBase {
  readonly protocol: typeof KEEL_WALLET_REQUEST_PROTOCOL;
  readonly requestId: string;
  readonly label: string;
  readonly transport?: KeelWalletTransport;
}

export interface KeelEthereumWalletRequest extends WalletRequestBase {
  readonly family: "ethereum";
  readonly chainId: number;
  readonly to: `0x${string}`;
  readonly data: `0x${string}`;
  readonly valueWei: string;
}

export interface KeelTezosWalletRequest extends WalletRequestBase {
  readonly family: "tezos";
  readonly network: string;
  readonly destination: string;
  readonly amountMutez: string;
  readonly entrypoint?: string;
  /** Canonical Micheline JSON when a contract call has parameters. */
  readonly parameters?: string;
}

export type KeelWalletRequest = KeelEthereumWalletRequest | KeelTezosWalletRequest;

export interface KeelWalletRequestEnvelope {
  readonly request: KeelWalletRequest;
  readonly integrity: Integrity;
}

export interface KeelWalletRequestVerification {
  readonly valid: boolean;
  readonly integrity?: Integrity;
  readonly issues: readonly string[];
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const fields = new Set(allowed);
  for (const key of Object.keys(value)) if (!fields.has(key)) throw new TypeError(`${label}.${key} is not supported.`);
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be text.`);
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0 || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) throw new TypeError(`${label} is invalid.`);
  for (let index = 0; index < normalized.length; index += 1) {
    const unit = normalized.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = normalized.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError(`${label} contains an invalid Unicode scalar.`);
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError(`${label} contains an invalid Unicode scalar.`);
    }
  }
  return normalized;
}

function decimal(value: unknown, label: string): string {
  if (typeof value !== "string" || !DECIMAL.test(value) || value.length > 78) throw new TypeError(`${label} must be a canonical decimal amount.`);
  const numeric = BigInt(value);
  if (numeric > ((1n << 256n) - 1n)) throw new RangeError(`${label} exceeds the uint256 range.`);
  return value;
}

function parseIntegrity(value: unknown): Integrity {
  const input = object(value, "wallet request integrity");
  exactKeys(input, ["algorithm", "digest", "byteLength"], "wallet request integrity");
  if (input.algorithm !== "sha256" || typeof input.digest !== "string" || !DIGEST.test(input.digest)) throw new TypeError("Wallet request integrity must be lower-case SHA-256.");
  if (!Number.isSafeInteger(input.byteLength) || (input.byteLength as number) <= 0) throw new TypeError("Wallet request integrity byteLength must be positive.");
  return { algorithm: "sha256", digest: input.digest as `0x${string}`, byteLength: input.byteLength as number };
}

function normalizeBase(input: Record<string, unknown>): WalletRequestBase {
  if (input.protocol !== KEEL_WALLET_REQUEST_PROTOCOL) throw new TypeError("Unsupported Keel wallet request protocol.");
  const requestId = text(input.requestId, "wallet request.requestId", 128);
  const label = text(input.label, "wallet request.label", 160);
  const transport = input.transport === undefined ? undefined : text(input.transport, "wallet request.transport", 32);
  if (transport !== undefined && !TRANSPORTS.has(transport as KeelWalletTransport)) throw new TypeError("wallet request.transport is unsupported.");
  return { protocol: KEEL_WALLET_REQUEST_PROTOCOL, requestId, label, ...(transport === undefined ? {} : { transport: transport as KeelWalletTransport }) };
}

function assertTransport(family: KeelWalletRequest["family"], transport: KeelWalletTransport | undefined): void {
  if (transport === undefined) return;
  if (family === "ethereum" && transport === "tezconnect") throw new TypeError("tezconnect is only compatible with Tezos wallet requests.");
  if (family === "tezos" && transport === "injected") throw new TypeError("injected is only compatible with Ethereum wallet requests.");
}

function assertMicheline(value: unknown, depth = 0): void {
  if (depth > 32) throw new RangeError("wallet request.parameters exceeds the Micheline depth limit.");
  if (Array.isArray(value)) {
    if (value.length === 0 || value.length > 256) throw new TypeError("wallet request.parameters arrays must contain 1 through 256 nodes.");
    value.forEach((item) => assertMicheline(item, depth + 1));
    return;
  }
  const input = object(value, "wallet request.parameters node");
  if (typeof input.int === "string") {
    exactKeys(input, ["int"], "wallet request.parameters int node");
    if (!/^-?(?:0|[1-9][0-9]*)$/u.test(input.int)) throw new TypeError("wallet request.parameters int is invalid.");
    return;
  }
  if (typeof input.string === "string") {
    exactKeys(input, ["string"], "wallet request.parameters string node");
    text(input.string, "wallet request.parameters.string", 16_384);
    return;
  }
  if (typeof input.bytes === "string") {
    exactKeys(input, ["bytes"], "wallet request.parameters bytes node");
    if (!/^(?:[0-9a-f]{2})*$/u.test(input.bytes)) throw new TypeError("wallet request.parameters bytes must be lower-case even-length hexadecimal.");
    return;
  }
  if (typeof input.prim === "string") {
    exactKeys(input, ["prim", "args", "annots"], "wallet request.parameters prim node");
    text(input.prim, "wallet request.parameters.prim", 128);
    if (input.args !== undefined) {
      if (!Array.isArray(input.args) || input.args.length > 256) throw new TypeError("wallet request.parameters.args is invalid.");
      input.args.forEach((item) => assertMicheline(item, depth + 1));
    }
    if (input.annots !== undefined) {
      if (!Array.isArray(input.annots) || input.annots.length > 64) throw new TypeError("wallet request.parameters.annots is invalid.");
      input.annots.forEach((item, index) => text(item, `wallet request.parameters.annots[${index}]`, 128));
    }
    return;
  }
  throw new TypeError("wallet request.parameters must be a Micheline int, string, bytes, prim, or node array.");
}

function normalizeParameters(value: unknown): string {
  const source = text(value, "wallet request.parameters", 16_384);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw new TypeError("wallet request.parameters must be valid JSON.");
  }
  assertMicheline(parsed);
  return canonicalJson(parsed);
}

function normalizeRequest(value: unknown): KeelWalletRequest {
  const input = object(value, "wallet request");
  if (input.family === "ethereum") {
    exactKeys(input, ["protocol", "requestId", "label", "transport", "family", "chainId", "to", "data", "valueWei"], "ethereum wallet request");
    const base = normalizeBase(input);
    assertTransport("ethereum", base.transport);
    if (!Number.isSafeInteger(input.chainId) || (input.chainId as number) <= 0) throw new TypeError("wallet request.chainId must be a positive safe integer.");
    if (typeof input.to !== "string" || !ADDRESS.test(input.to)) throw new TypeError("wallet request.to must be a 20-byte Ethereum address.");
    if (typeof input.data !== "string" || !HEX.test(input.data)) throw new TypeError("wallet request.data must be even-length hexadecimal data.");
    return { ...base, family: "ethereum", chainId: input.chainId as number, to: input.to.toLowerCase() as `0x${string}`, data: input.data.toLowerCase() as `0x${string}`, valueWei: decimal(input.valueWei, "wallet request.valueWei") };
  }
  if (input.family === "tezos") {
    exactKeys(input, ["protocol", "requestId", "label", "transport", "family", "network", "destination", "amountMutez", "entrypoint", "parameters"], "tezos wallet request");
    const base = normalizeBase(input);
    assertTransport("tezos", base.transport);
    const network = text(input.network, "wallet request.network", 64);
    const destination = text(input.destination, "wallet request.destination", 64);
    if (!TEZOS_ADDRESS.test(destination)) throw new TypeError("wallet request.destination must be a Tezos tz or KT1 address.");
    const entrypoint = input.entrypoint === undefined ? undefined : text(input.entrypoint, "wallet request.entrypoint", 31);
    if (entrypoint !== undefined && !ENTRYPOINT.test(entrypoint)) throw new TypeError("wallet request.entrypoint is invalid.");
    const parameters = input.parameters === undefined ? undefined : normalizeParameters(input.parameters);
    return { ...base, family: "tezos", network, destination, amountMutez: decimal(input.amountMutez, "wallet request.amountMutez"), ...(entrypoint === undefined ? {} : { entrypoint }), ...(parameters === undefined ? {} : { parameters }) };
  }
  throw new TypeError("wallet request.family must be ethereum or tezos.");
}

function sameIntegrity(left: Integrity, right: Integrity): boolean {
  return left.algorithm === right.algorithm && left.digest === right.digest && left.byteLength === right.byteLength;
}

async function requestIntegrity(request: KeelWalletRequest): Promise<Integrity> {
  return createIntegrity(utf8ToBytes(canonicalJson(request)));
}

export function parseKeelWalletRequest(value: unknown): KeelWalletRequest {
  return normalizeRequest(value);
}

export async function createKeelWalletRequest(value: unknown): Promise<KeelWalletRequestEnvelope> {
  const request = normalizeRequest(value);
  return { request, integrity: await requestIntegrity(request) };
}

export async function verifyKeelWalletRequest(value: unknown): Promise<KeelWalletRequestVerification> {
  try {
    const envelope = object(value, "wallet request envelope");
    exactKeys(envelope, ["request", "integrity"], "wallet request envelope");
    const request = normalizeRequest(envelope.request);
    const supplied = parseIntegrity(envelope.integrity);
    const actual = await requestIntegrity(request);
    const issues: string[] = [];
    if (!sameIntegrity(actual, supplied)) issues.push("wallet request integrity does not match canonical request bytes");
    return { valid: issues.length === 0, integrity: actual, issues };
  } catch (error) {
    return { valid: false, issues: [error instanceof Error ? error.message : String(error)] };
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new TypeError("Wallet QR payload contains invalid base64url.");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function encodeKeelWalletRequestQr(envelope: KeelWalletRequestEnvelope): Promise<string> {
  const value = object(envelope, "wallet request envelope");
  exactKeys(value, ["request", "integrity"], "wallet request envelope");
  const request = normalizeRequest(value.request);
  const integrity = parseIntegrity(value.integrity);
  const actual = await requestIntegrity(request);
  if (!sameIntegrity(actual, integrity)) throw new TypeError("Wallet request envelope integrity does not match its request.");
  const bytes = utf8ToBytes(canonicalJson({ request, integrity }));
  if (bytes.byteLength > MAX_QR_BYTES) throw new RangeError(`Wallet QR payload cannot exceed ${MAX_QR_BYTES} bytes.`);
  return KEEL_WALLET_QR_SCHEME + base64UrlEncode(bytes);
}

export async function decodeKeelWalletRequestQr(value: string): Promise<KeelWalletRequestEnvelope> {
  if (typeof value !== "string" || !value.startsWith(KEEL_WALLET_QR_SCHEME)) throw new TypeError("Wallet QR payload uses an unsupported scheme.");
  const encoded = value.slice(KEEL_WALLET_QR_SCHEME.length);
  if (encoded.length > 32_768) throw new RangeError("Wallet QR payload is too large.");
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(base64UrlDecode(encoded))) as unknown;
  const envelope = object(parsed, "wallet request envelope");
  exactKeys(envelope, ["request", "integrity"], "wallet request envelope");
  const request = normalizeRequest(envelope.request);
  const integrity = parseIntegrity(envelope.integrity);
  const actual = await requestIntegrity(request);
  if (!sameIntegrity(actual, integrity)) throw new TypeError("Wallet QR payload integrity does not match its request.");
  return { request, integrity };
}
