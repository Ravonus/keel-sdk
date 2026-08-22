import { canonicalJson, createIntegrity, utf8ToBytes, type Integrity } from "@keel/protocol";
import {
  createKeelWalletRequest,
  parseKeelWalletRequest,
  verifyKeelWalletRequest,
  type KeelWalletRequestEnvelope,
  type KeelWalletTransport,
} from "./wallet-request.js";

export const KEEL_WALLET_INTENT_PROTOCOL = "keel-wallet-intent@1" as const;
export const KEEL_WALLET_INTENT_QR_LIMIT = 24_576 as const;

const HEX = /^0x(?:[0-9a-f]{2})*$/u;
const BYTES32 = /^0x[0-9a-f]{64}$/u;
const ADDRESS = /^0x[0-9a-f]{40}$/u;
const DIGEST = BYTES32;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const MAX_OPERATIONS = 16_384;
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_CALL_BYTES = 512_000;
const MAX_PLAN_BYTES = 4 * 1024 * 1024;
const SIGNATURES = {
  castSlugs: "castSlugs(bytes[])",
  weldObject: "weldObject(bytes32[],bytes32,uint64,uint8,string)",
  weldComposite: "weldComposite(bytes32[],bytes32,uint64,string)",
} as const;
const SELECTORS = { castSlugs: "0x0d1ff9e2", weldObject: "0xb17463a8", weldComposite: "0x5f97a164" } as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const CAVEAT = "Unsigned batch wallet intent only; no RPC, signing, submission, or QR encoding was performed." as const;
const QR_REASON = "Batch intents do not encode QR payloads; review each wallet request before choosing a connector." as const;
type OperationKind = keyof typeof SIGNATURES;

interface NormalizedOperation {
  readonly operationId: string;
  readonly kind: OperationKind;
  readonly chainId: number;
  readonly to: `0x${string}`;
  readonly data: `0x${string}`;
  readonly valueWei: "0";
  readonly signature: string;
  readonly args: readonly unknown[];
  readonly objectId?: `0x${string}`;
  readonly storedByteLength?: number;
}

interface NormalizedReady {
  readonly source: { readonly planIntegrity: Integrity; readonly contentIntegrity: Integrity };
  readonly operations: readonly NormalizedOperation[];
}

export interface KeelEthereumWalletIntentInput {
  readonly family: "ethereum";
  readonly ready: unknown;
  readonly requestId: string;
  readonly label: string;
  readonly transport?: KeelWalletTransport;
  readonly qr?: boolean;
  /** Inject the contract-specific canonical ABI validator (for example viem's decode/re-encode check). */
  readonly validateCalldata?: (signature: string, data: `0x${string}`, args: readonly unknown[]) => boolean | Promise<boolean>;
  /** Inject the adapter's full operation/ID verifier; this binds object IDs, stored lengths, and graph commitments. */
  readonly validateAdapterOperation?: (operation: {
    readonly kind: OperationKind;
    readonly signature: string;
    readonly args: readonly unknown[];
    readonly data: `0x${string}`;
    readonly objectId?: `0x${string}`;
    readonly storedByteLength?: number;
  }) => boolean | Promise<boolean>;
}

export interface KeelWalletIntentPlan {
  readonly protocol: typeof KEEL_WALLET_INTENT_PROTOCOL;
  readonly status: "review-only";
  readonly chainReady: false;
  readonly family: "ethereum";
  readonly requestId: string;
  readonly label: string;
  readonly transport?: KeelWalletTransport;
  readonly source: { readonly planIntegrity: Integrity };
  readonly requests: readonly KeelWalletRequestEnvelope[];
  readonly qr: {
    readonly status: "unsupported";
    readonly requested: boolean;
    readonly estimatedBytes: number;
    readonly maxBytes: typeof KEEL_WALLET_INTENT_QR_LIMIT;
    readonly reason: typeof QR_REASON;
  };
  readonly integrity: Integrity;
  readonly walletApproval: "required";
  readonly signing: "not-performed";
  readonly submission: "not-performed";
  readonly caveat: typeof CAVEAT;
}

export interface KeelWalletIntentDeferred {
  readonly status: "deferred";
  readonly chainReady: false;
  readonly family: "ethereum" | "tezos";
  readonly code: "tezos-adapter-required" | "transport-mismatch" | "adapter-validation-required";
  readonly issues: readonly string[];
  readonly walletApproval: "required";
  readonly signing: "not-performed";
  readonly submission: "not-performed";
}

export type KeelWalletIntentResult = KeelWalletIntentPlan | KeelWalletIntentDeferred;

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

function integrity(value: unknown, label: string): Integrity {
  const input = object(value, label);
  exact(input, ["algorithm", "digest", "byteLength"], label);
  if (input.algorithm !== "sha256" || typeof input.digest !== "string" || !DIGEST.test(input.digest)) throw new TypeError(`${label} must be lower-case SHA-256.`);
  if (typeof input.byteLength !== "number" || !Number.isSafeInteger(input.byteLength) || input.byteLength <= 0 || input.byteLength > MAX_SOURCE_BYTES) throw new TypeError(`${label}.byteLength is invalid.`);
  return { algorithm: "sha256", digest: input.digest as `0x${string}`, byteLength: input.byteLength };
}

function decimal(value: unknown, label: string): string {
  if (typeof value !== "string" || !DECIMAL.test(value) || value.length > 78 || BigInt(value) > ((1n << 256n) - 1n)) throw new TypeError(`${label} must be canonical uint256 text.`);
  return value;
}

function transport(value: unknown, label: string): KeelWalletTransport | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !["injected", "walletconnect-qr", "ledger", "tezconnect", "local-encrypted"].includes(value)) throw new TypeError(`${label} is unsupported.`);
  return value as KeelWalletTransport;
}

function sameIntegrity(left: Integrity, right: Integrity): boolean {
  return left.algorithm === right.algorithm && left.digest === right.digest && left.byteLength === right.byteLength;
}

function bytes32(value: unknown, label: string): `0x${string}` {
  if (typeof value !== "string" || !BYTES32.test(value)) throw new TypeError(`${label} must be lower-case bytes32.`);
  return value as `0x${string}`;
}

function argsArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return value;
}

function byteHex(value: unknown, label: string, maximum: number): `0x${string}` {
  if (typeof value !== "string" || !HEX.test(value) || value !== value.toLowerCase() || value.length > 2 + maximum * 2) throw new TypeError(`${label} must be lower-case bounded bytes.`);
  return value as `0x${string}`;
}

async function operation(value: unknown, index: number, planDigest: Integrity, validateCalldata: KeelEthereumWalletIntentInput["validateCalldata"], validateAdapterOperation: KeelEthereumWalletIntentInput["validateAdapterOperation"]): Promise<NormalizedOperation> {
  const input = object(value, `wallet intent ready.operations[${index}]`);
  exact(input, ["operationId", "kind", "chainId", "to", "valueWei", "signature", "args", "data", "objectId", "storedByteLength"], `wallet intent ready.operations[${index}]`);
  const operationId = text(input.operationId, `wallet intent ready.operations[${index}].operationId`, 128);
  const expectedId = `op-${planDigest.digest.slice(2, 14)}-${String(index).padStart(5, "0")}`;
  if (operationId !== expectedId) throw new TypeError(`wallet intent ready.operations[${index}].operationId is not bound to the source plan.`);
  if (typeof input.kind !== "string" || !(input.kind in SIGNATURES)) throw new TypeError(`wallet intent ready.operations[${index}].kind is unsupported.`);
  const kind = input.kind as OperationKind;
  if (typeof input.chainId !== "number" || !Number.isSafeInteger(input.chainId) || input.chainId <= 0) throw new TypeError(`wallet intent ready.operations[${index}].chainId is invalid.`);
  if (typeof input.to !== "string" || !ADDRESS.test(input.to) || input.to === ZERO_ADDRESS || input.to !== input.to.toLowerCase()) throw new TypeError(`wallet intent ready.operations[${index}].to is invalid.`);
  if (input.valueWei !== "0") throw new TypeError(`wallet intent ready.operations[${index}].valueWei must be zero.`);
  if (input.signature !== SIGNATURES[kind]) throw new TypeError(`wallet intent ready.operations[${index}].signature does not match kind.`);
  const data = byteHex(input.data, `wallet intent ready.operations[${index}].data`, MAX_CALL_BYTES);
  const minimumCallBytes = kind === "castSlugs" ? 164 : kind === "weldObject" ? 292 : 260;
  if (data.length < 2 + minimumCallBytes * 2 || data.slice(0, 10) !== SELECTORS[kind]) throw new TypeError(`wallet intent ready.operations[${index}].data has an unexpected KeelHold selector or ABI body.`);
  const args = argsArray(input.args, `wallet intent ready.operations[${index}].args`);
  if (kind === "castSlugs") {
    if (Object.prototype.hasOwnProperty.call(input, "objectId") || Object.prototype.hasOwnProperty.call(input, "storedByteLength")) throw new TypeError(`wallet intent ready.operations[${index}] castSlugs cannot include object metadata.`);
    if (args.length !== 1 || !Array.isArray(args[0]) || args[0].length < 1 || args[0].length > 3) throw new TypeError(`wallet intent ready.operations[${index}].args are invalid for castSlugs.`);
    args[0].forEach((chunk, chunkIndex) => byteHex(chunk, `wallet intent ready.operations[${index}].args[0][${chunkIndex}]`, 23_000));
  } else {
    const objectId = bytes32(input.objectId, `wallet intent ready.operations[${index}].objectId`);
    if (typeof input.storedByteLength !== "number" || !Number.isSafeInteger(input.storedByteLength) || input.storedByteLength <= 0 || input.storedByteLength > MAX_SOURCE_BYTES) throw new TypeError(`wallet intent ready.operations[${index}].storedByteLength is invalid.`);
    if (args.length < 4 || args.length > 5 || !Array.isArray(args[0]) || args[0].length < 1 || args[0].length > 128) throw new TypeError(`wallet intent ready.operations[${index}].args are invalid.`);
    args[0].forEach((child, childIndex) => bytes32(child, `wallet intent ready.operations[${index}].args[0][${childIndex}]`));
    bytes32(args[1], `wallet intent ready.operations[${index}].args[1]`);
    if (typeof args[2] !== "number" || !Number.isSafeInteger(args[2]) || args[2] <= 0 || args[2] > MAX_SOURCE_BYTES) throw new TypeError(`wallet intent ready.operations[${index}].args[2] is invalid.`);
    if (typeof args[3] !== "number" || !Number.isSafeInteger(args[3]) || args[3] < 0 || args[3] > 3) throw new TypeError(`wallet intent ready.operations[${index}].args[3] is invalid.`);
    const media = kind === "weldObject" ? args[4] : args[3];
    if (typeof media !== "string" || media.length === 0 || new TextEncoder().encode(media).byteLength > 128 || (kind === "weldObject" ? args.length !== 5 : args.length !== 4)) {
      throw new TypeError(`wallet intent ready.operations[${index}] ${kind} arguments are invalid.`);
    }
    if (validateCalldata === undefined || await validateCalldata(input.signature as string, data, args) !== true) throw new TypeError(`wallet intent ready.operations[${index}].data is not canonically validated against its ABI arguments.`);
    const normalized: NormalizedOperation = { operationId, kind, chainId: input.chainId as number, to: input.to as `0x${string}`, data, valueWei: "0", signature: input.signature as string, args, objectId, storedByteLength: input.storedByteLength as number };
    if (validateAdapterOperation === undefined || await validateAdapterOperation(normalized) !== true) throw new TypeError(`wallet intent ready.operations[${index}] is not verified by the adapter's object and graph commitments.`);
    return normalized;
  }
  if (validateCalldata === undefined || await validateCalldata(input.signature as string, data, args) !== true) throw new TypeError(`wallet intent ready.operations[${index}].data is not canonically validated against its ABI arguments.`);
  const normalized: NormalizedOperation = { operationId, kind, chainId: input.chainId as number, to: input.to as `0x${string}`, data, valueWei: "0", signature: input.signature as string, args };
  if (validateAdapterOperation === undefined || await validateAdapterOperation(normalized) !== true) throw new TypeError(`wallet intent ready.operations[${index}] is not verified by the adapter's object and graph commitments.`);
  return normalized;
}

async function normalizeReady(value: unknown, validateCalldata: KeelEthereumWalletIntentInput["validateCalldata"], validateAdapterOperation: KeelEthereumWalletIntentInput["validateAdapterOperation"]): Promise<NormalizedReady> {
  const input = object(value, "wallet intent ready");
  exact(input, ["status", "family", "chainReady", "source", "operations", "signing", "submission", "caveat"], "wallet intent ready");
  if (input.status !== "ready-for-review" || input.family !== "ethereum" || input.chainReady !== false || input.signing !== "not-performed" || input.submission !== "not-performed" || input.caveat !== "Unsigned calldata only; no RPC, simulation, signing, or submission was performed.") throw new TypeError("wallet intent ready flags are invalid.");
  const sourceInput = object(input.source, "wallet intent ready.source");
  exact(sourceInput, ["planIntegrity", "contentIntegrity"], "wallet intent ready.source");
  const source = { planIntegrity: integrity(sourceInput.planIntegrity, "wallet intent ready.source.planIntegrity"), contentIntegrity: integrity(sourceInput.contentIntegrity, "wallet intent ready.source.contentIntegrity") };
  if (!Array.isArray(input.operations) || input.operations.length === 0 || input.operations.length > MAX_OPERATIONS) throw new RangeError("wallet intent ready.operations exceed the bounded limit.");
  const operations = await Promise.all(input.operations.map((item, index) => operation(item, index, source.planIntegrity, validateCalldata, validateAdapterOperation)));
  const first = operations[0];
  if (first === undefined) throw new TypeError("wallet intent requires one ready operation.");
  const ids = new Set<string>();
  let totalCallBytes = 0;
  let sawCreate = false;
  const createdIds = new Set<string>();
  for (const item of operations) {
    if (ids.has(item.operationId)) throw new TypeError(`wallet intent operation ${item.operationId} is duplicated.`);
    ids.add(item.operationId);
    if (item.chainId !== first.chainId || item.to !== first.to) throw new TypeError("wallet intent operations must share one Ethereum target.");
    totalCallBytes += (item.data.length - 2) / 2;
    if (totalCallBytes > MAX_CALL_BYTES) throw new RangeError("wallet intent calldata exceeds the aggregate limit.");
    if (item.kind === "castSlugs") {
      if (sawCreate) throw new TypeError("wallet intent castSlugs operations must precede object creation.");
    } else {
      sawCreate = true;
      const objectId = item.objectId;
      if (objectId === undefined || createdIds.has(objectId)) throw new TypeError("wallet intent object IDs must be unique.");
      if (item.kind === "weldComposite") {
        const children = item.args[0];
        if (!Array.isArray(children) || children.some((child) => typeof child !== "string" || !createdIds.has(child))) throw new TypeError("wallet intent composite parts must reference prior objects.");
      }
      createdIds.add(objectId);
    }
  }
  const last = operations[operations.length - 1];
  if (last === undefined || (last.kind !== "weldObject" && last.kind !== "weldComposite") || last.args[1] !== source.contentIntegrity.digest || last.args[2] !== source.contentIntegrity.byteLength) throw new TypeError("wallet intent final object operation is not bound to contentIntegrity.");
  return { source, operations };
}

function deferred(family: "ethereum" | "tezos", code: KeelWalletIntentDeferred["code"], issue: string): KeelWalletIntentDeferred {
  return { status: "deferred", chainReady: false, family, code, issues: [issue], walletApproval: "required", signing: "not-performed", submission: "not-performed" };
}

function unsignedBody(plan: Omit<KeelWalletIntentPlan, "integrity" | "qr">, qr: KeelWalletIntentPlan["qr"]): Omit<KeelWalletIntentPlan, "integrity"> {
  return { ...plan, qr };
}

export async function createKeelWalletIntentPlan(inputValue: unknown): Promise<KeelWalletIntentResult> {
  const input = object(inputValue, "wallet intent input");
  exact(input, ["family", "ready", "requestId", "label", "transport", "qr", "validateCalldata", "validateAdapterOperation"], "wallet intent input");
  const family = input.family;
  if (family !== "ethereum" && family !== "tezos") throw new TypeError("wallet intent family must be ethereum or tezos.");
  const requestId = text(input.requestId, "wallet intent.requestId", 128);
  const label = text(input.label, "wallet intent.label", 160);
  if (input.qr !== undefined && typeof input.qr !== "boolean") throw new TypeError("wallet intent.qr must be boolean.");
  const selectedTransport = transport(input.transport, "wallet intent.transport");
  if (family === "tezos") return deferred("tezos", selectedTransport !== undefined && selectedTransport !== "tezconnect" ? "transport-mismatch" : "tezos-adapter-required", selectedTransport !== undefined && selectedTransport !== "tezconnect" ? "Ethereum transport cannot carry a Tezos intent." : "A contract-specific Tezos adapter is required before creating wallet intents.");
  if (selectedTransport === "tezconnect") return deferred("ethereum", "transport-mismatch", "tezconnect cannot carry an Ethereum wallet intent.");
  if (input.validateCalldata !== undefined && typeof input.validateCalldata !== "function") throw new TypeError("wallet intent.validateCalldata must be a function.");
  if (input.validateAdapterOperation !== undefined && typeof input.validateAdapterOperation !== "function") throw new TypeError("wallet intent.validateAdapterOperation must be a function.");
  if (input.validateCalldata === undefined || input.validateAdapterOperation === undefined) return deferred("ethereum", "adapter-validation-required", "Inject the adapter's canonical ABI and object/graph validators before creating wallet intents.");
  const ready = await normalizeReady(input.ready, input.validateCalldata as KeelEthereumWalletIntentInput["validateCalldata"], input.validateAdapterOperation as KeelEthereumWalletIntentInput["validateAdapterOperation"]);
  const requests: KeelWalletRequestEnvelope[] = [];
  for (const [index, item] of ready.operations.entries()) {
    requests.push(await createKeelWalletRequest({
      protocol: "keel-wallet-request@1",
      requestId: `${requestId}:${String(index).padStart(5, "0")}`,
      label: `${label} [${index + 1}/${ready.operations.length}]`,
      ...(selectedTransport === undefined ? {} : { transport: selectedTransport }),
      family: "ethereum",
      chainId: item.chainId,
      to: item.to,
      data: item.data,
      valueWei: item.valueWei,
    }));
  }
  const base = {
    protocol: KEEL_WALLET_INTENT_PROTOCOL,
    status: "review-only" as const,
    chainReady: false as const,
    family: "ethereum" as const,
    requestId,
    label,
    ...(selectedTransport === undefined ? {} : { transport: selectedTransport }),
    source: { planIntegrity: ready.source.planIntegrity },
    requests,
    walletApproval: "required" as const,
    signing: "not-performed" as const,
    submission: "not-performed" as const,
    caveat: CAVEAT,
  };
  let estimate = 0;
  let body: Omit<KeelWalletIntentPlan, "integrity">;
  for (let pass = 0; pass < 2; pass += 1) {
    const qr = { status: "unsupported" as const, requested: input.qr === true, estimatedBytes: estimate, maxBytes: KEEL_WALLET_INTENT_QR_LIMIT, reason: QR_REASON };
    body = unsignedBody(base, qr);
    estimate = utf8ToBytes(canonicalJson(body)).byteLength;
  }
  const finalQr = { status: "unsupported" as const, requested: input.qr === true, estimatedBytes: estimate, maxBytes: KEEL_WALLET_INTENT_QR_LIMIT, reason: QR_REASON };
  body = unsignedBody(base, finalQr);
  return { ...body, integrity: await createIntegrity(utf8ToBytes(canonicalJson(body))) };
}

function normalizeRequestEnvelope(value: unknown, index: number): KeelWalletRequestEnvelope {
  const input = object(value, `wallet intent plan.requests[${index}]`);
  exact(input, ["request", "integrity"], `wallet intent plan.requests[${index}]`);
  const request = parseKeelWalletRequest(input.request);
  return { request, integrity: integrity(input.integrity, `wallet intent plan.requests[${index}].integrity`) };
}

function normalizePlan(value: unknown): { readonly body: Omit<KeelWalletIntentPlan, "integrity">; readonly integrity: Integrity } {
  const input = object(value, "wallet intent plan");
  exact(input, ["protocol", "status", "chainReady", "family", "requestId", "label", "transport", "source", "requests", "qr", "integrity", "walletApproval", "signing", "submission", "caveat"], "wallet intent plan");
  if (input.protocol !== KEEL_WALLET_INTENT_PROTOCOL || input.status !== "review-only" || input.chainReady !== false || input.family !== "ethereum" || input.walletApproval !== "required" || input.signing !== "not-performed" || input.submission !== "not-performed" || input.caveat !== CAVEAT) throw new TypeError("wallet intent plan flags are invalid.");
  const requestId = text(input.requestId, "wallet intent plan.requestId", 128);
  const label = text(input.label, "wallet intent plan.label", 160);
  const selectedTransport = transport(input.transport, "wallet intent plan.transport");
  if (selectedTransport === "tezconnect") throw new TypeError("tezconnect cannot carry an Ethereum wallet intent.");
  const sourceInput = object(input.source, "wallet intent plan.source");
  exact(sourceInput, ["planIntegrity"], "wallet intent plan.source");
  const source = { planIntegrity: integrity(sourceInput.planIntegrity, "wallet intent plan.source.planIntegrity") };
  if (!Array.isArray(input.requests) || input.requests.length === 0 || input.requests.length > MAX_OPERATIONS) throw new TypeError("wallet intent plan.requests is invalid.");
  const requests = input.requests.map(normalizeRequestEnvelope);
  requests.forEach((envelope, index) => {
    const request = envelope.request;
    if (request.family !== "ethereum" || request.requestId !== `${requestId}:${String(index).padStart(5, "0")}` || request.label !== `${label} [${index + 1}/${requests.length}]`) throw new TypeError(`wallet intent plan.requests[${index}] is not bound to the plan.`);
    if (selectedTransport !== undefined && request.transport !== selectedTransport) throw new TypeError(`wallet intent plan.requests[${index}] transport does not match the plan.`);
    if (selectedTransport === undefined && request.transport !== undefined) throw new TypeError(`wallet intent plan.requests[${index}] unexpectedly selects a transport.`);
  });
  const qrInput = object(input.qr, "wallet intent plan.qr");
  exact(qrInput, ["status", "requested", "estimatedBytes", "maxBytes", "reason"], "wallet intent plan.qr");
  if (qrInput.status !== "unsupported" || typeof qrInput.requested !== "boolean" || qrInput.maxBytes !== KEEL_WALLET_INTENT_QR_LIMIT || qrInput.reason !== QR_REASON || typeof qrInput.estimatedBytes !== "number" || !Number.isSafeInteger(qrInput.estimatedBytes) || qrInput.estimatedBytes < 0 || qrInput.estimatedBytes > MAX_PLAN_BYTES) throw new TypeError("wallet intent plan.qr is invalid.");
  const planIntegrity = integrity(input.integrity, "wallet intent plan.integrity");
  const body: Omit<KeelWalletIntentPlan, "integrity"> = {
    protocol: KEEL_WALLET_INTENT_PROTOCOL,
    status: "review-only",
    chainReady: false,
    family: "ethereum",
    requestId,
    label,
    ...(selectedTransport === undefined ? {} : { transport: selectedTransport }),
    source,
    requests,
    qr: { status: "unsupported", requested: qrInput.requested, estimatedBytes: qrInput.estimatedBytes, maxBytes: KEEL_WALLET_INTENT_QR_LIMIT, reason: QR_REASON },
    walletApproval: "required",
    signing: "not-performed",
    submission: "not-performed",
    caveat: CAVEAT,
  };
  return { body, integrity: planIntegrity };
}

export function parseKeelWalletIntentPlan(value: unknown): KeelWalletIntentPlan {
  const normalized = normalizePlan(value);
  return { ...normalized.body, integrity: normalized.integrity };
}

export async function verifyKeelWalletIntentPlan(value: unknown): Promise<{ readonly valid: boolean; readonly integrity?: Integrity; readonly issues: readonly string[] }> {
  try {
    const normalized = normalizePlan(value);
    const issues: string[] = [];
    for (const [index, request] of normalized.body.requests.entries()) {
      const verification = await verifyKeelWalletRequest(request);
      if (!verification.valid) issues.push(...verification.issues.map((issue) => `requests[${index}]: ${issue}`));
    }
    const actual = await createIntegrity(utf8ToBytes(canonicalJson(normalized.body)));
    if (!sameIntegrity(actual, normalized.integrity)) issues.push("wallet intent integrity does not match canonical plan bytes");
    return { valid: issues.length === 0, integrity: actual, issues };
  } catch (error) {
    return { valid: false, issues: [error instanceof Error ? error.message : String(error)] };
  }
}
