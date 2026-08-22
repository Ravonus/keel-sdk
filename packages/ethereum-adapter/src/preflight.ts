import type { Hex, Integrity } from "@keel/protocol";
import { utf8ToBytes } from "@keel/protocol";
import type { EthereumAdapterReady, EthereumAdapterResult, UnsignedKeelHoldCall } from "./adapter.js";
import { createViemEthereumAdapterCodecs } from "./viem-codecs.js";
import { bytesToHex, encodeAbiParameters as viemEncodeAbiParameters, keccak256 as viemKeccak256 } from "viem";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const HEX32 = /^0x[0-9a-f]{64}$/u;
const HASH32 = HEX32;
const HEX = /^0x(?:[0-9a-f]{2})*$/u;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MAX_CHECKS = 16_384;
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_CALL_BYTES = 512_000;
const MAX_SLUG_BYTES = 23_000;
const MAX_BATCH_SLUGS = 3;
const MAX_CHILDREN = 128;
const SIGNATURES: Record<UnsignedKeelHoldCall["kind"], string> = {
  castSlugs: "castSlugs(bytes[])",
  weldObject: "weldObject(bytes32[],bytes32,uint64,uint8,string)",
  weldComposite: "weldComposite(bytes32[],bytes32,uint64,string)",
};
const SELECTORS: Record<UnsignedKeelHoldCall["kind"], string> = {
  castSlugs: "0x0d1ff9e2",
  weldObject: "0xb17463a8",
  weldComposite: "0x5f97a164",
};
const CANONICAL_VALIDATE_FUNCTION_DATA = createViemEthereumAdapterCodecs().validateFunctionData;

function bytesFromHex(value: Hex): Uint8Array {
  const bytes = new Uint8Array((value.length - 2) / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
  return bytes;
}

function concatBytes(values: readonly Uint8Array[]): Uint8Array {
  const total = values.reduce((sum, value) => sum + value.byteLength, 0);
  if (!Number.isSafeInteger(total) || total > MAX_SOURCE_BYTES) throw new RangeError("object ID preimage exceeds the preflight byte limit.");
  const result = new Uint8Array(total);
  let offset = 0;
  for (const value of values) { result.set(value, offset); offset += value.byteLength; }
  return result;
}

function canonicalKeccak(value: Uint8Array): Hex {
  return viemKeccak256(bytesToHex(value)) as Hex;
}

function compressionCode(value: number): number {
  return value;
}

function deriveObjectId(operation: UnsignedKeelHoldCall, storedByteLength: number): Hex {
  const children = operationIds(operation);
  const indexDigest = canonicalKeccak(concatBytes(children.map(bytesFromHex)));
  const digest = operation.args[1] as Hex;
  const byteLength = operation.args[2] as number;
  const mediaType = (operation.kind === "weldObject" ? operation.args[4] : operation.args[3]) as string;
  const mediaDigest = canonicalKeccak(utf8ToBytes(mediaType));
  const types = operation.kind === "weldObject"
    ? ["bytes1", "bytes32", "bytes32", "uint64", "uint64", "uint8", "bytes32"]
    : ["bytes1", "bytes32", "bytes32", "uint64", "uint64", "bytes32"];
  const values = operation.kind === "weldObject"
    ? ["0x00", indexDigest, digest, byteLength, storedByteLength, compressionCode(operation.args[3] as number), mediaDigest]
    : ["0x01", indexDigest, digest, byteLength, storedByteLength, mediaDigest];
  const encoded = viemEncodeAbiParameters(types.map((type) => ({ type })), values as never) as Hex;
  return canonicalKeccak(bytesFromHex(encoded));
}

export interface EthereumReadOnlyClient {
  readonly getCode: (request: { readonly chainId: number; readonly address: `0x${string}` }) => Promise<Hex>;
  readonly readContract: (request: {
    readonly chainId: number;
    readonly address: `0x${string}`;
    readonly functionName: "slugPointer" | "objectExists";
    readonly args: readonly [Hex];
  }) => Promise<unknown>;
}

export interface EthereumPreflightRequest {
  readonly kind: "chunk-pointer" | "object-exists";
  readonly operationId: string;
  readonly id: Hex;
}

export interface EthereumPreflightCheck {
  readonly kind: "contract-code" | "chunk-pointer" | "object-exists";
  readonly operationId?: string;
  readonly id?: Hex;
  readonly status: "present" | "missing" | "already-present";
}

export interface EthereumPreflightPassed {
  readonly status: "passed";
  readonly chainReady: false;
  readonly target: { readonly chainId: number; readonly address: `0x${string}` };
  readonly source: { readonly planIntegrity: Integrity };
  readonly requests: readonly EthereumPreflightRequest[];
  readonly checks: readonly EthereumPreflightCheck[];
  readonly signing: "not-performed";
  readonly submission: "not-performed";
  readonly caveat: "Read-only code and descriptor checks passed; no simulation, signing, or submission was performed.";
}

export interface EthereumPreflightFailure {
  readonly status: "blocked" | "unavailable" | "deferred";
  readonly chainReady: false;
  readonly code: "contract-missing" | "chunk-missing" | "object-missing" | "read-unavailable" | "invalid-adapter-result" | "adapter-result-deferred";
  readonly issues: readonly string[];
  readonly target?: { readonly chainId: number; readonly address: `0x${string}` };
  readonly source?: { readonly planIntegrity: Integrity };
  readonly signing: "not-performed";
  readonly submission: "not-performed";
}

export type EthereumPreflightResult = EthereumPreflightPassed | EthereumPreflightFailure;

export interface EthereumKeelHoldReceipt {
  readonly operationId: string;
  readonly transactionHash: Hex;
  readonly chainId: number;
  readonly to: `0x${string}`;
  readonly status: "success" | "reverted";
  readonly blockNumber: number;
}

export interface EthereumReceiptVerificationPassed {
  readonly status: "verified";
  readonly chainReady: false;
  readonly source: { readonly planIntegrity: Integrity };
  readonly receipts: readonly EthereumKeelHoldReceipt[];
  readonly signing: "not-performed";
  readonly submission: "not-performed";
  readonly caveat: "Receipt shape and operation bindings verified locally; no logs, state, signing, or submission were fetched or performed.";
}

export interface EthereumReceiptVerificationFailure {
  readonly status: "failed" | "deferred";
  readonly chainReady: false;
  readonly code: "adapter-result-deferred" | "receipt-mismatch" | "receipt-reverted" | "receipt-invalid";
  readonly issues: readonly string[];
  readonly source?: { readonly planIntegrity: Integrity };
  readonly signing: "not-performed";
  readonly submission: "not-performed";
}

export type EthereumReceiptVerificationResult = EthereumReceiptVerificationPassed | EthereumReceiptVerificationFailure;

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const fields = new Set(allowed);
  for (const key of Object.keys(value)) if (!fields.has(key)) throw new TypeError(`${label}.${key} is not supported.`);
}

function hex32(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !HEX32.test(value)) throw new TypeError(`${label} must be a lower-case bytes32 value.`);
  return value as Hex;
}

function sourceInfo(ready: EthereumAdapterReady): { readonly planIntegrity: Integrity } {
  const input = object(ready.source, "adapter.source");
  exact(input, ["planIntegrity", "contentIntegrity"], "adapter.source");
  const integrityValue = (value: unknown, label: string): Integrity => {
    const inputValue = object(value, label);
    exact(inputValue, ["algorithm", "digest", "byteLength"], label);
    if (inputValue.algorithm !== "sha256" || typeof inputValue.digest !== "string" || !HASH32.test(inputValue.digest)) throw new TypeError(`${label} must be lower-case SHA-256.`);
    const byteLength = positive(inputValue.byteLength, `${label}.byteLength`);
    if (byteLength > MAX_SOURCE_BYTES) throw new RangeError(`${label}.byteLength exceeds ${MAX_SOURCE_BYTES}.`);
    return { algorithm: "sha256", digest: inputValue.digest as Hex, byteLength };
  };
  const plan = integrityValue(input.planIntegrity, "adapter.source.planIntegrity");
  integrityValue(input.contentIntegrity, "adapter.source.contentIntegrity");
  return { planIntegrity: plan };
}

function address(value: unknown, label: string): `0x${string}` {
  if (typeof value !== "string" || !ADDRESS.test(value)) throw new TypeError(`${label} must be a 20-byte address.`);
  return value.toLowerCase() as `0x${string}`;
}

function positive(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new TypeError(`${label} must be a positive safe integer within its limit.`);
  return value;
}

function media(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`${label} must be printable text.`);
  if (new TextEncoder().encode(value).byteLength > 128) throw new RangeError(`${label} exceeds the 128-byte UTF-8 limit.`);
  return value;
}

function chunkBytes(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !HEX.test(value) || value.length <= 2 || (value.length - 2) / 2 > MAX_SLUG_BYTES) throw new TypeError(`${label} must be a non-empty hex chunk no larger than ${MAX_SLUG_BYTES} bytes.`);
  return value as Hex;
}

function ids(value: unknown, label: string): Hex[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CHILDREN) throw new TypeError(`${label} must contain 1 through ${MAX_CHILDREN} IDs.`);
  return value.map((item, index) => hex32(item, `${label}[${index}]`));
}

function validateArguments(kind: UnsignedKeelHoldCall["kind"], value: readonly unknown[], label: string): void {
  if (kind === "castSlugs") {
    if (value.length !== 1 || !Array.isArray(value[0]) || value[0].length < 1 || value[0].length > MAX_BATCH_SLUGS) throw new TypeError(`${label} must contain 1 through ${MAX_BATCH_SLUGS} chunks.`);
    (value[0] as readonly unknown[]).forEach((item, index) => chunkBytes(item, `${label}[0][${index}]`));
    return;
  }
  if (kind === "weldObject") {
    if (value.length !== 5) throw new TypeError(`${label} must contain five ABI arguments.`);
    ids(value[0], `${label}[0]`);
    hex32(value[1], `${label}[1]`);
    positive(value[2], `${label}[2]`, MAX_SOURCE_BYTES);
    if (typeof value[3] !== "number" || !Number.isSafeInteger(value[3]) || value[3] < 0 || value[3] > 3) throw new TypeError(`${label}[3] compression code is invalid.`);
    media(value[4], `${label}[4]`);
    return;
  }
  if (value.length !== 4) throw new TypeError(`${label} must contain four ABI arguments.`);
  ids(value[0], `${label}[0]`);
  hex32(value[1], `${label}[1]`);
  positive(value[2], `${label}[2]`, MAX_SOURCE_BYTES);
  media(value[3], `${label}[3]`);
}

function deferred(code: EthereumPreflightFailure["code"], issue: string, ready?: EthereumAdapterReady): EthereumPreflightFailure {
  let context: { readonly target?: { readonly chainId: number; readonly address: `0x${string}` }; readonly source?: { readonly planIntegrity: Integrity } } = {};
  if (ready !== undefined) {
    try { context = { target: targetOf(ready), source: sourceInfo(ready) }; } catch { /* malformed adapter results stay unbound */ }
  }
  return {
    status: code === "adapter-result-deferred" || code === "invalid-adapter-result" ? "deferred" : code === "read-unavailable" ? "unavailable" : "blocked",
    chainReady: false,
    code,
    issues: [issue],
    ...context,
    signing: "not-performed",
    submission: "not-performed",
  };
}

function targetOf(ready: EthereumAdapterReady): { readonly chainId: number; readonly address: `0x${string}` } {
  const first = ready.operations[0];
  if (first === undefined) throw new TypeError("adapter result has no operations.");
  const target = { chainId: positive(first.chainId, "operation.chainId"), address: address(first.to, "operation.to") };
  if (ready.operations.some((operation) => operation.chainId !== target.chainId || address(operation.to, "operation.to") !== target.address)) throw new TypeError("adapter operations do not share one target.");
  return target;
}

function validateObjectOrder(operations: readonly UnsignedKeelHoldCall[]): void {
  const created = new Set<string>();
  let castSlugsSeen = false;
  for (const operation of operations) {
    if (operation.kind === "castSlugs") {
      castSlugsSeen = true;
      continue;
    }
    if (!castSlugsSeen) throw new TypeError(`${operation.kind} cannot precede its castSlugs operation.`);
    if (operation.kind === "weldObject") {
      if (operation.objectId === undefined || created.has(operation.objectId)) throw new TypeError(`adapter object ${operation.objectId ?? "<missing>"} is duplicated.`);
      created.add(operation.objectId);
    } else if (operation.kind === "weldComposite") {
      for (const part of operationIds(operation)) if (!created.has(part)) throw new TypeError(`composite ${operation.operationId} references an object that was not created earlier.`);
      if (operation.objectId === undefined || created.has(operation.objectId)) throw new TypeError(`adapter object ${operation.objectId ?? "<missing>"} is duplicated.`);
      created.add(operation.objectId);
    }
  }
  if (!castSlugsSeen) throw new TypeError("adapter result has no castSlugs operation.");
}

function validateObjectIds(operations: readonly UnsignedKeelHoldCall[]): void {
  const chunkLengths = new Map<Hex, number>();
  const objectLengths = new Map<Hex, number>();
  let totalChunkBytes = 0;
  for (const operation of operations) {
    if (operation.kind === "castSlugs") {
      const values = operation.args[0] as readonly unknown[];
      for (const value of values) {
        const bytes = bytesFromHex(value as Hex);
        totalChunkBytes += bytes.byteLength;
        if (totalChunkBytes > MAX_SOURCE_BYTES) throw new RangeError(`KeelHold preflight bytes exceed ${MAX_SOURCE_BYTES}.`);
        const id = canonicalKeccak(bytes);
        const previous = chunkLengths.get(id);
        if (previous !== undefined && previous !== bytes.byteLength) throw new TypeError(`Chunk ${id} has conflicting stored lengths.`);
        chunkLengths.set(id, bytes.byteLength);
      }
      continue;
    }
    const children = operationIds(operation);
    const storedByteLength = operation.storedByteLength;
    if (storedByteLength === undefined || !Number.isSafeInteger(storedByteLength) || storedByteLength <= 0 || storedByteLength > MAX_SOURCE_BYTES) throw new TypeError(`${operation.operationId} is missing a bounded storedByteLength commitment.`);
    let expectedStoredByteLength = 0;
    if (operation.kind === "weldObject") {
      for (const id of children) {
        const length = chunkLengths.get(id);
        if (length === undefined) throw new TypeError(`${operation.operationId} references a chunk that is absent from preceding castSlugs.`);
        expectedStoredByteLength += length;
      }
    } else {
      for (const id of children) {
        const length = objectLengths.get(id);
        if (length === undefined) throw new TypeError(`${operation.operationId} references an object whose stored length is unavailable.`);
        expectedStoredByteLength += length;
      }
    }
    if (expectedStoredByteLength !== storedByteLength) throw new TypeError(`${operation.operationId} storedByteLength does not match its preceding content.`);
    const expectedObjectId = deriveObjectId(operation, storedByteLength);
    if (operation.objectId !== expectedObjectId) throw new TypeError(`${operation.operationId} objectId does not match its canonical KeelHold preimage.`);
    objectLengths.set(operation.objectId, storedByteLength);
  }
}

function validateOperation(value: unknown, index: number): UnsignedKeelHoldCall {
  const input = object(value, `adapter.operations[${index}]`);
  exact(input, ["operationId", "kind", "chainId", "to", "valueWei", "signature", "args", "data", "objectId", "storedByteLength"], `adapter.operations[${index}]`);
  if (typeof input.operationId !== "string" || input.operationId.length === 0 || input.operationId.length > 128) throw new TypeError(`adapter.operations[${index}].operationId is invalid.`);
  if (input.kind !== "castSlugs" && input.kind !== "weldObject" && input.kind !== "weldComposite") throw new TypeError(`adapter.operations[${index}].kind is invalid.`);
  const chainId = positive(input.chainId, `adapter.operations[${index}].chainId`);
  const to = address(input.to, `adapter.operations[${index}].to`);
  if (input.valueWei !== "0" || input.signature !== SIGNATURES[input.kind]) throw new TypeError(`adapter.operations[${index}] has an unsupported call descriptor.`);
  if (!Array.isArray(input.args)) throw new TypeError(`adapter.operations[${index}].args must be an array.`);
  const kind = input.kind as UnsignedKeelHoldCall["kind"];
  validateArguments(kind, input.args as readonly unknown[], `adapter.operations[${index}].args`);
  const minimumCallBytes = input.kind === "castSlugs" ? 164 : input.kind === "weldObject" ? 292 : 260;
  if (typeof input.data !== "string" || !HEX.test(input.data) || (input.data.length - 2) / 2 > MAX_CALL_BYTES || input.data.length < 2 + minimumCallBytes * 2 || input.data.slice(0, 10).toLowerCase() !== SELECTORS[input.kind]) throw new TypeError(`adapter.operations[${index}].data has an invalid KeelHold selector or ABI body.`);
  if (CANONICAL_VALIDATE_FUNCTION_DATA === undefined || CANONICAL_VALIDATE_FUNCTION_DATA(input.signature as string, input.data as Hex, input.args as readonly unknown[]) !== true) throw new TypeError(`adapter.operations[${index}].data does not decode as its canonical KeelHold call.`);
  if (input.objectId !== undefined) hex32(input.objectId, `adapter.operations[${index}].objectId`);
  if ((input.kind === "weldObject" || input.kind === "weldComposite") && input.objectId === undefined) throw new TypeError(`adapter.operations[${index}].objectId is required.`);
  if (input.kind === "castSlugs" && (input.objectId !== undefined || input.storedByteLength !== undefined)) throw new TypeError(`adapter.operations[${index}] castSlugs cannot carry object metadata.`);
  if (input.kind !== "castSlugs" && (typeof input.storedByteLength !== "number" || !Number.isSafeInteger(input.storedByteLength) || input.storedByteLength <= 0 || input.storedByteLength > MAX_SOURCE_BYTES)) throw new TypeError(`adapter.operations[${index}].storedByteLength is invalid.`);
  const operation: UnsignedKeelHoldCall = { operationId: input.operationId as string, kind, chainId, to, valueWei: "0", signature: input.signature as string, args: input.args as readonly unknown[], data: input.data as Hex, ...(input.objectId === undefined ? {} : { objectId: input.objectId as Hex }), ...(input.storedByteLength === undefined ? {} : { storedByteLength: input.storedByteLength as number }) };
  return operation;
}

function assertReady(ready: EthereumAdapterReady): void {
  const input = object(ready, "adapter result");
  exact(input, ["status", "family", "chainReady", "source", "operations", "signing", "submission", "caveat"], "adapter result");
  if (ready.status !== "ready-for-review" || ready.family !== "ethereum" || ready.chainReady !== false || ready.signing !== "not-performed" || ready.submission !== "not-performed" || ready.caveat !== "Unsigned calldata only; no RPC, simulation, signing, or submission was performed.") throw new TypeError("adapter result is not an unsigned Ethereum review descriptor.");
  if (!Array.isArray(ready.operations) || ready.operations.length === 0 || ready.operations.length > MAX_CHECKS) throw new TypeError("adapter result operations are invalid.");
  sourceInfo(ready);
  const ids = new Set<string>();
  ready.operations.forEach((operation, index) => {
    const parsed = validateOperation(operation, index);
    if (ids.has(parsed.operationId)) throw new TypeError(`adapter operation ${parsed.operationId} is duplicated.`);
    const expectedOperationId = `op-${ready.source.planIntegrity.digest.slice(2, 14)}-${String(index).padStart(5, "0")}`;
    if (parsed.operationId !== expectedOperationId) throw new TypeError(`adapter operation ${index} is not bound to the source plan integrity.`);
    ids.add(parsed.operationId);
  });
  validateObjectOrder(ready.operations);
  validateObjectIds(ready.operations);
  const creates = ready.operations.filter((operation) => operation.kind === "weldObject" || operation.kind === "weldComposite");
  const root = creates[creates.length - 1];
  if (root === undefined || root.args[1] !== ready.source.contentIntegrity.digest || root.args[2] !== ready.source.contentIntegrity.byteLength) throw new TypeError("adapter source contentIntegrity does not match the final object descriptor.");
  targetOf(ready);
}

function operationIds(operation: UnsignedKeelHoldCall): Hex[] {
  if (operation.kind !== "weldObject" && operation.kind !== "weldComposite") return [];
  if (!Array.isArray(operation.args) || !Array.isArray(operation.args[0])) throw new TypeError(`${operation.kind} args do not contain IDs.`);
  const ids = operation.args[0] as readonly unknown[];
  if (ids.length === 0) throw new TypeError(`${operation.kind} must contain at least one ID.`);
  return ids.map((id, index) => hex32(id, `${operation.operationId}.args[0][${index}]`));
}

function requests(ready: EthereumAdapterReady): EthereumPreflightRequest[] {
  const result: EthereumPreflightRequest[] = [];
  const seen = new Set<string>();
  for (const operation of ready.operations) {
    const kind = operation.kind === "weldObject" ? "chunk-pointer" : operation.kind === "weldComposite" ? "object-exists" : undefined;
    if (kind === undefined) continue;
    for (const id of operationIds(operation)) {
      const key = `${kind}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ kind, operationId: operation.operationId, id });
      if (result.length > MAX_CHECKS) throw new RangeError(`preflight checks exceed ${MAX_CHECKS}.`);
    }
  }
  return result;
}

function codePresent(value: unknown): boolean {
  return typeof value === "string" && HEX.test(value) && value.length > 2;
}

function pointerPresent(value: unknown): boolean {
  return typeof value === "string" && ADDRESS.test(value) && value.toLowerCase() !== ZERO_ADDRESS;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must return a boolean.`);
  return value;
}

export async function preflightEthereumKeelHoldOperations(ready: EthereumAdapterResult, client: EthereumReadOnlyClient): Promise<EthereumPreflightResult> {
  if (ready === null || typeof ready !== "object" || Array.isArray(ready)) return deferred("invalid-adapter-result", "A review descriptor object is required.");
  if (ready.status !== "ready-for-review") return deferred("adapter-result-deferred", "A ready-for-review adapter result is required.");
  let target: { readonly chainId: number; readonly address: `0x${string}` };
  let source: { readonly planIntegrity: Integrity };
  let checks: EthereumPreflightCheck[] = [];
  let readRequests: EthereumPreflightRequest[];
  try {
    assertReady(ready);
    target = targetOf(ready);
    source = sourceInfo(ready);
    readRequests = requests(ready);
  } catch (error) {
    return deferred("invalid-adapter-result", error instanceof Error ? error.message : String(error), ready);
  }
  try {
    const code = await client.getCode(target);
    if (!codePresent(code)) return deferred("contract-missing", "KeelHold target has no deployed bytecode.", ready);
    checks.push({ kind: "contract-code", status: "present" });
    for (const request of readRequests) {
      const value = await client.readContract({ chainId: target.chainId, address: target.address, functionName: request.kind === "chunk-pointer" ? "slugPointer" : "objectExists", args: [request.id] });
      if (request.kind === "chunk-pointer") {
        if (!pointerPresent(value)) return deferred("chunk-missing", `Chunk ${request.id} is not present on the target.`, ready);
        checks.push({ kind: request.kind, operationId: request.operationId, id: request.id, status: "present" });
      } else {
        checks.push({ kind: request.kind, operationId: request.operationId, id: request.id, status: bool(value, `${request.kind} ${request.id}`) ? "already-present" : "missing" });
      }
    }
  } catch (error) {
    return {
      status: "unavailable",
      chainReady: false,
      code: "read-unavailable",
      issues: [error instanceof Error ? error.message : String(error)],
      target,
      source,
      signing: "not-performed",
      submission: "not-performed",
    };
  }
  return {
    status: "passed",
    chainReady: false,
    target,
    source,
    requests: readRequests,
    checks,
    signing: "not-performed",
    submission: "not-performed",
    caveat: "Read-only code and descriptor checks passed; no simulation, signing, or submission was performed.",
  };
}

function receipt(value: unknown, label: string): EthereumKeelHoldReceipt {
  const input = object(value, label);
  exact(input, ["operationId", "transactionHash", "chainId", "to", "status", "blockNumber"], label);
  if (typeof input.operationId !== "string" || input.operationId.length === 0 || input.operationId.length > 128) throw new TypeError(`${label}.operationId is invalid.`);
  const transactionHash = hex32(input.transactionHash, `${label}.transactionHash`);
  const chainId = positive(input.chainId, `${label}.chainId`);
  const to = address(input.to, `${label}.to`);
  if (input.status !== "success" && input.status !== "reverted") throw new TypeError(`${label}.status is invalid.`);
  const blockNumber = positive(input.blockNumber, `${label}.blockNumber`);
  return { operationId: input.operationId, transactionHash, chainId, to, status: input.status, blockNumber };
}

export function verifyEthereumKeelHoldReceipts(ready: EthereumAdapterResult, values: readonly unknown[]): EthereumReceiptVerificationResult {
  if (ready === null || typeof ready !== "object" || Array.isArray(ready)) return { status: "failed", chainReady: false, code: "receipt-invalid", issues: ["A review descriptor object is required."], signing: "not-performed", submission: "not-performed" };
  if (ready.status !== "ready-for-review") return { status: "deferred", chainReady: false, code: "adapter-result-deferred", issues: ["A ready-for-review adapter result is required."], signing: "not-performed", submission: "not-performed" };
  let source: { readonly planIntegrity: Integrity };
  try {
    assertReady(ready);
    source = sourceInfo(ready);
  } catch (error) {
    return { status: "failed", chainReady: false, code: "receipt-invalid", issues: [error instanceof Error ? error.message : String(error)], signing: "not-performed", submission: "not-performed" };
  }
  if (!Array.isArray(values) || values.length !== ready.operations.length) return { status: "failed", chainReady: false, code: "receipt-mismatch", issues: ["Receipt count does not match the operation count."], source, signing: "not-performed", submission: "not-performed" };
  try {
    const normalized = values.map((value, index) => receipt(value, `receipt[${index}]`));
    for (const [index, item] of normalized.entries()) {
      const operation = ready.operations[index];
      if (operation === undefined) return { status: "failed", chainReady: false, code: "receipt-mismatch", issues: [`receipt[${index}] has no matching operation.`], source, signing: "not-performed", submission: "not-performed" };
      if (item.operationId !== operation.operationId || item.chainId !== operation.chainId || item.to !== operation.to.toLowerCase()) return { status: "failed", chainReady: false, code: "receipt-mismatch", issues: [`receipt[${index}] does not bind to operation ${operation.operationId}.`], source, signing: "not-performed", submission: "not-performed" };
      if (item.status !== "success") return { status: "failed", chainReady: false, code: "receipt-reverted", issues: [`operation ${operation.operationId} reverted.`], source, signing: "not-performed", submission: "not-performed" };
    }
    return { status: "verified", chainReady: false, source, receipts: normalized, signing: "not-performed", submission: "not-performed", caveat: "Receipt shape and operation bindings verified locally; no logs, state, signing, or submission were fetched or performed." };
  } catch (error) {
    return { status: "failed", chainReady: false, code: "receipt-invalid", issues: [error instanceof Error ? error.message : String(error)], source, signing: "not-performed", submission: "not-performed" };
  }
}
