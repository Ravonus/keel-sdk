import {
  createViemEthereumAdapterCodecs,
  prepareEthereumKeelHoldOperations,
  type EthereumAdapterResult,
} from "@keel/ethereum-adapter";
import path from "node:path";
import type { Workspace } from "./types.js";

const MAX_PLAN_BYTES = 4 * 1024 * 1024;
const MAX_SLUG_BYTES = 23_000;
const MAX_SOURCE_ENTRIES = 65_536;
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
const SAFE_RELATIVE = /^(?!\/)(?!.*(?:^|\/)(?:\.|\.\.)$)[^\\\u0000-\u001f\u007f]+$/u;

function safeRelative(value: string): boolean {
  return SAFE_RELATIVE.test(value) && value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const fields = new Set(allowed);
  for (const key of Object.keys(value)) if (!fields.has(key)) throw new TypeError(`${label}.${key} is not supported.`);
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== "string" || result.length === 0) throw new TypeError(`${key} must be a non-empty string.`);
  return result;
}

function optionalBoolean(value: Record<string, unknown>, key: string): boolean | undefined {
  const result = value[key];
  if (result === undefined) return undefined;
  if (typeof result !== "boolean") throw new TypeError(`${key} must be boolean.`);
  return result;
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const value = (error as { readonly code?: unknown }).code;
  return typeof value === "string" ? value : undefined;
}

function collectChunkFiles(plan: unknown): string[] {
  const input = record(plan, "upload plan");
  const values: unknown[] = [];
  if (input.schema === "keel-upload-plan@2") {
    if (Array.isArray(input.chunks)) values.push(...input.chunks);
  } else if (input.schema === "keel-recursive-upload-plan@2" && Array.isArray(input.objects)) {
    for (const objectValue of input.objects) {
      const item = record(objectValue, "upload plan object");
      if (item.kind === "leaf" && Array.isArray(item.chunks)) values.push(...item.chunks);
    }
  }
  const files = new Set<string>();
  for (const value of values) {
    const item = record(value, "upload plan chunk");
    if (typeof item.file === "string" && safeRelative(item.file)) files.add(item.file);
    if (files.size > MAX_SOURCE_ENTRIES) throw new RangeError(`upload plan references more than ${MAX_SOURCE_ENTRIES} chunk files.`);
  }
  return [...files];
}

async function loadPlan(workspace: Workspace, planPath: string): Promise<{ readonly plan: unknown; readonly chunks: Readonly<Record<string, Uint8Array>> }> {
  const loaded = await workspace.readFile(planPath, MAX_PLAN_BYTES);
  const plan = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(loaded.bytes)) as unknown;
  const directory = path.dirname(planPath);
  const chunks: Record<string, Uint8Array> = {};
  let total = 0;
  for (const file of collectChunkFiles(plan)) {
    const relative = path.join(directory, file);
    try {
      const chunk = await workspace.readFile(relative, MAX_SLUG_BYTES);
      total += chunk.bytes.byteLength;
      if (!Number.isSafeInteger(total) || total > MAX_SOURCE_BYTES) throw new RangeError(`chunk bytes exceed the ${MAX_SOURCE_BYTES}-byte adapter limit.`);
      chunks[file] = chunk.bytes;
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
  }
  return { plan, chunks };
}

export async function ethereumEncodeTool(workspace: Workspace, value: unknown): Promise<unknown> {
  const input = record(value, "ethereum-encode arguments");
  exact(input, ["plan", "family", "chainId", "target", "qr"], "ethereum-encode arguments");
  const planPath = requiredString(input, "plan");
  const family = requiredString(input, "family");
  if (family !== "ethereum") throw new TypeError("ethereum-encode currently supports family ethereum only.");
  const chainId = input.chainId;
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId <= 0) throw new TypeError("chainId must be a positive safe integer.");
  const target = requiredString(input, "target");
  const qrRequested = optionalBoolean(input, "qr") === true;
  const loaded = await loadPlan(workspace, planPath);
  const result: EthereumAdapterResult = await prepareEthereumKeelHoldOperations({
    plan: loaded.plan,
    chunks: loaded.chunks,
    target: { family: "ethereum", chainId, address: target },
    codecs: createViemEthereumAdapterCodecs(),
  });
  const output = {
    ...result,
    planPath,
    transport: {
      qr: "unsupported",
      requested: qrRequested,
      reason: "This offline adapter emits unsigned calldata only; review it first, then use wallet-request-prepare for a connector-specific request.",
    },
  };
  if (new TextEncoder().encode(JSON.stringify(output)).byteLength > MAX_RESULT_BYTES) throw new RangeError(`ethereum-encode response exceeds the ${MAX_RESULT_BYTES}-byte MCP detail limit.`);
  return output;
}
