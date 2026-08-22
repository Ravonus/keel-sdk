export const SPRITE_SOURCE_SCHEMA = "oca-sprite-source@1" as const;
/**
 * The on-disk container format id, deliberately still carrying the old project
 * name.
 *
 * Every other OCA identifier in this repository was renamed to KEEL. This one
 * is frozen, because it is written into the bytes of revision-locked binary
 * bundles and the library compiler refuses to change a published revision in
 * place: renaming it forces `1@1` to become `1@2` for every vault bundle. That
 * would change the identity of published sprite assets, which other projects
 * reference, to fix a string no human reads.
 *
 * It goes away for free the next time a bundle is revised for a real reason.
 * `readSpriteCodex` already accepts the KEEL spelling, so a bundle emitted
 * under it loads today.
 */
export const SPRITE_CODEX_SCHEMA = "oca-sprite-codex@1" as const;

/** The name new bundles will carry once the vault bundles are next revised. */
export const SPRITE_CODEX_SCHEMA_KEEL = "oca-sprite-codex@1" as const;
export const SPRITE_BUILD_SCHEMA = "oca-sprite-build@1" as const;
export const SPRITE_LOCK_SCHEMA = "oca-sprite-lock@1" as const;
export const SPRITE_LIBRARY_SOURCE_SCHEMA = "oca-sprite-library-source@1" as const;
export const SPRITE_LIBRARY_BUILD_SCHEMA = "oca-sprite-library-build@1" as const;
export const SPRITE_LIBRARY_LOCK_SCHEMA = "oca-sprite-library-lock@1" as const;

export interface SpriteSheetFrameSource {
  path: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  /** Exact opt-in parity with Vault's connected near-white background remover. */
  removeConnectedLightBackground?: boolean;
}

export type SpriteFrameSource = string | SpriteSheetFrameSource;

export interface SpriteSourceAsset {
  /** Permanent positive integer. Never reuse or renumber it. */
  id: number;
  key: string;
  label: string;
  /** Permanent zero-based atlas row. Never reuse or move it. */
  slot: number;
  /** Reserved cells for future frames. Cannot shrink. */
  frameCapacity: number;
  frames: SpriteFrameSource[];
}

export interface SelectionRevision {
  revision: number;
  activeAssetIds: number[];
}

export interface SparseMaskSource {
  path: string;
  root?: string;
}

export interface SpriteSourceManifest {
  schema: typeof SPRITE_SOURCE_SCHEMA;
  id: string;
  frame: { width: number; height: number };
  defaultDisplaySize?: number;
  assets: SpriteSourceAsset[];
  selections: SelectionRevision[];
  masks?: SparseMaskSource;
}

export interface CodexFrame {
  x: number;
  y: number;
  maskOffset: number;
  maskLength: number;
}

export interface CodexAsset {
  id: number;
  key: string;
  label: string;
  slot: number;
  frameCapacity: number;
  regions: string[];
  frames: CodexFrame[];
}

export interface CodexMetadata {
  schema: typeof SPRITE_CODEX_SCHEMA;
  id: string;
  frame: { width: number; height: number };
  atlas: { width: number; height: number; sha256: string; mediaType: "image/webp" };
  defaultDisplaySize: number;
  assets: CodexAsset[];
  selections: SelectionRevision[];
}

export interface SpriteBuildManifest {
  schema: typeof SPRITE_BUILD_SCHEMA;
  id: string;
  sourceSha256: string;
  atlas: { file: string; sha256: string; bytes: number; width: number; height: number };
  codex: { file: string; sha256: string; bytes: number };
  assetCount: number;
  frameCount: number;
  selectionRevisions: number[];
}

export interface LockedAsset {
  id: number;
  key: string;
  slot: number;
  frameCapacity: number;
  frameSha256: string[];
  maskSha256: string[];
}

export interface SpriteLock {
  schema: typeof SPRITE_LOCK_SCHEMA;
  id: string;
  frame: { width: number; height: number };
  assets: LockedAsset[];
  selections: SelectionRevision[];
  /** IDs omitted by a later selection. They can never be selected again. */
  retiredAssetIds: number[];
  build: { manifestSha256: string; atlasSha256: string; codexSha256: string };
}

export interface SpriteCodexLimits {
  maxCodexBytes: number;
  maxAtlasBytes: number;
  maxMetadataBytes: number;
  maxAssets: number;
  maxFramesPerAsset: number;
  maxTotalFrames: number;
  maxRegionsPerAsset: number;
  maxMaskEntriesPerFrame: number;
  maxTotalMaskEntries: number;
  maxAtlasWidth: number;
  maxAtlasHeight: number;
  maxDecodedPixels: number;
}

export const DEFAULT_SPRITE_CODEX_LIMITS: Readonly<SpriteCodexLimits> = Object.freeze({
  maxCodexBytes: 8 * 1024 * 1024,
  maxAtlasBytes: 32 * 1024 * 1024,
  maxMetadataBytes: 2 * 1024 * 1024,
  maxAssets: 4_096,
  maxFramesPerAsset: 1_024,
  maxTotalFrames: 65_536,
  maxRegionsPerAsset: 1_024,
  maxMaskEntriesPerFrame: 1_048_576,
  maxTotalMaskEntries: 8_388_608,
  maxAtlasWidth: 16_384,
  maxAtlasHeight: 16_384,
  maxDecodedPixels: 67_108_864,
});

export interface CompileOptions {
  manifestPath: string;
  outputDirectory: string;
  lockPath?: string;
  writeLock?: boolean;
}

export interface SpriteBundleRevisionRef {
  bundleId: number;
  revision: number;
}

export interface SpriteLibraryBundleSource extends SpriteBundleRevisionRef {
  key: string;
  role: string;
  source: string;
  lock: string;
  dependencies: SpriteBundleRevisionRef[];
}

export interface SpriteLibraryProfileSource {
  id: string;
  revision: number;
  roots: SpriteBundleRevisionRef[];
}

export interface SpriteInventoryRoot {
  path: string;
  label: string;
}

export interface SpriteLibrarySourceManifest {
  schema: typeof SPRITE_LIBRARY_SOURCE_SCHEMA;
  id: string;
  bundles: SpriteLibraryBundleSource[];
  profiles: SpriteLibraryProfileSource[];
  inventoryRoots: SpriteInventoryRoot[];
}

export interface SpriteLibraryBundleBuild extends SpriteBundleRevisionRef {
  key: string;
  role: string;
  dependencies: SpriteBundleRevisionRef[];
  buildManifest: string;
  buildManifestSha256: string;
}

export interface SpriteInventoryEntry {
  path: string;
  sha256: string;
  bytes: number;
  status: "included" | "excluded";
  reason: string;
  bundles: string[];
}

export interface SpriteInventoryReport {
  schema: "oca-sprite-inventory@1";
  libraryId: string;
  entries: SpriteInventoryEntry[];
  included: number;
  excluded: number;
}

export interface SpriteLibraryBuildManifest {
  schema: typeof SPRITE_LIBRARY_BUILD_SCHEMA;
  id: string;
  bundles: SpriteLibraryBundleBuild[];
  profiles: SpriteLibraryProfileSource[];
  inventory: { file: string; sha256: string; bytes: number };
}

export interface SpriteLibraryLock {
  schema: typeof SPRITE_LIBRARY_LOCK_SCHEMA;
  id: string;
  bundles: Array<SpriteLibraryBundleBuild & { sourceSha256: string }>;
  profiles: SpriteLibraryProfileSource[];
  build: { manifestSha256: string; inventorySha256: string };
}

export interface CompileLibraryOptions {
  manifestPath: string;
  outputDirectory: string;
  lockPath?: string;
  writeLock?: boolean;
}
