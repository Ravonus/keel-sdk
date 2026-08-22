import type { Address, Hex } from "./types.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;

export const UINT64_MAX = (1n << 64n) - 1n;
export const UINT128_MAX = (1n << 128n) - 1n;
export const UINT256_MAX = (1n << 256n) - 1n;

export function uint(
  value: bigint | number | undefined,
  fallback = 0n,
  label = "value",
  maximum = UINT256_MAX,
): bigint {
  if (value === undefined) return fallback;
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError(`${label} must be a non-negative safe integer or bigint.`);
  }
  const result = BigInt(value);
  if (result < 0n) throw new RangeError(`${label} cannot be negative.`);
  if (result > maximum) throw new RangeError(`${label} exceeds its uint bound.`);
  return result;
}

export function normalizedAddress(value: Address | undefined, fallback: Address, label: string): Address {
  const result = value ?? fallback;
  if (!ADDRESS.test(result)) throw new TypeError(`${label} is not an EVM address.`);
  return result.toLowerCase() as Address;
}

export function normalizedBytes32(value: Hex | undefined, fallback: Hex, label: string): Hex {
  const result = value ?? fallback;
  if (!BYTES32.test(result)) throw new TypeError(`${label} must be bytes32.`);
  return result.toLowerCase() as Hex;
}

export function normalizedHex(value: Hex | undefined, fallback: Hex, label: string): Hex {
  const result = value ?? fallback;
  if (!HEX.test(result)) throw new TypeError(`${label} must be even-length hexadecimal.`);
  return result.toLowerCase() as Hex;
}

export function enumValue<T extends number>(value: T, allowed: readonly T[], label: string): T {
  if (!allowed.includes(value)) throw new RangeError(`${label} has an unsupported enum value.`);
  return value;
}

export function hexByteLength(value: Hex): number {
  return (value.length - 2) / 2;
}
