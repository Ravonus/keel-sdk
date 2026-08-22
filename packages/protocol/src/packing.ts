import type { PackedUint48Group } from "./types.js";

export const UINT48_MAX = (1n << 48n) - 1n;
export const UINT48_IDS_PER_WORD = 5;

function toUint48(value: bigint | number | string, index: number): bigint {
  let normalized: bigint;
  try {
    normalized = BigInt(value);
  } catch {
    throw new TypeError(`ID at index ${index} is not an integer.`);
  }
  if (normalized < 0n || normalized > UINT48_MAX) {
    throw new RangeError(`ID at index ${index} does not fit uint48.`);
  }
  return normalized;
}

export function packUint48Ids(
  values: readonly (bigint | number | string)[],
  idsPerWord = UINT48_IDS_PER_WORD,
): readonly PackedUint48Group[] {
  if (!Number.isSafeInteger(idsPerWord) || idsPerWord <= 0 || idsPerWord > 5) {
    throw new RangeError("idsPerWord must be an integer from 1 through 5.");
  }

  const groups: PackedUint48Group[] = [];
  for (let offset = 0; offset < values.length; offset += idsPerWord) {
    const ids = values.slice(offset, offset + idsPerWord).map((value, index) => toUint48(value, offset + index));
    let packed = 0n;
    ids.forEach((id, index) => {
      packed |= id << BigInt(index * 48);
    });
    groups.push({ value: packed, ids });
  }
  return groups;
}

export function unpackUint48Ids(value: bigint | number | string, count = UINT48_IDS_PER_WORD): readonly bigint[] {
  if (!Number.isSafeInteger(count) || count < 0 || count > 5) {
    throw new RangeError("count must be an integer from 0 through 5.");
  }
  const packed = BigInt(value);
  if (packed < 0n || packed >= 1n << 256n) throw new RangeError("Packed value must fit uint256.");

  const ids: bigint[] = [];
  for (let index = 0; index < count; index += 1) {
    ids.push((packed >> BigInt(index * 48)) & UINT48_MAX);
  }
  return ids;
}
