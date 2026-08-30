import type {
  ArtifactAttribute,
  ArtifactManifest,
  KeelIndexAnchor,
  ArtifactResource,
  ArtifactThumbnail,
  Compression,
  EntrypointMode,
  Integrity,
  ResourceRole,
  ResourceSource,
  KeelComponentFormat,
  KeelComponentRole,
  KeelComponentUpdatePolicy,
  KeelAttribution,
  KeelLibraryBindings,
  KeelStakeObject,
  KeelWebpProfile,
} from "@keel/protocol";

export interface StudioStackComponentInput {
  readonly label: string;
  readonly role: KeelComponentRole;
  readonly format: KeelComponentFormat;
  readonly updates: KeelComponentUpdatePolicy;
  readonly labelOrigin?: "creator" | "library-default";
  readonly library?: string;
}

export type ArtifactLifecycleStatus = "draft" | "ready" | "published" | "failed";
export type StudioStorageStrategy = "local" | "onchain" | "hybrid";

export interface StudioAssetInput {
  readonly id?: string;
  readonly fileName: string;
  readonly mediaType?: string;
  readonly bytes: Uint8Array;
  readonly role?: ResourceRole;
  readonly executable?: boolean;
  readonly description?: string;
  readonly remoteUri?: string;
  readonly entrypoint?: boolean;
  readonly stack?: StudioStackComponentInput;
  readonly additionalSources?: readonly ResourceSource[];
  /**
   * Generated composite resources have no creator-owned local file. They are
   * reconstructed exclusively from the exact declared sources. Ordinary
   * uploaded files keep the default local source plus any verified fallbacks.
   */
  readonly sourceMode?: "local-and-additional" | "additional-only";
}

export interface PrepareStudioArtifactOptions {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly creator?: string;
  readonly sourceRepository?: string;
  readonly createdAt?: string;
  readonly revision?: number;
  readonly parentRevision?: number;
  /**
   * Freeze the canonical 1/1 artifact. Omitted/false preserves the existing
   * creator-editable revision behavior for compatibility.
   */
  readonly immutable?: boolean;
  readonly assets: readonly StudioAssetInput[];
  readonly libraries?: KeelLibraryBindings;
  readonly thumbnailCapture?: ArtifactThumbnail["capture"];
  readonly mediaDerivativeProfiles?: readonly KeelWebpProfile[];
  readonly stakeObject?: KeelStakeObject;
  /** Creator-authored role labels; these do not grant runtime or edit access. */
  readonly attributions?: readonly KeelAttribution[];
  /**
   * Optional manifest-driven Flash runtime. The project owns the SWF; the
   * Ruffle scripts/WASM and deterministic trait modules are declared by path
   * and become verified Keel resources in the prepared artifact.
   */
  readonly flashRuntime?: StudioFlashRuntime;
  /**
   * Protocol-owned, canonical manifest extensions. Callers must use a
   * namespaced key so a creation module can be recovered without changing the
   * base artifact schema.
   */
  readonly extensions?: Readonly<Record<string, unknown>>;
  readonly maxResourceBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxResources?: number;
  readonly timeoutMs?: number;
}

/** Paths are resolved against the exact normalized Studio asset paths. */
export interface StudioFlashRuntime {
  readonly swfPath: string;
  readonly loaderPath: string;
  readonly seededRandomPath: string;
  readonly editionPath: string;
  readonly ruffleMainPath: string;
  readonly ruffleModernCorePath: string;
  readonly ruffleLegacyCorePath: string;
  /** Optional extensions-enabled WASM. */
  readonly ruffleModernWasmPath?: string;
  /** MVP/vanilla WASM. Unsupported browsers may upload it locally. */
  readonly ruffleLegacyWasmPath: string;
  /** Select one extensions-enabled WASM path or retain the legacy upload flow. */
  readonly ruffleWasmPolicy?: "modern-only" | "dual";
  /** SHA-256 commitment for the optional local MVP/vanilla upload. */
  readonly ruffleModernWasmSha256?: string;
  readonly ruffleModernWasmByteLength?: number;
  readonly ruffleModernWasmFileName?: string;
  readonly collectionSize: number;
  /** Local preview fallback only; production token seeds come from Keel. */
  readonly previewRootSeed?: string;
}

export interface PreparedStudioResource {
  readonly resource: ArtifactResource;
  readonly fileName: string;
  readonly decodedBytes: Uint8Array;
  readonly storedBytes: Uint8Array;
  readonly compression: Compression;
  readonly decodedIntegrity: Integrity;
  readonly storedIntegrity: Integrity;
  readonly decodedByteLength: number;
  readonly storedByteLength: number;
  readonly compressionRatio: number;
}

export interface StudioArtifactStats {
  readonly resourceCount: number;
  readonly executableResourceCount: number;
  readonly decodedByteLength: number;
  readonly storedByteLength: number;
  readonly bytesSaved: number;
  readonly compressionRatio: number;
}

export interface PreparedStudioArtifact {
  readonly manifest: ArtifactManifest;
  readonly manifestIntegrity: Integrity;
  readonly resources: readonly PreparedStudioResource[];
  readonly stats: StudioArtifactStats;
}

export interface ResourceDeploymentEstimate {
  readonly resourceId: string;
  readonly decodedByteLength: number;
  readonly storedByteLength: number;
  readonly chunkCount: number;
  readonly leafObjectCount: number;
  readonly compositeObjectCount: number;
  readonly treeDepth: number;
  readonly transactionCount: number;
  readonly approximateCalldataBytes: number;
}

export interface ArtifactDeploymentEstimate {
  readonly schema: "keel-studio-deployment-estimate@1";
  readonly chunkBytes: number;
  readonly maxChildren: number;
  readonly resources: readonly ResourceDeploymentEstimate[];
  readonly transactionCount: number;
  readonly approximateCalldataBytes: number;
}

export interface NormalizedStudioAsset {
  readonly id: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly role: ResourceRole;
  readonly executable: boolean;
  readonly description?: string;
  readonly remoteUri?: string;
  readonly entrypoint: boolean;
  readonly mode: EntrypointMode;
  readonly stack?: StudioStackComponentInput;
  readonly additionalSources?: readonly ResourceSource[];
  readonly sourceMode: "local-and-additional" | "additional-only";
}

export interface PreparedVerificationResult {
  readonly valid: boolean;
  readonly manifestValid: boolean;
  readonly resourcesValid: boolean;
  readonly errors: readonly string[];
}

export interface StudioResourceDescriptor {
  readonly id: string;
  readonly role: ResourceRole;
  readonly mediaType: string;
  readonly integrity: Integrity;
  readonly uri: string;
  readonly executable?: boolean;
  readonly originalName?: string;
  readonly description?: string;
  readonly aliases?: readonly string[];
  readonly compression?: Compression;
}

export interface StudioManifestInput {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly createdAt: string;
  readonly creator?: string;
  readonly resources: readonly StudioResourceDescriptor[];
  readonly entrypointResourceId: string;
  readonly entrypointMode?: EntrypointMode;
  readonly fallbackImageResourceId?: string;
  readonly downloadResourceId?: string;
  readonly downloadFilename?: string;
  readonly viewerBaseUrl?: string;
  readonly anchor?: KeelIndexAnchor;
  readonly revision?: number;
  readonly parentRevision?: number;
  readonly parentDigest?: Integrity;
  readonly attributes?: readonly ArtifactAttribute[];
  readonly attributions?: readonly KeelAttribution[];
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export interface BuiltStudioManifest {
  readonly manifest: ArtifactManifest;
  readonly integrity: Integrity;
}

export interface ResourceSourcePatch {
  readonly resourceId: string;
  readonly source: ResourceSource;
  readonly prepend?: boolean;
}

export interface UploadPlanMetrics {
  readonly decodedBytes: number;
  readonly storedBytes: number;
  readonly savedBytes: number;
  readonly savingsRatio: number;
  readonly compression: Compression | "mixed";
  readonly chunks: number;
  readonly leafObjects: number;
  readonly compositeObjects: number;
  readonly treeDepth: number;
  readonly estimatedTransactions: number;
}

export interface CompressionSummary {
  readonly originalBytes: number;
  readonly storedBytes: number;
  readonly savedBytes: number;
  readonly ratio: number;
  readonly percentSaved: number;
}

export interface WrapperInput {
  readonly title: string;
  readonly mediaType: string;
  readonly resourcePath: string;
  readonly originalPath?: string;
  readonly backgroundColor?: string;
  readonly objectFit?: "contain" | "cover" | "fill" | "none";
}

export interface IndexedEventIdentity {
  readonly chainId: number;
  readonly blockNumber?: bigint;
  readonly transactionHash: `0x${string}`;
  readonly logIndex: number;
}

export interface IndexerCursorState {
  readonly chainId?: number;
  readonly nextBlock: bigint;
  readonly lastProcessedBlock?: bigint;
  readonly lastProcessedBlockHash?: `0x${string}`;
}

export interface IndexedRange {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
}

export interface IndexedBlockCheckpoint {
  readonly chainId: number;
  readonly blockNumber: bigint;
  readonly blockHash: `0x${string}`;
  readonly parentHash: `0x${string}`;
}

export interface ReorgDecision {
  readonly reorg: boolean;
  readonly rewindTo: bigint;
  readonly deleteFrom: bigint;
  readonly reason: string;
}

/** Backward-compatible name used by the studio wrapper implementation. */
export type ArtifactWrapperInput = WrapperInput;
