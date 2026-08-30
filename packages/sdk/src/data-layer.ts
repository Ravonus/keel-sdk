import { gunzipSync, gzipSync } from "node:zlib";

const MAGIC = Uint8Array.from([0x4b, 0x44, 0x50, 0x31]); // KDP1
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export type KeelDataValue = null | boolean | number | string | readonly KeelDataValue[] | {
  readonly [key: string]: KeelDataValue;
};
export type KeelModulePhase = "data" | "runtime" | "render";

export interface KeelOrderedModule {
  readonly moduleId: string;
  readonly phase?: KeelModulePhase;
  readonly weight?: number;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] as number) - (right[index] as number);
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
}

function uintHead(major: number, value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Canonical CBOR integers must be non-negative safe integers.");
  if (value < 24) return Uint8Array.of((major << 5) | value);
  if (value <= 0xff) return Uint8Array.of((major << 5) | 24, value);
  if (value <= 0xffff) return Uint8Array.of((major << 5) | 25, value >>> 8, value & 0xff);
  if (value <= 0xffff_ffff) {
    return Uint8Array.of((major << 5) | 26, value >>> 24, value >>> 16, value >>> 8, value);
  }
  const high = Math.floor(value / 0x1_0000_0000);
  const low = value >>> 0;
  return Uint8Array.of((major << 5) | 27, high >>> 24, high >>> 16, high >>> 8, high, low >>> 24, low >>> 16, low >>> 8, low);
}

function encodeCBOR(value: KeelDataValue): Uint8Array {
  if (value === null) return Uint8Array.of(0xf6);
  if (value === false) return Uint8Array.of(0xf4);
  if (value === true) return Uint8Array.of(0xf5);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("Keel data numbers must be safe integers.");
    return value >= 0 ? uintHead(0, value) : uintHead(1, -1 - value);
  }
  if (typeof value === "string") {
    const bytes = encoder.encode(value);
    return concat([uintHead(3, bytes.byteLength), bytes]);
  }
  if (Array.isArray(value)) return concat([uintHead(4, value.length), ...value.map(encodeCBOR)]);
  if (typeof value === "object") {
    const entries = Object.entries(value).map(([key, item]) => ({ key: encodeCBOR(key), value: encodeCBOR(item) }));
    entries.sort((left, right) => left.key.byteLength - right.key.byteLength || compareBytes(left.key, right.key));
    return concat([uintHead(5, entries.length), ...entries.flatMap((entry) => [entry.key, entry.value])]);
  }
  throw new TypeError("Keel data supports only JSON-compatible values.");
}

function readLength(bytes: Uint8Array, offset: { value: number }, additional: number): number {
  if (additional < 24) return additional;
  const count = additional === 24 ? 1 : additional === 25 ? 2 : additional === 26 ? 4 : additional === 27 ? 8 : 0;
  if (count === 0 || offset.value + count > bytes.byteLength) throw new TypeError("Invalid canonical CBOR length.");
  let value = 0;
  for (let index = 0; index < count; index += 1) value = value * 256 + (bytes[offset.value++] as number);
  if (!Number.isSafeInteger(value)) throw new RangeError("Canonical CBOR value exceeds JavaScript safe integer range.");
  return value;
}

function decodeCBOR(bytes: Uint8Array, offset: { value: number }): KeelDataValue {
  if (offset.value >= bytes.byteLength) throw new TypeError("Truncated canonical CBOR value.");
  const head = bytes[offset.value++] as number;
  const major = head >>> 5;
  const additional = head & 31;
  if (major === 7) {
    if (additional === 20) return false;
    if (additional === 21) return true;
    if (additional === 22) return null;
    throw new TypeError("Unsupported canonical CBOR simple value.");
  }
  const length = readLength(bytes, offset, additional);
  if (major === 0) return length;
  if (major === 1) return -1 - length;
  if (major === 3) {
    const end = offset.value + length;
    if (end > bytes.byteLength) throw new TypeError("Truncated canonical CBOR string.");
    const value = decoder.decode(bytes.subarray(offset.value, end));
    offset.value = end;
    return value;
  }
  if (major === 4) return Array.from({ length }, () => decodeCBOR(bytes, offset));
  if (major === 5) {
    const value: Record<string, KeelDataValue> = {};
    for (let index = 0; index < length; index += 1) {
      const key = decodeCBOR(bytes, offset);
      if (typeof key !== "string" || Object.hasOwn(value, key)) throw new TypeError("Canonical CBOR maps require unique text keys.");
      value[key] = decodeCBOR(bytes, offset);
    }
    return value;
  }
  throw new TypeError("Unsupported canonical CBOR major type.");
}

/** Encode JSON/YAML-compatible data as canonical CBOR, optionally deterministic gzip. */
export function encodeKeelDataPack(value: KeelDataValue, compression: "none" | "gzip" = "gzip"): Uint8Array {
  const cbor = encodeCBOR(value);
  const stored = compression === "gzip" ? new Uint8Array(gzipSync(cbor, { level: 9, mtime: 0 })) : cbor;
  return concat([MAGIC, Uint8Array.of(compression === "gzip" ? 1 : 0), stored]);
}

export function decodeKeelDataPack(pack: Uint8Array): KeelDataValue {
  if (pack.byteLength < 6 || !MAGIC.every((byte, index) => pack[index] === byte)) throw new TypeError("Invalid KEEL data-pack header.");
  const payload = pack.subarray(5);
  const cbor = pack[4] === 1 ? new Uint8Array(gunzipSync(payload)) : pack[4] === 0 ? payload : undefined;
  if (cbor === undefined) throw new TypeError("Unsupported KEEL data-pack compression.");
  const offset = { value: 0 };
  const value = decodeCBOR(cbor, offset);
  if (offset.value !== cbor.byteLength) throw new TypeError("KEEL data pack has trailing bytes.");
  return value;
}

/** Data always precedes runtime, which always precedes render. Weight only orders peers. */
export function orderKeelModules<T extends KeelOrderedModule>(modules: readonly T[]): readonly T[] {
  const phaseRank: Record<KeelModulePhase, number> = { data: 0, runtime: 1, render: 2 };
  return modules.map((module, index) => {
    const phase = module.phase ?? "runtime";
    const weight = module.weight ?? 0;
    if (!Number.isSafeInteger(weight) || weight < -32_768 || weight > 32_767) throw new RangeError(`${module.moduleId} weight is outside int16.`);
    return { module, index, phase, weight };
  }).sort((left, right) => phaseRank[left.phase] - phaseRank[right.phase]
    || left.weight - right.weight
    || left.index - right.index).map(({ module }) => module);
}
