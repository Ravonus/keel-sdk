import type { ByteChunk, TextEncoding } from "./types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function utf8ToBytes(value: string): Uint8Array {
  return encoder.encode(value);
}

export function bytesToUtf8(value: Uint8Array): string {
  return decoder.decode(value);
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

// DOM BufferSource/BlobPart only accept ArrayBuffer-backed views, so a plain
// Uint8Array (which may be backed by a SharedArrayBuffer) has to be narrowed first.
export function toBufferSource(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return value.buffer instanceof ArrayBuffer
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);
}

export function bytesToHex(value: Uint8Array): `0x${string}` {
  let output = "0x";
  for (const byte of value) output += byte.toString(16).padStart(2, "0");
  return output as `0x${string}`;
}

export function hexToBytes(value: string): Uint8Array {
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  if (normalized.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(normalized)) {
    throw new TypeError("Expected an even-length hexadecimal string.");
  }
  const output = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < output.length; i += 1) {
    output[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return output;
}

function binaryStringToBytes(value: string): Uint8Array {
  const output = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i += 1) output[i] = value.charCodeAt(i);
  return output;
}

function bytesToBinaryString(value: Uint8Array): string {
  const chunkSize = 32_768;
  let output = "";
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    const chunk = value.subarray(offset, offset + chunkSize);
    output += String.fromCharCode(...chunk);
  }
  return output;
}

export function decodeBase64(value: string): Uint8Array {
  if (typeof globalThis.atob !== "function") {
    throw new Error("This runtime does not provide atob(). Supply decoded bytes through an adapter.");
  }
  return binaryStringToBytes(globalThis.atob(value));
}

export function encodeBase64(value: Uint8Array): string {
  if (typeof globalThis.btoa !== "function") {
    throw new Error("This runtime does not provide btoa().");
  }
  return globalThis.btoa(bytesToBinaryString(value));
}

// Z85, as used by the original Keel `de85` decoder. The alphabet is chosen
// so every character survives a JavaScript string literal unescaped.
const BASE85_ALPHABET =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#";

const BASE85_VALUES = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let index = 0; index < BASE85_ALPHABET.length; index += 1) {
    table[BASE85_ALPHABET.charCodeAt(index)] = index;
  }
  return table;
})();

const POW85 = [1, 85, 85 ** 2, 85 ** 3, 85 ** 4];

/**
 * Decodes Z85. Characters outside the alphabet are skipped, matching the
 * original decoder, so whitespace introduced by line-wrapping is harmless.
 *
 * A trailing partial group of `i` characters yields `i - 1` bytes: the decoder
 * pads the group with the highest digit and keeps only the leading bytes.
 */
export function decodeBase85(value: string): Uint8Array {
  const output = new Uint8Array(Math.ceil((value.length * 4) / 5));
  let written = 0;
  let accumulator = 0;
  let digits = 0;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const digit = code < 128 ? BASE85_VALUES[code] ?? -1 : -1;
    if (digit < 0) continue;
    accumulator = accumulator * 85 + digit;
    digits += 1;
    if (digits === 5) {
      output[written++] = (accumulator >>> 24) & 255;
      output[written++] = (accumulator >>> 16) & 255;
      output[written++] = (accumulator >>> 8) & 255;
      output[written++] = accumulator & 255;
      accumulator = 0;
      digits = 0;
    }
  }

  if (digits > 0) {
    const missing = 5 - digits;
    for (let index = 0; index < missing; index += 1) accumulator = accumulator * 85 + 84;
    for (let shift = 3; shift > missing - 1; shift -= 1) {
      output[written++] = (accumulator >>> (8 * shift)) & 255;
    }
  }

  return output.slice(0, written);
}

/** Encodes Z85 such that {@link decodeBase85} returns the original bytes exactly. */
export function encodeBase85(value: Uint8Array): string {
  let output = "";

  const whole = value.byteLength - (value.byteLength % 4);
  for (let offset = 0; offset < whole; offset += 4) {
    let group =
      (value[offset] ?? 0) * 16_777_216 +
      (value[offset + 1] ?? 0) * 65_536 +
      (value[offset + 2] ?? 0) * 256 +
      (value[offset + 3] ?? 0);
    let encoded = "";
    for (let digit = 0; digit < 5; digit += 1) {
      encoded = BASE85_ALPHABET[group % 85] + encoded;
      group = Math.floor(group / 85);
    }
    output += encoded;
  }

  const remaining = value.byteLength - whole;
  if (remaining > 0) {
    // The decoder reconstructs `padded = group * 85^missing + (85^missing - 1)`
    // and keeps the leading `remaining` bytes, so pick the smallest group whose
    // reconstruction carries the bytes we want.
    const missing = 4 - remaining;
    let target = 0;
    for (let index = 0; index < remaining; index += 1) target = target * 256 + (value[whole + index] ?? 0);
    target *= 256 ** missing;

    const scale = POW85[missing] ?? 1;
    const group = Math.ceil((target - scale + 1) / scale);
    let encoded = "";
    let cursor = group;
    for (let digit = 0; digit < remaining + 1; digit += 1) {
      encoded = BASE85_ALPHABET[cursor % 85] + encoded;
      cursor = Math.floor(cursor / 85);
    }
    output += encoded;
  }

  return output;
}

export function decodeText(value: string, encoding: TextEncoding): Uint8Array {
  switch (encoding) {
    case "utf8":
      return utf8ToBytes(value);
    case "base64":
      return decodeBase64(value);
    case "base64url": {
      const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
      const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
      return decodeBase64(normalized + padding);
    }
    case "base85":
      return decodeBase85(value);
  }
}

export function toDataUrl(mediaType: string, value: Uint8Array): string {
  return `data:${mediaType};base64,${encodeBase64(value)}`;
}

export function chunkBytes(value: Uint8Array, maxChunkBytes = 23_000): readonly ByteChunk[] {
  if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes <= 0) {
    throw new RangeError("maxChunkBytes must be a positive safe integer.");
  }

  const chunks: ByteChunk[] = [];
  for (let offset = 0, index = 0; offset < value.byteLength; offset += maxChunkBytes, index += 1) {
    const bytes = value.slice(offset, Math.min(offset + maxChunkBytes, value.byteLength));
    chunks.push({ index, offset, length: bytes.byteLength, bytes });
  }

  return chunks;
}

export function chunkUtf8(value: string, maxChunkBytes = 23_000): readonly ByteChunk[] {
  return chunkBytes(utf8ToBytes(value), maxChunkBytes);
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let i = 0; i < left.byteLength; i += 1) {
    difference |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return difference === 0;
}
