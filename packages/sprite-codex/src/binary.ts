import { DEFAULT_SPRITE_CODEX_LIMITS, SPRITE_CODEX_SCHEMA, type CodexMetadata, type SpriteCodexLimits } from "./types.js";

const MAGIC = new Uint8Array([0x53, 0x43, 0x58, 0x31]); // SCX1
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeVarUint(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("varuint must be a non-negative safe integer");
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return Uint8Array.from(bytes);
}

export function decodeVarUint(bytes: Uint8Array, start = 0): { value: number; next: number } {
  let value = 0;
  let multiplier = 1;
  let offset = start;
  let count = 0;
  while (offset < bytes.length && count < 8) {
    const byte = bytes[offset];
    if (byte === undefined) break;
    value += (byte & 0x7f) * multiplier;
    if (!Number.isSafeInteger(value)) throw new RangeError("varuint exceeds safe integer range");
    offset += 1;
    count += 1;
    if ((byte & 0x80) === 0) {
      if (encodeVarUint(value).length !== count) throw new Error("non-canonical varuint");
      return { value, next: offset };
    }
    multiplier *= 128;
  }
  throw new Error("truncated varuint");
}

export function encodeSparseMask(entries: ReadonlyArray<readonly [number, number]>): Uint8Array {
  const sorted = [...entries].sort((a, b) => a[0] - b[0]);
  const parts: Uint8Array[] = [encodeVarUint(sorted.length)];
  let previous = -1;
  for (const [pixel, region] of sorted) {
    if (!Number.isSafeInteger(pixel) || pixel < 0 || pixel <= previous) throw new Error("mask pixels must be unique non-negative integers");
    if (!Number.isSafeInteger(region) || region < 0) throw new Error("mask region indexes must be non-negative integers");
    parts.push(encodeVarUint(pixel - previous), encodeVarUint(region));
    previous = pixel;
  }
  return concat(parts);
}

export function decodeSparseMask(bytes: Uint8Array, maxEntries = DEFAULT_SPRITE_CODEX_LIMITS.maxMaskEntriesPerFrame): ReadonlyArray<readonly [number, number]> {
  const countResult = decodeVarUint(bytes);
  if (countResult.value > maxEntries) throw new Error(`sparse mask entry count exceeds limit ${maxEntries}`);
  let offset = countResult.next;
  let previous = -1;
  const entries: Array<readonly [number, number]> = [];
  for (let index = 0; index < countResult.value; index += 1) {
    const delta = decodeVarUint(bytes, offset);
    if (delta.value === 0) throw new Error("sparse mask pixels must be strictly increasing");
    const region = decodeVarUint(bytes, delta.next);
    previous += delta.value;
    entries.push([previous, region.value]);
    offset = region.next;
  }
  if (offset !== bytes.length) throw new Error("sparse mask has trailing bytes");
  return entries;
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function encodeCodex(metadata: CodexMetadata, masks: Uint8Array): Uint8Array {
  const json = textEncoder.encode(JSON.stringify(metadata));
  const header = new Uint8Array(8);
  header.set(MAGIC);
  new DataView(header.buffer).setUint32(4, json.length, true);
  return concat([header, json, masks]);
}

function integer(value: unknown, label: string, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${label} must be an integer >= ${minimum}`);
}

function digest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
}

function validateMetadata(metadata: CodexMetadata, masks: Uint8Array, limits: SpriteCodexLimits): void {
  if (metadata.schema !== SPRITE_CODEX_SCHEMA) {
    throw new Error("unsupported sprite codex schema");
  }
  if (typeof metadata.id !== "string" || metadata.id.length === 0 || metadata.id.length > 256) throw new Error("invalid codex id");
  integer(metadata.frame?.width, "frame.width", 1);
  integer(metadata.frame?.height, "frame.height", 1);
  integer(metadata.defaultDisplaySize, "defaultDisplaySize", 1);
  integer(metadata.atlas?.width, "atlas.width", 1);
  integer(metadata.atlas?.height, "atlas.height", 1);
  if (metadata.atlas.width > limits.maxAtlasWidth || metadata.atlas.height > limits.maxAtlasHeight) throw new Error("atlas dimensions exceed configured limits");
  if (metadata.atlas.width > Math.floor(limits.maxDecodedPixels / metadata.atlas.height)) throw new Error("atlas decoded pixels exceed configured limit");
  if (metadata.atlas.mediaType !== "image/webp") throw new Error("atlas media type must be image/webp");
  digest(metadata.atlas.sha256, "atlas.sha256");
  if (!Array.isArray(metadata.assets) || metadata.assets.length === 0 || metadata.assets.length > limits.maxAssets) throw new Error("asset count is invalid or exceeds configured limit");
  const ids = new Set<number>();
  const keys = new Set<string>();
  const slots = new Set<number>();
  let totalFrames = 0;
  let totalMaskEntries = 0;
  let expectedMaskOffset = 0;
  let priorAssetId = 0;
  let maximumCapacity = 0;
  let maximumSlot = 0;
  for (const asset of metadata.assets) {
    integer(asset.id, "asset.id", 1);
    integer(asset.slot, "asset.slot");
    integer(asset.frameCapacity, "asset.frameCapacity", 1);
    if (typeof asset.key !== "string" || asset.key.length === 0 || asset.key.length > 256) throw new Error("invalid asset key");
    if (typeof asset.label !== "string" || asset.label.length > 1_024) throw new Error("invalid asset label");
    if (ids.has(asset.id) || keys.has(asset.key) || slots.has(asset.slot)) throw new Error("duplicate asset id, key, or slot");
    if (asset.id <= priorAssetId) throw new Error("assets must be canonically ordered by increasing id");
    priorAssetId = asset.id;
    ids.add(asset.id); keys.add(asset.key); slots.add(asset.slot);
    if (!Array.isArray(asset.regions) || asset.regions.length > limits.maxRegionsPerAsset || new Set(asset.regions).size !== asset.regions.length || asset.regions.some((region) => typeof region !== "string" || region.length === 0 || region.length > 256)) {
      throw new Error(`asset ${asset.id} has invalid or duplicate regions`);
    }
    if (asset.regions.some((region, index) => index > 0 && region <= (asset.regions[index - 1] ?? ""))) throw new Error(`asset ${asset.id} regions must be canonically sorted`);
    if (!Array.isArray(asset.frames) || asset.frames.length === 0 || asset.frames.length > asset.frameCapacity || asset.frames.length > limits.maxFramesPerAsset) throw new Error(`asset ${asset.id} frame count is invalid or exceeds limit`);
    if (asset.frameCapacity > Math.floor(metadata.atlas.width / metadata.frame.width)) throw new Error(`asset ${asset.id} frame capacity exceeds atlas width`);
    maximumCapacity = Math.max(maximumCapacity, asset.frameCapacity);
    maximumSlot = Math.max(maximumSlot, asset.slot);
    totalFrames += asset.frames.length;
    if (totalFrames > limits.maxTotalFrames) throw new Error("total frame count exceeds configured limit");
    for (const [frameIndex, frame] of asset.frames.entries()) {
      integer(frame.x, "frame.x"); integer(frame.y, "frame.y"); integer(frame.maskOffset, "frame.maskOffset"); integer(frame.maskLength, "frame.maskLength", 1);
      if (frame.x !== frameIndex * metadata.frame.width || frame.y !== asset.slot * metadata.frame.height || frame.x + metadata.frame.width > metadata.atlas.width || frame.y + metadata.frame.height > metadata.atlas.height) {
        throw new Error(`asset ${asset.id} frame is outside or misaligned with the atlas`);
      }
      if (frame.maskOffset !== expectedMaskOffset || frame.maskLength > masks.length - frame.maskOffset) throw new Error(`asset ${asset.id} has invalid or non-canonical mask offsets`);
      const entries = decodeSparseMask(masks.subarray(frame.maskOffset, frame.maskOffset + frame.maskLength), limits.maxMaskEntriesPerFrame);
      for (const [pixel, region] of entries) {
        if (pixel >= metadata.frame.width * metadata.frame.height) throw new Error(`asset ${asset.id} mask pixel is outside the frame`);
        if (region >= asset.regions.length) throw new Error(`asset ${asset.id} mask references an unknown region`);
      }
      totalMaskEntries += entries.length;
      if (totalMaskEntries > limits.maxTotalMaskEntries) throw new Error("total mask entries exceed configured limit");
      expectedMaskOffset += frame.maskLength;
    }
  }
  if (metadata.atlas.width !== maximumCapacity * metadata.frame.width || metadata.atlas.height !== (maximumSlot + 1) * metadata.frame.height) throw new Error("atlas dimensions are not canonical for reserved slots");
  if (expectedMaskOffset !== masks.length) throw new Error("codex has unreferenced trailing mask bytes");
  if (!Array.isArray(metadata.selections) || metadata.selections.length === 0) throw new Error("codex requires selection revisions");
  const revisions = new Set<number>();
  const retired = new Set<number>();
  let priorRevision = 0;
  let priorActive: Set<number> | undefined;
  for (const selection of metadata.selections) {
    integer(selection.revision, "selection.revision", 1);
    if (revisions.has(selection.revision) || selection.revision <= priorRevision) throw new Error("selection revisions must be unique and strictly increasing");
    revisions.add(selection.revision);
    priorRevision = selection.revision;
    if (!Array.isArray(selection.activeAssetIds) || selection.activeAssetIds.length === 0 || new Set(selection.activeAssetIds).size !== selection.activeAssetIds.length) throw new Error(`selection ${selection.revision} is empty or repeats assets`);
    const current = new Set<number>();
    for (const id of selection.activeAssetIds) {
      if (!ids.has(id)) throw new Error(`selection ${selection.revision} references unknown asset ${id}`);
      if (retired.has(id)) throw new Error(`selection ${selection.revision} reactivates retired asset ${id}`);
      current.add(id);
    }
    if (priorActive !== undefined) for (const id of priorActive) if (!current.has(id)) retired.add(id);
    priorActive = current;
  }
}

export function decodeCodex(bytes: Uint8Array, configuredLimits: Partial<SpriteCodexLimits> = {}): { metadata: CodexMetadata; masks: Uint8Array } {
  const limits = { ...DEFAULT_SPRITE_CODEX_LIMITS, ...configuredLimits };
  for (const [name, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid sprite codex limit ${name}`);
  if (bytes.length > limits.maxCodexBytes) throw new Error(`sprite codex exceeds limit ${limits.maxCodexBytes}`);
  if (bytes.length < 8 || MAGIC.some((byte, index) => bytes[index] !== byte)) throw new Error("unsupported sprite codex magic/version");
  const jsonLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  if (jsonLength > limits.maxMetadataBytes) throw new Error(`sprite codex metadata exceeds limit ${limits.maxMetadataBytes}`);
  if (jsonLength > bytes.length - 8) throw new Error("truncated sprite codex metadata");
  const jsonBytes = bytes.subarray(8, 8 + jsonLength);
  const jsonText = textDecoder.decode(jsonBytes);
  const metadata = JSON.parse(jsonText) as CodexMetadata;
  if (JSON.stringify(metadata) !== jsonText) throw new Error("sprite codex metadata is not canonically encoded");
  const masks = bytes.slice(8 + jsonLength);
  validateMetadata(metadata, masks, limits);
  return { metadata, masks };
}
