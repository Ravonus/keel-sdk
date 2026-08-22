import {
  canonicalJson,
  createIntegrity,
  type Hex,
  type Integrity,
} from "@keel/protocol";
import {
  KEEL_MODULE_RESOLVER_VERSION,
  verifyKeelModuleBytes,
  verifyKeelModuleLock,
  type LegacyModuleResolverSnapshot,
  type ModuleLockEnvelope,
} from "./module-legacy.js";

export const KEEL_MODULE_RECEIPT_PROTOCOL = "keel-module-receipt@1" as const;

export type ModuleBytesStatus = "unavailable" | "verified" | "mismatch";

export interface ModuleReceiptStatus {
  readonly releaseKey: string;
  readonly bytes: ModuleBytesStatus;
}

export interface ModuleReceipt {
  readonly schema: typeof KEEL_MODULE_RECEIPT_PROTOCOL;
  readonly resolverVersion: typeof KEEL_MODULE_RESOLVER_VERSION;
  readonly catalogIntegrity: Integrity;
  readonly lockIntegrity: Integrity;
  readonly statuses: readonly ModuleReceiptStatus[];
}

export interface ModuleReceiptEnvelope {
  readonly receipt: ModuleReceipt;
  readonly integrity: Integrity;
}

export interface ModuleReceiptVerification {
  readonly valid: boolean;
  readonly receiptIntegrity: Integrity;
  readonly issues: readonly string[];
}

function sameIntegrity(left: Integrity, right: Integrity): boolean {
  return left.algorithm === right.algorithm && left.digest === right.digest && left.byteLength === right.byteLength;
}

function status(value: string): ModuleBytesStatus {
  if (value !== "unavailable" && value !== "verified" && value !== "mismatch") throw new TypeError("Unsupported module byte status.");
  return value;
}

function releaseKeyText(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function parseIntegrity(value: unknown, label: string): Integrity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(label + " must be an object.");
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!["algorithm", "digest", "byteLength"].includes(key)) throw new TypeError(label + "." + key + " is not supported.");
  if (input.algorithm !== "sha256" || typeof input.digest !== "string" || !/^0x[0-9a-f]{64}$/u.test(input.digest) || !Number.isSafeInteger(input.byteLength) || (input.byteLength as number) <= 0) throw new TypeError(label + " is invalid.");
  return { algorithm: "sha256", digest: input.digest as Hex, byteLength: input.byteLength as number };
}

function receiptEnvelope(value: unknown): ModuleReceiptEnvelope {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("module receipt envelope must be an object.");
  const envelope = value as Record<string, unknown>;
  for (const key of Object.keys(envelope)) if (!["receipt", "integrity"].includes(key)) throw new TypeError("module receipt envelope contains an unsupported field.");
  const receiptValue = envelope.receipt;
  if (receiptValue === null || typeof receiptValue !== "object" || Array.isArray(receiptValue)) throw new TypeError("module receipt must be an object.");
  const receipt = receiptValue as Record<string, unknown>;
  for (const key of Object.keys(receipt)) if (!["schema", "resolverVersion", "catalogIntegrity", "lockIntegrity", "statuses"].includes(key)) throw new TypeError("module receipt contains an unsupported field.");
  if (receipt.schema !== KEEL_MODULE_RECEIPT_PROTOCOL || receipt.resolverVersion !== KEEL_MODULE_RESOLVER_VERSION) throw new TypeError("Unsupported module receipt.");
  const catalogIntegrity = parseIntegrity(receipt.catalogIntegrity, "module receipt.catalogIntegrity");
  const lockIntegrity = parseIntegrity(receipt.lockIntegrity, "module receipt.lockIntegrity");
  if (!Array.isArray(receipt.statuses) || receipt.statuses.length === 0 || receipt.statuses.length > 64) throw new TypeError("module receipt statuses are invalid.");
  const statuses: ModuleReceiptStatus[] = [];
  const seen = new Set<string>();
  for (const [index, itemValue] of receipt.statuses.entries()) {
    if (itemValue === null || typeof itemValue !== "object" || Array.isArray(itemValue)) throw new TypeError("module receipt status " + index + " is invalid.");
    const item = itemValue as Record<string, unknown>;
    for (const key of Object.keys(item)) if (!["releaseKey", "bytes"].includes(key)) throw new TypeError("module receipt status contains an unsupported field.");
    if (!releaseKeyText(item.releaseKey) || seen.has(item.releaseKey)) throw new TypeError("module receipt has duplicate or empty release status.");
    const bytes = status(typeof item.bytes === "string" ? item.bytes : "");
    seen.add(item.releaseKey);
    statuses.push({ releaseKey: item.releaseKey, bytes });
  }
  return {
    receipt: { schema: KEEL_MODULE_RECEIPT_PROTOCOL, resolverVersion: KEEL_MODULE_RESOLVER_VERSION, catalogIntegrity, lockIntegrity, statuses },
    integrity: parseIntegrity(envelope.integrity, "module receipt envelope.integrity"),
  };
}

export async function createKeelModuleReceipt(
  snapshot: LegacyModuleResolverSnapshot,
  lockEnvelope: ModuleLockEnvelope,
  bytes: Readonly<Record<string, Uint8Array>> = {},
): Promise<ModuleReceiptEnvelope> {
  const checkedLock = await verifyKeelModuleLock(snapshot, lockEnvelope);
  if (!checkedLock.valid) throw new Error("Cannot create a receipt for an invalid module lock: " + checkedLock.issues.join("; "));
  const statuses: ModuleReceiptStatus[] = [];
  for (const resolution of lockEnvelope.lock.resolutions) {
    const candidate = bytes[resolution.releaseKey];
    const byteStatus = candidate === undefined ? "unavailable" : await verifyKeelModuleBytes(resolution, candidate);
    statuses.push({ releaseKey: resolution.releaseKey, bytes: byteStatus });
  }
  const receipt: ModuleReceipt = {
    schema: KEEL_MODULE_RECEIPT_PROTOCOL,
    resolverVersion: KEEL_MODULE_RESOLVER_VERSION,
    catalogIntegrity: lockEnvelope.lock.catalogIntegrity,
    lockIntegrity: lockEnvelope.integrity,
    statuses,
  };
  return { receipt, integrity: await createIntegrity(new TextEncoder().encode(canonicalJson(receipt))) };
}

export async function verifyKeelModuleReceipt(
  snapshot: LegacyModuleResolverSnapshot,
  lockEnvelope: ModuleLockEnvelope,
  envelope: ModuleReceiptEnvelope,
  bytes: Readonly<Record<string, Uint8Array>> = {},
): Promise<ModuleReceiptVerification> {
  let checked: ModuleReceiptEnvelope;
  try {
    checked = receiptEnvelope(envelope);
  } catch (error) {
    const fallback = await createIntegrity(new Uint8Array());
    return { valid: false, receiptIntegrity: fallback, issues: [error instanceof Error ? error.message : String(error)] };
  }
  const issues: string[] = [];
  const actualIntegrity = await createIntegrity(new TextEncoder().encode(canonicalJson(checked.receipt)));
  if (!sameIntegrity(actualIntegrity, checked.integrity)) issues.push("receipt integrity does not match canonical receipt bytes");
  const lockCheck = await verifyKeelModuleLock(snapshot, lockEnvelope);
  if (!lockCheck.valid) return { valid: false, receiptIntegrity: actualIntegrity, issues: lockCheck.issues.map((issue) => "lock: " + issue) };
  if (!sameIntegrity(checked.receipt.catalogIntegrity, lockEnvelope.lock.catalogIntegrity)) issues.push("receipt catalog integrity does not match lock");
  if (!sameIntegrity(checked.receipt.lockIntegrity, lockEnvelope.integrity)) issues.push("receipt lock integrity does not match lock");
  if (checked.receipt.statuses.length !== lockEnvelope.lock.resolutions.length) issues.push("receipt status count does not match lock");
  const seen = new Set<string>();
  for (let index = 0; index < checked.receipt.statuses.length; index += 1) {
    const item = checked.receipt.statuses[index];
    const expected = lockEnvelope.lock.resolutions[index];
    if (item === undefined || expected === undefined || item.releaseKey !== expected.releaseKey || seen.has(item.releaseKey)) {
      issues.push("receipt statuses are not in the exact lock order");
      continue;
    }
    seen.add(item.releaseKey);
    let actualStatus: ModuleBytesStatus = "unavailable";
    const candidate = bytes[item.releaseKey];
    if (candidate !== undefined) actualStatus = await verifyKeelModuleBytes(expected, candidate);
    if (item.bytes !== actualStatus) issues.push("receipt byte status is not supported by supplied bytes for " + item.releaseKey);
  }
  return { valid: issues.length === 0, receiptIntegrity: actualIntegrity, issues };
}
