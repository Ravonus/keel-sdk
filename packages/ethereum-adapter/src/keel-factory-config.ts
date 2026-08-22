import type { Hex } from "@keel/protocol";
import {
  encodeAbiParameters,
  keccak256,
  stringToHex,
  type AbiParameter,
  type Hex as ViemHex,
} from "viem";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_DIGEST = `0x${"00".repeat(32)}`;
const MAX_TEXT_BYTES = 256;
const MAX_UINT96 = (1n << 96n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;
const CONFIG_PARAMETERS = [
  { type: "bytes32" },
  { type: "bytes32" },
  { type: "address" },
  { type: "address" },
  { type: "uint96" },
  { type: "uint256" },
  { type: "address" },
  { type: "address" },
] as const satisfies readonly AbiParameter[];

/** The exact tuple passed to KeelFactory.dieConfigDigest. */
export interface KeelFactoryCollectionConfig {
  readonly name: string;
  readonly symbol: string;
  readonly admin: `0x${string}`;
  readonly royaltyReceiver: `0x${string}`;
  readonly royaltyBps: string;
  readonly maxSupply: string;
  readonly mintManager: `0x${string}`;
  readonly keelIndex: `0x${string}`;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, label: string): void {
  const allowed = new Set(["name", "symbol", "admin", "royaltyReceiver", "royaltyBps", "maxSupply", "mintManager", "keelIndex"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${label}.${key} is not supported.`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`${label} must be printable text.`);
  if (/[\uD800-\uDFFF]/u.test(value)) throw new TypeError(`${label} must not contain unpaired UTF-16 surrogates.`);
  if (new TextEncoder().encode(value).byteLength > MAX_TEXT_BYTES) throw new RangeError(`${label} exceeds the ${MAX_TEXT_BYTES}-byte UTF-8 limit.`);
  return value;
}

function address(value: unknown, label: string, allowZero: boolean): `0x${string}` {
  if (typeof value !== "string" || !ADDRESS.test(value)) throw new TypeError(`${label} must be an Ethereum address.`);
  const normalized = value.toLowerCase() as `0x${string}`;
  if (!allowZero && normalized === ZERO_ADDRESS) throw new TypeError(`${label} cannot be the zero address.`);
  return normalized;
}

function uint(value: unknown, label: string, maximum: bigint, allowZero: boolean): string {
  if (typeof value !== "string" || !DECIMAL.test(value)) throw new TypeError(`${label} must be a canonical decimal string.`);
  const maxDigits = maximum === MAX_UINT96 ? 29 : 78;
  if (value.length > maxDigits) throw new RangeError(`${label} exceeds its decimal width.`);
  const parsed = BigInt(value);
  if ((!allowZero && parsed === 0n) || parsed > maximum) throw new RangeError(`${label} is outside its Solidity width.`);
  return parsed.toString();
}

/** Normalize an exact JSON-safe CollectionConfig for account review. */
export function normalizeKeelFactoryCollectionConfig(value: unknown): KeelFactoryCollectionConfig {
  const input = object(value, "KeelFactory collectionConfig");
  exact(input, "KeelFactory collectionConfig");
  const royaltyBps = uint(input.royaltyBps, "collectionConfig.royaltyBps", MAX_UINT96, true);
  if (BigInt(royaltyBps) > 10_000n) throw new RangeError("collectionConfig.royaltyBps cannot exceed 10000.");
  const royaltyReceiver = address(input.royaltyReceiver, "collectionConfig.royaltyReceiver", true);
  if (royaltyBps !== "0" && royaltyReceiver === ZERO_ADDRESS) throw new TypeError("collectionConfig.royaltyReceiver is required when royaltyBps is non-zero.");
  return {
    name: text(input.name, "collectionConfig.name"),
    symbol: text(input.symbol, "collectionConfig.symbol"),
    admin: address(input.admin, "collectionConfig.admin", false),
    royaltyReceiver,
    royaltyBps,
    maxSupply: uint(input.maxSupply, "collectionConfig.maxSupply", MAX_UINT256, false),
    mintManager: address(input.mintManager, "collectionConfig.mintManager", true),
    keelIndex: address(input.keelIndex, "collectionConfig.keelIndex", true),
  };
}

/** Compute KeelFactory.dieConfigDigest(config) with viem's ABI encoder. */
export function createKeelFactoryConfigDigest(value: unknown): Hex {
  const config = normalizeKeelFactoryCollectionConfig(value);
  const encoded = encodeAbiParameters(CONFIG_PARAMETERS, [
    keccak256(stringToHex(config.name)),
    keccak256(stringToHex(config.symbol)),
    config.admin,
    config.royaltyReceiver,
    config.royaltyBps,
    config.maxSupply,
    config.mintManager,
    config.keelIndex,
  ] as never);
  const digest = keccak256(encoded as ViemHex) as Hex;
  if (digest === ZERO_DIGEST) throw new Error("KeelFactory config digest cannot be zero.");
  return digest;
}
