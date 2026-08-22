import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { concat, encodeCodex, encodeSparseMask } from "./binary.js";
import { canonicalJson, sha256, sha256Text } from "./hash.js";
import {
  SPRITE_BUILD_SCHEMA,
  SPRITE_LOCK_SCHEMA,
  SPRITE_SOURCE_SCHEMA,
  type CodexAsset,
  type CodexMetadata,
  type CompileOptions,
  type LockedAsset,
  type SelectionRevision,
  type SpriteBuildManifest,
  type SpriteLock,
  type SpriteSourceAsset,
  type SpriteFrameSource,
  type SpriteSourceManifest,
} from "./types.js";

interface AuthoredMaskFile {
  overrides?: Record<string, Record<string, Record<string, string>>>;
  [key: string]: unknown;
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

function nonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
}

function validateSelections(selections: SelectionRevision[], assets: SpriteSourceAsset[]): void {
  if (selections.length === 0) throw new Error("at least one selection revision is required");
  const ids = new Set(assets.map((asset) => asset.id));
  let priorRevision = 0;
  for (const selection of selections) {
    positiveInteger(selection.revision, "selection revision");
    if (selection.revision <= priorRevision) throw new Error("selection revisions must be strictly increasing");
    priorRevision = selection.revision;
    if (selection.activeAssetIds.length === 0) throw new Error(`selection revision ${selection.revision} cannot be empty`);
    if (new Set(selection.activeAssetIds).size !== selection.activeAssetIds.length) throw new Error(`selection revision ${selection.revision} repeats an asset`);
    for (const id of selection.activeAssetIds) if (!ids.has(id)) throw new Error(`selection revision ${selection.revision} references unknown asset ${id}`);
  }
  deriveRetiredAssetIds(selections);
}

function deriveRetiredAssetIds(selections: SelectionRevision[]): number[] {
  const retired = new Set<number>();
  let previous = new Set(selections[0]?.activeAssetIds ?? []);
  for (const selection of selections.slice(1)) {
    const current = new Set(selection.activeAssetIds);
    for (const id of current) if (retired.has(id)) throw new Error(`selection revision ${selection.revision} reactivates retired asset ${id}`);
    for (const id of previous) if (!current.has(id)) retired.add(id);
    previous = current;
  }
  return [...retired].sort((left, right) => left - right);
}

function validateSource(value: unknown): asserts value is SpriteSourceManifest {
  if (value === null || typeof value !== "object") throw new Error("sprite source must be an object");
  const source = value as Partial<SpriteSourceManifest>;
  if (source.schema !== SPRITE_SOURCE_SCHEMA) throw new Error(`expected schema ${SPRITE_SOURCE_SCHEMA}`);
  if (typeof source.id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(source.id)) throw new Error("source id must be a stable lowercase identifier");
  if (source.frame === undefined) throw new Error("source frame is required");
  positiveInteger(source.frame.width, "frame.width");
  positiveInteger(source.frame.height, "frame.height");
  if (!Array.isArray(source.assets) || source.assets.length === 0) throw new Error("source assets cannot be empty");
  const ids = new Set<number>();
  const keys = new Set<string>();
  const slots = new Set<number>();
  for (const asset of source.assets) {
    positiveInteger(asset.id, `asset ${asset.key} id`);
    nonNegativeInteger(asset.slot, `asset ${asset.key} slot`);
    positiveInteger(asset.frameCapacity, `asset ${asset.key} frameCapacity`);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(asset.key)) throw new Error(`asset key ${asset.key} is invalid`);
    if (ids.has(asset.id)) throw new Error(`duplicate asset id ${asset.id}`);
    if (keys.has(asset.key)) throw new Error(`duplicate asset key ${asset.key}`);
    if (slots.has(asset.slot)) throw new Error(`duplicate atlas slot ${asset.slot}`);
    if (!Array.isArray(asset.frames) || asset.frames.length === 0 || asset.frames.length > asset.frameCapacity) {
      throw new Error(`asset ${asset.key} must have 1..${asset.frameCapacity} frames`);
    }
    for (const frame of asset.frames) {
      if (typeof frame === "string") {
        if (frame.length === 0) throw new Error(`asset ${asset.key} has an empty frame path`);
        continue;
      }
      if (frame === null || typeof frame !== "object" || typeof frame.path !== "string" || frame.path.length === 0) throw new Error(`asset ${asset.key} has an invalid sheet frame`);
      nonNegativeInteger(frame.x, `asset ${asset.key} frame x`);
      nonNegativeInteger(frame.y, `asset ${asset.key} frame y`);
      if (frame.width !== undefined && frame.width !== source.frame.width) throw new Error(`asset ${asset.key} sheet frame width must equal frame.width`);
      if (frame.height !== undefined && frame.height !== source.frame.height) throw new Error(`asset ${asset.key} sheet frame height must equal frame.height`);
      if (frame.removeConnectedLightBackground !== undefined && typeof frame.removeConnectedLightBackground !== "boolean") throw new Error(`asset ${asset.key} has an invalid background-removal flag`);
    }
    ids.add(asset.id);
    keys.add(asset.key);
    slots.add(asset.slot);
  }
  if (!Array.isArray(source.selections)) throw new Error("source selections are required");
  validateSelections(source.selections, source.assets);
}

async function materializeFrame(manifestDirectory: string, source: SpriteFrameSource, width: number, height: number): Promise<{ bytes: Buffer; digestBytes: Uint8Array }> {
  const framePath = path.resolve(manifestDirectory, typeof source === "string" ? source : source.path);
  const original = new Uint8Array(await readFile(framePath));
  const metadata = await sharp(original).metadata();
  if (typeof source === "string") {
    if (metadata.width !== width || metadata.height !== height) throw new Error(`${source} is ${metadata.width}x${metadata.height}; expected ${width}x${height}`);
    return { bytes: Buffer.from(original), digestBytes: original };
  }
  const extractWidth = source.width ?? width;
  const extractHeight = source.height ?? height;
  if (metadata.width === undefined || metadata.height === undefined || source.x + extractWidth > metadata.width || source.y + extractHeight > metadata.height) {
    throw new Error(`${source.path} sheet frame ${source.x},${source.y},${extractWidth},${extractHeight} is outside ${metadata.width ?? 0}x${metadata.height ?? 0}`);
  }
  let pipeline = sharp(original).extract({ left: source.x, top: source.y, width: extractWidth, height: extractHeight });
  if (source.removeConnectedLightBackground === true) {
    const raw = await pipeline.ensureAlpha().raw().toBuffer();
    const visited = new Uint8Array(width * height);
    const queue: number[] = [];
    const enqueue = (x: number, y: number): void => {
      const index = y * width + x;
      if (visited[index] !== 0) return;
      const offset = index * 4;
      const minimum = Math.min(raw[offset]!, raw[offset + 1]!, raw[offset + 2]!);
      const maximum = Math.max(raw[offset]!, raw[offset + 1]!, raw[offset + 2]!);
      if (minimum < 210 || maximum - minimum > 12) return;
      visited[index] = 1; queue.push(index);
    };
    for (let x = 0; x < width; x += 1) { enqueue(x, 0); enqueue(x, height - 1); }
    for (let y = 0; y < height; y += 1) { enqueue(0, y); enqueue(width - 1, y); }
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const index = queue[cursor]!; const x = index % width; const y = Math.floor(index / width); raw[index * 4 + 3] = 0;
      if (x > 0) enqueue(x - 1, y); if (x + 1 < width) enqueue(x + 1, y); if (y > 0) enqueue(x, y - 1); if (y + 1 < height) enqueue(x, y + 1);
    }
    pipeline = sharp(raw, { raw: { width, height, channels: 4 } });
  }
  const extracted = await pipeline.png().toBuffer();
  return { bytes: extracted, digestBytes: extracted };
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

async function existingLock(file: string | undefined): Promise<SpriteLock | undefined> {
  if (file === undefined) return undefined;
  try {
    const lock = await readJson<SpriteLock>(file);
    if (lock.schema !== SPRITE_LOCK_SCHEMA) throw new Error(`unsupported lock schema in ${file}`);
    if (!Array.isArray(lock.retiredAssetIds)) throw new Error(`lock ${file} does not record irreversible retired asset IDs`);
    return lock;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw error;
  }
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function enforceHistory(lock: SpriteLock | undefined, source: SpriteSourceManifest, lockedAssets: LockedAsset[]): void {
  if (lock === undefined) return;
  if (lock.id !== source.id || lock.frame.width !== source.frame.width || lock.frame.height !== source.frame.height) {
    throw new Error("source identity or frame geometry differs from the immutable lock");
  }
  for (const prior of lock.assets) {
    const current = lockedAssets.find((asset) => asset.id === prior.id);
    if (current === undefined) throw new Error(`asset ${prior.id} was deleted; keep its pixels and retire it in a new selection revision`);
    if (current.key !== prior.key || current.slot !== prior.slot || current.frameCapacity < prior.frameCapacity) {
      throw new Error(`asset ${prior.id} changed its immutable key, slot, or frame capacity`);
    }
    if (current.frameSha256.length < prior.frameSha256.length || !prior.frameSha256.every((digest, index) => current.frameSha256[index] === digest)) {
      throw new Error(`asset ${prior.id} changed or removed immutable frame pixels; allocate a new asset id`);
    }
    if (current.maskSha256.length < prior.maskSha256.length || !prior.maskSha256.every((digest, index) => current.maskSha256[index] === digest)) {
      throw new Error(`asset ${prior.id} changed or removed an immutable authored mask; allocate a new asset id`);
    }
  }
  for (const prior of lock.selections) {
    const current = source.selections.find((selection) => selection.revision === prior.revision);
    if (current === undefined || !sameNumbers(current.activeAssetIds, prior.activeAssetIds)) {
      throw new Error(`selection revision ${prior.revision} is immutable; append a new revision`);
    }
  }
  const retired = new Set(deriveRetiredAssetIds(source.selections));
  for (const id of lock.retiredAssetIds) if (!retired.has(id)) throw new Error(`retired asset ${id} cannot be reactivated`);
}

function maskRoot(maskFile: AuthoredMaskFile, configuredRoot: string | undefined): Record<string, Record<string, Record<string, string>>> {
  const root = configuredRoot ?? "overrides";
  const value = maskFile[root];
  if (value === undefined) return {};
  if (value === null || typeof value !== "object") throw new Error(`mask root ${root} must be an object`);
  return value as Record<string, Record<string, Record<string, string>>>;
}

function normalizeFrameMask(mask: Record<string, string> | undefined, pixelCount: number): Array<readonly [number, string]> {
  if (mask === undefined) return [];
  return Object.entries(mask).map(([pixelText, region]) => {
    const pixel = Number(pixelText);
    if (!Number.isSafeInteger(pixel) || pixel < 0 || pixel >= pixelCount) throw new Error(`mask pixel ${pixelText} is outside the frame`);
    if (typeof region !== "string" || region.length === 0) throw new Error(`mask pixel ${pixelText} has no region`);
    return [pixel, region] as const;
  }).sort((left, right) => left[0] - right[0]);
}

export async function compileSpriteCodex(options: CompileOptions): Promise<{ manifest: SpriteBuildManifest; lock: SpriteLock }> {
  const manifestPath = path.resolve(options.manifestPath);
  const manifestDirectory = path.dirname(manifestPath);
  const outputDirectory = path.resolve(options.outputDirectory);
  const lockPath = options.lockPath === undefined ? undefined : path.resolve(options.lockPath);
  const sourceUnknown = await readJson<unknown>(manifestPath);
  validateSource(sourceUnknown);
  const source = sourceUnknown;
  const priorLock = await existingLock(lockPath);
  if (options.writeLock === false && (lockPath === undefined || priorLock === undefined)) throw new Error("check mode requires an existing --lock file");
  const masksFile = source.masks === undefined ? {} : await readJson<AuthoredMaskFile>(path.resolve(manifestDirectory, source.masks.path));
  const authoredMasks = maskRoot(masksFile, source.masks?.root);
  const width = Math.max(...source.assets.map((asset) => asset.frameCapacity)) * source.frame.width;
  const height = (Math.max(...source.assets.map((asset) => asset.slot)) + 1) * source.frame.height;
  const composites: Array<{ input: Buffer; left: number; top: number }> = [];
  const lockedAssets: LockedAsset[] = [];
  const assetMasks = new Map<number, Array<Array<readonly [number, string]>>>();

  for (const asset of [...source.assets].sort((left, right) => left.id - right.id)) {
    const frameDigests: string[] = [];
    const frameMasks: Array<Array<readonly [number, string]>> = [];
    for (const [frameIndex, frameSource] of asset.frames.entries()) {
      const frame = await materializeFrame(manifestDirectory, frameSource, source.frame.width, source.frame.height);
      frameDigests.push(await sha256(frame.digestBytes));
      composites.push({ input: frame.bytes, left: frameIndex * source.frame.width, top: asset.slot * source.frame.height });
      frameMasks.push(normalizeFrameMask(authoredMasks[asset.key]?.[String(frameIndex)], source.frame.width * source.frame.height));
    }
    assetMasks.set(asset.id, frameMasks);
    lockedAssets.push({
      id: asset.id,
      key: asset.key,
      slot: asset.slot,
      frameCapacity: asset.frameCapacity,
      frameSha256: frameDigests,
      maskSha256: await Promise.all(frameMasks.map((frameMask) => sha256Text(canonicalJson(frameMask)))),
    });
  }
  enforceHistory(priorLock, source, lockedAssets);

  await mkdir(outputDirectory, { recursive: true });
  const atlasBytes = await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(composites)
    .webp({ lossless: true, effort: 6, smartSubsample: false })
    .toBuffer();
  const atlasSha256 = await sha256(atlasBytes);

  const maskParts: Uint8Array[] = [];
  const codexAssets: CodexAsset[] = [];
  let maskOffset = 0;
  for (const asset of [...source.assets].sort((left, right) => left.id - right.id)) {
    const masks = assetMasks.get(asset.id) ?? [];
    const regions = [...new Set(masks.flat().map((entry) => entry[1]))].sort();
    const frames = masks.map((entries, frameIndex) => {
      const encoded = encodeSparseMask(entries.map(([pixel, region]) => [pixel, regions.indexOf(region)] as const));
      maskParts.push(encoded);
      const frame = { x: frameIndex * source.frame.width, y: asset.slot * source.frame.height, maskOffset, maskLength: encoded.length };
      maskOffset += encoded.length;
      return frame;
    });
    codexAssets.push({ id: asset.id, key: asset.key, label: asset.label, slot: asset.slot, frameCapacity: asset.frameCapacity, regions, frames });
  }
  const codexMetadata: CodexMetadata = {
    schema: "oca-sprite-codex@1",
    id: source.id,
    frame: source.frame,
    atlas: { width, height, sha256: atlasSha256, mediaType: "image/webp" },
    defaultDisplaySize: source.defaultDisplaySize ?? 32,
    assets: codexAssets,
    selections: source.selections,
  };
  const codexBytes = encodeCodex(codexMetadata, concat(maskParts));
  const codexSha256 = await sha256(codexBytes);
  const baseName = source.id;
  const atlasFile = `${baseName}.atlas.webp`;
  const codexFile = `${baseName}.codex.bin`;
  const buildFile = `${baseName}.build.json`;
  const checksumsFile = `${baseName}.sha256`;
  const sourceSha256 = await sha256Text(canonicalJson(source));
  const buildManifest: SpriteBuildManifest = {
    schema: SPRITE_BUILD_SCHEMA,
    id: source.id,
    sourceSha256,
    atlas: { file: atlasFile, sha256: atlasSha256, bytes: atlasBytes.length, width, height },
    codex: { file: codexFile, sha256: codexSha256, bytes: codexBytes.length },
    assetCount: source.assets.length,
    frameCount: source.assets.reduce((sum, asset) => sum + asset.frames.length, 0),
    selectionRevisions: source.selections.map((selection) => selection.revision),
  };
  const buildBytes = new TextEncoder().encode(`${canonicalJson(buildManifest)}\n`);
  const manifestSha256 = await sha256(buildBytes);
  const lock: SpriteLock = {
    schema: SPRITE_LOCK_SCHEMA,
    id: source.id,
    frame: source.frame,
    assets: lockedAssets,
    selections: source.selections,
    retiredAssetIds: deriveRetiredAssetIds(source.selections),
    build: { manifestSha256, atlasSha256, codexSha256 },
  };
  const lockBytes = new TextEncoder().encode(`${canonicalJson(lock)}\n`);
  const lockSha256 = await sha256(lockBytes);
  const checksums = `${atlasSha256}  ${atlasFile}\n${codexSha256}  ${codexFile}\n${manifestSha256}  ${buildFile}\n${lockSha256}  ${path.basename(lockPath ?? `${baseName}.lock.json`)}\n`;
  await Promise.all([
    writeFile(path.join(outputDirectory, atlasFile), atlasBytes),
    writeFile(path.join(outputDirectory, codexFile), codexBytes),
    writeFile(path.join(outputDirectory, buildFile), buildBytes),
    writeFile(path.join(outputDirectory, checksumsFile), checksums),
    ...(lockPath !== undefined && options.writeLock !== false ? [mkdir(path.dirname(lockPath), { recursive: true }).then(() => writeFile(lockPath, lockBytes))] : []),
  ]);
  return { manifest: buildManifest, lock };
}
