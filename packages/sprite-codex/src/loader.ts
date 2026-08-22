import { decodeCodex, decodeSparseMask } from "./binary.js";
import { sha256 } from "./hash.js";
import { DEFAULT_SPRITE_CODEX_LIMITS, type CodexAsset, type CodexMetadata, type SelectionRevision, type SpriteCodexLimits } from "./types.js";

export interface SpriteCodexLoadOptions {
  codexUrl: string | URL;
  atlasUrl: string | URL;
  codexSha256: string;
  atlasSha256: string;
  fetch?: typeof globalThis.fetch;
  limits?: Partial<SpriteCodexLimits>;
}

export interface CanvasFrameOptions {
  asset: number | string;
  frame?: number;
  dx?: number;
  dy?: number;
  displayWidth?: number;
  displayHeight?: number;
}

function normalizeDigest(value: string): string {
  const digest = value.toLowerCase().replace(/^sha256[:-]?/, "");
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("expected a 32-byte SHA-256 digest");
  return digest as string;
}

export function pixelArtCss(): Readonly<Record<string, string>> {
  return { imageRendering: "pixelated", msInterpolationMode: "nearest-neighbor" };
}

export class SpriteCodex {
  readonly metadata: CodexMetadata;
  readonly image: CanvasImageSource;
  readonly #masks: Uint8Array;
  readonly #atlasObjectUrl: string | undefined;

  constructor(metadata: CodexMetadata, masks: Uint8Array, image: CanvasImageSource, atlasObjectUrl?: string) {
    this.metadata = metadata;
    this.#masks = masks;
    this.image = image;
    this.#atlasObjectUrl = atlasObjectUrl;
  }

  asset(idOrKey: number | string): CodexAsset {
    const asset = this.metadata.assets.find((entry) => typeof idOrKey === "number" ? entry.id === idOrKey : entry.key === idOrKey);
    if (asset === undefined) throw new Error(`unknown sprite asset ${String(idOrKey)}`);
    return asset;
  }

  selection(revision: number): SelectionRevision {
    const selection = this.metadata.selections.find((entry) => entry.revision === revision);
    if (selection === undefined) throw new Error(`unknown selection revision ${revision}`);
    return selection;
  }

  regionMask(idOrKey: number | string, frameIndex = 0): ReadonlyMap<number, string> {
    const asset = this.asset(idOrKey);
    const frame = asset.frames[frameIndex];
    if (frame === undefined) throw new RangeError(`frame ${frameIndex} is outside ${asset.key}`);
    const encoded = this.#masks.subarray(frame.maskOffset, frame.maskOffset + frame.maskLength);
    return new Map(decodeSparseMask(encoded).map(([pixel, region]) => {
      const name = asset.regions[region];
      if (name === undefined) throw new Error(`mask references unknown region ${region}`);
      return [pixel, name] as const;
    }));
  }

  draw(context: CanvasRenderingContext2D, options: CanvasFrameOptions): void {
    const asset = this.asset(options.asset);
    const frame = asset.frames[options.frame ?? 0];
    if (frame === undefined) throw new RangeError(`frame ${options.frame ?? 0} is outside ${asset.key}`);
    context.imageSmoothingEnabled = false;
    context.drawImage(
      this.image,
      frame.x,
      frame.y,
      this.metadata.frame.width,
      this.metadata.frame.height,
      options.dx ?? 0,
      options.dy ?? 0,
      options.displayWidth ?? this.metadata.defaultDisplaySize,
      options.displayHeight ?? this.metadata.defaultDisplaySize,
    );
  }

  css(idOrKey: number | string, frameIndex = 0, displaySize = this.metadata.defaultDisplaySize, atlasUrl?: string): string {
    const asset = this.asset(idOrKey);
    const frame = asset.frames[frameIndex];
    if (frame === undefined) throw new RangeError(`frame ${frameIndex} is outside ${asset.key}`);
    const scale = displaySize / this.metadata.frame.width;
    const url = atlasUrl ?? this.#atlasObjectUrl;
    if (url === undefined) throw new Error("css() needs atlasUrl when the codex was constructed without one");
    return [
      `width:${displaySize}px`,
      `height:${displaySize}px`,
      `background-image:url(${JSON.stringify(url)})`,
      `background-repeat:no-repeat`,
      `background-size:${this.metadata.atlas.width * scale}px ${this.metadata.atlas.height * scale}px`,
      `background-position:${-frame.x * scale}px ${-frame.y * scale}px`,
      "image-rendering:pixelated",
    ].join(";");
  }

  dispose(): void {
    if (this.#atlasObjectUrl !== undefined) URL.revokeObjectURL(this.#atlasObjectUrl);
  }
}

async function responseBytes(fetcher: typeof globalThis.fetch, url: string | URL, limit: number): Promise<Uint8Array> {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`failed to load ${String(url)}: HTTP ${response.status}`);
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > limit) throw new Error(`resource ${String(url)} exceeds byte limit ${limit}`);
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > limit) throw new Error(`resource ${String(url)} exceeds byte limit ${limit}`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.length;
    if (length > limit) {
      await reader.cancel("sprite resource byte limit exceeded");
      throw new Error(`resource ${String(url)} exceeds byte limit ${limit}`);
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

function uint24(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

export function parseWebpDimensions(bytes: Uint8Array): { width: number; height: number } {
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
  if (bytes.length < 20 || ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WEBP") throw new Error("sprite atlas is not a WebP container");
  const riffLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true) + 8;
  if (riffLength > bytes.length) throw new Error("sprite atlas WebP is truncated");
  if (riffLength !== bytes.length) throw new Error("sprite atlas WebP has trailing bytes");
  let offset = 12;
  while (offset + 8 <= riffLength) {
    const type = ascii(offset, 4);
    const size = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0, true);
    const dataOffset = offset + 8;
    if (size > riffLength - dataOffset) throw new Error("sprite atlas has a truncated WebP chunk");
    if (type === "VP8X" && size >= 10) return { width: uint24(bytes, dataOffset + 4) + 1, height: uint24(bytes, dataOffset + 7) + 1 };
    if (type === "VP8L" && size >= 5) {
      if (bytes[dataOffset] !== 0x2f) throw new Error("sprite atlas has an invalid VP8L header");
      const bits = new DataView(bytes.buffer, bytes.byteOffset + dataOffset + 1, 4).getUint32(0, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (type === "VP8 " && size >= 10) {
      if (bytes[dataOffset + 3] !== 0x9d || bytes[dataOffset + 4] !== 0x01 || bytes[dataOffset + 5] !== 0x2a) throw new Error("sprite atlas has an invalid VP8 header");
      const view = new DataView(bytes.buffer, bytes.byteOffset + dataOffset + 6, 4);
      const width = view.getUint16(0, true) & 0x3fff;
      const height = view.getUint16(2, true) & 0x3fff;
      if (width === 0 || height === 0) throw new Error("sprite atlas has invalid VP8 dimensions");
      return { width, height };
    }
    offset = dataOffset + size + (size & 1);
  }
  throw new Error("sprite atlas WebP has no supported image dimensions");
}

export async function loadSpriteCodex(options: SpriteCodexLoadOptions): Promise<SpriteCodex> {
  const fetcher = options.fetch ?? globalThis.fetch;
  if (fetcher === undefined) throw new Error("fetch is unavailable");
  const limits: SpriteCodexLimits = { ...DEFAULT_SPRITE_CODEX_LIMITS, ...options.limits };
  for (const [name, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid sprite codex limit ${name}`);
  const [codexBytes, atlasBytes] = await Promise.all([
    responseBytes(fetcher, options.codexUrl, limits.maxCodexBytes),
    responseBytes(fetcher, options.atlasUrl, limits.maxAtlasBytes),
  ]);
  const [actualCodex, actualAtlas] = await Promise.all([sha256(codexBytes), sha256(atlasBytes)]);
  if (actualCodex !== normalizeDigest(options.codexSha256)) throw new Error("sprite codex SHA-256 mismatch");
  if (actualAtlas !== normalizeDigest(options.atlasSha256)) throw new Error("sprite atlas SHA-256 mismatch");
  const decoded = decodeCodex(codexBytes, limits);
  if (normalizeDigest(decoded.metadata.atlas.sha256) !== actualAtlas) throw new Error("sprite atlas does not match codex commitment");
  const dimensions = parseWebpDimensions(atlasBytes);
  if (dimensions.width !== decoded.metadata.atlas.width || dimensions.height !== decoded.metadata.atlas.height) throw new Error("sprite atlas dimensions do not match codex metadata");
  if (dimensions.width > limits.maxAtlasWidth || dimensions.height > limits.maxAtlasHeight || dimensions.width > Math.floor(limits.maxDecodedPixels / dimensions.height)) {
    throw new Error("sprite atlas decoded dimensions exceed configured limits");
  }
  const atlasBuffer = new Uint8Array(atlasBytes).buffer as ArrayBuffer;
  const objectUrl = URL.createObjectURL(new Blob([atlasBuffer], { type: "image/webp" }));
  try {
    const image = await createImageBitmap(new Blob([atlasBuffer], { type: "image/webp" }));
    return new SpriteCodex(decoded.metadata, decoded.masks, image, objectUrl);
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}
