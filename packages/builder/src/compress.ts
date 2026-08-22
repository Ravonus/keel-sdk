import { promisify } from "node:util";
import {
  brotliCompress,
  brotliDecompress,
  constants,
  deflate,
  gzip,
  gunzip,
  inflate,
} from "node:zlib";
import type { Compression } from "@keel/protocol";

const brotliCompressAsync = promisify(brotliCompress);
const brotliDecompressAsync = promisify(brotliDecompress);
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const deflateAsync = promisify(deflate);
const inflateAsync = promisify(inflate);

export async function compressBytes(compression: Compression, bytes: Uint8Array): Promise<Uint8Array> {
  switch (compression) {
    case "none":
      return bytes.slice();
    case "brotli":
      return new Uint8Array(
        await brotliCompressAsync(bytes, {
          params: {
            [constants.BROTLI_PARAM_QUALITY ?? 1]: 11,
            [constants.BROTLI_PARAM_MODE ?? 0]: constants.BROTLI_MODE_GENERIC ?? 0,
          },
        }),
      );
    case "gzip":
      return new Uint8Array(await gzipAsync(bytes, { level: 9 }));
    case "deflate":
      return new Uint8Array(await deflateAsync(bytes, { level: 9 }));
  }
}

export async function decompressBytes(compression: Compression, bytes: Uint8Array): Promise<Uint8Array> {
  switch (compression) {
    case "none":
      return bytes.slice();
    case "brotli":
      return new Uint8Array(await brotliDecompressAsync(bytes));
    case "gzip":
      return new Uint8Array(await gunzipAsync(bytes));
    case "deflate":
      return new Uint8Array(await inflateAsync(bytes));
  }
}

export async function chooseSmallestCompression(
  bytes: Uint8Array,
  candidates: readonly Compression[] = ["brotli", "gzip", "deflate", "none"],
): Promise<{ readonly compression: Compression; readonly bytes: Uint8Array }> {
  let best: { compression: Compression; bytes: Uint8Array } = { compression: "none", bytes: bytes.slice() };
  for (const compression of candidates) {
    const compressed = await compressBytes(compression, bytes);
    if (compressed.byteLength < best.bytes.byteLength) best = { compression, bytes: compressed };
  }
  return best;
}
